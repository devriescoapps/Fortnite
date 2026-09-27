// Authoritative match: lifecycle (lobby -> transport -> play -> ended), input processing,
// combat with lag compensation, loot, building, storm, vehicles, projectiles, rebirth,
// spectating and replication with interest management.
import { randomBytes } from 'node:crypto';
import { ByteWriter } from '../shared/binary';
import {
  BUILD_MATS, BuildGrid, MATERIALS, Piece, PieceSpec, PieceType, WallVariant, inBuildRange, isPieceGrounded, pieceCenter, slotKey,
} from '../shared/build';
import { CollisionWorld, OwnerKind, Shape } from '../shared/collision';
import {
  BUILD_COST, BUILD_INTERVAL, DOWNED_BLEED, DOWNED_HEALTH, GRID, INPUT_DT, INTERACT_RANGE, MATCH_DEFAULTS, MAX_HEALTH, MAX_MATERIAL,
  MAX_SHIELD, MOVE, Mode as GameMode, PICKUP_RANGE, REVIVE_HEALTH, REVIVE_TIME, SKYPORT, TEAM_SIZE, TICK_DT, TICK_RATE, WATER_LEVEL,
} from '../shared/constants';
import {
  AMMO_MAX, AMMO_TYPES, HARVEST_TOOL, ITEM_BY_CODE, ITEM_BY_ID, ItemStack, ProjectileSpec, damageFalloff, makeStack, weaponDamage,
} from '../shared/items';
import { MapData, PROP_TYPES, buildWorld } from '../shared/mapdata';
import { rayAABB, raySphere } from '../shared/math';
import { nearestPoi } from '../shared/pois';
import {
  ContainerInfo, EF_ADS, EF_BUILDING, EF_CROUCH, EF_GROUNDED, EF_RELOAD, EF_SLIDE, EF_SPRINT, EF_USING, EntSnap, GroundItemInfo,
  MatchInit, MatchPhase, PieceInfo, PlayerInfo, ProjSnap, VehSnap, encodeSnapshot, quantizeSim, Action,
} from '../shared/protocol';
import { EMOTE_IDS } from '../shared/progression';
import { RNG } from '../shared/rng';
import { BTN, InputCmd, Mode, SimEvent, createSim, emptyInventory, eyeHeight, stepSim } from '../shared/sim';
import { STORM_INITIAL_RADIUS, STORM_PHASES, StormState, initialStorm, stormCircleAt } from '../shared/storm';
import { NO_GROUND, Terrain } from '../shared/terrain';
import { VEHICLES, VehicleHit, VehicleInput, VehicleState, seatWorldPos, stepVehicle } from '../shared/vehicle';
import { BotBrain, botName } from './bot';
import type { ServerConfig } from './config';
import { AMMO_DROP, rollAmmoBox, rollChestLoot, rollFloorLoot, rollSupplyDrop } from './loot';
import { ClientLink, ServerPlayer } from './player';
import type { Profile, ProfileStore } from './profiles';

export interface GroundItem extends GroundItemInfo {
  spawnT: number;
}

export interface Container extends ContainerInfo {
  tier: number;
}

interface Projectile {
  id: number;
  kind: 0 | 1 | 2; // rocket, grenade, smoke
  owner: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  fuse: number;
  life: number;
  spec: ProjectileSpec;
  code: number;
}

interface Pad {
  id: number;
  x: number;
  y: number;
  z: number;
}

export interface Island {
  terrain: Terrain;
  map: MapData;
}

export interface MatchOptions {
  mode: GameMode;
  cfg: ServerConfig;
  island: Island;
  profiles: ProfileStore | null;
  seed?: number;
  allowBotOnly?: boolean;
}

export interface JoinRequest {
  link: ClientLink | null;
  profile: Profile | null;
  name: string;
  cos: PlayerInfo['cos'];
  level: number;
}

const FEED_CAUSES: Record<string, string> = {
  storm: 'the Surge', fall: 'a long fall', void: 'the void', disconnect: 'disconnect', left: 'leaving', bleed: 'bleeding out', vehicle: 'a Rover',
};

export class Match {
  readonly id = randomBytes(4).toString('hex');
  readonly mode: GameMode;
  readonly teamSize: number;
  readonly cfg: ServerConfig;
  readonly terrain: Terrain;
  readonly map: MapData;
  readonly world: CollisionWorld;
  readonly grid: BuildGrid;
  readonly rng: RNG;
  readonly seed: number;
  private propColliders: Map<number, number>;
  private propHp = new Map<number, number>();
  private removedProps: number[] = [];
  private removedMapPieces = new Set<number>();
  private mapPieceMax: number;
  private building = new Set<number>();
  private damagedPieces = new Map<number, number>();

  players = new Map<number, ServerPlayer>();
  teams = new Map<number, ServerPlayer[]>();
  private nextPlayerId = 1;
  private nextTeamId = 0;
  phase: MatchPhase = 'lobby';
  phaseEnd: number;
  time = 0;
  tick = 0;
  items = new Map<number, GroundItem>();
  private nextItemId = 1;
  containers = new Map<number, Container>();
  private nextContainerId = 1;
  vehicles = new Map<number, VehicleState>();
  private vehicleInputs = new Map<number, VehicleInput>();
  private projectiles = new Map<number, Projectile>();
  private nextProjId = 1;
  pads = new Map<number, Pad>();
  private padList: Pad[] = [];
  private nextPadId = 1;
  spires: { id: number; x: number; y: number; z: number }[];
  storm: StormState = initialStorm();
  bus: MatchInit['bus'] = null;
  smokes: { x: number; y: number; z: number; r: number; until: number }[] = [];
  private placedTeams = new Set<number>();
  private lastElimTeam = -1;
  winnerTeam = -1;
  private endedAt = 0;
  closed = false;
  private writer = new ByteWriter(8192);
  private broadcastQ: { ev: unknown; x?: number; z?: number; r?: number; team?: number; except?: number }[] = [];
  private lastAlive = -1;
  profiles: ProfileStore | null;
  allowBotOnly: boolean;
  onClose: ((m: Match) => void) | null = null;
  totalTeamsAtStart = 0;

  constructor(opts: MatchOptions) {
    this.mode = opts.mode;
    this.teamSize = TEAM_SIZE[opts.mode];
    this.cfg = opts.cfg;
    this.terrain = opts.island.terrain;
    this.map = opts.island.map;
    this.profiles = opts.profiles;
    this.allowBotOnly = !!opts.allowBotOnly;
    this.seed = opts.seed ?? (Math.random() * 0x7fffffff) | 0;
    this.rng = new RNG(this.seed);
    const w = buildWorld(this.terrain, this.map);
    this.world = w.world;
    this.grid = w.grid;
    this.propColliders = w.propColliders;
    this.mapPieceMax = this.grid.allocId() - 1;
    this.phaseEnd = this.cfg.lobbyTime;
    this.spires = this.map.spires.map((s, i) => ({ id: i + 1, ...s }));
    for (const lp of this.map.launchPads) this.addPad(lp.x, lp.y, lp.z, false);
    this.spawnLoot();
    this.spawnVehicles();
  }

  // -------------------------------------------------------------------------
  // Players & teams
  // -------------------------------------------------------------------------

  get humans() {
    return [...this.players.values()].filter((p) => !p.isBot);
  }

  canJoin(n: number) {
    return this.phase === 'lobby' && this.time < this.phaseEnd - 4 && this.humans.length + n <= this.cfg.maxPlayers;
  }

  private newTeam(): number {
    const id = this.nextTeamId++;
    this.teams.set(id, []);
    return id;
  }

  private teamWithRoom(n: number, humansOnly: boolean): number {
    for (const [id, members] of this.teams) {
      if (members.length + n <= this.teamSize && (!humansOnly || members.some((m) => !m.isBot))) return id;
    }
    return -1;
  }

  /**
   * Add a party of humans to the same team. Bots are removed to make room. With `fill` (default)
   * a party may be merged into another human team that has open seats, like squad-fill queues.
   */
  addParty(reqs: JoinRequest[], fill = true): ServerPlayer[] {
    const n = reqs.length;
    let team = -1;
    // replace a bot-only team, else find room
    for (const [id, members] of this.teams) {
      if (members.length > 0 && members.every((m) => m.isBot) && this.teamSize >= n) {
        for (const b of [...members]) this.removePlayer(b);
        team = id;
        break;
      }
    }
    if (team < 0 && fill) team = this.teamWithRoom(n, true);
    if (team < 0) team = this.newTeam();
    const out: ServerPlayer[] = [];
    for (const r of reqs) {
      const p = new ServerPlayer(this.nextPlayerId++, r.name, team, r.cos, r.level, r.link, null);
      p.profile = r.profile;
      this.insertPlayer(p);
      out.push(p);
    }
    this.fillBots();
    for (const p of out) this.sendInit(p);
    return out;
  }

  private insertPlayer(p: ServerPlayer) {
    this.players.set(p.id, p);
    if (!this.teams.has(p.team)) this.teams.set(p.team, []);
    this.teams.get(p.team)!.push(p);
    this.spawnInLobby(p);
    this.broadcast({ e: 'join', player: this.info(p) }, { except: p.id });
  }

  addBot(team?: number) {
    const t = team ?? (this.teamWithRoom(1, false) >= 0 ? this.teamWithRoom(1, false) : this.newTeam());
    const skill = Math.max(0.05, Math.min(0.98, this.cfg.botSkill + this.rng.range(-0.3, 0.3)));
    const p = new ServerPlayer(this.nextPlayerId++, botName(this.rng), t, randomLoadout(this.rng), this.rng.int(1, 60), null, null);
    p.bot = new BotBrain(this, p, new RNG(this.rng.int(1, 1e9)), skill);
    this.insertPlayer(p);
    return p;
  }

  fillBots() {
    if (!this.cfg.fillBots && !this.allowBotOnly) return;
    while (this.players.size > this.cfg.maxPlayers) {
      const bots = [...this.players.values()].filter((p) => p.isBot);
      if (!bots.length) break;
      // prefer removing from bot-only teams
      const b = bots.find((x) => this.teams.get(x.team)!.every((m) => m.isBot)) ?? bots[bots.length - 1];
      this.removePlayer(b);
    }
    while (this.players.size < this.cfg.maxPlayers) {
      // top up human teams first, then bot teams
      let t = this.teamWithRoom(1, true);
      if (t < 0) t = this.teamWithRoom(1, false);
      this.addBot(t >= 0 ? t : undefined);
    }
  }

  removePlayer(p: ServerPlayer) {
    this.players.delete(p.id);
    const t = this.teams.get(p.team);
    if (t) {
      const i = t.indexOf(p);
      if (i >= 0) t.splice(i, 1);
      if (t.length === 0) this.teams.delete(p.team);
    }
    this.broadcast({ e: 'leave', id: p.id });
  }

  info(p: ServerPlayer): PlayerInfo {
    return { id: p.id, name: p.name, team: p.team, bot: p.isBot, cos: p.cos, level: p.level };
  }

  private spawnInLobby(p: ServerPlayer) {
    const S = SKYPORT;
    let x = 0, z = 0;
    for (let k = 0; k < 20; k++) {
      x = S.x + this.rng.range(-S.halfX + 3, S.halfX - 3);
      z = S.z + this.rng.range(-S.halfZ + 3, S.halfZ - 3);
      if (Math.abs(x - S.x) > 8 || Math.abs(z - S.z) > 8) break;
    }
    const inv = emptyInventory();
    inv.mats = [MAX_MATERIAL, MAX_MATERIAL, MAX_MATERIAL];
    p.sim = createSim(x, S.y + 0.5, z);
    p.sim.inv = inv;
    p.sim.hp = MAX_HEALTH;
    p.sim.yaw = this.rng.range(0, Math.PI * 2);
  }

