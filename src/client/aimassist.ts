// Aim assist for touch and gamepad players. Pure math (no DOM/three) so it is unit-tested.
//
// It only ever adjusts the local view yaw/pitch — the server still resolves every shot from
// the input stream, so assist can't create hits the player's view didn't produce. Three parts:
//  - friction: look input slows down while the crosshair is over/near a target
//  - magnetism: while the player is actively moving/looking, the view drifts toward the target
//  - ADS snap: pressing aim with a target near the crosshair closes part of the gap
// Targets are pre-filtered by the caller (enemies only, line of sight checked).

export interface AssistTarget {
  id: number;
  x: number;
  y: number; // aim point (chest height)
  z: number;
}

export interface AssistPick {
  target: AssistTarget;
  dYaw: number; // signed angular gap (target - view)
  dPitch: number;
  ang: number; // angular distance (radians)
  radius: number; // capture radius used for this target (radians)
  dist: number;
}

export interface AssistInput {
  yaw: number;
  pitch: number;
  /** View rotation the player asked for this frame (radians, already sensitivity-scaled). */
  lookYaw: number;
  lookPitch: number;
  /** Player is moving the stick / dragging / firing (magnetism only helps an active player). */
  active: boolean;
  ads: boolean;
  /** Rising edge of ADS this frame. */
  adsPressed: boolean;
  dt: number;
  strength: number; // 0..1
}

const TAU = Math.PI * 2;
export const wrap = (a: number) => {
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
};

/** Yaw/pitch (engine convention: yaw 0 looks toward -Z) from an origin toward a point. */
export function anglesTo(ox: number, oy: number, oz: number, x: number, y: number, z: number) {
  const dx = x - ox, dy = y - oy, dz = z - oz;
  const h = Math.hypot(dx, dz);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, h), dist: Math.hypot(h, dy) };
}

/**
 * Best target inside the capture cone. The cone widens for nearby targets so a body-sized
 * silhouette is always catchable (angular half-size of ~0.6 m at the target distance).
 * `visible` is called in order of increasing angle until one passes (limits raycasts).
 */
export function pickTarget(
  yaw: number, pitch: number, ox: number, oy: number, oz: number, targets: AssistTarget[],
  opts: { cone: number; maxRange: number; visible?: (t: AssistTarget) => boolean; maxChecks?: number },
): AssistPick | null {
  const cands: AssistPick[] = [];
  for (const t of targets) {
    const a = anglesTo(ox, oy, oz, t.x, t.y, t.z);
    if (a.dist > opts.maxRange || a.dist < 0.5) continue;
    const dYaw = wrap(a.yaw - yaw);
    const dPitch = a.pitch - pitch;
    // yaw error shrinks toward the poles; weight it by cos(pitch) for a true angular distance
    const ang = Math.hypot(dYaw * Math.cos(pitch), dPitch);
    const radius = opts.cone + Math.atan2(0.6, a.dist);
    if (ang > radius) continue;
    cands.push({ target: t, dYaw, dPitch, ang, radius, dist: a.dist });
  }
  cands.sort((p, q) => p.ang / p.radius - q.ang / q.radius);
  const max = opts.maxChecks ?? 3;
  for (let i = 0; i < cands.length && i < max; i++) {
    if (!opts.visible || opts.visible(cands[i].target)) return cands[i];
  }
  return null;
}

/** Apply friction, magnetism and ADS snap. Returns the new view angles. */
export function applyAssist(inp: AssistInput, pick: AssistPick | null): { yaw: number; pitch: number } {
  let { lookYaw, lookPitch } = inp;
  let yaw = inp.yaw, pitch = inp.pitch;
  const k = Math.max(0, Math.min(1, inp.strength));
  if (!pick || k === 0) return { yaw: wrap(yaw + lookYaw), pitch: pitch + lookPitch };
  const close = Math.max(0, 1 - pick.ang / pick.radius); // 1 = dead on, 0 = cone edge

  // friction: slow the player's own look while near the target (never below 45% speed)
  const fr = 1 - k * 0.55 * close;
  lookYaw *= fr;
  lookPitch *= fr;
  yaw += lookYaw;
  pitch += lookPitch;

  // recompute the gap after the player's input
  let dYaw = wrap(pick.dYaw - lookYaw);
  let dPitch = pick.dPitch - lookPitch;

  // ADS snap: close a fraction of the gap immediately
  if (inp.adsPressed) {
    const f = 0.65 * k;
    yaw += dYaw * f;
    pitch += dPitch * f;
    dYaw *= 1 - f;
    dPitch *= 1 - f;
  }

  // magnetism: bounded angular speed toward the target, only while the player is active
  if (inp.active) {
    const gap = Math.hypot(dYaw, dPitch);
    if (gap > 1e-5) {
      const rate = k * (inp.ads ? 0.9 : 0.55) * (0.35 + 0.65 * close); // rad/s
      const step = Math.min(gap, rate * inp.dt);
      yaw += (dYaw / gap) * step;
      pitch += (dPitch / gap) * step;
    }
  }
  return { yaw: wrap(yaw), pitch };
}

/** True when the view ray passes within the target's body (used for optional auto-fire). */
export function onTarget(pick: AssistPick | null) {
  if (!pick) return false;
  return pick.ang < Math.atan2(0.42, pick.dist);
}
