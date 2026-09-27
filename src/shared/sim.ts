// Deterministic player simulation (movement + weapon/consumable state machine).
// The server runs this authoritatively for every input command; the client runs the
// exact same code to predict its own player and replays unacknowledged inputs after
// each snapshot (reconciliation).
import {
  CROUCH_EYE, CROUCH_HEIGHT, DOWNED_HEIGHT, EYE_HEIGHT, INVENTORY_SLOTS, MOVE, PLAYER_HEIGHT,
  PLAYER_RADIUS, STEP_HEIGHT, WATER_LEVEL,
} from './constants';
import { CollisionWorld } from './collision';
import {
  AMMO_TYPES, HARVEST_TOOL, ITEM_BY_CODE, ItemStack, RARITY_RELOAD, RARITY_SPREAD, WeaponStats, ammoIndex,
} from './items';
import { approach, clamp, forwardFromYawPitch, rightFromYaw } from './math';
import { hash32, mulberry32 } from './rng';
import { NO_GROUND } from './terrain';

export const enum Mode {
  Walk = 0,
  Skydive = 1,
  Glide = 2,
  Swim = 3,
  Mantle = 4,
  Bus = 5,
  Vehicle = 6,
  Downed = 7,
  Dead = 8,
}

export const BTN = {
  JUMP: 1,
  SPRINT: 2,
  CROUCH: 4,
  FIRE: 8,
  ADS: 16,
  RELOAD: 32,
  USE: 64,
  BUILD: 128,
} as const;

export interface InputCmd {
  seq: number;
  mx: number; // strafe [-1,1] (right positive)
  mz: number; // forward [-1,1]
  yaw: number;
  pitch: number;
  buttons: number;
  slot: number; // desired inventory slot 0..5
  viewTick: number; // server tick the client was viewing (lag compensation)
}

export interface Inventory {
  slots: (ItemStack | null)[]; // index 0 = harvest tool
  ammo: number[]; // per AMMO_TYPES
  mats: number[]; // timber, stone, alloy
}

export interface SimState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number; pitch: number;
  mode: Mode;
  grounded: boolean;
  crouch: boolean;
  sprint: boolean;
  ads: boolean;
  slideT: number;
  slideCd: number;
  mantleT: number;
  m0x: number; m0y: number; m0z: number;
  m1x: number; m1y: number; m1z: number;
  canGlide: boolean;
  airT: number;
  prevButtons: number;
  // equipment
  slot: number;
  equipT: number;
  cooldown: number;
  burstLeft: number;
  reloadT: number;
  bloom: number;
  useT: number; // consumable channel progress, -1 when idle
  shotSeq: number;
  emote: number;
  hp: number; // authoritative on server, mirrored for prediction checks
  shield: number;
  inv: Inventory;
}

export interface StepCtx {
  world: CollisionWorld;
  playerId: number;
  canAttack: boolean;
  pads?: { x: number; y: number; z: number }[];
}

export const SLOT_KEEP = 255; // input.slot value meaning "no slot change requested"

export type SimEvent =
  | { t: 'shot'; code: number; rarity: number; ox: number; oy: number; oz: number; dirs: number[]; seq: number }
  | { t: 'rocket'; code: number; rarity: number; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }
  | { t: 'melee'; code: number; rarity: number; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number }
  | { t: 'throw'; code: number; ox: number; oy: number; oz: number; vx: number; vy: number; vz: number }
  | { t: 'utility'; code: number; x: number; y: number; z: number; yaw: number }
  | { t: 'used'; code: number }
  | { t: 'land'; speed: number }
  | { t: 'jump' }
  | { t: 'deploy' }
  | { t: 'reload' }
  | { t: 'mantle' }
  | { t: 'launch' }
  | { t: 'void' };

export function emptyInventory(): Inventory {
  const slots: (ItemStack | null)[] = new Array(INVENTORY_SLOTS + 1).fill(null);
  slots[0] = { code: HARVEST_TOOL.code, rarity: 0, count: 1, mag: 0 };
  return { slots, ammo: AMMO_TYPES.map(() => 0), mats: [0, 0, 0] };
}