  /** Called when a human's socket closes. */
  disconnect(p: ServerPlayer) {
    p.link = null;
    if (this.phase === 'lobby') {
      this.removePlayer(p);
      this.fillBots();
      return;
    }
    if (!p.eliminated) p.disconnectedAt = this.time;
  }

  /** A returning human (same profile) takes their character back. */
  reconnect(p: ServerPlayer, link: ClientLink) {
    p.link = link;
    p.disconnectedAt = null;
    p.queue.length = 0;
    this.sendInit(p);
  }

  /** Player chose to leave (back to menu). */
  leave(p: ServerPlayer) {
    if (this.phase === 'lobby') {
      this.removePlayer(p);
      this.fillBots();
      p.link = null;
      return;
    }
    if (!p.eliminated && this.phase !== 'ended') this.eliminate(p, null, 'left');
    if (!p.resultsSent) this.sendResults(p, true);
    p.leftMatch = true;
    p.link = null;
  }

  /** Development helpers (only reachable when DEV_COMMANDS=1). */
  dev(p: ServerPlayer, cmd: { cmd: string; x?: number; z?: number; id?: string; rarity?: number }) {
    const s = p.sim;
    if (cmd.cmd === 'teleport' && Number.isFinite(cmd.x) && Number.isFinite(cmd.z)) {
      const g = this.world.groundAt(cmd.x!, cmd.z!, 500, 0.4);
      s.x = cmd.x!;
      s.z = cmd.z!;
      s.y = (g === NO_GROUND ? this.terrain.surfaceAt(cmd.x!, cmd.z!) : g) + 0.3;
      s.vx = s.vy = s.vz = 0;
      s.mode = Mode.Walk;
      s.grounded = false;
      p.landed = true;
      quantizeSim(s);
    } else if (cmd.cmd === 'give' && cmd.id && ITEM_BY_ID[cmd.id]) {
      const def = ITEM_BY_ID[cmd.id];
      if (def.ammoType) s.inv.ammo[AMMO_TYPES.indexOf(def.ammoType)] += 60;
      else {
        const i = s.inv.slots.findIndex((x, k) => k > 0 && !x);
        if (i > 0) s.inv.slots[i] = makeStack(cmd.id, Math.max(0, Math.min(4, cmd.rarity ?? 2)), def.stack > 1 ? def.stack : 1);
      }
    }
  }

