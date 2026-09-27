// Network protocol. High-frequency traffic (inputs, snapshots) is binary; everything else
// is small reliable JSON messages over the same WebSocket (TCP => ordered, reliable).
import { ByteReader, ByteWriter } from './binary';
import { InputCmd, Mode, SimState } from './sim';
import type { Mode as GameMode } from './constants';
import type { StormState } from './storm';
import type { PieceType } from './build';

export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;

// ---------------------------------------------------------------------------
// Inputs (client -> server)
// ---------------------------------------------------------------------------

export function quantizeInput(i: InputCmd): InputCmd {
  return {
    seq: i.seq >>> 0,
    mx: Math.round(Math.max(-1, Math.min(1, i.mx)) * 127) / 127,
    mz: Math.round(Math.max(-1, Math.min(1, i.mz)) * 127) / 127,
    yaw: Math.fround(i.yaw),
    pitch: Math.fround(i.pitch),
    buttons: i.buttons & 0xffff,
    slot: i.slot & 0xff,
    viewTick: Math.fround(i.viewTick),
  };
}

export function encodeInputs(w: ByteWriter, list: InputCmd[]) {
  w.reset();
  w.u8w(MSG_INPUT);
  w.u8w(list.length);
  for (const i of list) {
    w.u32w(i.seq);
    w.i8w(Math.round(i.mx * 127));
    w.i8w(Math.round(i.mz * 127));
    w.f32w(i.yaw);
    w.f32w(i.pitch);
    w.u16w(i.buttons);
    w.u8w(i.slot);
    w.f32w(i.viewTick);
  }
  return w.bytes();
}