export function createSim(x = 0, y = 0, z = 0): SimState {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
    mode: Mode.Walk, grounded: false, crouch: false, sprint: false, ads: false,
    slideT: 0, slideCd: 0, mantleT: 0, m0x: 0, m0y: 0, m0z: 0, m1x: 0, m1y: 0, m1z: 0,
    canGlide: false, airT: 0, prevButtons: 0,
    slot: 0, equipT: 0, cooldown: 0, burstLeft: 0, reloadT: 0, bloom: 0, useT: -1, shotSeq: 0, emote: 0,
    hp: 100, shield: 0,
    inv: emptyInventory(),
  };
}

export function cloneInventory(inv: Inventory): Inventory {
  return {
    slots: inv.slots.map((s) => (s ? { ...s } : null)),
    ammo: inv.ammo.slice(),
    mats: inv.mats.slice(),
  };
}

export function copySim(dst: SimState, src: SimState) {
  const inv = cloneInventory(src.inv);
  Object.assign(dst, src);
  dst.inv = inv;
}

export function playerHeight(s: SimState) {
  if (s.mode === Mode.Downed) return DOWNED_HEIGHT;
  return s.crouch ? CROUCH_HEIGHT : PLAYER_HEIGHT;
}

export function eyeHeight(s: SimState) {
  if (s.mode === Mode.Downed) return 0.6;
  return s.crouch ? CROUCH_EYE : EYE_HEIGHT;
}

/** Over-the-shoulder camera pivot offsets (shared so server aims exactly like the client). */
export const SHOULDER_RIGHT = 0.55;
export const SHOULDER_UP = 0.2;

export function currentItem(s: SimState): ItemStack | null {
  return s.inv.slots[s.slot] ?? null;
}

export function currentWeapon(s: SimState): WeaponStats | null {
  const it = currentItem(s);
  if (!it) return null;
  return ITEM_BY_CODE[it.code].weapon ?? null;
}

const canUseItems = (s: SimState) => s.mode === Mode.Walk || s.mode === Mode.Mantle;

// ---------------------------------------------------------------------------
// Collision movement
// ---------------------------------------------------------------------------

interface MoveResult {
  landed: boolean;
  impact: number;
  hitCeil: boolean;
}

const moveRes: MoveResult = { landed: false, impact: 0, hitCeil: false };

function moveAndCollide(s: SimState, dx: number, dy: number, dz: number, world: CollisionWorld): MoveResult {
  const r = PLAYER_RADIUS;
  const h = playerHeight(s);
  const terrain = world.terrain;
  moveRes.landed = false;
  moveRes.impact = 0;
  moveRes.hitCeil = false;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / 0.28));
  const sx = dx / n, sy = dy / n, sz = dz / n;
  for (let i = 0; i < n; i++) {
    const stepUp = s.grounded ? STEP_HEIGHT : 0.05;
    // --- X ---
    if (sx !== 0) {
      const nx = s.x + sx;
      const th = terrain.heightAt(nx, s.z);
      if ((th !== NO_GROUND && th > s.y + STEP_HEIGHT) || world.overlaps(nx, s.y + stepUp, s.y + h, s.z, r)) {
        s.vx = 0;
      } else s.x = nx;
    }
    // --- Z ---
    if (sz !== 0) {
      const nz = s.z + sz;
      const th = terrain.heightAt(s.x, nz);
      if ((th !== NO_GROUND && th > s.y + STEP_HEIGHT) || world.overlaps(s.x, s.y + stepUp, s.y + h, nz, r)) {
        s.vz = 0;
      } else s.z = nz;
    }
    // --- ground follow / step up ---
    if (s.grounded) {
      const g = world.groundAt(s.x, s.z, s.y + STEP_HEIGHT, r);
      if (g !== NO_GROUND && g >= s.y - 0.7 && s.vy <= 0) {
        if (g > s.y && world.overlaps(s.x, g + 0.05, g + h, s.z, r)) {
          // no headroom to step up; stay
        } else s.y = g;
      } else {
        s.grounded = false;
      }
    } else {
      // popped into terrain from the side (e.g. gliding into a slope)
      const th = terrain.heightAt(s.x, s.z);
      if (th !== NO_GROUND && th > s.y && th <= s.y + STEP_HEIGHT + 0.01) {
        s.y = th;
        if (s.vy <= 0) {
          moveRes.landed = true;
          moveRes.impact = -s.vy;
          s.vy = 0;
          s.grounded = true;
        }
      }
    }
    // --- Y ---
    if (!s.grounded && sy !== 0) {
      if (sy < 0) {
        const g = world.groundAt(s.x, s.z, s.y + 0.05, r);
        if (g !== NO_GROUND && s.y + sy <= g) {
          s.y = g;
          moveRes.landed = true;
          moveRes.impact = -s.vy;
          s.vy = 0;
          s.grounded = true;
        } else s.y += sy;
      } else {
        if (world.overlaps(s.x, s.y + h, s.y + h + sy, s.z, r)) {
          moveRes.hitCeil = true;
          s.vy = 0;
        } else s.y += sy;
      }
    }
  }
  return moveRes;
}