  findByProfile(profileId: string) {
    for (const p of this.players.values()) if (p.profile && p.profile.id === profileId && !p.leftMatch) return p;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // World setup
  // -------------------------------------------------------------------------

  private spawnLoot() {
    const rng = this.rng;
    for (const s of this.map.lootSpots) {
      if (!rng.chance(0.72)) continue;
      const stacks = rollFloorLoot(rng, s.tier);
      stacks.forEach((st, i) => this.spawnItem(st, s.x + i * 0.7, s.y, s.z + i * 0.3));
    }
    for (const c of this.map.chestSpots) {
      if (c.tier < 1.4 && !rng.chance(0.75)) continue;
      this.addContainer('chest', c.x, c.y, c.z, c.rot ?? 0, c.tier);
    }
    for (const a of this.map.ammoSpots) {
      if (!rng.chance(0.8)) continue;
      this.addContainer('ammo', a.x, a.y, a.z, 0, 1);
    }
  }

  private spawnVehicles() {
    const spots = [...this.map.vehicleSpots];
    this.rng.shuffle(spots);
    const n = Math.min(spots.length, 12);
    for (let i = 0; i < n; i++) {
      const s = spots[i];
      const y = this.terrain.surfaceAt(s.x, s.z);
      const v: VehicleState = { id: i + 1, type: 0, x: s.x, y: y + 0.2, z: s.z, yaw: s.yaw, pitch: 0, roll: 0, speed: 0, vy: 0, hp: VEHICLES[0].hp, seats: [0, 0, 0, 0], boost: 0 };
      this.vehicles.set(v.id, v);
    }
  }

  private addContainer(kind: Container['kind'], x: number, y: number, z: number, rot: number, tier: number, extra: Partial<Container> = {}) {
    const c: Container = { id: this.nextContainerId++, kind, x, y, z, rot, open: false, tier, ...extra };
    this.containers.set(c.id, c);
    return c;
  }

  spawnItem(st: ItemStack, x: number, y: number, z: number, owner?: number, from?: [number, number, number]) {
    const g = this.world.groundAt(x, z, y + 0.6, 0.2);
    const gy = g === NO_GROUND ? y : Math.max(g, Math.min(y, g + 0.5));
    const it: GroundItem = { id: this.nextItemId++, code: st.code, rarity: st.rarity, count: st.count, mag: st.mag, x, y: Math.max(gy, WATER_LEVEL - 0.3), z, spawnT: this.time };
    if (owner !== undefined) it.owner = owner;
    this.items.set(it.id, it);
    if (this.phase !== 'lobby' || this.tick > 0) this.broadcast({ e: 'i+', item: stripItem(it), from });
    return it;
  }

  private removeItem(id: number) {
    if (this.items.delete(id)) this.broadcast({ e: 'i-', id });
  }

  private addPad(x: number, y: number, z: number, announce = true) {
    const pad: Pad = { id: this.nextPadId++, x, y, z };
    this.pads.set(pad.id, pad);
    this.padList = [...this.pads.values()];
    if (announce) this.broadcast({ e: 'pad+', pad });
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  update() {
    if (this.closed) return;
    this.tick++;
    this.time += TICK_DT;
    switch (this.phase) {
      case 'lobby':
        if (this.time >= this.phaseEnd) this.startBus();
        break;
      case 'bus':
        this.updateBus();
        break;
      case 'ended':
        if (this.time >= this.endedAt + MATCH_DEFAULTS.endLinger) this.close();
        break;
    }
    this.processPlayers();
    this.updateVehicles();
    this.updateProjectiles();
    this.updateChannels();
    this.updateStorm();
    this.updateMisc();
    for (const p of this.players.values()) p.record(this.tick);
    this.sendSnapshots();
    this.flushEvents();
    if (!this.allowBotOnly && this.phase !== 'ended') {
      const anyHuman = this.humans.some((h) => !h.leftMatch && (h.connected || (h.disconnectedAt !== null && !h.eliminated)));
      if (!anyHuman) this.close();
    }
  }

  private processPlayers() {
    for (const p of this.players.values()) {
      if (p.bot && this.phase !== 'ended') p.bot.update(TICK_DT);
      p.inputBudget = Math.min(0.25, p.inputBudget + TICK_DT);
      if (p.queue.length > 150) p.queue.splice(0, p.queue.length - 150);
      while (p.queue.length) {
        const q = p.queue[0];
        if (q.kind === 'input') {
          // Inputs that replace idle filler steps are free (the filler already used their time slot);
          // everything else must fit the real-time budget, which prevents speed hacks.
          if (p.fillerDebt > 0) p.fillerDebt--;
          else {
            if (p.inputBudget < INPUT_DT - 1e-6) break;
            p.inputBudget -= INPUT_DT;
          }
          p.lastInputAt = this.time;
          this.processInput(p, q.cmd);
        } else {
          this.processAction(p, q.act);
        }
        p.queue.shift();
      }
      // A client that stops sending inputs keeps being simulated (gravity, storm) with idle input.
      if (!p.isBot && this.time - p.lastInputAt > 0.25 && !p.eliminated && p.queue.length === 0) {
        while (p.inputBudget >= INPUT_DT) {
          p.inputBudget -= INPUT_DT;
          if (p.fillerDebt < 600) p.fillerDebt++;
          const s = p.sim;
          this.processInput(p, { seq: p.lastSeq, mx: 0, mz: 0, yaw: s.yaw, pitch: s.pitch, buttons: 0, slot: 255, viewTick: this.tick }, true);
        }
      }
    }
  }

  private processInput(p: ServerPlayer, cmd: InputCmd, synthetic = false) {
    if (!synthetic) {
      p.lastSeq = cmd.seq;
      p.lastViewTick = cmd.viewTick;
    }
    if (p.eliminated || p.leftMatch) return;
    const s = p.sim;
    if (s.mode === Mode.Bus) {
      s.yaw = cmd.yaw;
      s.pitch = cmd.pitch;
      const pressed = cmd.buttons & ~s.prevButtons;
      s.prevButtons = cmd.buttons;
      if (pressed & BTN.JUMP && this.bus && this.time >= this.bus.t0 + MATCH_DEFAULTS.busDoorsOpen) this.exitBus(p);
      return;
    }
    if (s.mode === Mode.Vehicle) {
      s.yaw = cmd.yaw;
      s.pitch = cmd.pitch;
      s.prevButtons = cmd.buttons;
      if (p.seat === 0) this.vehicleInputs.set(p.vehicleId, { mx: cmd.mx, mz: cmd.mz, handbrake: (cmd.buttons & BTN.JUMP) !== 0 });
      return;
    }
    const ev: SimEvent[] = [];
    const px = s.x, pz = s.z;
    stepSim(s, cmd, INPUT_DT, { world: this.world, playerId: p.id, canAttack: this.phase === 'bus' || this.phase === 'play', pads: this.padList }, ev);
    quantizeSim(s);
    if (s.mode === Mode.Walk && this.phase !== 'lobby') p.stats.footDist += Math.hypot(s.x - px, s.z - pz);
    for (const e of ev) this.handleSimEvent(p, e, cmd);
  }

  private handleSimEvent(p: ServerPlayer, e: SimEvent, cmd: InputCmd) {
    switch (e.t) {
      case 'shot': this.fireHitscan(p, e, cmd.viewTick); break;
      case 'melee': this.doMelee(p, e, cmd.viewTick); break;
      case 'rocket': {
        const def = ITEM_BY_CODE[e.code];
        const spec = def.weapon!.projectile!;
        this.spawnProjectile(p, 0, spec, e.code, e.ox, e.oy, e.oz, e.dx * spec.speed, e.dy * spec.speed, e.dz * spec.speed);
        this.broadcast({ e: 'snd', k: 'rocket', p: p.id, x: e.ox, y: e.oy, z: e.oz }, { x: e.ox, z: e.oz, r: 300, except: p.id });
        break;
      }
      case 'throw': {
        const def = ITEM_BY_CODE[e.code];
        const spec = def.throwable!;
        this.spawnProjectile(p, spec.kind === 'smoke' ? 2 : 1, spec, e.code, e.ox, e.oy, e.oz, e.vx, e.vy, e.vz);
        this.broadcast({ e: 'swing', p: p.id, k: 'throw' }, { x: p.sim.x, z: p.sim.z, r: 200, except: p.id });
        break;
      }
      case 'utility': this.doUtility(p, e.code, e.x, e.y, e.z); break;
      case 'used': this.applyConsumable(p, e.code); break;
      case 'land': {
        if (e.speed > MOVE.fallDamageSpeed) this.applyDamage(p, (e.speed - MOVE.fallDamageSpeed) * MOVE.fallDamagePerMps, null, { cause: 'fall' });
        if (!p.landed && this.phase !== 'lobby') {
          p.landed = true;
          const np = nearestPoi(p.sim.x, p.sim.z);
          if (np.dist < np.poi.r + 40) p.stats.landedPoi = np.poi.id;
          p.bot?.onLanded();
        }
        break;
      }
      case 'void': this.eliminate(p, null, 'void'); break;
      case 'deploy': this.broadcast({ e: 'snd', k: 'deploy', p: p.id }, { x: p.sim.x, z: p.sim.z, r: 250, except: p.id }); break;
      case 'launch': this.broadcast({ e: 'snd', k: 'launch', p: p.id }, { x: p.sim.x, z: p.sim.z, r: 250, except: p.id }); break;
      case 'reload': this.broadcast({ e: 'snd', k: 'reload', p: p.id }, { x: p.sim.x, z: p.sim.z, r: 60, except: p.id }); break;
      default: break;
    }
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  private startBus() {
    this.phase = 'bus';
    // remove warm-up builds
    const ids: number[] = [];
    for (const pc of this.grid.pieces.values()) if (pc.owner !== 0) ids.push(pc.id);
    for (const id of ids) this.grid.remove(id);
    if (ids.length) this.broadcast({ e: 'p-', ids });
    this.building.clear();
    const a = this.rng.range(0, Math.PI * 2);
    const ox = this.rng.range(-140, 140), oz = this.rng.range(-140, 140);
    const dx = Math.cos(a), dz = Math.sin(a);
    const L = 760;
    const len = L * 2;
    this.bus = { x0: ox - dx * L, z0: oz - dz * L, x1: ox + dx * L, z1: oz + dz * L, t0: this.time, t1: this.time + len / MATCH_DEFAULTS.busSpeed };
    this.phaseEnd = this.bus.t1;
    this.totalTeamsAtStart = [...this.teams.values()].filter((t) => t.length > 0).length;
    for (const p of this.players.values()) {
      const s = createSim(this.bus.x0, MATCH_DEFAULTS.busAltitude, this.bus.z0);
      s.mode = Mode.Bus;
      s.hp = MAX_HEALTH;
      s.shield = 0;
      s.yaw = Math.atan2(-dx, -dz);
      p.sim = s;
      p.channel = null;
      p.landed = false;
      p.stats.timeAlive = 0;
      p.bot?.onBus();
    }
    this.broadcast({ e: 'phase', phase: this.phase, end: this.phaseEnd, bus: this.bus });
    this.broadcastAlive();
  }

  busPos() {
    const b = this.bus!;
    const t = Math.min(1, Math.max(0, (this.time - b.t0) / (b.t1 - b.t0)));
    return { x: b.x0 + (b.x1 - b.x0) * t, y: MATCH_DEFAULTS.busAltitude, z: b.z0 + (b.z1 - b.z0) * t, yaw: Math.atan2(-(b.x1 - b.x0), -(b.z1 - b.z0)) };
  }

  private updateBus() {
    const bp = this.busPos();
    for (const p of this.players.values()) {
      if (p.sim.mode !== Mode.Bus) continue;
      p.sim.x = bp.x;
      p.sim.y = bp.y - 2;
      p.sim.z = bp.z;
      p.sim.vx = p.sim.vy = p.sim.vz = 0;
    }
    if (this.time >= this.bus!.t1) {
      for (const p of this.players.values()) if (p.sim.mode === Mode.Bus && !p.eliminated) this.exitBus(p);
      this.startPlay();
    }
  }

  exitBus(p: ServerPlayer) {
    const bp = this.busPos();
    const b = this.bus!;
    const len = Math.hypot(b.x1 - b.x0, b.z1 - b.z0);
    const s = p.sim;
    s.mode = Mode.Skydive;
    s.x = bp.x + this.rng.range(-1.5, 1.5);
    s.y = bp.y - 4;
    s.z = bp.z + this.rng.range(-1.5, 1.5);
    s.vx = ((b.x1 - b.x0) / len) * 8;
    s.vz = ((b.z1 - b.z0) / len) * 8;
    s.vy = -5;
    s.grounded = false;
    quantizeSim(s);
    p.bot?.onExitBus();
  }

  private startPlay() {
    this.phase = 'play';
    const ph = STORM_PHASES[0];
    const from = { x: 0, z: 0, r: STORM_INITIAL_RADIUS };
    this.storm = { phase: 0, stage: 'wait', t0: this.time, t1: this.time + ph.wait * this.cfg.stormScale, from, to: this.nextCircle(from, ph.radius), dps: ph.dps };
    this.broadcast({ e: 'phase', phase: this.phase, end: 0 });
    this.broadcast({ e: 'storm', s: this.storm });
  }

  private nextCircle(from: { x: number; z: number; r: number }, r: number) {
    for (let k = 0; k < 60; k++) {
      const maxD = Math.max(0, Math.min(from.r - r, 560 - r)) * 0.95;
      const a = this.rng.range(0, Math.PI * 2);
      const d = Math.sqrt(this.rng.float()) * maxD;
      const x = from.x + Math.cos(a) * d, z = from.z + Math.sin(a) * d;
      if (this.terrain.isLand(x, z) && Math.abs(x) < 560 && Math.abs(z) < 560) return { x, z, r };
    }
    return { x: from.x, z: from.z, r };
  }

  private updateStorm() {
    const st = this.storm;
    if (st.stage === 'idle' || this.phase === 'ended') return;
    if (st.stage !== 'done' && this.time >= st.t1) {
      if (st.stage === 'wait') {
        st.stage = 'shrink';
        st.t0 = this.time;
        st.t1 = this.time + STORM_PHASES[st.phase].shrink * this.cfg.stormScale;
        if (st.phase <= 4) this.spawnSupplyDrop();
        this.broadcast({ e: 'msg', text: 'The Surge is closing in!', k: 'storm' });
      } else if (st.stage === 'shrink') {
        for (const p of this.players.values()) if (p.standing) p.stats.phasesSurvived++;
        st.phase++;
        st.from = { ...st.to };
        if (st.phase >= STORM_PHASES.length) {
          st.stage = 'done';
          st.dps = STORM_PHASES[STORM_PHASES.length - 1].dps * 1.5;
        } else {
          const ph = STORM_PHASES[st.phase];
          st.stage = 'wait';
          st.to = this.nextCircle(st.from, ph.radius);
          st.dps = ph.dps;
          st.t0 = this.time;
          st.t1 = this.time + ph.wait * this.cfg.stormScale;
          if (st.phase === MATCH_DEFAULTS.rebirthWindowPhase && this.teamSize > 1) this.broadcast({ e: 'msg', text: 'Rebirth Spires have gone dark.', k: 'info' });
        }
      }
      this.broadcast({ e: 'storm', s: st });
    }
    const c = stormCircleAt(st, this.time);
    for (const p of this.players.values()) {
      if (!p.alive || p.sim.mode === Mode.Bus) continue;
      const out = Math.hypot(p.sim.x - c.x, p.sim.z - c.z) > c.r;
      if (!out) {
        p.stormAccum = 0;
        continue;
      }
      p.stormAccum += TICK_DT;
      if (p.stormAccum >= 1) {
        p.stormAccum -= 1;
        this.applyDamage(p, st.dps, null, { cause: 'storm' });
      }
    }
  }

  private spawnSupplyDrop() {
    const to = this.storm.to;
    for (let k = 0; k < 30; k++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = Math.sqrt(this.rng.float()) * to.r * 0.8;
      const x = to.x + Math.cos(a) * d, z = to.z + Math.sin(a) * d;
      if (!this.terrain.isLand(x, z)) continue;
      const g = this.world.groundAt(x, z, 400, 0.5);
      const y = g === NO_GROUND ? this.terrain.surfaceAt(x, z) : g;
      const y0 = 190;
      const c = this.addContainer('supply', x, y, z, 0, 3, { land: this.time + (y0 - y) / 7, y0 });
      this.broadcast({ e: 'c+', c: stripContainer(c) });
      this.broadcast({ e: 'msg', text: 'A supply drop is falling!', k: 'supply' });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  private hitbox(mode: Mode, crouch: boolean) {
    if (mode === Mode.Downed) return { bottom: 0, top: 0.55, head: 0.5, r: 0.5 };
    if (mode === Mode.Swim) return { bottom: 0.9, top: 1.45, head: 1.62, r: 0.45 };
    if (crouch) return { bottom: 0, top: 0.95, head: 1.1, r: 0.45 };
    return { bottom: 0, top: 1.45, head: 1.62, r: 0.45 };
  }

  /** Lag-compensated ray vs player hitboxes. */
  rayPlayers(shooter: ServerPlayer | null, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, viewTick: number) {
    let best: { p: ServerPlayer; t: number; head: boolean } | null = null;
    const nowTick = this.tick - 1;
    for (const q of this.players.values()) {
      if (q === shooter || !q.alive || q.sim.mode === Mode.Bus || q.sim.mode === Mode.Dead) continue;
      if (shooter && q.team === shooter.team) continue;
      const pos = q.posAt(viewTick, nowTick);
      // quick reject by distance from ray
      const cx = pos.x - ox, cy = pos.y + 1 - oy, cz = pos.z - oz;
      const along = cx * dx + cy * dy + cz * dz;
      if (along < -2 || along > maxT + 2) continue;
      const px = cx - dx * along, py = cy - dy * along, pz = cz - dz * along;
      if (px * px + py * py + pz * pz > 9) continue;
      const hb = this.hitbox(pos.mode, pos.crouch);
      const lim = best ? best.t : maxT;
      const th = raySphere(ox, oy, oz, dx, dy, dz, pos.x, pos.y + hb.head, pos.z, 0.3, lim);
      const tb = rayAABB(ox, oy, oz, dx, dy, dz, pos.x - hb.r, pos.y + hb.bottom, pos.z - hb.r, pos.x + hb.r, pos.y + hb.top, pos.z + hb.r, lim);
      let t = -1, head = false;
      if (th >= 0 && (tb < 0 || th <= tb + 0.25)) {
        t = th;
        head = true;
      } else if (tb >= 0) t = tb;
      if (t >= 0 && (!best || t < best.t)) best = { p: q, t, head };
    }
    return best;
  }

  private rayVehicles(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number) {
    let best: { v: VehicleState; t: number } | null = null;
    for (const v of this.vehicles.values()) {
      const t = rayAABB(ox, oy, oz, dx, dy, dz, v.x - 1.4, v.y + 0.2, v.z - 1.4, v.x + 1.4, v.y + 1.7, v.z + 1.4, best ? best.t : maxT);
      if (t >= 0) best = { v, t };
    }
    return best;
  }

  private fireHitscan(p: ServerPlayer, e: Extract<SimEvent, { t: 'shot' }>, viewTick: number) {
    const def = ITEM_BY_CODE[e.code];
    const w = def.weapon!;
    const hits: number[][] = [];
    const perTarget = new Map<ServerPlayer, { dmg: number; head: boolean; x: number; y: number; z: number }>();
    for (let k = 0; k < e.dirs.length; k += 3) {
      const dx = e.dirs[k], dy = e.dirs[k + 1], dz = e.dirs[k + 2];
      const wh = this.world.raycast(e.ox, e.oy, e.oz, dx, dy, dz, w.range);
      const maxT = wh ? wh.t : w.range;
      const ph = this.rayPlayers(p, e.ox, e.oy, e.oz, dx, dy, dz, maxT, viewTick);
      const vh = this.rayVehicles(e.ox, e.oy, e.oz, dx, dy, dz, ph ? ph.t : maxT);
      if (vh && (!ph || vh.t < ph.t)) {
        const dmg = weaponDamage(w, e.rarity) * damageFalloff(w, vh.t);
        this.damageVehicle(vh.v, dmg, p);
        hits.push([e.ox + dx * vh.t, e.oy + dy * vh.t, e.oz + dz * vh.t, 0]);
        continue;
      }
      if (ph) {
        let dmg = weaponDamage(w, e.rarity) * damageFalloff(w, ph.t);
        if (ph.head) dmg *= w.headMult;
        const hx = e.ox + dx * ph.t, hy = e.oy + dy * ph.t, hz = e.oz + dz * ph.t;
        const agg = perTarget.get(ph.p);
        if (agg) {
          agg.dmg += dmg;
          agg.head ||= ph.head;
        } else perTarget.set(ph.p, { dmg, head: ph.head, x: hx, y: hy, z: hz });
        hits.push([hx, hy, hz, ph.head ? 2 : 1]);
      } else if (wh) {
        if (wh.collider) this.damageCollider(wh.collider.ownerKind, wh.collider.ownerId, weaponDamage(w, e.rarity) * w.structureMult, p, false);
        hits.push([wh.x, wh.y, wh.z, 0]);
      } else {
        const r = Math.min(w.range, 250);
        hits.push([e.ox + dx * r, e.oy + dy * r, e.oz + dz * r, 3]);
      }
    }
    for (const [q, a] of perTarget) {
      if (a.head) p.stats.headshots++;
      this.applyDamage(q, a.dmg, p, { head: a.head, code: e.code, x: a.x, y: a.y, z: a.z, cause: 'weapon' });
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    this.broadcast(
      { e: 'shot', p: p.id, c: e.code, o: [round(e.ox), round(e.oy), round(e.oz)], h: hits.map((h) => [round(h[0]), round(h[1]), round(h[2]), h[3]]) },
      { x: e.ox, z: e.oz, r: 400, except: p.id },
    );
  }

  private doMelee(p: ServerPlayer, e: Extract<SimEvent, { t: 'melee' }>, viewTick: number) {
    const w = ITEM_BY_CODE[e.code].weapon!;
    const range = w.meleeRange ?? 2.5;
    this.broadcast({ e: 'swing', p: p.id, k: 'melee' }, { x: p.sim.x, z: p.sim.z, r: 120, except: p.id });
    // generous melee: test a few rays in a small cone
    const offsets = [[0, 0], [0.12, 0], [-0.12, 0], [0, -0.15]];
    for (const [ox, oy] of offsets) {
      const dx = e.dx + ox * Math.cos(p.sim.yaw), dy = e.dy + oy, dz = e.dz - ox * Math.sin(p.sim.yaw);
      const l = Math.hypot(dx, dy, dz);
      const ph = this.rayPlayers(p, e.ox, e.oy, e.oz, dx / l, dy / l, dz / l, range + 0.4, viewTick);
      if (ph) {
        const dmg = weaponDamage(w, e.rarity) * (ph.head ? 1.25 : 1);
        this.applyDamage(ph.p, dmg, p, { head: ph.head, code: e.code, cause: 'weapon', x: e.ox + (dx / l) * ph.t, y: e.oy + (dy / l) * ph.t, z: e.oz + (dz / l) * ph.t });
        if (w.knockback && ph.p.standing && ph.p.sim.mode === Mode.Walk) {
          const s = ph.p.sim;
          s.vx += (dx / l) * w.knockback;
          s.vz += (dz / l) * w.knockback;
          s.vy = 8;
          s.grounded = false;
        }
        return;
      }
    }
    const wh = this.world.raycast(e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, range);
    if (wh && wh.collider) {
      const dmg = weaponDamage(w, e.rarity) * w.structureMult;
      this.damageCollider(wh.collider.ownerKind, wh.collider.ownerId, dmg, p, e.code === HARVEST_TOOL.code);
      this.broadcast({ e: 'fx', k: 'harvest', x: wh.x, y: wh.y, z: wh.z }, { x: wh.x, z: wh.z, r: 120 });
    }
  }

  /** Damage whatever a collider belongs to: build piece or harvestable prop. */
  private damageCollider(kind: OwnerKind, id: number, dmg: number, attacker: ServerPlayer | null, harvest: boolean) {
    if (kind === OwnerKind.Piece) {
      const pc = this.grid.get(id);
      if (!pc) return;
      const md = MATERIALS[pc.mat];
      if (harvest && attacker && md.harvest && pc.owner === 0) this.giveMaterial(attacker, md.harvest, md.harvestPerHit);
      this.damagePiece(pc, dmg);
    } else if (kind === OwnerKind.Prop) {
      const prop = this.map.props[id];
      const T = PROP_TYPES[prop.t];
      if (T.hp <= 0) return;
      let hp = this.propHp.get(id) ?? Math.round(T.hp * prop.s);
      if (harvest && attacker && T.harvest) this.giveMaterial(attacker, T.harvest, Math.round(T.perHit * (0.8 + prop.s * 0.3)));
      hp -= dmg;
      if (hp <= 0) {
        const cid = this.propColliders.get(id);
        if (cid !== undefined) this.world.remove(cid);
        this.propColliders.delete(id);
        this.removedProps.push(id);
        this.propHp.delete(id);
        this.broadcast({ e: 'prop-', id });
      } else {
        this.propHp.set(id, hp);
        this.broadcast({ e: 'prophit', id }, { x: prop.x, z: prop.z, r: 150 });
      }
    }
  }

  private giveMaterial(p: ServerPlayer, mat: string, n: number) {
    const i = BUILD_MATS.indexOf(mat as never);
    if (i < 0 || this.phase === 'lobby') return;
    const before = p.sim.inv.mats[i];
    p.sim.inv.mats[i] = Math.min(MAX_MATERIAL, before + n);
    const got = p.sim.inv.mats[i] - before;
    if (got > 0) {
      p.stats.harvested += got;
      p.send({ e: 'harv', m: i, n: got });
    }
  }

  damagePiece(pc: Piece, dmg: number) {
    if (MATERIALS[pc.mat].indestructible) return;
    pc.hp -= dmg;
    if (pc.hp <= 0) this.destroyPieces([pc.id]);
    else {
      this.damagedPieces.set(pc.id, pc.hp);
    }
  }

  destroyPieces(ids: number[]) {
    const removed: number[] = [];
    const neighbors = new Set<number>();
    for (const id of ids) {
      const pc = this.grid.get(id);
      if (!pc) continue;
      for (const n of this.grid.neighbors(pc, id)) neighbors.add(n);
      this.grid.remove(id);
      this.building.delete(id);
      this.damagedPieces.delete(id);
      removed.push(id);
      if (id <= this.mapPieceMax) this.removedMapPieces.add(id);
    }
    for (const id of removed) neighbors.delete(id);
    const doomed = this.grid.findUnsupported(neighbors);
    for (const id of doomed) {
      this.grid.remove(id);
      this.building.delete(id);
      this.damagedPieces.delete(id);
      removed.push(id);
      if (id <= this.mapPieceMax) this.removedMapPieces.add(id);
    }
    if (removed.length) this.broadcast({ e: 'p-', ids: removed });
  }

  applyDamage(
    target: ServerPlayer,
    amount: number,
    attacker: ServerPlayer | null,
    info: { cause: 'weapon' | 'explosion' | 'storm' | 'fall' | 'vehicle'; head?: boolean; code?: number; x?: number; y?: number; z?: number },
  ): number {
    if (!target.alive || amount <= 0) return 0;
    if (this.phase === 'lobby' || this.phase === 'ended') return 0;
    const s = target.sim;
    if (s.mode === Mode.Bus) return 0;
    if (attacker && attacker !== target && attacker.team === target.team) return 0;
    if (attacker === target && info.cause !== 'fall') return 0;
    let dealt = 0;
    let shieldDealt = 0;
    if (target.downed) {
      dealt = Math.min(target.downedHp, amount);
      target.downedHp -= amount;
    } else {
      let a = amount;
      if (info.cause !== 'storm' && info.cause !== 'fall') {
        shieldDealt = Math.min(s.shield, a);
        s.shield -= shieldDealt;
        a -= shieldDealt;
      }
      dealt = Math.min(s.hp, a);
      s.hp -= a;
    }
    target.lastDamagedAt = this.time;
    if (attacker && attacker !== target) {
      target.lastAttacker = attacker.id;
      attacker.stats.damage += dealt + shieldDealt;
      attacker.send({
        e: 'hit', t: target.id, d: Math.round(dealt + shieldDealt), sh: shieldDealt > 0 && dealt === 0 ? 1 : 0, h: info.head ? 1 : 0,
        x: info.x ?? s.x, y: info.y ?? s.y + 1.5, z: info.z ?? s.z,
      });
    }
    target.stats.damageTaken += dealt + shieldDealt;
    target.send({ e: 'hurt', x: attacker ? attacker.sim.x : NaN, z: attacker ? attacker.sim.z : NaN, d: Math.round(dealt + shieldDealt), c: info.cause });
    target.bot?.onDamaged(attacker);
    if (target.downed) {
      if (target.downedHp <= 0) this.eliminate(target, attacker ?? this.players.get(target.knockedBy) ?? null, info.cause === 'storm' ? 'storm' : 'bleed', info.code, info.head);
    } else if (s.hp <= 0.001) {
      s.hp = 0;
      const team = this.teams.get(target.team) ?? [];
      const standingMates = team.some((m) => m !== target && m.standing);
      if (this.teamSize > 1 && standingMates && info.cause !== 'fall') this.knockDown(target, attacker, info.code, info.head);
      else this.eliminate(target, attacker, info.cause === 'weapon' || info.cause === 'explosion' ? undefined : info.cause, info.code, info.head);
    }
    return dealt + shieldDealt;
  }

  private knockDown(p: ServerPlayer, by: ServerPlayer | null, code?: number, head?: boolean) {
    p.downed = true;
    p.downedHp = DOWNED_HEALTH;
    p.knockedBy = by?.id ?? 0;
    this.exitVehicle(p);
    const s = p.sim;
    s.mode = Mode.Downed;
    s.crouch = false;
    s.slideT = 0;
    s.useT = -1;
    s.reloadT = 0;
    s.emote = 0;
    s.hp = 0;
    p.channel = null;
    this.broadcast({ e: 'feed', k: by?.name ?? '', v: p.name, w: code ?? -1, h: head ? 1 : 0, kn: 1, kt: by?.team ?? -1, vt: p.team, ki: by?.id ?? 0, vi: p.id });
  }

  eliminate(p: ServerPlayer, killer: ServerPlayer | null, cause?: string, code?: number, head?: boolean) {
    if (p.eliminated) return;
    p.alive = false;
    p.downed = false;
    p.eliminated = true;
    p.eliminatedAt = this.time;
    p.channel = null;
    this.exitVehicle(p);
    const s = p.sim;
    const dx = s.x, dy = s.y, dz = s.z;
    s.mode = Mode.Dead;
    s.hp = 0;
    s.shield = 0;
    if (this.phase !== 'lobby') p.stats.timeAlive = this.time - (this.bus?.t0 ?? 0);
    this.dropAll(p, dx, dy, dz);
    if (this.teamSize > 1 && this.storm.phase < MATCH_DEFAULTS.rebirthWindowPhase) {
      const team = this.teams.get(p.team) ?? [];
      if (team.some((m) => m.standing)) {
        this.spawnItem(makeStack('chip', 4, 1), dx, dy + 0.3, dz, p.id);
      }
    }
    if (killer && killer !== p) {
      killer.stats.kills++;
      const w = code !== undefined ? ITEM_BY_CODE[code]?.weapon : undefined;
      if (w) killer.stats.classKills[w.cls] = (killer.stats.classKills[w.cls] ?? 0) + 1;
      killer.send({ e: 'elimd', v: p.name });
    }
    const causeText = !killer && cause ? FEED_CAUSES[cause] ?? cause : '';
    this.broadcast({ e: 'feed', k: killer?.name ?? causeText, v: p.name, w: code ?? -1, h: head ? 1 : 0, kn: 0, kt: killer?.team ?? -1, vt: p.team, ki: killer?.id ?? 0, vi: p.id });
    p.send({ e: 'elim', by: killer?.name ?? causeText });
    // spectating
    const target = killer && killer.standing ? killer : this.pickSpectateTarget(p, 1);
    p.spectating = target?.id ?? 0;
    p.send({ e: 'spec', id: p.spectating });
    for (const q of this.players.values()) {
      if (q.eliminated && q.spectating === p.id && q !== p) {
        const t = killer && killer.standing ? killer : this.pickSpectateTarget(q, 1);
        q.spectating = t?.id ?? 0;
        q.send({ e: 'spec', id: q.spectating });
      }
    }
    this.lastElimTeam = p.team;
    this.teamCheck(p.team);
    this.broadcastAlive();
  }

  private teamCheck(team: number) {
    const members = this.teams.get(team) ?? [];
    if (members.some((m) => m.standing)) return;
    for (const m of members) {
      if (m.alive && m.downed) this.eliminate(m, this.players.get(m.knockedBy) ?? null, 'bleed');
    }
    if (this.placedTeams.has(team)) return;
    this.placedTeams.add(team);
    if (this.phase === 'lobby') return;
    const placement = this.aliveTeams().length + 1;
    for (const m of members) {
      m.placement = placement;
      if (!m.resultsSent) this.sendResults(m);
    }
    this.checkWin();
  }

  aliveTeams(): number[] {
    const out: number[] = [];
    for (const [id, members] of this.teams) if (members.some((m) => m.standing)) out.push(id);
    return out;
  }

  private checkWin() {
    if (this.phase !== 'play' && this.phase !== 'bus') return;
    const alive = this.aliveTeams();
    if (alive.length > 1) return;
    const winner = alive.length === 1 ? alive[0] : this.lastElimTeam;
    this.winnerTeam = winner;
    this.phase = 'ended';
    this.endedAt = this.time;
    const members = this.teams.get(winner) ?? [];
    for (const m of members) {
      m.placement = 1;
      m.stats.won = true;
      if (m.alive) m.stats.timeAlive = this.time - (this.bus?.t0 ?? 0);
      m.resultsSent = false;
      this.sendResults(m);
    }
    this.placedTeams.add(winner);
    this.broadcast({ e: 'phase', phase: 'ended', end: this.endedAt + MATCH_DEFAULTS.endLinger, winner, names: members.map((m) => m.name) });
  }

  private sendResults(p: ServerPlayer, provisional = false) {
    if (p.resultsSent) return;
    p.resultsSent = true;
    if (p.isBot) return;
    if (provisional && !p.placement) p.placement = this.aliveTeams().length;
    p.stats.placement = p.placement;
    const total = Math.max(this.totalTeamsAtStart, this.teams.size);
    if (p.profile && this.profiles) {
      const res = this.profiles.applyMatch(p.profile, p.stats, total);
      if (p.link) p.send({ t: 'results', ...res });
    } else if (p.link) {
      p.send({ t: 'results', placement: p.placement, total, won: p.stats.won, kills: p.stats.kills, damage: Math.round(p.stats.damage), survived: Math.round(p.stats.timeAlive), xp: [], totalXp: 0, levelBefore: p.level, levelAfter: p.level, currency: 0, challengesDone: [], tierBefore: 1, tierAfter: 1 });
    }
  }

  private dropAll(p: ServerPlayer, x: number, y: number, z: number) {
    const inv = p.sim.inv;
    const drops: ItemStack[] = [];
    for (let i = 1; i < inv.slots.length; i++) {
      const it = inv.slots[i];
      if (it) drops.push(it);
      inv.slots[i] = null;
    }
    AMMO_TYPES.forEach((a, i) => {
      if (inv.ammo[i] > 0) drops.push(makeStack(`ammo_${a}`, 0, inv.ammo[i]));
      inv.ammo[i] = 0;
    });
    BUILD_MATS.forEach((m, i) => {
      if (inv.mats[i] > 0 && this.phase !== 'lobby') drops.push(makeStack(`mat_${m}`, 0, Math.min(inv.mats[i], 200)));
      inv.mats[i] = 0;
    });
    drops.forEach((st, i) => {
      const a = (i / Math.max(1, drops.length)) * Math.PI * 2;
      const r = 0.8 + (i % 2) * 0.6;
      this.spawnItem(st, x + Math.cos(a) * r, y + 0.5, z + Math.sin(a) * r, undefined, [x, y + 1, z]);
    });
    p.sim.slot = 0;
  }

  private pickSpectateTarget(viewer: ServerPlayer, dir: number): ServerPlayer | null {
    const list = [...this.players.values()].filter((q) => q.standing && q !== viewer);
    if (!list.length) return null;
    const mates = list.filter((q) => q.team === viewer.team);
    const pool = mates.length ? mates : list;
    const idx = pool.findIndex((q) => q.id === viewer.spectating);
    return pool[(idx + dir + pool.length) % pool.length] ?? pool[0];
  }

  // -------------------------------------------------------------------------
  // Projectiles & explosions
  // -------------------------------------------------------------------------

  private spawnProjectile(p: ServerPlayer, kind: 0 | 1 | 2, spec: ProjectileSpec, code: number, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const pr: Projectile = { id: this.nextProjId++, kind, owner: p.id, x, y, z, vx, vy, vz, fuse: spec.fuse, life: 0, spec, code };
    this.projectiles.set(pr.id, pr);
  }

  private updateProjectiles() {
    const sub = 2;
    const dt = TICK_DT / sub;
    for (const pr of [...this.projectiles.values()]) {
      for (let k = 0; k < sub && this.projectiles.has(pr.id); k++) this.stepProjectile(pr, dt);
    }
  }

  private stepProjectile(pr: Projectile, dt: number) {
    pr.life += dt;
    if (pr.kind !== 0) pr.vy -= pr.spec.gravity * dt;
    const sp = Math.hypot(pr.vx, pr.vy, pr.vz);
    const len = sp * dt;
    if (len > 1e-6) {
      const dx = pr.vx / sp, dy = pr.vy / sp, dz = pr.vz / sp;
      const wh = this.world.raycast(pr.x, pr.y, pr.z, dx, dy, dz, len);
      const owner = this.players.get(pr.owner) ?? null;
      if (pr.kind === 0) {
        const ph = this.rayPlayers(owner, pr.x, pr.y, pr.z, dx, dy, dz, wh ? wh.t : len, this.tick - 1);
        if (ph || wh) {
          const t = ph ? ph.t : wh!.t;
          this.explode(pr.x + dx * t, pr.y + dy * t, pr.z + dz * t, pr.spec, owner, pr.code);
          this.projectiles.delete(pr.id);
          return;
        }
      } else if (wh) {
        // bounce
        pr.x += dx * Math.max(0, wh.t - 0.05);
        pr.y += dy * Math.max(0, wh.t - 0.05);
        pr.z += dz * Math.max(0, wh.t - 0.05);
        let nx = 0, ny = 1, nz = 0;
        if (wh.collider && wh.collider.shape === Shape.Box) {
          const c = wh.collider;
          const d = [Math.abs(wh.x - c.minX), Math.abs(wh.x - c.maxX), Math.abs(wh.y - c.minY), Math.abs(wh.y - c.maxY), Math.abs(wh.z - c.minZ), Math.abs(wh.z - c.maxZ)];
          const m = d.indexOf(Math.min(...d));
          nx = m === 0 ? -1 : m === 1 ? 1 : 0;
          ny = m === 2 ? -1 : m === 3 ? 1 : 0;
          nz = m === 4 ? -1 : m === 5 ? 1 : 0;
        }
        const vn = pr.vx * nx + pr.vy * ny + pr.vz * nz;
        pr.vx = (pr.vx - 2 * vn * nx) * 0.45;
        pr.vy = (pr.vy - 2 * vn * ny) * 0.45;
        pr.vz = (pr.vz - 2 * vn * nz) * 0.45;
      } else {
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        pr.z += pr.vz * dt;
      }
      if (pr.kind === 0) {
        pr.x += pr.vx * dt;
        pr.y += pr.vy * dt;
        pr.z += pr.vz * dt;
      }
    }
    if (pr.y < -30 || pr.life > 8) {
      this.projectiles.delete(pr.id);
      return;
    }
    if (pr.kind !== 0) {
      pr.fuse -= dt;
      if (pr.fuse <= 0) {
        this.projectiles.delete(pr.id);
        if (pr.kind === 1) this.explode(pr.x, pr.y, pr.z, pr.spec, this.players.get(pr.owner) ?? null, pr.code);
        else {
          const sm = { x: pr.x, y: pr.y, z: pr.z, r: pr.spec.radius, until: this.time + 12 };
          this.smokes.push(sm);
          this.broadcast({ e: 'smoke', x: pr.x, y: pr.y, z: pr.z, r: pr.spec.radius, d: 12 });
        }
      }
    }
  }

  explode(x: number, y: number, z: number, spec: ProjectileSpec, owner: ServerPlayer | null, code: number) {
    this.broadcast({ e: 'boom', x, y, z, r: spec.radius });
    const r = spec.radius;
    for (const q of this.players.values()) {
      if (!q.alive || q.sim.mode === Mode.Bus) continue;
      const cx = q.sim.x, cy = q.sim.y + 0.9, cz = q.sim.z;
      const d = Math.hypot(cx - x, cy - y, cz - z);
      if (d > r + 0.5) continue;
      if (d > 0.5) {
        const los = this.world.raycast(x, y + 0.2, z, (cx - x) / d, (cy - y - 0.2) / d, (cz - z) / d, d - 0.4);
        if (los) continue;
      }
      const f = 1 - Math.min(1, d / (r + 0.5)) * 0.6;
      this.applyDamage(q, spec.damage * f, owner, { cause: 'explosion', code });
    }
    const list = this.world.queryXZ(x - r, z - r, x + r, z + r).slice();
    const done = new Set<string>();
    for (const c of list) {
      if (c.ownerKind === OwnerKind.Static) continue;
      const key = `${c.ownerKind}:${c.ownerId}`;
      if (done.has(key)) continue;
      done.add(key);
      const px = Math.max(c.minX, Math.min(x, c.maxX)), py = Math.max(c.minY, Math.min(y, c.maxY)), pz = Math.max(c.minZ, Math.min(z, c.maxZ));
      const d = Math.hypot(px - x, py - y, pz - z);
      if (d > r) continue;
      this.damageCollider(c.ownerKind, c.ownerId, spec.structure * (1 - (d / r) * 0.5), owner, false);
    }
    for (const v of this.vehicles.values()) {
      const d = Math.hypot(v.x - x, v.y + 0.8 - y, v.z - z);
      if (d < r + 1) this.damageVehicle(v, spec.damage * 2 * (1 - d / (r + 1)), owner);
    }
  }

  // -------------------------------------------------------------------------
  // Vehicles
  // -------------------------------------------------------------------------

  private updateVehicles() {
    for (const v of [...this.vehicles.values()]) {
      const driver = v.seats[0] ? this.players.get(v.seats[0]) : undefined;
      const inp = driver ? this.vehicleInputs.get(v.id) ?? null : null;
      const hits: VehicleHit[] = [];
      const ox = v.x, oz = v.z;
      stepVehicle(v, inp, TICK_DT, this.world, hits);
      const moved = Math.hypot(v.x - ox, v.z - oz);
      if (driver) driver.stats.vehicleDist += moved;
      for (const h of hits) {
        if (h.speed > 9) {
          this.damageCollider(h.colliderOwnerKind, h.ownerId, h.speed * 9, null, false);
          this.damageVehicle(v, h.speed * 1.5, null);
        }
      }
      const sp = Math.abs(v.speed);
      if (sp > 8) {
        for (const q of this.players.values()) {
          if (!q.alive || q.vehicleId === v.id || q.sim.mode === Mode.Bus || q.sim.mode === Mode.Vehicle) continue;
          if (driver && q.team === driver.team) continue;
          const d = Math.hypot(q.sim.x - v.x, q.sim.z - v.z);
          if (d < 1.9 && Math.abs(q.sim.y - v.y) < 2) {
            this.applyDamage(q, sp * 2.5, driver ?? null, { cause: 'vehicle' });
            const s = q.sim;
            const nx = (s.x - v.x) / (d || 1), nz = (s.z - v.z) / (d || 1);
            s.vx = nx * 10;
            s.vz = nz * 10;
            s.vy = 6;
            s.grounded = false;
          }
        }
      }
      for (let i = 0; i < v.seats.length; i++) {
        const q = v.seats[i] ? this.players.get(v.seats[i]) : undefined;
        if (!q) continue;
        const sp2 = seatWorldPos(v, i);
        q.sim.x = sp2.x;
        q.sim.y = sp2.y;
        q.sim.z = sp2.z;
        q.sim.vx = q.sim.vy = q.sim.vz = 0;
        quantizeSim(q.sim);
      }
    }
  }

  damageVehicle(v: VehicleState, dmg: number, by: ServerPlayer | null) {
    v.hp -= dmg;
    if (v.hp > 0) return;
    this.broadcast({ e: 'boom', x: v.x, y: v.y + 1, z: v.z, r: 6 });
    for (let i = 0; i < v.seats.length; i++) {
      const q = v.seats[i] ? this.players.get(v.seats[i]) : undefined;
      if (q) {
        this.exitVehicle(q);
        this.applyDamage(q, 30, by, { cause: 'explosion' });
      }
    }
    for (const q of this.players.values()) {
      if (!q.alive) continue;
      const d = Math.hypot(q.sim.x - v.x, q.sim.z - v.z);
      if (d < 6) this.applyDamage(q, 50 * (1 - d / 6), by, { cause: 'explosion' });
    }
    this.vehicles.delete(v.id);
    this.broadcast({ e: 'vboom', id: v.id });
  }

  private enterVehicle(p: ServerPlayer, v: VehicleState) {
    if (!p.standing || (p.sim.mode !== Mode.Walk && p.sim.mode !== Mode.Swim)) return;
    if (Math.hypot(p.sim.x - v.x, p.sim.z - v.z) > 4.5 || Math.abs(p.sim.y - v.y) > 3) return;
    const seat = v.seats.findIndex((s) => s === 0);
    if (seat < 0) return;
    v.seats[seat] = p.id;
    p.vehicleId = v.id;
    p.seat = seat;
    const s = p.sim;
    s.mode = Mode.Vehicle;
    s.crouch = false;
    s.sprint = false;
    s.ads = false;
    s.reloadT = 0;
    s.useT = -1;
    s.emote = 0;
    p.channel = null;
  }

  exitVehicle(p: ServerPlayer) {
    if (!p.vehicleId) return;
    const v = this.vehicles.get(p.vehicleId);
    if (v) {
      v.seats[p.seat] = 0;
      const side = p.seat % 2 === 0 ? -1 : 1;
      const rx = Math.cos(v.yaw) * side * 2.2, rz = -Math.sin(v.yaw) * side * 2.2;
      p.sim.x = v.x + rx;
      p.sim.z = v.z + rz;
      const g = this.world.groundAt(p.sim.x, p.sim.z, v.y + 3, 0.4);
      p.sim.y = g === NO_GROUND ? v.y + 1 : Math.max(g, v.y) + 0.2;
      this.vehicleInputs.delete(v.id);
    }
    p.vehicleId = 0;
    p.seat = 0;
    if (p.sim.mode === Mode.Vehicle) {
      p.sim.mode = Mode.Walk;
      p.sim.grounded = false;
      p.sim.vy = 0;
    }
    quantizeSim(p.sim);
  }

  // -------------------------------------------------------------------------
  // Actions (ordered with inputs)
  // -------------------------------------------------------------------------

  processAction(p: ServerPlayer, a: Action) {
    if (!a || typeof a !== 'object') return;
    if (a.a === 'spectate') {
      if (p.eliminated) {
        const t = this.pickSpectateTarget(p, a.dir === -1 ? -1 : 1);
        p.spectating = t?.id ?? 0;
        p.send({ e: 'spec', id: p.spectating });
      }
      return;
    }
    if (!p.alive || p.eliminated) return;
    switch (a.a) {
      case 'build': this.processBuild(p, a); break;
      case 'edit': this.processEdit(p, a.id); break;
      case 'pickup': this.pickup(p, a.id); break;
      case 'drop': this.dropSlot(p, a.slot); break;
      case 'dropAmmo': this.dropAmmo(p, a.ammo | 0, a.count | 0); break;
      case 'dropMat': this.dropMat(p, a.mat | 0, a.count | 0); break;
      case 'swap': this.swapSlots(p, a.from | 0, a.to | 0); break;
      case 'interact': this.startInteract(p, a.kind, a.id | 0); break;
      case 'exitVehicle': this.exitVehicle(p); break;
      case 'seat': {
        const v = this.vehicles.get(p.vehicleId);
        const seat = a.seat | 0;
        if (v && seat >= 0 && seat < v.seats.length && v.seats[seat] === 0) {
          v.seats[p.seat] = 0;
          v.seats[seat] = p.id;
          p.seat = seat;
        }
        break;
      }
      case 'emote': {
        const s = p.sim;
        if (!p.downed && s.mode === Mode.Walk && s.grounded && a.id >= 0 && a.id < EMOTE_IDS.length) s.emote = (a.id | 0) + 1;
        break;
      }
      case 'ping': {
        if (![a.x, a.y, a.z].every(Number.isFinite)) break;
        for (const m of this.teams.get(p.team) ?? []) m.send({ e: 'ping', x: a.x, y: a.y, z: a.z, from: p.id });
        break;
      }
    }
  }

  private processBuild(p: ServerPlayer, a: Extract<Action, { a: 'build' }>) {
    const s = p.sim;
    const fail = (why: string) => p.send({ e: 'bf', key: slotKey(a as PieceSpec), why });
    if (this.phase === 'bus' && s.mode === Mode.Bus) return fail('bus');
    if (this.phase === 'ended') return fail('ended');
    if (s.mode !== Mode.Walk || p.downed) return fail('state');
    if (!['wall', 'floor', 'ramp', 'roof'].includes(a.type)) return fail('type');
    if (![a.i, a.j, a.k, a.d, a.mat].every((v) => Number.isInteger(v))) return fail('bad');
    if (a.mat < 0 || a.mat > 2) return fail('mat');
    if (this.time - p.lastBuildAt < BUILD_INTERVAL - 0.025) return fail('rate');
    const spec: PieceSpec = { type: a.type as PieceType, i: a.i, j: a.j, k: a.k, d: a.d };
    if (!inBuildRange(spec, s.x, s.y + eyeHeight(s), s.z)) return fail('range');
    if (s.inv.mats[a.mat] < BUILD_COST) return fail('mats');
    const ok = this.grid.canPlace(spec, this.terrain);
    if (!ok.ok) return fail(ok.reason ?? 'invalid');
    s.inv.mats[a.mat] -= BUILD_COST;
    p.lastBuildAt = this.time;
    if (this.phase !== 'lobby') p.stats.builds++;
    this.addPlayerPiece(p, spec, a.mat, 0);
  }

  private addPlayerPiece(p: ServerPlayer, spec: PieceSpec, mat: number, variant: number, instant = false) {
    const md = MATERIALS[mat];
    const pc: Piece = {
      ...spec, id: this.grid.allocId(), variant, mat, hp: instant ? md.maxHp : Math.max(1, md.maxHp * 0.1), maxHp: md.maxHp,
      owner: p.id, team: p.team, anchored: false, grounded: isPieceGrounded(spec, this.terrain), tint: 0,
      buildStart: this.time, buildTime: instant ? 0.2 : md.buildTime, colliderIds: [],
    };
    this.grid.add(pc);
    if (!instant) this.building.add(pc.id);
    this.broadcast({ e: 'p+', p: pieceInfo(pc) });
    return pc;
  }

  private processEdit(p: ServerPlayer, id: number) {
    const pc = this.grid.get(id);
    if (!pc || pc.type !== 'wall' || pc.owner === 0) return;
    const owner = this.players.get(pc.owner);
    if (pc.owner !== p.id && (!owner || owner.team !== p.team)) return;
    const c = pieceCenter(pc);
    if (Math.hypot(c.x - p.sim.x, c.y - p.sim.y, c.z - p.sim.z) > 7) return;
    const next = pc.variant === WallVariant.Solid ? WallVariant.Door : pc.variant === WallVariant.Door ? WallVariant.Window : WallVariant.Solid;
    const copy = { ...pc, variant: next, colliderIds: [] };
    this.grid.remove(pc.id);
    this.grid.add(copy);
    if (this.building.has(pc.id)) this.building.add(copy.id);
    this.broadcast({ e: 'p+', p: pieceInfo(copy) });
  }

  /** Line of sight from a player's chest to a point (walls block looting through them). */
  hasLOS(p: ServerPlayer, x: number, y: number, z: number) {
    const ox = p.sim.x, oy = p.sim.y + 1.2, oz = p.sim.z;
    const dx = x - ox, dy = y - oy, dz = z - oz;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.9) return true;
    return !this.world.raycast(ox, oy, oz, dx / d, dy / d, dz / d, d - 0.35, undefined, true);
  }

  private pickup(p: ServerPlayer, id: number) {
    const it = this.items.get(id);
    const s = p.sim;
    if (!it || p.downed) return;
    if (s.mode !== Mode.Walk && s.mode !== Mode.Swim) return;
    if (Math.hypot(it.x - s.x, it.y - (s.y + 0.5), it.z - s.z) > PICKUP_RANGE + 1.2) return;
    if (!this.hasLOS(p, it.x, it.y + 0.3, it.z)) return;
    const def = ITEM_BY_CODE[it.code];
    const inv = s.inv;
    if (def.category === 'special') {
      if (it.owner === undefined || it.owner === p.id) return;
      const owner = this.players.get(it.owner);
      if (!owner || owner.team !== p.team) return;
      p.chips.push(it.owner);
      this.removeItem(id);
      p.send({ e: 'chips', ids: p.chips });
      this.broadcast({ e: 'msg', text: `${p.name} grabbed ${owner.name}'s Rebirth Chip`, k: 'team' }, { team: p.team });
      return;
    }
    if (def.category === 'ammo') {
      const ai = AMMO_TYPES.indexOf(def.ammoType!);
      const take = Math.min(it.count, AMMO_MAX[def.ammoType!] - inv.ammo[ai]);
      if (take <= 0) return p.send({ e: 'msg', text: 'Ammo full', k: 'warn' });
      inv.ammo[ai] += take;
      this.consumeItem(it, take);
      return;
    }
    if (def.category === 'material') {
      const mi = BUILD_MATS.indexOf(def.material!);
      const take = Math.min(it.count, MAX_MATERIAL - inv.mats[mi]);
      if (take <= 0) return p.send({ e: 'msg', text: 'Materials full', k: 'warn' });
      inv.mats[mi] += take;
      this.consumeItem(it, take);
      return;
    }
    let remaining = it.count;
    if (def.stack > 1) {
      for (let i = 1; i < inv.slots.length && remaining > 0; i++) {
        const sl = inv.slots[i];
        if (sl && sl.code === it.code) {
          const add = Math.min(remaining, def.stack - sl.count);
          sl.count += add;
          remaining -= add;
        }
      }
    }
    if (remaining > 0) {
      let empty = -1;
      for (let i = 1; i < inv.slots.length; i++) if (!inv.slots[i]) {
        empty = i;
        break;
      }
      if (empty > 0) {
        inv.slots[empty] = { code: it.code, rarity: it.rarity, count: remaining, mag: it.mag };
        remaining = 0;
        if (def.category === 'weapon' && (s.slot === 0 || !inv.slots[s.slot])) {
          s.slot = empty;
          s.equipT = def.weapon!.equipTime;
          s.reloadT = 0;
          s.useT = -1;
        }
      } else if (s.slot > 0 && inv.slots[s.slot]) {
        // swap with the held item
        const held = inv.slots[s.slot]!;
        inv.slots[s.slot] = { code: it.code, rarity: it.rarity, count: remaining, mag: it.mag };
        remaining = 0;
        s.reloadT = 0;
        s.useT = -1;
        s.equipT = def.weapon ? def.weapon.equipTime : 0.25;
        this.spawnItem(held, s.x, s.y + 0.4, s.z, undefined, [s.x, s.y + 1, s.z]);
      } else {
        return p.send({ e: 'msg', text: 'Inventory full', k: 'warn' });
      }
    }
    this.consumeItem(it, it.count - remaining);
  }

  private consumeItem(it: GroundItem, n: number) {
    it.count -= n;
    if (it.count <= 0) this.removeItem(it.id);
    else this.broadcast({ e: 'ic', id: it.id, n: it.count });
  }

  private dropSlot(p: ServerPlayer, slot: number) {
    const s = p.sim;
    if (slot < 1 || slot >= s.inv.slots.length) return;
    const it = s.inv.slots[slot];
    if (!it) return;
    s.inv.slots[slot] = null;
    if (s.slot === slot) {
      s.slot = 0;
      s.reloadT = 0;
      s.useT = -1;
      s.equipT = 0.2;
    }
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    this.spawnItem(it, s.x + fx * 1.2, s.y + 0.4, s.z + fz * 1.2, undefined, [s.x, s.y + 1.2, s.z]);
  }

  private dropAmmo(p: ServerPlayer, ai: number, count: number) {
    const s = p.sim;
    if (ai < 0 || ai >= AMMO_TYPES.length) return;
    const n = Math.min(count > 0 ? count : s.inv.ammo[ai], s.inv.ammo[ai]);
    if (n <= 0) return;
    s.inv.ammo[ai] -= n;
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    this.spawnItem(makeStack(`ammo_${AMMO_TYPES[ai]}`, 0, n), s.x + fx * 1.2, s.y + 0.4, s.z + fz * 1.2);
  }

  private dropMat(p: ServerPlayer, mi: number, count: number) {
    const s = p.sim;
    if (mi < 0 || mi > 2 || this.phase === 'lobby') return;
    const n = Math.min(count > 0 ? count : 30, s.inv.mats[mi]);
    if (n <= 0) return;
    s.inv.mats[mi] -= n;
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    this.spawnItem(makeStack(`mat_${BUILD_MATS[mi]}`, 0, n), s.x + fx * 1.2, s.y + 0.4, s.z + fz * 1.2);
  }

  private swapSlots(p: ServerPlayer, a: number, b: number) {
    const s = p.sim;
    const n = s.inv.slots.length;
    if (a < 1 || b < 1 || a >= n || b >= n || a === b) return;
    const t = s.inv.slots[a];
    s.inv.slots[a] = s.inv.slots[b];
    s.inv.slots[b] = t;
    if (s.slot === a) s.slot = b;
    else if (s.slot === b) s.slot = a;
    if (!s.inv.slots[s.slot]) s.slot = 0;
  }

  private startInteract(p: ServerPlayer, kind: string, id: number) {
    const s = p.sim;
    if (p.downed) return;
    if (kind === 'vehicle') {
      const v = this.vehicles.get(id);
      if (v) this.enterVehicle(p, v);
      return;
    }
    if (s.mode !== Mode.Walk) return;
    if (kind === 'chest' || kind === 'ammo' || kind === 'supply') {
      const c = this.containers.get(id);
      if (!c || !this.hasLOS(p, c.x, c.y + 0.5, c.z)) return;
    }
    let dur = 0;
    if (kind === 'chest') {
      const c = this.containers.get(id);
      if (!c || c.open || c.kind !== 'chest') return;
      dur = 0.4;
    } else if (kind === 'ammo') {
      const c = this.containers.get(id);
      if (!c || c.open || c.kind !== 'ammo') return;
      dur = 0.25;
    } else if (kind === 'supply') {
      const c = this.containers.get(id);
      if (!c || c.open || c.kind !== 'supply' || (c.land ?? 0) > this.time) return;
      dur = 1.0;
    } else if (kind === 'revive') {
      const t = this.players.get(id);
      if (!t || !t.downed || t.team !== p.team) return;
      dur = REVIVE_TIME;
    } else if (kind === 'spire') {
      if (!p.chips.length || this.storm.phase >= MATCH_DEFAULTS.rebirthWindowPhase) return;
      if (!this.spires.find((sp) => sp.id === id)) return;
      dur = 4;
    } else return;
    p.channel = { kind: kind as never, id, t: 0, dur };
    p.send({ e: 'chan', k: kind, d: dur });
  }

  private channelTargetPos(p: ServerPlayer): { x: number; y: number; z: number; r: number } | null {
    const ch = p.channel!;
    switch (ch.kind) {
      case 'chest':
      case 'ammo':
      case 'supply': {
        const c = this.containers.get(ch.id);
        if (!c || c.open) return null;
        return { x: c.x, y: c.y, z: c.z, r: INTERACT_RANGE + 1 };
      }
      case 'revive': {
        const t = this.players.get(ch.id);
        if (!t || !t.downed) return null;
        return { x: t.sim.x, y: t.sim.y, z: t.sim.z, r: 3 };
      }
      case 'spire': {
        const sp = this.spires.find((x) => x.id === ch.id);
        if (!sp || !p.chips.length) return null;
        return { x: sp.x, y: sp.y, z: sp.z, r: 5 };
      }
    }
  }

  private updateChannels() {
    for (const p of this.players.values()) {
      const ch = p.channel;
      if (!ch) continue;
      const tp = p.standing && p.sim.mode === Mode.Walk ? this.channelTargetPos(p) : null;
      const held = (p.sim.prevButtons & BTN.USE) !== 0;
      if (!tp || !held || Math.hypot(tp.x - p.sim.x, tp.y - p.sim.y, tp.z - p.sim.z) > tp.r) {
        p.channel = null;
        p.send({ e: 'chanx' });
        continue;
      }
      ch.t += TICK_DT;
      if (ch.t < ch.dur) continue;
      p.channel = null;
      p.send({ e: 'chanx', done: 1 });
      this.completeChannel(p, ch.kind, ch.id);
    }
  }

  private completeChannel(p: ServerPlayer, kind: string, id: number) {
    if (kind === 'chest' || kind === 'ammo' || kind === 'supply') {
      const c = this.containers.get(id)!;
      c.open = true;
      this.broadcast({ e: 'co', id });
      const loot = kind === 'chest' ? rollChestLoot(this.rng, c.tier) : kind === 'ammo' ? rollAmmoBox(this.rng) : rollSupplyDrop(this.rng);
      if (kind === 'chest') p.stats.chests++;
      else if (kind === 'ammo') p.stats.ammoBoxes++;
      else p.stats.supplies++;
      const fx = p.sim.x - c.x, fz = p.sim.z - c.z;
      const fl = Math.hypot(fx, fz) || 1;
      loot.forEach((st, i) => {
        const a = Math.atan2(fz / fl, fx / fl) + (i - (loot.length - 1) / 2) * 0.55;
        const r = 1.3 + (i % 2) * 0.4;
        this.spawnItem(st, c.x + Math.cos(a) * r, c.y + 0.3, c.z + Math.sin(a) * r, undefined, [c.x, c.y + 0.8, c.z]);
      });
    } else if (kind === 'revive') {
      const t = this.players.get(id);
      if (!t || !t.downed) return;
      t.downed = false;
      t.sim.mode = Mode.Walk;
      t.sim.hp = REVIVE_HEALTH;
      t.sim.grounded = false;
      p.stats.revives++;
      this.broadcast({ e: 'msg', text: `${p.name} revived ${t.name}`, k: 'team' }, { team: p.team });
      t.bot?.onRevived();
    } else if (kind === 'spire') {
      const sp = this.spires.find((x) => x.id === id)!;
      for (const pid of p.chips) {
        const t = this.players.get(pid);
        if (!t || !t.eliminated || t.leftMatch) continue;
        this.rebirth(t, sp.x, sp.y, sp.z);
        p.stats.rebirths++;
      }
      p.chips = [];
      p.send({ e: 'chips', ids: [] });
    }
  }

  private rebirth(t: ServerPlayer, x: number, y: number, z: number) {
    t.eliminated = false;
    t.alive = true;
    t.downed = false;
    t.resultsSent = false;
    t.placement = 0;
    this.placedTeams.delete(t.team);
    const s = createSim(x, y + 110, z);
    s.mode = Mode.Skydive;
    s.hp = MAX_HEALTH;
    s.inv.slots[1] = makeStack('pip', 0);
    s.inv.ammo[0] = 36;
    t.sim = s;
    t.spectating = 0;
    t.send({ e: 'reborn' });
    t.send({ e: 'spec', id: 0 });
    this.broadcast({ e: 'msg', text: `${t.name} has been reborn!`, k: 'team' });
    this.broadcastAlive();
    t.bot?.onBus();
  }

  private doUtility(p: ServerPlayer, code: number, x: number, y: number, z: number) {
    const def = ITEM_BY_CODE[code];
    if (def.utility === 'springpad') {
      const g = this.world.groundAt(x, z, y + 1.2, 0.5);
      if (g === NO_GROUND) return;
      this.addPad(x, g + 0.05, z);
    } else if (def.utility === 'popfort') {
      const i = Math.floor(p.sim.x / GRID), k = Math.floor(p.sim.z / GRID);
      const j = Math.floor((p.sim.y + 0.3) / GRID);
      const specs: PieceSpec[] = [
        { type: 'wall', i, j, k, d: 0 }, { type: 'wall', i, j, k: k + 1, d: 0 },
        { type: 'wall', i, j, k, d: 1 }, { type: 'wall', i: i + 1, j, k, d: 1 },
        { type: 'roof', i, j: j + 1, k, d: 0 },
      ];
      for (const sp of specs) if (this.grid.canPlace(sp, this.terrain).ok || this.grid.at(sp) === undefined) {
        if (!this.grid.at(sp)) this.addPlayerPiece(p, sp, 2, 0, true);
      }
    }
  }

  private applyConsumable(p: ServerPlayer, code: number) {
    const u = ITEM_BY_CODE[code].use;
    if (!u || !p.standing) return;
    const s = p.sim;
    let healed = 0;
    if (u.heal) {
      const cap = u.healCap ?? MAX_HEALTH;
      const nv = Math.max(s.hp, Math.min(cap, s.hp + u.heal));
      healed += nv - s.hp;
      s.hp = nv;
    }
    if (u.shield) {
      const cap = u.shieldCap ?? MAX_SHIELD;
      const nv = Math.max(s.shield, Math.min(cap, s.shield + u.shield));
      healed += nv - s.shield;
      s.shield = nv;
    }
    if (u.overTime) p.overTime += u.overTime;
    p.stats.healed += healed;
  }

  // -------------------------------------------------------------------------
  // Misc per-tick updates
  // -------------------------------------------------------------------------

  private updateMisc() {
    const dt = TICK_DT;
    // build progress
    for (const id of this.building) {
      const pc = this.grid.get(id);
      if (!pc) {
        this.building.delete(id);
        continue;
      }
      if (this.time - pc.buildStart >= pc.buildTime) {
        this.building.delete(id);
        continue;
      }
      pc.hp = Math.min(pc.maxHp, pc.hp + ((pc.maxHp * 0.9) / pc.buildTime) * dt);
    }
    if (this.damagedPieces.size) {
      const l: [number, number][] = [];
      for (const [id, hp] of this.damagedPieces) l.push([id, Math.round(hp)]);
      this.damagedPieces.clear();
      this.broadcast({ e: 'php', l });
    }
    for (const p of this.players.values()) {
      if (p.downed && p.alive) {
        const beingRevived = [...(this.teams.get(p.team) ?? [])].some((m) => m.channel?.kind === 'revive' && m.channel.id === p.id);
        if (!beingRevived) {
          p.downedHp -= DOWNED_BLEED * dt;
          if (p.downedHp <= 0) this.eliminate(p, this.players.get(p.knockedBy) ?? null, 'bleed');
        }
      }
      if (p.overTime > 0 && p.standing) {
        const amt = Math.min(p.overTime, 5 * dt);
        p.overTime -= amt;
        if (p.sim.hp < MAX_HEALTH) p.sim.hp = Math.min(MAX_HEALTH, p.sim.hp + amt);
        else if (p.sim.shield < MAX_SHIELD) p.sim.shield = Math.min(MAX_SHIELD, p.sim.shield + amt);
        else p.overTime = 0;
        p.stats.healed += amt;
      }
      if (p.disconnectedAt !== null && !p.eliminated && this.time - p.disconnectedAt > MATCH_DEFAULTS.reconnectGrace) {
        this.eliminate(p, null, 'disconnect');
      }
    }
    // rebirth chips expire
    for (const it of [...this.items.values()]) {
      if (it.owner !== undefined && this.time - it.spawnT > MATCH_DEFAULTS.chipLifetime) this.removeItem(it.id);
    }
    this.smokes = this.smokes.filter((s) => s.until > this.time);
  }

  private broadcastAlive() {
    const n = [...this.players.values()].filter((p) => p.alive).length;
    if (n !== this.lastAlive) {
      this.lastAlive = n;
      this.broadcast({ e: 'alive', n });
    }
  }

  // -------------------------------------------------------------------------
  // Replication
  // -------------------------------------------------------------------------

  broadcast(ev: unknown, opt: { x?: number; z?: number; r?: number; team?: number; except?: number } = {}) {
    this.broadcastQ.push({ ev, ...opt });
  }

  private flushEvents() {
    const q = this.broadcastQ;
    this.broadcastQ = [];
    for (const p of this.players.values()) {
      if (p.isBot) {
        p.outbox.length = 0;
        continue;
      }
      if (!p.link || !p.link.open) {
        p.outbox.length = 0;
        continue;
      }
      const list: unknown[] = [];
      for (const b of q) {
        if (b.except === p.id) continue;
        if (b.team !== undefined && b.team !== p.team) continue;
        if (b.r !== undefined && b.x !== undefined && b.z !== undefined) {
          const view = this.viewPos(p);
          if (Math.hypot(view.x - b.x, view.z - b.z) > b.r) continue;
        }
        list.push(b.ev);
      }
      const direct: unknown[] = [];
      for (const m of p.outbox) {
        if (m && typeof m === 'object' && 't' in (m as Record<string, unknown>)) p.link.send(m);
        else direct.push(m);
      }
      p.outbox.length = 0;
      const all = list.concat(direct);
      if (all.length) p.link.send({ t: 'ev', l: all });
    }
  }

  private viewPos(p: ServerPlayer) {
    if (p.eliminated && p.spectating) {
      const t = this.players.get(p.spectating);
      if (t) return t.sim;
    }
    return p.sim;
  }

  private sendSnapshots() {
    const busP = this.phase === 'bus' && this.bus ? this.busPos() : null;
    for (const p of this.players.values()) {
      if (p.isBot || !p.link || !p.link.open) continue;
      const view = this.viewPos(p);
      const specTarget = p.eliminated ? this.players.get(p.spectating) : undefined;
      const ents: EntSnap[] = [];
      for (const q of this.players.values()) {
        if (q === p && !p.eliminated) continue;
        if (q.eliminated || q.sim.mode === Mode.Bus) continue;
        const d = Math.hypot(q.sim.x - view.x, q.sim.z - view.z);
        const mate = q.team === p.team;
        if (d > 420 && !mate && q !== specTarget) continue;
        const s = q.sim;
        const it = s.inv.slots[s.slot];
        const flags =
          (s.crouch ? EF_CROUCH : 0) | (s.ads ? EF_ADS : 0) | (s.sprint ? EF_SPRINT : 0) | (s.grounded ? EF_GROUNDED : 0) |
          (s.reloadT > 0 ? EF_RELOAD : 0) | (s.useT >= 0 ? EF_USING : 0) | (s.prevButtons & BTN.BUILD ? EF_BUILDING : 0) | (s.slideT > 0 ? EF_SLIDE : 0);
        const showHp = mate || q === specTarget;
        ents.push({
          id: q.id, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, mode: s.mode, flags,
          hp: showHp ? (q.downed ? q.downedHp : s.hp) : 0, shield: showHp ? s.shield : 0,
          item: s.prevButtons & BTN.BUILD ? 254 : it ? it.code : 255, rarity: it ? it.rarity : 0, emote: s.emote,
          vehicle: q.vehicleId, seat: q.seat, speed: Math.hypot(s.vx, s.vz), vy: s.vy,
        });
      }
      const vehicles: VehSnap[] = [];
      for (const v of this.vehicles.values()) {
        if (Math.hypot(v.x - view.x, v.z - view.z) > 450) continue;
        vehicles.push({ id: v.id, type: v.type, x: v.x, y: v.y, z: v.z, yaw: v.yaw, pitch: v.pitch, roll: v.roll, speed: v.speed, hp: v.hp });
      }
      const projs: ProjSnap[] = [];
      for (const pr of this.projectiles.values()) {
        if (Math.hypot(pr.x - view.x, pr.z - view.z) > 450) continue;
        projs.push({ id: pr.id, kind: pr.kind, x: pr.x, y: pr.y, z: pr.z });
      }
      const bin = encodeSnapshot(this.writer, {
        tick: this.tick, time: this.time, ack: p.lastSeq, self: p.eliminated ? null : p.sim, ents, vehicles, projs, bus: busP,
      });
      p.link.sendBin(bin);
    }
  }

  sendInit(p: ServerPlayer) {
    if (!p.link) return;
    const pieces: PieceInfo[] = [];
    for (const pc of this.grid.pieces.values()) if (pc.owner !== 0) pieces.push(pieceInfo(pc));
    const damaged: [number, number][] = [];
    for (const pc of this.grid.pieces.values()) if (pc.owner === 0 && pc.hp < pc.maxHp) damaged.push([pc.id, Math.round(pc.hp)]);
    const init: MatchInit = {
      t: 'match', matchId: this.id, mode: this.mode, you: p.id, team: p.team, seed: this.seed, phase: this.phase, phaseEnd: this.phaseEnd,
      tick: this.tick, time: this.time,
      players: [...this.players.values()].map((q) => this.info(q)),
      items: [...this.items.values()].map(stripItem),
      containers: [...this.containers.values()].map(stripContainer),
      pieces, removedMapPieces: [...this.removedMapPieces], damagedMapPieces: damaged, removedProps: this.removedProps.slice(),
      storm: this.storm, bus: this.bus, alive: [...this.players.values()].filter((q) => q.alive).length,
      launchPads: [...this.pads.values()].map((pd) => ({ ...pd })),
      spectating: p.eliminated ? p.spectating : undefined,
    };
    p.link.send(init);
    if (p.chips.length) p.send({ e: 'chips', ids: p.chips });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.players.values()) {
      if (!p.isBot && p.link && p.link.open && !p.leftMatch) p.link.send({ t: 'matchOver' });
    }
    this.onClose?.(this);
  }
}

function stripItem(it: GroundItem): GroundItemInfo {
  const o: GroundItemInfo = { id: it.id, code: it.code, rarity: it.rarity, count: it.count, mag: it.mag, x: it.x, y: it.y, z: it.z };
  if (it.owner !== undefined) o.owner = it.owner;
  return o;
}

function stripContainer(c: Container): ContainerInfo {
  const o: ContainerInfo = { id: c.id, kind: c.kind, x: c.x, y: c.y, z: c.z, rot: c.rot, open: c.open };
  if (c.land !== undefined) {
    o.land = c.land;
    o.y0 = c.y0;
  }
  return o;
}

export function pieceInfo(pc: Piece): PieceInfo {
  return {
    id: pc.id, type: pc.type, i: pc.i, j: pc.j, k: pc.k, d: pc.d, variant: pc.variant, mat: pc.mat, hp: Math.round(pc.hp), maxHp: pc.maxHp,
    owner: pc.owner, team: pc.team, tint: pc.tint, buildStart: pc.buildStart, buildTime: pc.buildTime, anchored: pc.anchored,
  };
}

function randomLoadout(rng: RNG): PlayerInfo['cos'] {
  const outfits = ['rookie', 'rookie2', 'tidecaller', 'emberscout', 'mossranger', 'neonnomad', 'circuitknight', 'coralcaptain', 'frostbyte', 'glitchpop', 'midnightfox', 'cocoa'];
  const hats = ['hat_none', 'cap', 'beanie', 'headphones', 'foxears', 'partyhat', 'mohawk'];
  const packs = ['bp_none', 'satchel', 'shell', 'flag', 'guitar', 'rocketpack'];
  const gliders = ['delta', 'parafoil', 'kite', 'leaf'];
  return {
    outfit: rng.pick(outfits), headwear: rng.pick(hats), backpack: rng.pick(packs), glider: rng.pick(gliders),
    trail: rng.pick(['trail_none', 'sparkle', 'bubbles']), emote1: 'wave', emote2: rng.pick(['cheer', 'bop', 'robot', 'spin']),
  };
}

export { AMMO_DROP, ITEM_BY_ID };