export function decodeInputs(r: ByteReader): InputCmd[] {
  const n = Math.min(r.u8(), 32);
  const out: InputCmd[] = [];
  for (let k = 0; k < n; k++) {
    if (r.remaining < 21) break;
    const seq = r.u32();
    const mx = r.i8() / 127;
    const mz = r.i8() / 127;
    const yaw = r.f32();
    const pitch = r.f32();
    const buttons = r.u16();
    const slot = r.u8();
    const viewTick = r.f32();
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(viewTick)) continue;
    out.push({ seq, mx, mz, yaw, pitch, buttons, slot, viewTick });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshots (server -> client)
// ---------------------------------------------------------------------------

export interface EntSnap {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  mode: number;
  flags: number; // EF_*
  hp: number;
  shield: number;
  item: number; // held item code (255 none)
  rarity: number;
  emote: number;
  vehicle: number;
  seat: number;
  speed: number; // horizontal speed (animation)
  vy: number;
}

export const EF_CROUCH = 1;
export const EF_ADS = 2;
export const EF_SPRINT = 4;
export const EF_GROUNDED = 8;
export const EF_RELOAD = 16;
export const EF_USING = 32;
export const EF_BUILDING = 64;
export const EF_SLIDE = 128;

export interface VehSnap {
  id: number;
  type: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  hp: number;
}

export interface ProjSnap {
  id: number;
  kind: number; // 0 rocket, 1 grenade, 2 smoke, 3 supply
  x: number;
  y: number;
  z: number;
}

/** The vehicle the local player occupies; full-precision state only for the driver. */
export interface DriveSnap {
  id: number;
  seat: number;
  st: { x: number; y: number; z: number; yaw: number; pitch: number; roll: number; speed: number; vy: number } | null;
}

export interface Snapshot {
  tick: number;
  time: number;
  ack: number;
  self: SimState | null;
  drive?: DriveSnap | null;
  ents: EntSnap[];
  vehicles: VehSnap[];
  projs: ProjSnap[];
  bus: { x: number; y: number; z: number; yaw: number } | null;
}

const TAU = Math.PI * 2;
const qYaw = (y: number) => Math.round((((y % TAU) + TAU) % TAU) / TAU * 65535) & 0xffff;
const dqYaw = (q: number) => (q / 65535) * TAU;

function writeSelf(w: ByteWriter, s: SimState) {
  w.f32w(s.x); w.f32w(s.y); w.f32w(s.z);
  w.f32w(s.vx); w.f32w(s.vy); w.f32w(s.vz);
  w.f32w(s.yaw); w.f32w(s.pitch);
  w.u8w(s.mode);
  w.u8w((s.grounded ? 1 : 0) | (s.crouch ? 2 : 0) | (s.sprint ? 4 : 0) | (s.ads ? 8 : 0) | (s.canGlide ? 16 : 0));
  w.f32w(s.slideT); w.f32w(s.slideCd); w.f32w(s.mantleT);
  w.f32w(s.m0x); w.f32w(s.m0y); w.f32w(s.m0z);
  w.f32w(s.m1x); w.f32w(s.m1y); w.f32w(s.m1z);
  w.f32w(s.airT);
  w.u16w(s.prevButtons);
  w.u8w(s.slot);
  w.f32w(s.equipT); w.f32w(s.cooldown);
  w.u8w(s.burstLeft);
  w.f32w(s.reloadT); w.f32w(s.bloom); w.f32w(s.useT);
  w.u32w(s.shotSeq);
  w.u8w(s.emote);
  w.f32w(s.hp); w.f32w(s.shield);
  w.u8w(s.inv.slots.length);
  for (const it of s.inv.slots) {
    if (!it) {
      w.u8w(255);
      continue;
    }
    w.u8w(it.code); w.u8w(it.rarity); w.u16w(it.count); w.u16w(it.mag);
  }
  w.u8w(s.inv.ammo.length);
  for (const a of s.inv.ammo) w.u16w(a);
  w.u8w(s.inv.mats.length);
  for (const m of s.inv.mats) w.u16w(m);
}

function readSelf(r: ByteReader): SimState {
  const s = {} as SimState;
  s.x = r.f32(); s.y = r.f32(); s.z = r.f32();
  s.vx = r.f32(); s.vy = r.f32(); s.vz = r.f32();
  s.yaw = r.f32(); s.pitch = r.f32();
  s.mode = r.u8() as Mode;
  const b = r.u8();
  s.grounded = !!(b & 1); s.crouch = !!(b & 2); s.sprint = !!(b & 4); s.ads = !!(b & 8); s.canGlide = !!(b & 16);
  s.slideT = r.f32(); s.slideCd = r.f32(); s.mantleT = r.f32();
  s.m0x = r.f32(); s.m0y = r.f32(); s.m0z = r.f32();
  s.m1x = r.f32(); s.m1y = r.f32(); s.m1z = r.f32();
  s.airT = r.f32();
  s.prevButtons = r.u16();
  s.slot = r.u8();
  s.equipT = r.f32(); s.cooldown = r.f32();
  s.burstLeft = r.u8();
  s.reloadT = r.f32(); s.bloom = r.f32(); s.useT = r.f32();
  s.shotSeq = r.u32();
  s.emote = r.u8();
  s.hp = r.f32(); s.shield = r.f32();
  const ns = r.u8();
  const slots = [];
  for (let k = 0; k < ns; k++) {
    const code = r.u8();
    if (code === 255) {
      slots.push(null);
      continue;
    }
    slots.push({ code, rarity: r.u8(), count: r.u16(), mag: r.u16() });
  }
  const na = r.u8();
  const ammo: number[] = [];
  for (let k = 0; k < na; k++) ammo.push(r.u16());
  const nm = r.u8();
  const mats: number[] = [];
  for (let k = 0; k < nm; k++) mats.push(r.u16());
  s.inv = { slots, ammo, mats };
  return s;
}

/** Round all float fields to f32 so the server state equals what the client receives. */
export function quantizeSim(s: SimState) {
  const f = Math.fround;
  s.x = f(s.x); s.y = f(s.y); s.z = f(s.z);
  s.vx = f(s.vx); s.vy = f(s.vy); s.vz = f(s.vz);
  s.yaw = f(s.yaw); s.pitch = f(s.pitch);
  s.slideT = f(s.slideT); s.slideCd = f(s.slideCd); s.mantleT = f(s.mantleT);
  s.m0x = f(s.m0x); s.m0y = f(s.m0y); s.m0z = f(s.m0z);
  s.m1x = f(s.m1x); s.m1y = f(s.m1y); s.m1z = f(s.m1z);
  s.airT = f(s.airT);
  s.equipT = f(s.equipT); s.cooldown = f(s.cooldown);
  s.reloadT = f(s.reloadT); s.bloom = f(s.bloom); s.useT = f(s.useT);
  s.hp = f(s.hp); s.shield = f(s.shield);
}

export function encodeSnapshot(w: ByteWriter, snap: Snapshot) {
  w.reset();
  w.u8w(MSG_SNAPSHOT);
  w.u32w(snap.tick);
  w.f32w(snap.time);
  w.u32w(snap.ack);
  w.u8w((snap.self ? 1 : 0) | (snap.bus ? 2 : 0) | (snap.drive ? 4 : 0));
  if (snap.self) writeSelf(w, snap.self);
  if (snap.drive) {
    const d = snap.drive;
    w.u16w(d.id);
    w.u8w(d.seat);
    w.u8w(d.st ? 1 : 0);
    if (d.st) for (const k of [d.st.x, d.st.y, d.st.z, d.st.yaw, d.st.pitch, d.st.roll, d.st.speed, d.st.vy]) w.f32w(k);
  }
  if (snap.bus) {
    w.f32w(snap.bus.x); w.f32w(snap.bus.y); w.f32w(snap.bus.z); w.u16w(qYaw(snap.bus.yaw));
  }
  w.u16w(snap.ents.length);
  for (const e of snap.ents) {
    w.u16w(e.id);
    w.f32w(e.x); w.f32w(e.y); w.f32w(e.z);
    w.u16w(qYaw(e.yaw));
    w.i16w(Math.round(e.pitch * 10000));
    w.u8w(e.mode);
    w.u8w(e.flags);
    w.u8w(Math.max(0, Math.min(255, Math.ceil(e.hp))));
    w.u8w(Math.max(0, Math.min(255, Math.ceil(e.shield))));
    w.u8w(e.item);
    w.u8w(e.rarity);
    w.u8w(e.emote);
    w.u16w(e.vehicle);
    w.u8w(e.seat);
    w.u8w(Math.min(255, Math.round(e.speed * 8)));
    w.i16w(Math.round(Math.max(-300, Math.min(300, e.vy)) * 100));
  }
  w.u16w(snap.vehicles.length);
  for (const v of snap.vehicles) {
    w.u16w(v.id); w.u8w(v.type);
    w.f32w(v.x); w.f32w(v.y); w.f32w(v.z);
    w.u16w(qYaw(v.yaw));
    w.i16w(Math.round(v.pitch * 10000)); w.i16w(Math.round(v.roll * 10000));
    w.f32w(v.speed);
    w.u16w(Math.max(0, Math.round(v.hp)));
  }
  w.u16w(snap.projs.length);
  for (const p of snap.projs) {
    w.u16w(p.id); w.u8w(p.kind);
    w.f32w(p.x); w.f32w(p.y); w.f32w(p.z);
  }
  return w.bytes();
}

export function decodeSnapshot(r: ByteReader): Snapshot {
  const tick = r.u32();
  const time = r.f32();
  const ack = r.u32();
  const flags = r.u8();
  const self = flags & 1 ? readSelf(r) : null;
  let drive: DriveSnap | null = null;
  if (flags & 4) {
    const id = r.u16();
    const seat = r.u8();
    const has = r.u8();
    drive = { id, seat, st: has ? { x: r.f32(), y: r.f32(), z: r.f32(), yaw: r.f32(), pitch: r.f32(), roll: r.f32(), speed: r.f32(), vy: r.f32() } : null };
  }
  let bus: Snapshot['bus'] = null;
  if (flags & 2) bus = { x: r.f32(), y: r.f32(), z: r.f32(), yaw: dqYaw(r.u16()) };
  const ne = r.u16();
  const ents: EntSnap[] = [];
  for (let k = 0; k < ne; k++) {
    ents.push({
      id: r.u16(),
      x: r.f32(), y: r.f32(), z: r.f32(),
      yaw: dqYaw(r.u16()),
      pitch: r.i16() / 10000,
      mode: r.u8(),
      flags: r.u8(),
      hp: r.u8(),
      shield: r.u8(),
      item: r.u8(),
      rarity: r.u8(),
      emote: r.u8(),
      vehicle: r.u16(),
      seat: r.u8(),
      speed: r.u8() / 8,
      vy: r.i16() / 100,
    });
  }
  const nv = r.u16();
  const vehicles: VehSnap[] = [];
  for (let k = 0; k < nv; k++) {
    vehicles.push({
      id: r.u16(), type: r.u8(), x: r.f32(), y: r.f32(), z: r.f32(), yaw: dqYaw(r.u16()),
      pitch: r.i16() / 10000, roll: r.i16() / 10000, speed: r.f32(), hp: r.u16(),
    });
  }
  const np = r.u16();
  const projs: ProjSnap[] = [];
  for (let k = 0; k < np; k++) projs.push({ id: r.u16(), kind: r.u8(), x: r.f32(), y: r.f32(), z: r.f32() });
  return { tick, time, ack, self, drive, ents, vehicles, projs, bus };
}

// ---------------------------------------------------------------------------
// JSON messages
// ---------------------------------------------------------------------------

export interface CosmeticLoadout {
  outfit: string;
  headwear: string;
  backpack: string;
  glider: string;
  trail: string;
  emote1: string;
  emote2: string;
}

export interface PlayerInfo {
  id: number;
  name: string;
  team: number;
  bot: boolean;
  cos: CosmeticLoadout;
  level: number;
}

export interface GroundItemInfo {
  id: number;
  code: number;
  rarity: number;
  count: number;
  mag: number;
  x: number;
  y: number;
  z: number;
  owner?: number; // rebirth chips: whose chip
}

export interface ContainerInfo {
  id: number;
  kind: 'chest' | 'ammo' | 'supply';
  x: number;
  y: number;
  z: number;
  rot: number;
  open: boolean;
  land?: number; // supply drops: landing time
  y0?: number; // supply drop spawn height
}

export interface PieceInfo {
  id: number;
  type: PieceType;
  i: number;
  j: number;
  k: number;
  d: number;
  variant: number;
  mat: number;
  hp: number;
  maxHp: number;
  owner: number;
  team: number;
  tint: number;
  buildStart: number;
  buildTime: number;
  anchored: boolean;
}

export type MatchPhase = 'lobby' | 'bus' | 'play' | 'ended';

export interface MatchInit {
  t: 'match';
  matchId: string;
  mode: GameMode;
  you: number;
  team: number;
  seed: number;
  phase: MatchPhase;
  phaseEnd: number;
  tick: number;
  time: number;
  players: PlayerInfo[];
  items: GroundItemInfo[];
  containers: ContainerInfo[];
  pieces: PieceInfo[]; // player-built pieces
  removedMapPieces: number[]; // destroyed map piece ids
  damagedMapPieces: [number, number][];
  removedProps: number[];
  storm: StormState;
  bus: { x0: number; z0: number; x1: number; z1: number; t0: number; t1: number } | null;
  alive: number;
  launchPads: { id: number; x: number; y: number; z: number }[];
  spectating?: number;
}

export interface ResultsMsg {
  t: 'results';
  placement: number;
  total: number;
  won: boolean;
  kills: number;
  damage: number;
  survived: number;
  xp: { label: string; amount: number }[];
  totalXp: number;
  levelBefore: number;
  levelAfter: number;
  currency: number;
  challengesDone: string[];
  tierBefore: number;
  tierAfter: number;
}

/** Actions are ordered with inputs so the server sees the same state the client predicted. */
export type Action =
  | { a: 'build'; type: PieceType; i: number; j: number; k: number; d: number; mat: number }
  | { a: 'pickup'; id: number }
  | { a: 'drop'; slot: number; count?: number }
  | { a: 'dropAmmo'; ammo: number; count: number }
  | { a: 'dropMat'; mat: number; count: number }
  | { a: 'swap'; from: number; to: number }
  | { a: 'interact'; kind: 'chest' | 'ammo' | 'supply' | 'revive' | 'spire' | 'vehicle'; id: number }
  | { a: 'exitVehicle' }
  | { a: 'seat'; seat: number }
  | { a: 'emote'; id: number }
  | { a: 'spectate'; dir: 1 | -1 }
  | { a: 'ping'; x: number; y: number; z: number }
  | { a: 'edit'; id: number };