function heightAboveGround(s: SimState, world: CollisionWorld) {
  const g = world.groundAt(s.x, s.z, s.y + 0.1, 0.3);
  if (g === NO_GROUND) return 1e4;
  return s.y - Math.max(g, WATER_LEVEL);
}

function waterDepthAt(world: CollisionWorld, x: number, z: number, y: number) {
  const g = world.groundAt(x, z, y + 0.1, 0.2);
  const ground = g === NO_GROUND ? -50 : g;
  return WATER_LEVEL - ground;
}

function tryMantle(s: SimState, world: CollisionWorld): boolean {
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  const r = PLAYER_RADIUS;
  // Something must be blocking in front at body height
  const bx = s.x + fx * 0.5, bz = s.z + fz * 0.5;
  if (!world.overlaps(bx, s.y + 0.3, s.y + PLAYER_HEIGHT, bz, r)) return false;
  const px = s.x + fx * 0.95, pz = s.z + fz * 0.95;
  const reach = s.grounded ? 1.9 : 2.3;
  const top = world.groundAt(px, pz, s.y + reach, r * 0.8);
  if (top === NO_GROUND || top <= s.y + STEP_HEIGHT) return false;
  if (world.overlaps(px, top + 0.05, top + PLAYER_HEIGHT, pz, r)) return false;
  if (world.overlaps(s.x, s.y + 0.2, top + PLAYER_HEIGHT, s.z, r * 0.9)) return false;
  s.mode = Mode.Mantle;
  s.mantleT = MOVE.mantleTime;
  s.m0x = s.x; s.m0y = s.y; s.m0z = s.z;
  s.m1x = px; s.m1y = top + 0.02; s.m1z = pz;
  s.vx = s.vy = s.vz = 0;
  s.slideT = 0;
  return true;
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

export function stepSim(s: SimState, inp: InputCmd, dt: number, ctx: StepCtx, ev: SimEvent[]) {
  const b = inp.buttons;
  const pressed = b & ~s.prevButtons;
  s.yaw = inp.yaw;
  s.pitch = clamp(inp.pitch, -1.45, 1.45);
  const mx = clamp(inp.mx, -1, 1);
  const mz = clamp(inp.mz, -1, 1);
  if (s.emote && (Math.abs(mx) > 0.1 || Math.abs(mz) > 0.1 || b & (BTN.JUMP | BTN.FIRE | BTN.ADS | BTN.BUILD))) s.emote = 0;

  switch (s.mode) {
    case Mode.Walk:
    case Mode.Downed:
      stepWalk(s, inp, dt, ctx, ev, pressed);
      break;
    case Mode.Skydive:
    case Mode.Glide:
      stepAir(s, inp, dt, ctx, ev, pressed);
      break;
    case Mode.Swim:
      stepSwim(s, inp, dt, ctx, ev, pressed);
      break;
    case Mode.Mantle: {
      s.mantleT -= dt;
      const t = 1 - Math.max(0, s.mantleT) / MOVE.mantleTime;
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      // rise first, then move forward
      const ty = Math.min(1, e * 1.6);
      s.x = s.m0x + (s.m1x - s.m0x) * e;
      s.z = s.m0z + (s.m1z - s.m0z) * e;
      s.y = s.m0y + (s.m1y - s.m0y) * ty;
      if (s.mantleT <= 0) {
        s.mode = Mode.Walk;
        s.x = s.m1x; s.y = s.m1y; s.z = s.m1z;
        s.grounded = true;
        s.vy = 0;
      }
      break;
    }
    default:
      break; // Bus / Vehicle / Dead are driven externally
  }

  if (s.y < -45 && s.mode !== Mode.Dead) ev.push({ t: 'void' });

  stepEquipment(s, inp, dt, ctx, ev, pressed);
  s.prevButtons = b;
}

function stepWalk(s: SimState, inp: InputCmd, dt: number, ctx: StepCtx, ev: SimEvent[], pressed: number) {
  const b = inp.buttons;
  const world = ctx.world;
  const downed = s.mode === Mode.Downed;
  const mx = clamp(inp.mx, -1, 1);
  const mz = clamp(inp.mz, -1, 1);
  const fire = (b & BTN.FIRE) !== 0 && !(b & BTN.BUILD);
  const wantCrouch = (b & BTN.CROUCH) !== 0;
  s.slideCd = Math.max(0, s.slideCd - dt);

  // --- crouch / slide ---
  const hspeed = Math.hypot(s.vx, s.vz);
  if (!downed && s.slideT <= 0 && wantCrouch && s.sprint && s.grounded && hspeed > 6 && s.slideCd <= 0) {
    s.slideT = 1.1;
    s.slideCd = MOVE.slideCooldown;
    const boost = Math.max(hspeed, MOVE.slideBoost) / (hspeed || 1);
    s.vx *= boost;
    s.vz *= boost;
  }
  if (s.slideT > 0) {
    s.slideT -= dt;
    s.crouch = true;
    const sp = Math.hypot(s.vx, s.vz);
    // downhill keeps momentum, uphill bleeds it
    let fr = MOVE.slideFriction;
    if (sp > 0.1) {
      const ahead = world.groundAt(s.x + (s.vx / sp) * 0.8, s.z + (s.vz / sp) * 0.8, s.y + 1, 0.2);
      if (ahead !== NO_GROUND) fr += clamp((ahead - s.y) / 0.8, -1, 1) * 9;
    }
    const nsp = Math.max(0, sp - fr * dt);
    if (sp > 0.01) {
      s.vx *= nsp / sp;
      s.vz *= nsp / sp;
    }
    // mild steering
    const yawF = -Math.sin(inp.yaw), yawZ = -Math.cos(inp.yaw);
    s.vx += yawF * mz * 2 * dt;
    s.vz += yawZ * mz * 2 * dt;
    if (!wantCrouch || nsp < MOVE.slideMinSpeed || s.slideT <= 0) s.slideT = 0;
  } else if (!downed) {
    if (wantCrouch) s.crouch = true;
    else if (s.crouch) {
      // stand up only with headroom
      if (!world.overlaps(s.x, s.y + CROUCH_HEIGHT, s.y + PLAYER_HEIGHT, s.z, PLAYER_RADIUS * 0.95)) s.crouch = false;
    }
  }

  const using = s.useT >= 0;
  const weapon = currentWeapon(s);
  const firingWeapon = fire && weapon !== null && weapon.cls !== 'melee';
  s.sprint = !downed && (b & BTN.SPRINT) !== 0 && mz > 0.1 && !s.crouch && !s.ads && !firingWeapon && !using;
  s.ads = !downed && (b & BTN.ADS) !== 0 && !(b & BTN.BUILD) && weapon !== null && weapon.cls !== 'melee' && s.slideT <= 0;

  if (s.slideT <= 0) {
    let speed = downed ? MOVE.downed : s.crouch ? MOVE.crouch : s.sprint ? MOVE.sprint : s.ads ? MOVE.ads : MOVE.run;
    if (using) speed *= 0.55;
    if (s.emote) speed = 0;
    const fwd = forwardFromYawPitch(inp.yaw, 0);
    const right = rightFromYaw(inp.yaw);
    let wx = fwd.x * mz + right.x * mx;
    let wz = fwd.z * mz + right.z * mx;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }
    const tx = wx * speed, tz = wz * speed;
    const accel = s.grounded ? MOVE.groundAccel : MOVE.airAccel;
    const ddx = tx - s.vx, ddz = tz - s.vz;
    const dl = Math.hypot(ddx, ddz);
    const maxD = accel * dt;
    if (dl <= maxD) {
      s.vx = tx;
      s.vz = tz;
    } else {
      s.vx += (ddx / dl) * maxD;
      s.vz += (ddz / dl) * maxD;
    }
  }

  // --- jump / mantle ---
  if (s.grounded) s.airT = 0;
  else s.airT += dt;
  if (!downed && pressed & BTN.JUMP) {
    if (mz > 0.1 && tryMantle(s, world)) {
      ev.push({ t: 'mantle' });
      return;
    }
    if (s.grounded || s.airT < 0.1) {
      s.vy = MOVE.jumpVel;
      s.grounded = false;
      s.airT = 1;
      s.slideT = 0;
      if (s.crouch && !world.overlaps(s.x, s.y + CROUCH_HEIGHT, s.y + PLAYER_HEIGHT, s.z, PLAYER_RADIUS * 0.95)) s.crouch = false;
      ev.push({ t: 'jump' });
    } else if (s.canGlide && heightAboveGround(s, world) > MOVE.minManualDeploy) {
      s.mode = Mode.Glide;
      ev.push({ t: 'deploy' });
      return;
    }
  } else if (!downed && !s.grounded && (inp.buttons & BTN.JUMP) && mz > 0.1 && s.vy < 3) {
    // holding jump into a ledge while airborne auto-mantles
    if (tryMantle(s, world)) {
      ev.push({ t: 'mantle' });
      return;
    }
  }

  if (!s.grounded) {
    s.vy = Math.max(-MOVE.terminalFall, s.vy - MOVE.gravity * dt);
  }
  const res = moveAndCollide(s, s.vx * dt, s.vy * dt, s.vz * dt, world);
  if (res.landed) {
    s.canGlide = false;
    if (res.impact > 4) ev.push({ t: 'land', speed: res.impact });
  }

  // --- launch pads ---
  if (!downed && s.grounded && ctx.pads) {
    for (const p of ctx.pads) {
      if (Math.abs(p.x - s.x) < 1.3 && Math.abs(p.z - s.z) < 1.3 && Math.abs(p.y - s.y) < 0.6) {
        s.mode = Mode.Skydive;
        s.vy = MOVE.launchPadVel;
        s.grounded = false;
        s.canGlide = true;
        s.crouch = false;
        s.slideT = 0;
        ev.push({ t: 'launch' });
        return;
      }
    }
  }

  // --- water ---
  if (!s.grounded || s.y < WATER_LEVEL - 1.1) {
    const depth = waterDepthAt(world, s.x, s.z, s.y);
    if (depth > 1.45 && s.y < WATER_LEVEL - 1.1) {
      s.mode = downed ? Mode.Downed : Mode.Swim;
      if (!downed) {
        s.y = WATER_LEVEL - 1.25;
        s.vy = 0;
        s.grounded = false;
        s.slideT = 0;
        s.crouch = false;
      } else {
        s.y = Math.max(s.y, WATER_LEVEL - 0.7);
        s.vy = 0;
      }
    }
  }
}

