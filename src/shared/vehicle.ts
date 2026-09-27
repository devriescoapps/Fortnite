// Arcade vehicle simulation ("Dune Rover"). Driven by the driver's input stream on the server.
import { CollisionWorld, OwnerKind } from './collision';
import { WATER_LEVEL } from './constants';
import { clamp } from './math';
import { NO_GROUND } from './terrain';

export interface VehicleDef {
  id: string;
  name: string;
  maxSpeed: number;
  reverseSpeed: number;
  accel: number;
  brake: number;
  steer: number;
  hp: number;
  radius: number;
  seats: { x: number; y: number; z: number }[];
}

export const VEHICLES: VehicleDef[] = [
  {
    id: 'rover', name: 'Dune Rover', maxSpeed: 27, reverseSpeed: 9, accel: 15, brake: 32, steer: 1.9, hp: 700, radius: 1.5,
    seats: [
      { x: -0.45, y: 0.75, z: -0.1 },
      { x: 0.45, y: 0.75, z: -0.1 },
      { x: -0.45, y: 0.95, z: 1.05 },
      { x: 0.45, y: 0.95, z: 1.05 },
    ],
  },
];

export interface VehicleState {
  id: number;
  type: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  vy: number;
  hp: number;
  seats: number[]; // player ids (0 = empty)
  boost: number;
}

export interface VehicleInput {
  mx: number;
  mz: number;
  handbrake: boolean;
}

export interface VehicleHit {
  colliderOwnerKind: OwnerKind;
  ownerId: number;
  speed: number;
}

export function seatWorldPos(v: VehicleState, seat: number) {
  const def = VEHICLES[v.type];
  const s = def.seats[seat];
  const c = Math.cos(v.yaw), sn = Math.sin(v.yaw);
  // local +z is backwards (vehicle faces -Z at yaw 0)
  return { x: v.x + s.x * c + s.z * sn, y: v.y + s.y, z: v.z - s.x * sn + s.z * c };
}

/** Round to f32 so client replays of the driven vehicle match the server bit-for-bit. */
export function quantizeVehicle(v: VehicleState) {
  const f = Math.fround;
  v.x = f(v.x); v.y = f(v.y); v.z = f(v.z);
  v.yaw = f(v.yaw); v.pitch = f(v.pitch); v.roll = f(v.roll);
  v.speed = f(v.speed); v.vy = f(v.vy);
}

export function stepVehicle(v: VehicleState, inp: VehicleInput | null, dt: number, world: CollisionWorld, hits: VehicleHit[]) {
  const def = VEHICLES[v.type];
  const mz = inp ? clamp(inp.mz, -1, 1) : 0;
  const mx = inp ? clamp(inp.mx, -1, 1) : 0;
  const ground = world.groundAt(v.x, v.z, v.y + 1.2, 1.0);
  const onGround = ground !== NO_GROUND && v.y <= ground + 0.15;
  const inWater = v.y < WATER_LEVEL - 0.6;
  let maxSp = def.maxSpeed;
  if (inWater) maxSp = 3;

  if (onGround) {
    if (mz > 0.05) {
      if (v.speed < 0) v.speed = Math.min(0, v.speed + def.brake * dt);
      else v.speed += def.accel * mz * dt;
    } else if (mz < -0.05) {
      if (v.speed > 0) v.speed = Math.max(0, v.speed - def.brake * dt);
      else v.speed -= def.accel * 0.6 * -mz * dt;
    } else {
      const drag = 5 * dt;
      v.speed = Math.abs(v.speed) < drag ? 0 : v.speed - Math.sign(v.speed) * drag;
    }
    if (inp?.handbrake) v.speed *= Math.pow(0.2, dt);
    v.speed = clamp(v.speed, -def.reverseSpeed, maxSp);
    const steerK = clamp(v.speed / 7, -1, 1);
    v.yaw -= mx * def.steer * steerK * dt * (inp?.handbrake ? 1.5 : 1);
  }

  const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
  const nx = v.x + fx * v.speed * dt;
  const nz = v.z + fz * v.speed * dt;
  const blocker = world.overlaps(nx, v.y + 0.6, v.y + 1.7, nz, def.radius * 0.8);
  const th = world.terrain.heightAt(nx, nz);
  const tooSteep = th !== NO_GROUND && th > v.y + 1.1;
  if (blocker || tooSteep) {
    if (blocker) hits.push({ colliderOwnerKind: blocker.ownerKind, ownerId: blocker.ownerId, speed: Math.abs(v.speed) });
    v.speed *= -0.25;
  } else {
    v.x = nx;
    v.z = nz;
  }

  const g2 = world.groundAt(v.x, v.z, v.y + 1.2, 1.0);
  if (g2 === NO_GROUND || v.y > g2 + 0.05) {
    v.vy -= 22 * dt;
    v.y += v.vy * dt;
    if (g2 !== NO_GROUND && v.y < g2) {
      v.y = g2;
      v.vy = 0;
    }
  } else {
    v.y = g2;
    v.vy = 0;
  }
  if (v.y < WATER_LEVEL - 1.2) v.y = WATER_LEVEL - 1.2; // wade/float at shallow depth

  // orient to terrain
  const L = 1.8;
  const hf = sample(world, v.x + fx * L, v.z + fz * L, v.y);
  const hb = sample(world, v.x - fx * L, v.z - fz * L, v.y);
  const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
  const hr = sample(world, v.x + rx * 1.1, v.z + rz * 1.1, v.y);
  const hl = sample(world, v.x - rx * 1.1, v.z - rz * 1.1, v.y);
  const tp = Math.atan2(hf - hb, L * 2);
  const tr = Math.atan2(hr - hl, 2.2);
  v.pitch += (clamp(tp, -0.6, 0.6) - v.pitch) * Math.min(1, dt * 8);
  v.roll += (clamp(tr, -0.5, 0.5) - v.roll) * Math.min(1, dt * 8);
}

function sample(world: CollisionWorld, x: number, z: number, y: number) {
  const g = world.groundAt(x, z, y + 1.5, 0.3);
  return g === NO_GROUND ? y : g;
}
