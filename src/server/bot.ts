// Server-side AI players. Bots produce the same InputCmd/Action stream as humans, so they
// obey identical movement, weapon and validation rules (no cheating bots).
import { BUILD_COST, INTERACT_RANGE, MATCH_DEFAULTS, PICKUP_RANGE, SKYPORT } from '../shared/constants';
import { buildTarget } from '../shared/build';
import { ITEM_BY_CODE, ItemDef, ammoIndex } from '../shared/items';
import { angleLerp, wrapAngle } from '../shared/math';
import { POIS } from '../shared/pois';
import { EMOTE_IDS } from '../shared/progression';
import { RNG } from '../shared/rng';
import { BTN, InputCmd, Mode, SLOT_KEEP } from '../shared/sim';
import { STORM_PHASES, stormCircleAt } from '../shared/storm';
import type { Match } from './match';
import type { ServerPlayer } from './player';

const ADJ = ['Turbo', 'Pixel', 'Sneaky', 'Cosmic', 'Mighty', 'Fuzzy', 'Rapid', 'Lucky', 'Salty', 'Neon', 'Chill', 'Wobbly', 'Brave', 'Zesty', 'Sly', 'Jolly', 'Rusty', 'Frosty', 'Sunny', 'Stormy'];
const NOUN = ['Panda', 'Toast', 'Otter', 'Comet', 'Waffle', 'Badger', 'Pickle', 'Falcon', 'Noodle', 'Yeti', 'Moose', 'Gecko', 'Muffin', 'Rhino', 'Squid', 'Kiwi', 'Taco', 'Walrus', 'Beacon', 'Sprout'];

export function botName(rng: RNG) {
  return `${rng.pick(ADJ)}${rng.pick(NOUN)}${rng.chance(0.4) ? rng.int(1, 99) : ''}`;
}

type Goal =
  | { kind: 'item'; id: number; until: number }
  | { kind: 'container'; id: number; until: number }
  | { kind: 'revive'; id: number; until: number }
  | { kind: 'spire'; id: number; until: number }
  | { kind: 'move'; x: number; z: number; until: number };

export class BotBrain {
  private seq = 1;
  private yaw = 0;
  private pitch = 0;
  private wantYaw = 0;
  private wantPitch = 0;
  private mx = 0;
  private mz = 0;
  private hold = 0; // held buttons
  private pulse = 0; // buttons pressed for one input
  private slot = SLOT_KEEP;
  private thinkT = 0;
  private enemy: ServerPlayer | null = null;
  private enemySeenAt = -10;
  private enemyLast = { x: 0, y: 0, z: 0 };
  private aimErrY = 0;
  private aimErrP = 0;
  private aimErrT = 0;
  private trackT = 0;
  private strafe = 1;
  private strafeT = 0;
  private goal: Goal | null = null;
  private blacklist = new Map<number, number>();
  private dropTarget: { x: number; z: number } | null = null;
  private jumpProgress = 0.5;
  private busMinDist = 1e9;
  private navSide = 1;
  private lastPos = { x: 0, z: 0, t: 0 };
  private stuck = 0;
  private stuckAction = 0;
  private buildCd = 0;
  private hurtAt = -10;
  private attacker: ServerPlayer | null = null;
  private useHoldUntil = 0;
  private healing = false;
  private fireToggle = false;
  private nadeCd = 0;
  private emoteCd = 0;
  private reaction: number;
  dbg = '';

  constructor(private m: Match, private p: ServerPlayer, private rng: RNG, private skill: number) {
    this.reaction = 0.45 - skill * 0.3;
  }

  // --- notifications from the match ---
  onBus() {
    this.dropTarget = null;
    this.goal = null;
    this.enemy = null;
    this.healing = false;
    this.jumpProgress = this.rng.range(0.12, 0.85);
    this.busMinDist = 1e9;
    this.navSide = this.rng.chance(0.5) ? 1 : -1;
  }
  onExitBus() {}
  onLanded() {
    this.goal = null;
  }
  onRevived() {
    this.goal = null;
  }
  onDamaged(by: ServerPlayer | null) {
    this.hurtAt = this.m.time;
    if (by && by !== this.p && by.team !== this.p.team) {
      this.attacker = by;
      if (!this.enemy || this.m.time - this.enemySeenAt > 1.5) {
        this.enemy = by;
        this.enemySeenAt = this.m.time - 0.2;
        this.enemyLast = { x: by.sim.x, y: by.sim.y, z: by.sim.z };
      }
    }
  }