function stepSwim(s: SimState, inp: InputCmd, dt: number, ctx: StepCtx, ev: SimEvent[], pressed: number) {
  const world = ctx.world;
  const fwd = forwardFromYawPitch(inp.yaw, 0);
  const right = rightFromYaw(inp.yaw);
  const mx = clamp(inp.mx, -1, 1);
  const mz = clamp(inp.mz, -1, 1);
  let wx = fwd.x * mz + right.x * mx;
  let wz = fwd.z * mz + right.z * mx;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) {
    wx /= wl;
    wz /= wl;
  }
  const sp = MOVE.swim * ((inp.buttons & BTN.SPRINT) ? 1.35 : 1);
  s.vx = approach(s.vx, wx * sp, 20 * dt);
  s.vz = approach(s.vz, wz * sp, 20 * dt);
  s.vy = 0;
  s.crouch = false;
  s.sprint = false;
  s.ads = false;
  s.y = approach(s.y, WATER_LEVEL - 1.25, 3 * dt);
  s.grounded = false;
  if (pressed & BTN.JUMP && mz > 0.1) {
    // climb out onto low ledges / docks
    s.grounded = false;
    if (tryMantle(s, world)) {
      ev.push({ t: 'mantle' });
      return;
    }
  }
  moveAndCollide(s, s.vx * dt, 0, s.vz * dt, world);
  const depth = waterDepthAt(world, s.x, s.z, s.y + 1);
  if (depth < 1.35) {
    const g = world.groundAt(s.x, s.z, s.y + STEP_HEIGHT + 0.6, PLAYER_RADIUS);
    if (g !== NO_GROUND) s.y = Math.max(s.y, g);
    s.mode = Mode.Walk;
    s.grounded = true;
  }
}

