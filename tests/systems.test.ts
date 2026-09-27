// Focused system tests against the authoritative Match with fake client links.
import { beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/server/config';
import { rollChestLoot, rollRarity } from '../src/server/loot';
import { Match } from '../src/server/match';
import type { ClientLink, ServerPlayer } from '../src/server/player';
import { ProfileStore } from '../src/server/profiles';
import { ByteReader, ByteWriter } from '../src/shared/binary';
import { GRID, INPUT_DT, MATCH_DEFAULTS, TICK_RATE } from '../src/shared/constants';
import { ITEM_BY_CODE, ITEM_BY_ID, makeStack } from '../src/shared/items';
import { MapData, generateMap } from '../src/shared/mapdata';
import { decodeInputs, decodeSnapshot, encodeInputs, encodeSnapshot, quantizeInput, quantizeSim } from '../src/shared/protocol';
import { DEFAULT_LOADOUT, addXp, emptyStats, xpToNext } from '../src/shared/progression';
import { RNG } from '../src/shared/rng';
import { BTN, InputCmd, Mode, SimEvent, copySim, createSim, stepSim } from '../src/shared/sim';
import { STORM_PHASES } from '../src/shared/storm';
import { Terrain } from '../src/shared/terrain';
import { quantizeVehicle, stepVehicle } from '../src/shared/vehicle';

let terrain: Terrain;
let map: MapData;
beforeAll(() => {
  terrain = new Terrain();
  map = generateMap(terrain);
});

const cfg = (o: Partial<ServerConfig> = {}): ServerConfig => ({
  port: 0, dataDir: 'x', maxPlayers: 4, lobbyTime: 1, queueWait: 0, stormScale: 1, botSkill: 0.5, fillBots: false, maxMatches: 1, devCommands: true, ...o,
});

class FakeLink implements ClientLink {
  msgs: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  bins = 0;
  open = true;
  profileId = null;
  send(m: unknown) {
    this.msgs.push(m);
  }
  sendBin() {
    this.bins++;
  }
  events(name: string) {
    return this.msgs.filter((m) => m.t === 'ev').flatMap((m) => m.l).filter((e: { e: string }) => e.e === name);
  }
}

const cmd = (o: Partial<InputCmd> = {}): InputCmd => ({ seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, slot: 255, viewTick: 0, ...o });

/** A match already in the 'play' phase with the given humans placed on the island. */
function playingMatch(mode: 'solo' | 'duos' | 'squads', teams: number[][]) {
  // humans only (fake links count as connected clients), no bot fill
  const m = new Match({ mode, cfg: cfg({ maxPlayers: 16 }), island: { terrain, map }, profiles: null, seed: 7 });
  const players: ServerPlayer[][] = [];
  for (const t of teams) {
    const links = t.map(() => new FakeLink());
    players.push(m.addParty(links.map((l, i) => ({ link: l, profile: null, name: `P${t[i]}`, cos: DEFAULT_LOADOUT, level: 1 })), false));
  }
  while (m.phase === 'lobby') m.update();
  while (m.phase === 'bus') {
    for (const p of m.players.values()) if (p.sim.mode === Mode.Bus && m.time > m.bus!.t0 + MATCH_DEFAULTS.busDoorsOpen) m.exitBus(p);
    m.update();
    if (m.time > m.bus!.t1 + 1) break;
  }
  // put everyone on flat ground near Pitstop Junction
  let k = 0;
  for (const team of players) for (const p of team) {
    m.dev(p, { cmd: 'teleport', x: -30 + k * 3, z: 150 });
    k++;
  }
  for (let i = 0; i < 20; i++) m.update();
  return { m, players };
}

function feed(m: Match, p: ServerPlayer, c: Partial<InputCmd>, n = 1) {
  for (let i = 0; i < n; i++) {
    p.queue.push({ kind: 'input', cmd: cmd({ seq: p.lastSeq + 1 + i, viewTick: m.tick - 1, ...c }) });
  }
}

describe('protocol', () => {
  it('round-trips inputs and snapshots', () => {
    const w = new ByteWriter(16);
    const inputs = [quantizeInput(cmd({ seq: 5, mx: 0.5, mz: -1, yaw: 1.234, pitch: -0.3, buttons: BTN.FIRE | BTN.JUMP, slot: 2, viewTick: 123.5 }))];
    const r = new ByteReader(encodeInputs(w, inputs));
    r.u8();
    expect(decodeInputs(r)).toEqual(inputs);
    const self = createSim(1, 2, 3);
    self.inv.slots[1] = makeStack('vanguard', 3);
    self.inv.ammo[1] = 77;
    quantizeSim(self);
    const bin = encodeSnapshot(w, { tick: 9, time: 0.3, ack: 5, self, ents: [], vehicles: [], projs: [{ id: 1, kind: 0, x: 1, y: 2, z: 3 }], bus: null });
    const rr = new ByteReader(bin);
    rr.u8();
    const snap = decodeSnapshot(rr);
    expect(snap.ack).toBe(5);
    expect(snap.self!.inv.slots[1]).toEqual(self.inv.slots[1]);
    expect(snap.self!.inv.ammo[1]).toBe(77);
    expect(snap.self!.x).toBe(self.x);
    expect(snap.projs[0].z).toBe(3);
  });

  it('client replay from a quantized server state is bit-identical to the server', () => {
    const m = new Match({ mode: 'solo', cfg: cfg(), island: { terrain, map }, profiles: null, seed: 1, allowBotOnly: true });
    const world = m.world;
    const server = createSim(-30, terrain.heightAt(-30, 150) + 0.2, 150);
    const inputs: InputCmd[] = [];
    const rng = new RNG(3);
    for (let i = 0; i < 240; i++) inputs.push(quantizeInput(cmd({ seq: i + 1, mz: rng.range(-1, 1), mx: rng.range(-1, 1), yaw: rng.range(-3, 3), buttons: rng.chance(0.05) ? BTN.JUMP : rng.chance(0.3) ? BTN.SPRINT : 0 })));
    const ev: SimEvent[] = [];
    // server simulates the first 120 inputs and "sends" its state
    for (const c of inputs.slice(0, 120)) {
      stepSim(server, c, INPUT_DT, { world, playerId: 1, canAttack: true }, ev);
      quantizeSim(server);
    }
    const client = createSim();
    copySim(client, server);
    for (const c of inputs.slice(120)) {
      stepSim(server, c, INPUT_DT, { world, playerId: 1, canAttack: true }, ev);
      quantizeSim(server);
      stepSim(client, c, INPUT_DT, { world, playerId: 1, canAttack: true }, ev);
      quantizeSim(client);
    }
    expect(client.x).toBe(server.x);
    expect(client.y).toBe(server.y);
    expect(client.z).toBe(server.z);
  });
});

describe('combat & lag compensation', () => {
  it('hits where the target was on the shooter screen (rewind), not where it is now', () => {
    const { m, players } = playingMatch('solo', [[1], [2]]);
    const [a] = players[0];
    const [b] = players[1];
    // b stands 12m north of a; record history, then b moves 3m east
    m.dev(a, { cmd: 'teleport', x: -30, z: 150 });
    m.dev(b, { cmd: 'teleport', x: -30, z: 138 });
    for (let i = 0; i < 10; i++) m.update();
    const pastTick = m.tick - 1;
    b.sim.x += 3;
    for (let i = 0; i < 3; i++) m.update();
    const ay = a.sim.y + 1.6;
    // aim at b's *old* chest position
    const tgt = b.posAt(pastTick, m.tick - 1);
    const dx = tgt.x - a.sim.x, dy = tgt.y + 1.1 - ay, dz = tgt.z - a.sim.z;
    const l = Math.hypot(dx, dy, dz);
    const hitOld = m.rayPlayers(a, a.sim.x, ay, a.sim.z, dx / l, dy / l, dz / l, 50, pastTick);
    expect(hitOld?.p).toBe(b);
    const hitNow = m.rayPlayers(a, a.sim.x, ay, a.sim.z, dx / l, dy / l, dz / l, 50, m.tick - 1);
    expect(hitNow).toBeNull();
    // rewinding further than MAX_LAG_COMP is clamped (can't shoot ghosts from long ago)
    const clamped = b.posAt(pastTick - TICK_RATE * 5, m.tick - 1);
    expect(Math.abs(clamped.x - b.sim.x)).toBeLessThan(3.01);
  });

  it('sniper bullets are ballistic: they travel, drop, and hit only after flight time', () => {
    const { m, players } = playingMatch('solo', [[1], [2]]);
    const [a] = players[0];
    const [b] = players[1];
    m.dev(a, { cmd: 'teleport', x: -30, z: 150 });
    m.dev(b, { cmd: 'teleport', x: -30, z: 80 });
    for (let i = 0; i < 20; i++) m.update();
    b.sim.shield = 100;
    m.dev(a, { cmd: 'give', id: 'longshot', rarity: 2 });
    const slot = a.sim.inv.slots.findIndex((x) => x && ITEM_BY_CODE[x.code].id === 'longshot');
    const w = ITEM_BY_ID.longshot.weapon!;
    const eyeY = a.sim.y + 1.6;
    const dist = Math.hypot(b.sim.x - a.sim.x, b.sim.z - a.sim.z);
    const tFlight = dist / w.ballistic!.speed;
    const drop = 0.5 * w.ballistic!.gravity * tFlight * tFlight;
    expect(m.world.raycast(a.sim.x, eyeY, a.sim.z, 0, (b.sim.y + 1.1 - eyeY) / dist, -1, dist)).toBeNull();
    // aim at the chest, compensating for drop; yaw 0 faces -Z (b is due north)
    const pitch = Math.atan2(b.sim.y + 1.1 + drop - eyeY, dist);
    feed(m, a, { slot, pitch, buttons: BTN.ADS }, 40); // equip + scope in
    for (let i = 0; i < 3; i++) m.update();
    feed(m, a, { slot, pitch, buttons: BTN.ADS | BTN.FIRE }, 1);
    m.update();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projs = [...(m as any).projectiles.values()] as { kind: number; owner: number; y: number; vy: number }[];
    const bullet = projs.find((x) => x.kind === 3 && x.owner === a.id);
    expect(bullet).toBeDefined();
    expect(b.sim.shield).toBe(100); // not instant
    const vy0 = bullet!.vy;
    m.update();
    expect(bullet!.vy).toBeLessThan(vy0); // gravity
    for (let i = 0; i < Math.ceil(tFlight * TICK_RATE) + 3; i++) m.update();
    expect(b.sim.shield).toBeLessThan(100);
    expect(a.stats.damage).toBeGreaterThan(0);
  });

  it('shields absorb damage first; eliminations drop loot and award kills', () => {
    const { m, players } = playingMatch('solo', [[1], [2]]);
    const [a] = players[0];
    const [b] = players[1];
    b.sim.shield = 50;
    b.sim.inv.slots[1] = makeStack('thumper', 2);
    m.applyDamage(b, 30, a, { cause: 'weapon' });
    expect(b.sim.shield).toBe(20);
    expect(b.sim.hp).toBe(100);
    m.applyDamage(b, 60, a, { cause: 'weapon' });
    expect(b.sim.shield).toBe(0);
    expect(b.sim.hp).toBe(60);
    const itemsBefore = m.items.size;
    m.applyDamage(b, 100, a, { cause: 'weapon', code: ITEM_BY_ID.thumper.code });
    expect(b.eliminated).toBe(true);
    expect(a.stats.kills).toBe(1);
    expect(a.stats.classKills.shotgun).toBe(1);
    expect(m.items.size).toBeGreaterThan(itemsBefore);
    expect(m.phase).toBe('ended');
    expect(m.winnerTeam).toBe(a.team);
    m.update(); // events/results are flushed at the end of the tick
    expect((a.link as FakeLink).msgs.some((x) => x.t === 'results' && x.placement === 1 && x.won)).toBe(true);
  });

  it('squads: knocked players can be revived; teams wipe when nobody is standing', () => {
    const { m, players } = playingMatch('squads', [[1, 2], [3]]);
    const [a1, a2] = players[0];
    const [enemy] = players[1];
    m.applyDamage(a1, 150, enemy, { cause: 'weapon' });
    expect(a1.downed).toBe(true);
    expect(a1.sim.mode).toBe(Mode.Downed);
    // teammate revives (hold USE)
    m.dev(a2, { cmd: 'teleport', x: a1.sim.x + 1, z: a1.sim.z });
    for (let i = 0; i < 5; i++) m.update();
    a2.queue.push({ kind: 'action', act: { a: 'interact', kind: 'revive', id: a1.id } });
    for (let t = 0; t < TICK_RATE * 6; t++) {
      feed(m, a2, { buttons: BTN.USE }, 2);
      m.update();
    }
    expect(a1.downed).toBe(false);
    expect(a1.sim.hp).toBe(30);
    // knock both: the team is wiped and the enemy wins
    m.applyDamage(a1, 200, enemy, { cause: 'weapon' });
    expect(a1.downed).toBe(true);
    m.applyDamage(a2, 200, enemy, { cause: 'weapon' });
    expect(a1.eliminated && a2.eliminated).toBe(true);
    expect(m.winnerTeam).toBe(enemy.team);
  });

  it('squads: a carried rebirth chip brings an eliminated teammate back at a spire', () => {
    const { m, players } = playingMatch('squads', [[1, 2], [3]]);
    const [a1, a2] = players[0];
    const [enemy] = players[1];
    m.applyDamage(a1, 150, enemy, { cause: 'weapon' }); // knocked
    m.applyDamage(a1, 200, enemy, { cause: 'weapon' }); // finished
    expect(a1.eliminated).toBe(true);
    const chip = [...m.items.values()].find((it) => it.owner === a1.id);
    expect(chip).toBeDefined();
    m.dev(a2, { cmd: 'teleport', x: chip!.x + 0.5, z: chip!.z });
    for (let i = 0; i < 10; i++) m.update();
    a2.queue.push({ kind: 'action', act: { a: 'pickup', id: chip!.id } });
    m.update();
    expect(a2.chips).toEqual([a1.id]);
    const sp = m.spires[0];
    m.dev(a2, { cmd: 'teleport', x: sp.x + 1.5, z: sp.z });
    for (let i = 0; i < 10; i++) m.update();
    a2.queue.push({ kind: 'action', act: { a: 'interact', kind: 'spire', id: sp.id } });
    for (let t = 0; t < TICK_RATE * 5; t++) {
      feed(m, a2, { buttons: BTN.USE }, 2);
      m.update();
    }
    expect(a1.eliminated).toBe(false);
    expect([Mode.Skydive, Mode.Glide]).toContain(a1.sim.mode);
    expect(a2.stats.rebirths).toBe(1);
  });
});

describe('building', () => {
  it('validates cost, range and rate, and collapses unsupported structures', () => {
    const { m, players } = playingMatch('solo', [[1], [2]]);
    const [a] = players[0];
    const s = a.sim;
    const i = Math.floor(s.x / GRID), k = Math.floor(s.z / GRID);
    const j = Math.floor((s.y + 0.3) / GRID);
    const act = (x: object) => a.queue.push({ kind: 'action', act: x as never });
    act({ a: 'build', type: 'wall', i, j, k: k - 1, d: 0, mat: 0 });
    m.update();
    expect((a.link as FakeLink).events('bf').at(-1)?.why).toBe('mats'); // no materials yet
    s.inv.mats = [100, 100, 100];
    act({ a: 'build', type: 'wall', i, j, k: k - 1, d: 0, mat: 0 });
    act({ a: 'build', type: 'wall', i, j: j + 1, k: k - 1, d: 0, mat: 0 }); // too fast
    m.update();
    expect(m.grid.at({ type: 'wall', i, j, k: k - 1, d: 0 })).toBeDefined();
    expect((a.link as FakeLink).events('bf').at(-1)?.why).toBe('rate');
    for (let n = 0; n < 5; n++) m.update();
    act({ a: 'build', type: 'wall', i, j: j + 1, k: k - 1, d: 0, mat: 0 });
    m.update();
    for (let n = 0; n < 5; n++) m.update();
    act({ a: 'build', type: 'wall', i: i + 40, j, k, d: 0, mat: 0 }); // out of range
    m.update();
    expect((a.link as FakeLink).events('bf').at(-1)?.why).toBe('range');
    expect(s.inv.mats[0]).toBe(80);
    // destroying the bottom wall collapses the one stacked on it
    const bottom = m.grid.at({ type: 'wall', i, j, k: k - 1, d: 0 })!;
    m.damagePiece(bottom, 9999);
    expect(m.grid.at({ type: 'wall', i, j: j + 1, k: k - 1, d: 0 })).toBeUndefined();
  });

  it('pieces build up health over time', () => {
    const { m, players } = playingMatch('solo', [[1], [2]]);
    const [a] = players[0];
    const s = a.sim;
    s.inv.mats = [100, 100, 100];
    const i = Math.floor(s.x / GRID), k = Math.floor(s.z / GRID), j = Math.floor((s.y + 0.3) / GRID);
    a.queue.push({ kind: 'action', act: { a: 'build', type: 'wall', i, j, k: k + 1, d: 0, mat: 1 } });
    m.update();
    const p = m.grid.at({ type: 'wall', i, j, k: k + 1, d: 0 })!;
    const hp0 = p.hp;
    for (let n = 0; n < TICK_RATE * 6; n++) m.update();
    expect(hp0).toBeLessThan(40);
    expect(p.hp).toBeCloseTo(p.maxHp, 0);
  });
});

describe('vehicles', () => {
  it('players can enter, drive and exit a Rover', () => {
    const { m, players } = playingMatch('solo', [[1], [2]]);
    const [a] = players[0];
    const v = [...m.vehicles.values()][0];
    m.dev(a, { cmd: 'teleport', x: v.x + 2, z: v.z });
    for (let i = 0; i < 10; i++) m.update();
    a.queue.push({ kind: 'action', act: { a: 'interact', kind: 'vehicle', id: v.id } });
    m.update();
    expect(a.sim.mode).toBe(Mode.Vehicle);
    expect(v.seats[0]).toBe(a.id);
    const x0 = v.x, z0 = v.z;
    for (let t = 0; t < TICK_RATE * 3; t++) {
      feed(m, a, { mz: 1 }, 2);
      m.update();
    }
    expect(Math.hypot(v.x - x0, v.z - z0)).toBeGreaterThan(10);
    expect(Math.hypot(a.sim.x - v.x, a.sim.z - v.z)).toBeLessThan(2);
    // client-side prediction of the driven vehicle replays bit-identically
    const snap = { ...v };
    const inputs = Array.from({ length: 30 }, (_, i) => ({ mx: Math.sin(i / 5), mz: 1, handbrake: i % 10 === 0 }));
    const client = { ...snap, seats: [...snap.seats] };
    for (const inp of inputs) {
      stepVehicle(v, inp, INPUT_DT, m.world, []);
      quantizeVehicle(v);
      stepVehicle(client, inp, INPUT_DT, m.world, []);
      quantizeVehicle(client);
    }
    expect([client.x, client.y, client.z, client.yaw]).toEqual([v.x, v.y, v.z, v.yaw]);
    a.queue.push({ kind: 'action', act: { a: 'exitVehicle' } });
    m.update();
    expect(a.sim.mode).toBe(Mode.Walk);
    expect(v.seats[0]).toBe(0);
  });
});

describe('map structural integrity', () => {
  it('knocking out a house wall stack collapses what it held up, and loot falls', () => {
    const { m } = playingMatch('solo', [[1], [2]]);
    // find a two-storey map building: an upper floor supported only through walls
    const upper = [...m.grid.pieces.values()].find((p) => p.owner === 0 && p.type === 'floor' && !p.grounded && !p.anchored && p.j >= 3);
    expect(upper).toBeDefined();
    const before = m.grid.pieces.size;
    // destroy every grounded piece of that building's footprint area
    const near = [...m.grid.pieces.values()].filter((p) => p.owner === 0 && !p.anchored && Math.abs(p.i - upper!.i) <= 6 && Math.abs(p.k - upper!.k) <= 6 && p.grounded);
    for (const p of near) m.damagePiece(p, 1e6);
    expect(m.grid.get(upper!.id)).toBeUndefined();
    expect(m.grid.pieces.size).toBeLessThan(before - near.length);
    // nothing floats: every item near the collapse rests on whatever is below it
    for (const it of m.items.values()) {
      if (Math.abs(it.x - (upper!.i + 0.5) * GRID) > 10 || Math.abs(it.z - (upper!.k + 0.5) * GRID) > 10) continue;
      const g = m.world.groundAt(it.x, it.z, it.y + 0.1, 0.2);
      const ground = g === -1e9 ? terrain.surfaceAt(it.x, it.z) : g;
      expect(it.y - ground).toBeLessThan(0.45);
    }
  });
});

describe('storm', () => {
  it('each next circle lies inside the previous one and damage ramps up', () => {
    const { m } = playingMatch('solo', [[1], [2]]);
    const seen: { x: number; z: number; r: number }[] = [];
    let guard = 0;
    while (m.storm.stage !== 'done' && guard++ < TICK_RATE * 60 * 20) {
      const before = m.storm.phase;
      m.update();
      if (m.storm.phase !== before || seen.length === 0) seen.push({ ...m.storm.to });
      if (m.phase === 'ended') break;
    }
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1], b = seen[i];
      expect(Math.hypot(a.x - b.x, a.z - b.z) + b.r).toBeLessThanOrEqual(a.r + 0.001);
    }
    expect(STORM_PHASES.map((p) => p.dps)).toEqual([...STORM_PHASES.map((p) => p.dps)].sort((x, y) => x - y));
  });
});

