// Aim assist math: capture cone, friction, magnetism, ADS snap, LOS filtering, auto-fire check.
import { describe, expect, it } from 'vitest';
import { AssistInput, anglesTo, applyAssist, onTarget, pickTarget, wrap } from '../src/client/aimassist';

// shooter at the origin (eye 1.6 m) looking north (yaw 0 = -Z)
const O = { x: 0, y: 1.6, z: 0 };
const base = (o: Partial<AssistInput> = {}): AssistInput => ({ yaw: 0, pitch: 0, lookYaw: 0, lookPitch: 0, active: false, ads: false, adsPressed: false, dt: 1 / 60, strength: 1, ...o });
/** A target `deg` degrees to the right of the view at distance d. */
const rightOf = (deg: number, d: number, id = 1) => {
  const a = (-deg * Math.PI) / 180; // turning right = negative yaw
  return { id, x: -Math.sin(a) * d, y: 1.6, z: -Math.cos(a) * d };
};

describe('aim assist', () => {
  it('uses the engine yaw convention and wraps angles', () => {
    expect(anglesTo(0, 0, 0, 0, 0, -10).yaw).toBeCloseTo(0);
    expect(anglesTo(0, 0, 0, 10, 0, 0).yaw).toBeCloseTo(-Math.PI / 2);
    expect(wrap(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(Math.abs(wrap(-Math.PI * 2 + 0.1) - 0.1)).toBeLessThan(1e-9);
  });

  it('captures targets inside the cone only, preferring the one nearest the crosshair', () => {
    const cone = 0.1;
    const near = rightOf(3, 40, 1), far = rightOf(5, 40, 2), outside = rightOf(20, 40, 3);
    const p = pickTarget(0, 0, O.x, O.y, O.z, [far, outside, near], { cone, maxRange: 150 });
    expect(p?.target.id).toBe(1);
    expect(p!.dYaw).toBeLessThan(0); // target is to the right
    expect(pickTarget(0, 0, O.x, O.y, O.z, [outside], { cone, maxRange: 150 })).toBeNull();
    expect(pickTarget(0, 0, O.x, O.y, O.z, [rightOf(2, 200)], { cone, maxRange: 150 })).toBeNull();
    // the cone widens for close targets (a body 3 m away at 15 degrees is still catchable)
    expect(pickTarget(0, 0, O.x, O.y, O.z, [rightOf(15, 3)], { cone, maxRange: 150 })).not.toBeNull();
  });

  it('skips targets that fail the line-of-sight check', () => {
    const a = rightOf(1, 30, 1), b = rightOf(4, 30, 2);
    const p = pickTarget(0, 0, O.x, O.y, O.z, [a, b], { cone: 0.1, maxRange: 150, visible: (t) => t.id !== 1 });
    expect(p?.target.id).toBe(2);
    expect(pickTarget(0, 0, O.x, O.y, O.z, [a], { cone: 0.1, maxRange: 150, visible: () => false })).toBeNull();
  });

  it('friction slows the look input near a target but never stops it', () => {
    const pick = pickTarget(0, 0, O.x, O.y, O.z, [rightOf(0.5, 30)], { cone: 0.1, maxRange: 150 });
    const out = applyAssist(base({ lookYaw: 0.02 }), pick);
    expect(out.yaw).toBeGreaterThan(0.02 * 0.44);
    expect(out.yaw).toBeLessThan(0.02 * 0.8);
    const free = applyAssist(base({ lookYaw: 0.02 }), null);
    expect(free.yaw).toBeCloseTo(0.02);
  });

  it('magnetism only pulls an active player, at a bounded rate, without overshooting', () => {
    const pick = pickTarget(0, 0, O.x, O.y, O.z, [rightOf(3, 40)], { cone: 0.1, maxRange: 150 })!;
    expect(applyAssist(base(), pick).yaw).toBe(0); // idle: no drift
    const one = applyAssist(base({ active: true }), pick);
    expect(one.yaw).toBeLessThan(0); // toward the target (right)
    expect(Math.abs(one.yaw)).toBeLessThan(0.02); // ~1 degree/frame at most
    // many frames converge on the target but never pass it
    let v = { yaw: 0, pitch: 0 };
    const t = rightOf(3, 40);
    for (let i = 0; i < 600; i++) {
      const p = pickTarget(v.yaw, v.pitch, O.x, O.y, O.z, [t], { cone: 0.1, maxRange: 150 });
      v = applyAssist(base({ ...v, active: true }), p);
    }
    expect(v.yaw).toBeCloseTo(pick.dYaw, 3);
  });

  it('ADS snap closes most of the gap in one press; strength 0 disables everything', () => {
    const pick = pickTarget(0, 0, O.x, O.y, O.z, [rightOf(4, 25)], { cone: 0.12, maxRange: 150 })!;
    const snap = applyAssist(base({ adsPressed: true, ads: true }), pick);
    expect(Math.abs(snap.yaw - pick.dYaw)).toBeLessThan(Math.abs(pick.dYaw) * 0.4);
    const off = applyAssist(base({ adsPressed: true, active: true, lookYaw: 0.01, strength: 0 }), pick);
    expect(off.yaw).toBeCloseTo(0.01);
  });

  it('auto-fire triggers only when the crosshair is on the body', () => {
    const on = pickTarget(0, 0, O.x, O.y, O.z, [rightOf(0.3, 30)], { cone: 0.1, maxRange: 150 });
    const off = pickTarget(0, 0, O.x, O.y, O.z, [rightOf(4, 30)], { cone: 0.1, maxRange: 150 });
    expect(onTarget(on)).toBe(true);
    expect(onTarget(off)).toBe(false);
    expect(onTarget(null)).toBe(false);
  });
});