function stepAir(s: SimState, inp: InputCmd, dt: number, ctx: StepCtx, ev: SimEvent[], pressed: number) {
  const world = ctx.world;
  const fwd = forwardFromYawPitch(inp.yaw, 0);
  const right = rightFromYaw(inp.yaw);
  const mx = clamp(inp.mx, -1, 1);
  const mz = clamp(inp.mz, -1, 1);
  s.crouch = false;
  s.sprint = false;
  s.ads = false;
  s.slideT = 0;
  const hag = heightAboveGround(s, world);
  if (s.mode === Mode.Skydive) {
    const dive = s.pitch < -0.5 && mz > 0.2;
    const hs = MOVE.skydiveHoriz * (dive ? 1.35 : 1);
    const tx = (fwd.x * mz + right.x * mx) * hs;
    const tz = (fwd.z * mz + right.z * mx) * hs;
    s.vx = approach(s.vx, tx, 16 * dt);
    s.vz = approach(s.vz, tz, 16 * dt);
    const targetVy = dive ? -MOVE.skydiveDiveFall : -MOVE.skydiveFall;
    s.vy = approach(s.vy, targetVy, 30 * dt);
    if ((s.vy < 0 && hag < MOVE.glideAutoDeploy) || (pressed & BTN.JUMP && hag > MOVE.minManualDeploy)) {
      s.mode = Mode.Glide;
      ev.push({ t: 'deploy' });
    }
  } else {
    // Glide: always moving forward, input modulates speed and strafe
    const base = MOVE.glideHoriz * (mz > 0.2 ? 1.2 : mz < -0.2 ? 0.55 : 1);
    const dive = s.pitch < -0.6;
    const tx = fwd.x * base + right.x * mx * 7;
    const tz = fwd.z * base + right.z * mx * 7;
    s.vx = approach(s.vx, tx, 10 * dt);
    s.vz = approach(s.vz, tz, 10 * dt);
    s.vy = approach(s.vy, dive ? -MOVE.glideFall * 1.8 : -MOVE.glideFall, 20 * dt);
  }
  const wasGlide = s.mode === Mode.Glide;
  const res = moveAndCollide(s, s.vx * dt, s.vy * dt, s.vz * dt, world);
  if (res.landed || s.grounded) {
    s.mode = Mode.Walk;
    s.canGlide = false;
    s.grounded = true;
    if (!wasGlide && res.impact > MOVE.fallDamageSpeed) ev.push({ t: 'land', speed: res.impact });
    else if (res.impact > 4) ev.push({ t: 'land', speed: Math.min(res.impact, 8) });
    return;
  }
  if (s.y < WATER_LEVEL - 0.5 && waterDepthAt(world, s.x, s.z, s.y) > 1.45) {
    s.mode = Mode.Swim;
    s.canGlide = false;
    s.y = WATER_LEVEL - 1.25;
    s.vy = 0;
  }
}