  private get s() {
    return this.p.sim;
  }

  /** Blacklist keys: items use their id, other goal kinds are offset so ids never collide. */
  private goalKey(g: Goal) {
    switch (g.kind) {
      case 'item': return g.id;
      case 'container': return g.id + 1e6;
      case 'revive': return g.id + 2e6;
      case 'spire': return g.id + 3e6;
      default: return -1;
    }
  }

  update(dt: number) {
    if (this.p.eliminated) return;
    this.thinkT -= dt;
    this.strafeT -= dt;
    this.buildCd -= dt;
    this.nadeCd -= dt;
    this.emoteCd -= dt;
    this.aimErrT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.18 + this.rng.range(0, 0.08);
      this.think();
    }
    this.steerAim(dt);
    // two inputs per server tick (60Hz input vs 30Hz tick)
    for (let k = 0; k < 2; k++) this.p.queue.push({ kind: 'input', cmd: this.makeInput() });
  }

  private makeInput(): InputCmd {
    let b = this.hold | this.pulse;
    this.pulse = 0;
    // semi-auto weapons need fresh presses
    if (b & BTN.FIRE) {
      const it = this.s.inv.slots[this.s.slot];
      const w = it ? ITEM_BY_CODE[it.code].weapon : undefined;
      if (w && !w.auto) {
        this.fireToggle = !this.fireToggle;
        if (!this.fireToggle) b &= ~BTN.FIRE;
      }
    }
    const cmd: InputCmd = { seq: this.seq++, mx: this.mx, mz: this.mz, yaw: Math.fround(this.yaw), pitch: Math.fround(this.pitch), buttons: b, slot: this.slot, viewTick: this.m.tick - 1 };
    this.slot = SLOT_KEEP;
    return cmd;
  }

  private steerAim(dt: number) {
    const rate = (this.enemy ? 5 + this.skill * 7 : 6) * dt;
    const dy = wrapAngle(this.wantYaw - this.yaw);
    this.yaw = wrapAngle(this.yaw + Math.max(-rate, Math.min(rate, dy)));
    this.pitch = angleLerp(this.pitch, this.wantPitch, Math.min(1, dt * 8));
  }

  private face(x: number, z: number) {
    this.wantYaw = Math.atan2(-(x - this.s.x), -(z - this.s.z));
  }

  private act(a: Parameters<Match['processAction']>[1]) {
    this.p.queue.push({ kind: 'action', act: a });
  }

  // ------------------------------------------------------------------------

  private think() {
    const m = this.m;
    const s = this.s;
    this.hold = 0;
    this.mx = 0;
    this.mz = 0;
    if (m.phase === 'lobby') return this.thinkLobby();
    if (s.mode === Mode.Bus) return this.thinkBus();
    if (s.mode === Mode.Skydive || s.mode === Mode.Glide) return this.thinkDrop();
    if (s.mode === Mode.Dead || s.mode === Mode.Vehicle) return;
    if (this.p.downed) return this.thinkDowned();
    this.perceive();
    this.checkStuck();
    this.dbg = 'fight';
    if (this.enemy && m.time - this.enemySeenAt < 2.5) {
      const d = Math.hypot(this.enemy.sim.x - s.x, this.enemy.sim.z - s.z);
      if (this.hasGun() || d < 7) return this.thinkFight();
    }
    this.dbg = 'rotate';
    if (this.stormThreat()) return this.thinkRotate();
    this.dbg = 'heal';
    if (this.needsHeal() && m.time - this.hurtAt > 2.5) return this.thinkHeal();
    this.healing = false;
    this.dbg = 'goal';
    if (this.thinkGoal()) return;
    this.dbg = 'hunt';
    if (this.enemy && m.time - this.enemySeenAt < 8) {
      this.moveTo(this.enemyLast.x, this.enemyLast.z, false);
      return;
    }
    this.dbg = 'roam';
    this.thinkRoam();
  }

  private thinkLobby() {
    const s = this.s;
    if (!this.goal || this.m.time > this.goal.until || (this.goal.kind === 'move' && Math.hypot(this.goal.x - s.x, this.goal.z - s.z) < 2)) {
      this.goal = { kind: 'move', x: SKYPORT.x + this.rng.range(-28, 28), z: SKYPORT.z + this.rng.range(-20, 20), until: this.m.time + 6 };
      if (this.rng.chance(0.3) && this.emoteCd <= 0) {
        this.act({ a: 'emote', id: this.rng.int(0, EMOTE_IDS.length - 1) });
        this.emoteCd = 6;
        this.goal.until = this.m.time + 3;
        return;
      }
    }
    if (s.emote) return;
    const g = this.goal as Extract<Goal, { kind: 'move' }>;
    this.face(g.x, g.z);
    this.mz = 1;
    if (this.rng.chance(0.03)) this.pulse |= BTN.JUMP;
  }

  private thinkBus() {
    const m = this.m;
    if (!this.dropTarget) {
      // prefer locations near the flight path (like players do)
      const b0 = m.bus!;
      const lx = b0.x1 - b0.x0, lz = b0.z1 - b0.z0;
      const ll = Math.hypot(lx, lz);
      const weights = POIS.map((p) => {
        const off = Math.abs((p.x - b0.x0) * lz - (p.z - b0.z0) * lx) / ll;
        return [p, p.lootTier * (p.kind === 'mountain' ? 0.5 : 1) * (off < 250 ? 3 : off < 400 ? 1 : 0.15)] as const;
      });
      const poi = this.rng.weighted(weights);
      const a = this.rng.range(0, Math.PI * 2), d = this.rng.range(0, poi.r * 0.8);
      this.dropTarget = { x: poi.x + Math.cos(a) * d, z: poi.z + Math.sin(a) * d };
      if (this.rng.chance(0.15)) {
        // random wilderness drop
        this.dropTarget = { x: this.rng.range(-400, 400), z: this.rng.range(-400, 400) };
      }
    }
    const b = m.bus!;
    const prog = (m.time - b.t0) / (b.t1 - b.t0);
    const bp = m.busPos();
    const dist = Math.hypot(bp.x - this.dropTarget.x, bp.z - this.dropTarget.z);
    const passed = dist > this.busMinDist + 5;
    this.busMinDist = Math.min(this.busMinDist, dist);
    if (m.time > b.t0 + MATCH_DEFAULTS.busDoorsOpen + 0.5 && (dist < 170 + this.jumpProgress * 60 || passed || prog > 0.93)) {
      this.pulse |= BTN.JUMP;
    }
  }

  private thinkDrop() {
    const s = this.s;
    const t = this.dropTarget ?? { x: s.x, z: s.z };
    const d = Math.hypot(t.x - s.x, t.z - s.z);
    this.face(t.x, t.z);
    if (s.mode === Mode.Skydive) {
      const h = s.y - this.m.terrain.surfaceAt(s.x, s.z);
      // dive steeply when close enough to drop straight down
      this.wantPitch = d < h * 0.45 ? -1.2 : -0.2;
      this.mz = d > 6 ? 1 : 0;
    } else {
      this.wantPitch = d < 20 ? -0.9 : 0;
      this.mz = d > 8 ? 1 : -1;
    }
  }

  private thinkDowned() {
    const mates = (this.m.teams.get(this.p.team) ?? []).filter((q) => q.standing && q !== this.p);
    if (!mates.length) return;
    const q = mates[0];
    this.moveTo(q.sim.x, q.sim.z, false);
  }

  // --- perception ---
  private perceive() {
    const m = this.m;
    const s = this.s;
    const eye = s.y + 1.5;
    let best: ServerPlayer | null = null;
    let bestD = 1e9;
    const range = 60 + this.skill * 80;
    const cands: [ServerPlayer, number][] = [];
    for (const q of m.players.values()) {
      if (!q.alive || q.team === this.p.team || q.sim.mode === Mode.Bus) continue;
      const d = Math.hypot(q.sim.x - s.x, q.sim.y - s.y, q.sim.z - s.z);
      if (d < range) cands.push([q, d]);
    }
    cands.sort((a, b) => a[1] - b[1]);
    for (const [q, d] of cands.slice(0, 3)) {
      // field of view (bots notice close enemies all around, far ones only in front)
      const ang = Math.abs(wrapAngle(Math.atan2(-(q.sim.x - s.x), -(q.sim.z - s.z)) - this.yaw));
      if (d > 18 && ang > 1.3 && q !== this.attacker) continue;
      const tx = q.sim.x, ty = q.sim.y + (q.downed ? 0.4 : 1.2), tz = q.sim.z;
      const dx = tx - s.x, dy = ty - eye, dz = tz - s.z;
      const l = Math.hypot(dx, dy, dz);
      const hit = m.world.raycast(s.x, eye, s.z, dx / l, dy / l, dz / l, l - 0.5);
      if (hit) continue;
      if (this.smokeBlocks(s.x, eye, s.z, tx, ty, tz)) continue;
      // prefer standing enemies over downed ones
      const score = d + (q.downed ? 25 : 0);
      if (score < bestD) {
        bestD = score;
        best = q;
      }
    }
    if (best) {
      if (best !== this.enemy) {
        this.trackT = 0;
        this.aimErrT = 0;
        if (m.time - this.enemySeenAt > 1) this.enemySeenAt = m.time + this.reaction; // reaction delay
      }
      this.enemy = best;
      if (m.time > this.enemySeenAt - this.reaction) this.enemySeenAt = Math.max(this.enemySeenAt, m.time);
      this.enemyLast = { x: best.sim.x, y: best.sim.y, z: best.sim.z };
    } else if (this.enemy && !this.enemy.alive) {
      this.enemy = null;
    }
  }

  private smokeBlocks(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    for (const sm of this.m.smokes) {
      const vx = bx - ax, vy = by - ay, vz = bz - az;
      const l2 = vx * vx + vy * vy + vz * vz;
      const t = Math.max(0, Math.min(1, ((sm.x - ax) * vx + (sm.y - ay) * vy + (sm.z - az) * vz) / l2));
      const d = Math.hypot(ax + vx * t - sm.x, ay + vy * t - sm.y, az + vz * t - sm.z);
      if (d < sm.r) return true;
    }
    return false;
  }

  private checkStuck() {
    const s = this.s;
    const now = this.m.time;
    if (now - this.lastPos.t < 1) return;
    const moved = Math.hypot(s.x - this.lastPos.x, s.z - this.lastPos.z);
    const intended = Math.abs(this.mz) > 0.1 || Math.abs(this.mx) > 0.1 || this.goal !== null;
    if (intended && moved < 1.0 && !this.enemy) this.stuck++;
    else this.stuck = Math.max(0, this.stuck - 1);
    this.lastPos = { x: s.x, z: s.z, t: now };
    if (this.stuck > 7) {
      if (this.goal && this.goal.kind !== 'move') this.blacklist.set(this.goalKey(this.goal), now + 30);
      this.goal = null;
      this.stuck = 0;
    }
  }

  // --- movement ---
  /** Pick a heading toward (x,z) that is not blocked right in front (cheap local avoidance). */
  private steer(x: number, z: number) {
    const s = this.s;
    const base = Math.atan2(-(x - s.x), -(z - s.z));
    const dist = Math.hypot(x - s.x, z - s.z);
    if (s.mode !== Mode.Walk || dist < 1.5) return base;
    const w = this.m.world;
    const probe = Math.min(3.2, dist);
    const offs = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2.0, -2.0];
    for (const o of offs) {
      const yaw = base + o * this.navSide;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const blocked =
        w.overlaps(s.x + fx * 1.1, s.y + 0.7, s.y + 1.7, s.z + fz * 1.1, 0.42) ||
        w.overlaps(s.x + fx * probe, s.y + 0.7, s.y + 1.7, s.z + fz * probe, 0.42);
      if (!blocked) return yaw;
    }
    this.navSide = -this.navSide;
    return base;
  }

  private moveTo(x: number, z: number, sprint: boolean) {
    const s = this.s;
    this.wantYaw = this.steer(x, z);
    this.wantPitch = 0;
    this.mz = 1;
    if (sprint) this.hold |= BTN.SPRINT;
    if (this.stuck >= 2) {
      this.pulse |= BTN.JUMP;
      if (this.stuck >= 3 && this.stuck < 5) this.mx = this.stuckAction % 2 ? 1 : -1;
      if (this.stuck >= 5) {
        // break through whatever is in the way
        this.slot = 0;
        this.hold |= BTN.FIRE;
        this.wantPitch = -0.1;
      }
      this.stuckAction++;
    }
    if (s.mode === Mode.Swim) this.hold |= BTN.SPRINT;
  }

  private stormThreat() {
    const st = this.m.storm;
    if (st.stage === 'idle') return false;
    const s = this.s;
    const now = stormCircleAt(st, this.m.time);
    const outNow = Math.hypot(s.x - now.x, s.z - now.z) > now.r - 8;
    if (outNow) return true;
    if (st.stage === 'done') return false;
    const distToNext = Math.hypot(s.x - st.to.x, s.z - st.to.z) - st.to.r * 0.8;
    if (distToNext <= 0) return false;
    // time needed to run into the next circle vs. time before the wall reaches us
    const need = distToNext / 6.5 + 8;
    const shrinkDur = STORM_PHASES[st.phase]?.shrink ?? 30;
    const avail = st.stage === 'wait' ? st.t1 - this.m.time + shrinkDur * this.m.cfg.stormScale * 0.6 : (st.t1 - this.m.time) * 0.6;
    return need > avail;
  }

  private thinkRotate() {
    const st = this.m.storm;
    const s = this.s;
    const c = st.stage === 'done' ? stormCircleAt(st, this.m.time) : st.to;
    const dx = s.x - c.x, dz = s.z - c.z;
    const d = Math.hypot(dx, dz) || 1;
    const r = c.r * 0.45;
    this.goal = null;
    this.moveTo(c.x + (dx / d) * r, c.z + (dz / d) * r, true);
  }

  private thinkRoam() {
    const s = this.s;
    const st = this.m.storm;
    if (!this.goal || this.goal.kind !== 'move' || this.m.time > this.goal.until || Math.hypot(this.goal.x - s.x, this.goal.z - s.z) < 5) {
      const c = st.stage === 'idle' ? { x: s.x, z: s.z, r: 120 } : st.stage === 'done' ? stormCircleAt(st, this.m.time) : st.to;
      const a = this.rng.range(0, Math.PI * 2), d = Math.sqrt(this.rng.float()) * c.r * 0.7;
      let x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      if (!this.m.terrain.isLand(x, z)) {
        x = c.x;
        z = c.z;
      }
      this.goal = { kind: 'move', x, z, until: this.m.time + 25 };
    }
    const g = this.goal as Extract<Goal, { kind: 'move' }>;
    this.moveTo(g.x, g.z, Math.hypot(g.x - s.x, g.z - s.z) > 20);
    this.maybeReload();
  }

  private maybeReload() {
    const it = this.s.inv.slots[this.s.slot];
    if (!it) return;
    const w = ITEM_BY_CODE[it.code].weapon;
    if (w && w.ammo && it.mag < w.mag * 0.5 && this.s.inv.ammo[ammoIndex(w.ammo)] > 0) this.pulse |= BTN.RELOAD;
  }

  // --- goals: loot, containers, revive, rebirth ---
  private thinkGoal(): boolean {
    const m = this.m;
    const s = this.s;
    if (this.goal && this.goal.kind !== 'move' && m.time > this.goal.until) {
      this.blacklist.set(this.goalKey(this.goal), m.time + 25);
      this.goal = null;
    }
    if (!this.goal || this.goal.kind === 'move') {
      const g = this.pickGoal();
      if (!g) return false;
      this.goal = g;
    }
    const g = this.goal!;
    let tx = 0, ty = 0, tz = 0; // eslint-disable-line prefer-const
    if (g.kind === 'item') {
      const it = m.items.get(g.id);
      if (!it) {
        this.goal = null;
        return false;
      }
      tx = it.x; ty = it.y; tz = it.z;
      if (Math.hypot(tx - s.x, tz - s.z) < PICKUP_RANGE - 0.8 && Math.abs(ty - s.y) < 2.5) {
        this.act({ a: 'pickup', id: it.id });
        this.blacklist.set(it.id, m.time + 8);
        this.goal = null;
        return true;
      }
    } else if (g.kind === 'container') {
      const c = m.containers.get(g.id);
      if (!c || c.open) {
        this.goal = null;
        return false;
      }
      tx = c.x; ty = c.y; tz = c.z;
      if (Math.hypot(tx - s.x, tz - s.z) < INTERACT_RANGE - 1 && Math.abs(ty - s.y) < 2.5) {
        if (m.time > this.useHoldUntil) {
          this.act({ a: 'interact', kind: c.kind, id: c.id });
          this.useHoldUntil = m.time + 1.6;
        }
        this.hold |= BTN.USE;
        this.face(tx, tz);
        return true;
      }
    } else if (g.kind === 'revive') {
      const t = m.players.get(g.id);
      if (!t || !t.downed) {
        this.goal = null;
        return false;
      }
      tx = t.sim.x; ty = t.sim.y; tz = t.sim.z;
      if (Math.hypot(tx - s.x, tz - s.z) < 2.2) {
        if (m.time > this.useHoldUntil) {
          this.act({ a: 'interact', kind: 'revive', id: t.id });
          this.useHoldUntil = m.time + 6;
        }
        this.hold |= BTN.USE;
        return true;
      }
    } else if (g.kind === 'spire') {
      const sp = m.spires.find((x) => x.id === g.id);
      if (!sp || !this.p.chips.length) {
        this.goal = null;
        return false;
      }
      tx = sp.x; ty = sp.y; tz = sp.z;
      if (Math.hypot(tx - s.x, tz - s.z) < 3.5) {
        if (m.time > this.useHoldUntil) {
          this.act({ a: 'interact', kind: 'spire', id: sp.id });
          this.useHoldUntil = m.time + 5;
        }
        this.hold |= BTN.USE;
        return true;
      }
    }
    const d = Math.hypot(tx - s.x, tz - s.z);
    this.moveTo(tx, tz, d > 12);
    return true;
  }

  private itemValue(def: ItemDef, rarity: number, owner?: number): number {
    const inv = this.s.inv;
    if (def.category === 'special') {
      if (owner === undefined) return 0;
      const o = this.m.players.get(owner);
      return o && o.team === this.p.team && o !== this.p && this.m.storm.phase < MATCH_DEFAULTS.rebirthWindowPhase ? 9 : 0;
    }
    const weapons = inv.slots.slice(1).filter((x) => x && ITEM_BY_CODE[x.code].weapon);
    const free = inv.slots.slice(1).filter((x) => !x).length;
    if (def.category === 'weapon') {
      const same = weapons.find((x) => ITEM_BY_CODE[x!.code].weapon!.cls === def.weapon!.cls);
      if (same) return same.rarity < rarity ? 3 : 0;
      return free > 0 ? 5 - weapons.length : 0;
    }
    if (def.category === 'ammo') {
      const a = def.ammoType!;
      const has = weapons.some((x) => ITEM_BY_CODE[x!.code].weapon!.ammo === a);
      return has && inv.ammo[ammoIndex(a)] < 90 ? 2 : 0;
    }
    if (def.category === 'material') return inv.mats.reduce((a, b) => a + b, 0) < 250 ? 1 : 0;
    if (def.category === 'heal') {
      const stacked = inv.slots.some((x) => x && x.code === def.code && x.count < def.stack);
      return stacked ? 1.5 : free > 1 ? 2 : 0;
    }
    return free > 1 ? 1 : 0;
  }

  private pickGoal(): Goal | null {
    const m = this.m;
    const s = this.s;
    const now = m.time;
    let best: Goal | null = null;
    let bestScore = 0;
    // revive downed teammates first
    for (const q of m.teams.get(this.p.team) ?? []) {
      if (q !== this.p && q.downed && Math.hypot(q.sim.x - s.x, q.sim.z - s.z) < 60) return { kind: 'revive', id: q.id, until: now + 15 };
    }
    if (this.p.chips.length && m.storm.phase < MATCH_DEFAULTS.rebirthWindowPhase) {
      let bs = null as null | { id: number; d: number };
      for (const sp of m.spires) {
        const d = Math.hypot(sp.x - s.x, sp.z - s.z);
        if (!bs || d < bs.d) bs = { id: sp.id, d };
      }
      if (bs && bs.d < 350) return { kind: 'spire', id: bs.id, until: now + 60 };
    }
    for (const it of m.items.values()) {
      const d = Math.hypot(it.x - s.x, it.z - s.z);
      if (d > 45 || Math.abs(it.y - s.y) > 12) continue;
      if ((this.blacklist.get(it.id) ?? 0) > now) continue;
      const v = this.itemValue(ITEM_BY_CODE[it.code], it.rarity, it.owner);
      if (v <= 0) continue;
      const score = v / (d + 6);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: 'item', id: it.id, until: now + 12 };
      }
    }
    for (const c of m.containers.values()) {
      if (c.open || (c.land ?? 0) > now) continue;
      const d = Math.hypot(c.x - s.x, c.z - s.z);
      if (d > 55 || Math.abs(c.y - s.y) > 12) continue;
      if ((this.blacklist.get(c.id + 1e6) ?? 0) > now) continue;
      const v = c.kind === 'supply' ? 7 : c.kind === 'chest' ? 4 : 1.5;
      const score = v / (d + 6);
      if (score > bestScore) {
        bestScore = score;
        best = { kind: 'container', id: c.id, until: now + 14 };
      }
    }
    return best;
  }

  // --- combat ---
  private hasGun() {
    const inv = this.s.inv;
    for (let i = 1; i < inv.slots.length; i++) {
      const it = inv.slots[i];
      if (!it) continue;
      const w = ITEM_BY_CODE[it.code].weapon;
      if (w && w.cls !== 'melee' && (it.mag > 0 || (w.ammo && inv.ammo[ammoIndex(w.ammo)] > 0))) return true;
    }
    return false;
  }

  private needsHeal() {
    const s = this.s;
    for (const it of s.inv.slots) {
      if (!it) continue;
      const u = ITEM_BY_CODE[it.code].use;
      if (!u) continue;
      if (u.shield && s.shield < (u.shieldCap ?? 100) - 10) return true;
      if (u.heal && s.hp < (u.healCap ?? 100) - 10) return true;
      if (u.overTime && s.hp + s.shield < 150) return true;
    }
    return false;
  }

  private thinkHeal() {
    const s = this.s;
    let bestSlot = -1;
    for (let i = 1; i < s.inv.slots.length; i++) {
      const it = s.inv.slots[i];
      if (!it) continue;
      const u = ITEM_BY_CODE[it.code].use;
      if (!u) continue;
      if ((u.shield && s.shield < (u.shieldCap ?? 100) - 10) || (u.heal && s.hp < (u.healCap ?? 100) - 10) || u.overTime) {
        bestSlot = i;
        break;
      }
    }
    if (bestSlot < 0) return;
    this.healing = true;
    if (s.slot !== bestSlot) this.slot = bestSlot;
    else this.hold |= BTN.FIRE;
  }

  private chooseWeaponSlot(dist: number): number {
    const inv = this.s.inv;
    let best = 0;
    let bestScore = -1;
    for (let i = 1; i < inv.slots.length; i++) {
      const it = inv.slots[i];
      if (!it) continue;
      const w = ITEM_BY_CODE[it.code].weapon;
      if (!w) continue;
      if (w.ammo && it.mag === 0 && inv.ammo[ammoIndex(w.ammo)] === 0) continue;
      let score = 1 + it.rarity * 0.2;
      switch (w.cls) {
        case 'shotgun': score += dist < 9 ? 5 : dist < 16 ? 2 : -2; break;
        case 'smg': score += dist < 22 ? 3.5 : dist < 40 ? 1.5 : -1; break;
        case 'ar': score += dist < 90 ? 3 : 1.5; break;
        case 'sniper': score += dist > 55 ? 4.5 : dist > 25 ? 1 : -2; break;
        case 'pistol': score += dist < 40 ? 1.5 : 0.5; break;
        case 'explosive': score += dist > 12 && dist < 60 ? 2.5 : -3; break;
        case 'melee': score += dist < 2.5 ? 2 : -5; break;
      }
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  private thinkFight() {
    const m = this.m;
    const s = this.s;
    const e = this.enemy!;
    if (!e.alive) {
      this.enemy = null;
      return;
    }
    const visible = m.time - this.enemySeenAt < 0.4;
    const ex = visible ? e.sim.x : this.enemyLast.x;
    const ez = visible ? e.sim.z : this.enemyLast.z;
    const ey = visible ? e.sim.y : this.enemyLast.y;
    const dist = Math.hypot(ex - s.x, ez - s.z);
    this.trackT += 0.2;

    // weapon
    const want = this.chooseWeaponSlot(dist);
    if (want !== s.slot && !this.healing) this.slot = want;
    const it = s.inv.slots[s.slot];
    const w = it ? ITEM_BY_CODE[it.code].weapon : undefined;
    this.healing = false;

    // aim with human-like error that shrinks while tracking
    if (this.aimErrT <= 0) {
      this.aimErrT = 0.35 + this.rng.range(0, 0.3);
      const base = (1.15 - this.skill) * 0.11 / (1 + this.trackT * 0.6);
      this.aimErrY = this.rng.gauss() * base;
      this.aimErrP = this.rng.gauss() * base * 0.6;
    }
    const aimHead = this.skill > 0.6 && dist < 40 && this.rng.chance(0.3);
    const ty = ey + (e.downed ? 0.35 : aimHead ? 1.6 : e.sim.crouch ? 0.8 : 1.15);
    const eyeY = s.y + (s.crouch ? 1.05 : 1.6);
    const dx = ex - s.x, dz = ez - s.z;
    // lead moving targets; ballistic weapons also compensate for travel time and bullet drop
    let lx: number, lz: number, drop = 0;
    if (w?.ballistic) {
      const t = dist / w.ballistic.speed;
      const k = 0.6 + this.skill * 0.4; // weaker bots under-lead
      lx = dx + e.sim.vx * t * k;
      lz = dz + e.sim.vz * t * k;
      drop = 0.5 * w.ballistic.gravity * t * t * k;
    } else {
      lx = dx + e.sim.vx * 0.004 * dist;
      lz = dz + e.sim.vz * 0.004 * dist;
    }
    this.wantYaw = Math.atan2(-lx, -lz) + this.aimErrY;
    this.wantPitch = Math.atan2(ty + drop - eyeY, Math.max(0.5, dist)) + this.aimErrP;
    const yawErr = Math.abs(wrapAngle(this.wantYaw - this.aimErrY - this.yaw));
    const tol = Math.atan2(0.7, Math.max(1, dist)) + 0.03;

    // fire
    if (w && visible && yawErr < tol + (w.cls === 'shotgun' ? 0.08 : 0)) {
      const inRange = w.cls === 'melee' ? dist < 2.6 : w.cls === 'shotgun' ? dist < 30 : w.cls === 'smg' ? dist < 60 : true;
      if (inRange && m.time >= this.enemySeenAt) {
        this.hold |= BTN.FIRE;
        if ((w.cls === 'sniper' || w.cls === 'ar') && dist > 30) this.hold |= BTN.ADS;
      }
    }

    // grenade
    if (this.nadeCd <= 0 && dist > 8 && dist < 26 && visible && this.rng.chance(0.08)) {
      const ni = s.inv.slots.findIndex((x) => x && ITEM_BY_CODE[x.code].id === 'popper');
      if (ni > 0) {
        this.slot = ni;
        this.nadeCd = 6;
        this.pulse |= BTN.FIRE;
        this.wantPitch += 0.25;
      }
    }

    // movement: strafe and hold preferred range
    const pref = !w ? 5 : w.cls === 'shotgun' ? 5 : w.cls === 'smg' ? 12 : w.cls === 'sniper' ? 70 : w.cls === 'melee' ? 1.5 : 30;
    if (this.strafeT <= 0) {
      this.strafeT = this.rng.range(0.4, 1.3);
      this.strafe = this.rng.chance(0.5) ? 1 : -1;
      if (this.rng.chance(0.18 * this.skill + 0.05)) this.pulse |= BTN.JUMP;
    }
    this.mx = this.strafe * (0.6 + this.skill * 0.4);
    this.mz = dist > pref + 6 ? 1 : dist < pref - 4 ? -0.8 : 0;
    if (!visible) {
      this.mz = 1;
      this.mx = 0;
    }
    if (!w) {
      // unarmed: run away toward loot
      this.mz = -1;
    }

    // build cover when taking damage
    const mats = s.inv.mats;
    const mat = mats[1] >= BUILD_COST ? 1 : mats[0] >= BUILD_COST ? 0 : mats[2] >= BUILD_COST ? 2 : -1;
    if (mat >= 0 && this.buildCd <= 0 && m.time - this.hurtAt < 0.6 && this.rng.chance(0.25 + this.skill * 0.5) && s.grounded) {
      const yawTo = Math.atan2(-dx, -dz);
      const spec = buildTarget('wall', s.x, s.y, s.z, yawTo, 0, m.grid);
      this.act({ a: 'build', type: spec.type, i: spec.i, j: spec.j, k: spec.k, d: spec.d, mat });
      if (this.skill > 0.55 && this.rng.chance(0.5)) {
        const r = buildTarget('ramp', s.x, s.y, s.z, yawTo, 0, m.grid);
        this.act({ a: 'build', type: r.type, i: r.i, j: r.j, k: r.k, d: r.d, mat });
      }
      this.buildCd = 1.8 - this.skill;
    }
  }
}