describe('loot & progression', () => {
  it('higher tier locations roll better rarities; caches always contain a weapon', () => {
    const rng = new RNG(1);
    const avg = (tier: number) => {
      let s = 0;
      for (let i = 0; i < 4000; i++) s += rollRarity(rng, tier);
      return s / 4000;
    };
    expect(avg(1.9)).toBeGreaterThan(avg(1.0) + 0.3);
    for (let i = 0; i < 50; i++) expect(rollChestLoot(rng, 1).some((st) => ITEM_BY_CODE[st.code].category === 'weapon')).toBe(true);
  });

  it('awards XP, levels, currency and challenge progress server-side', () => {
    const store = new ProfileStore('unused', false);
    const p = store.create('Tester');
    const stats = { ...emptyStats(), kills: 3, damage: 900, chests: 5, placement: 1, won: true, timeAlive: 600, builds: 60 };
    const res = store.applyMatch(p, stats, 20);
    expect(res.totalXp).toBeGreaterThan(1000);
    expect(p.level).toBeGreaterThan(1);
    expect(res.currency).toBeGreaterThan(100);
    expect(p.stats.wins).toBe(1);
    const lv = addXp(1, 0, xpToNext(1) + xpToNext(2));
    expect(lv.level).toBe(3);
    expect(store.buy(p, 'nonexistent')).toBe('Not for sale');
  });
});