// ---------------------------------------------------------------------------
// Weapons / consumables
// ---------------------------------------------------------------------------

export function spreadDegrees(s: SimState, w: WeaponStats, rarity: number) {
  let base = s.ads ? w.spreadAds : w.spreadHip;
  const moving = Math.hypot(s.vx, s.vz) > 1.2;
  let mult = 1;
  if (!s.grounded && s.mode === Mode.Walk) mult *= 1.8;
  else if (s.sprint) mult *= 1.5;
  else if (moving) mult *= 1.3;
  if (s.crouch && !moving) mult *= 0.75;
  if (w.cls === 'shotgun') mult = 1 + (mult - 1) * 0.3;
  base *= mult * RARITY_SPREAD[rarity];
  return base + s.bloom * (s.ads ? 0.6 : 1);
}

/** Deterministic pellet directions for a shot (server and client agree). */
export function shotDirections(playerId: number, shotSeq: number, dx: number, dy: number, dz: number, spreadDeg: number, pellets: number): number[] {
  const rnd = mulberry32(hash32(playerId, shotSeq, 0x5f3759df));
  // orthonormal basis around dir
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(dy) > 0.95) { ux = 1; uy = 0; }
  let rx = uy * dz - uz * dy, ry = uz * dx - ux * dz, rz = ux * dy - uy * dx;
  const rl = Math.hypot(rx, ry, rz);
  rx /= rl; ry /= rl; rz /= rl;
  const vx = dy * rz - dz * ry, vy = dz * rx - dx * rz, vz = dx * ry - dy * rx;
  const out: number[] = [];
  const spread = (spreadDeg * Math.PI) / 180;
  for (let p = 0; p < pellets; p++) {
    let a: number, th: number;
    if (pellets > 1 && p === 0) {
      a = spread * 0.15 * rnd();
      th = rnd() * Math.PI * 2;
    } else {
      a = spread * Math.sqrt(rnd());
      th = rnd() * Math.PI * 2;
    }
    const ta = Math.tan(a);
    const c = Math.cos(th) * ta, sn = Math.sin(th) * ta;
    let x = dx + rx * c + vx * sn, y = dy + ry * c + vy * sn, z = dz + rz * c + vz * sn;
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    out.push(x, y, z);
  }
  return out;
}

