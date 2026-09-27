// "The Surge": shrinking safe-zone definitions and interpolation helpers.
import { lerp } from './math';

export interface StormPhaseDef {
  wait: number; // seconds holding before the shrink
  shrink: number; // seconds to close to the next circle
  radius: number; // radius of the safe circle after this phase
  dps: number; // damage per second outside the safe zone during this phase
}

export const STORM_PHASES: StormPhaseDef[] = [
  { wait: 60, shrink: 50, radius: 380, dps: 1 },
  { wait: 50, shrink: 45, radius: 230, dps: 2 },
  { wait: 45, shrink: 40, radius: 130, dps: 4 },
  { wait: 35, shrink: 35, radius: 70, dps: 6 },
  { wait: 30, shrink: 30, radius: 35, dps: 8 },
  { wait: 25, shrink: 28, radius: 14, dps: 10 },
  { wait: 20, shrink: 25, radius: 0, dps: 14 },
];

export const STORM_INITIAL_RADIUS = 800;

export interface Circle {
  x: number;
  z: number;
  r: number;
}

/** Replicated storm state. Clients interpolate between `from` and `to` locally. */
export interface StormState {
  phase: number; // index into STORM_PHASES, -1 = not started
  stage: 'idle' | 'wait' | 'shrink' | 'done';
  t0: number; // stage start (match time)
  t1: number; // stage end (match time)
  from: Circle; // current safe circle at stage start
  to: Circle; // next safe circle
  dps: number;
}

export function initialStorm(): StormState {
  const c = { x: 0, z: 0, r: STORM_INITIAL_RADIUS };
  return { phase: -1, stage: 'idle', t0: 0, t1: 0, from: { ...c }, to: { ...c }, dps: 0 };
}

export function stormCircleAt(s: StormState, t: number): Circle {
  if (s.stage === 'shrink') {
    const k = Math.min(1, Math.max(0, (t - s.t0) / Math.max(0.001, s.t1 - s.t0)));
    return { x: lerp(s.from.x, s.to.x, k), z: lerp(s.from.z, s.to.z, k), r: lerp(s.from.r, s.to.r, k) };
  }
  if (s.stage === 'done') return { ...s.to };
  return { ...s.from };
}

export function isInStorm(s: StormState, t: number, x: number, z: number) {
  if (s.stage === 'idle') return false;
  const c = stormCircleAt(s, t);
  return Math.hypot(x - c.x, z - c.z) > c.r;
}

/** Distance outside the safe zone (0 if inside). */
export function distanceToSafety(s: StormState, t: number, x: number, z: number) {
  const c = stormCircleAt(s, t);
  return Math.max(0, Math.hypot(x - c.x, z - c.z) - c.r);
}