/** Eye position and aim direction (camera ray converged onto what the crosshair hits). */
export function aimRay(s: SimState, world: CollisionWorld, range: number) {
  const eyeY = s.y + eyeHeight(s);
  const f = forwardFromYawPitch(s.yaw, s.pitch);
  const rgt = rightFromYaw(s.yaw);
  const px = s.x + rgt.x * SHOULDER_RIGHT, py = eyeY + SHOULDER_UP, pz = s.z + rgt.z * SHOULDER_RIGHT;
  const hit = world.raycast(px, py, pz, f.x, f.y, f.z, range);
  let tx: number, ty: number, tz: number;
  if (hit && hit.t > 1.2) {
    tx = hit.x; ty = hit.y; tz = hit.z;
  } else {
    tx = px + f.x * range; ty = py + f.y * range; tz = pz + f.z * range;
  }
  const ox = s.x + rgt.x * 0.2, oy = eyeY, oz = s.z + rgt.z * 0.2;
  let dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const l = Math.hypot(dx, dy, dz);
  if (l < 1.5) {
    dx = f.x; dy = f.y; dz = f.z;
  } else {
    dx /= l; dy /= l; dz /= l;
  }
  return { ox, oy, oz, dx, dy, dz };
}

function stepEquipment(s: SimState, inp: InputCmd, dt: number, ctx: StepCtx, ev: SimEvent[], pressed: number) {
  const b = inp.buttons;
  s.cooldown = Math.max(0, s.cooldown - dt);
  s.equipT = Math.max(0, s.equipT - dt);

  // slot switching
  const want = inp.slot | 0;
  if (want !== SLOT_KEEP && want !== s.slot && want >= 0 && want < s.inv.slots.length && s.inv.slots[want]) {
    s.slot = want;
    const it = s.inv.slots[want]!;
    const def = ITEM_BY_CODE[it.code];
    s.equipT = def.weapon ? def.weapon.equipTime : 0.25;
    s.reloadT = 0;
    s.useT = -1;
    s.burstLeft = 0;
  }
  if (!s.inv.slots[s.slot]) s.slot = 0;

  const item = s.inv.slots[s.slot]!;
  const def = ITEM_BY_CODE[item.code];
  const w = def.weapon;
  if (w) s.bloom = Math.max(0, s.bloom - w.bloomRecover * dt);
  else s.bloom = 0;

  const building = (b & BTN.BUILD) !== 0;
  if (!canUseItems(s) || building || !ctx.canAttack || s.emote) {
    s.useT = -1;
    s.burstLeft = 0;
    if (building || !canUseItems(s)) s.reloadT = 0;
    // Harvesting is allowed pre-game (for fun), everything else waits.
    if (!(canUseItems(s) && !building && w && w.cls === 'melee' && !s.emote)) return;
  }

  const fireHeld = (b & BTN.FIRE) !== 0;
  const firePressed = (pressed & BTN.FIRE) !== 0;

  if (w) {
    // reload progress
    if (s.reloadT > 0) {
      s.reloadT -= dt;
      if (s.reloadT <= 0) {
        s.reloadT = 0;
        const ai = w.ammo ? ammoIndex(w.ammo) : -1;
        if (ai >= 0) {
          const need = w.mag - item.mag;
          const take = Math.min(need, s.inv.ammo[ai]);
          item.mag += take;
          s.inv.ammo[ai] -= take;
        }
      }
      return;
    }
    if (w.ammo && s.burstLeft === 0) {
      const ai = ammoIndex(w.ammo);
      const wantsReload = (b & BTN.RELOAD) !== 0 && item.mag < w.mag;
      const autoReload = item.mag === 0 && (fireHeld || s.cooldown <= 0);
      if ((wantsReload || autoReload) && s.inv.ammo[ai] > 0 && s.equipT <= 0) {
        s.reloadT = w.reload * RARITY_RELOAD[item.rarity];
        ev.push({ t: 'reload' });
        return;
      }
    }
    if (s.equipT > 0 || s.cooldown > 0) return;
    if (s.burstLeft > 0) {
      if (item.mag > 0) fireOnce(s, item, w, ctx, ev);
      s.burstLeft--;
      s.cooldown = s.burstLeft > 0 ? w.burstInterval : w.interval;
      if (item.mag <= 0) s.burstLeft = 0;
      return;
    }
    const trigger = w.auto ? fireHeld : firePressed;
    if (!trigger) return;
    if (w.cls === 'melee') {
      const eyeY = s.y + eyeHeight(s);
      const f = forwardFromYawPitch(s.yaw, s.pitch);
      ev.push({ t: 'melee', code: item.code, rarity: item.rarity, ox: s.x, oy: eyeY, oz: s.z, dx: f.x, dy: f.y, dz: f.z });
      s.cooldown = w.interval;
      s.sprint = false;
      return;
    }
    if (item.mag <= 0) return;
    fireOnce(s, item, w, ctx, ev);
    if (w.burst > 1) {
      s.burstLeft = w.burst - 1;
      s.cooldown = w.burstInterval;
    } else s.cooldown = w.interval;
    return;
  }

  if (def.use) {
    if (s.useT >= 0) {
      s.useT += dt;
      if (s.useT >= def.use.time) {
        s.useT = -1;
        s.cooldown = 0.3;
        ev.push({ t: 'used', code: item.code });
        item.count--;
        if (item.count <= 0) {
          s.inv.slots[s.slot] = null;
          s.slot = 0;
        }
      }
      return;
    }
    if (fireHeld && s.cooldown <= 0) {
      const u = def.use;
      const canHeal = (u.heal && s.hp < (u.healCap ?? 100)) || (u.shield && s.shield < (u.shieldCap ?? 100)) || (u.overTime && (s.hp < 100 || s.shield < 100));
      if (canHeal) s.useT = 0;
    }
    return;
  }

  if (def.throwable && firePressed && s.cooldown <= 0) {
    const f = forwardFromYawPitch(s.yaw, s.pitch + 0.12);
    const sp = def.throwable.speed;
    const eyeY = s.y + eyeHeight(s);
    ev.push({
      t: 'throw', code: item.code,
      ox: s.x + f.x * 0.6, oy: eyeY + 0.1, oz: s.z + f.z * 0.6,
      vx: f.x * sp + s.vx * 0.3, vy: f.y * sp + Math.max(0, s.vy) * 0.3, vz: f.z * sp + s.vz * 0.3,
    });
    s.cooldown = 0.7;
    item.count--;
    if (item.count <= 0) {
      s.inv.slots[s.slot] = null;
      s.slot = 0;
    }
    return;
  }

  if (def.utility && firePressed && s.cooldown <= 0 && s.grounded) {
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const d = def.utility === 'springpad' ? 1.8 : 0;
    ev.push({ t: 'utility', code: item.code, x: s.x + fx * d, y: s.y, z: s.z + fz * d, yaw: s.yaw });
    s.cooldown = 0.6;
    item.count--;
    if (item.count <= 0) {
      s.inv.slots[s.slot] = null;
      s.slot = 0;
    }
  }
}

function fireOnce(s: SimState, item: ItemStack, w: WeaponStats, ctx: StepCtx, ev: SimEvent[]) {
  const aim = aimRay(s, ctx.world, Math.min(w.range, 600));
  item.mag--;
  s.sprint = false;
  if (w.projectile) {
    ev.push({ t: 'rocket', code: item.code, rarity: item.rarity, ox: aim.ox, oy: aim.oy, oz: aim.oz, dx: aim.dx, dy: aim.dy, dz: aim.dz });
    s.shotSeq++;
    return;
  }
  const spread = spreadDegrees(s, w, item.rarity);
  const dirs = shotDirections(ctx.playerId, s.shotSeq, aim.dx, aim.dy, aim.dz, spread, w.pellets);
  ev.push({ t: 'shot', code: item.code, rarity: item.rarity, ox: aim.ox, oy: aim.oy, oz: aim.oz, dirs, seq: s.shotSeq });
  s.shotSeq++;
  s.bloom = Math.min(w.bloomMax, s.bloom + w.bloomPerShot);
}
