import { beforeAll, describe, expect, it } from 'vitest';
import { BuildGrid, Piece, buildTarget, isPieceGrounded, slotKey } from '../src/shared/build';
import { CollisionWorld } from '../src/shared/collision';
import { GRID, INPUT_DT, SKYPORT } from '../src/shared/constants';
import { ITEM_BY_ID, makeStack } from '../src/shared/items';
import { createIsland } from '../src/shared/mapdata';
import { BTN, InputCmd, Mode, SimEvent, SimState, createSim, stepSim } from '../src/shared/sim';

let world: CollisionWorld;
let grid: BuildGrid;
let terrain: ReturnType<typeof createIsland>['terrain'];

beforeAll(() => {
  const isl = createIsland();
  world = isl.world;
  grid = isl.grid;
  terrain = isl.terrain;
});

const inp = (o: Partial<InputCmd> = {}): InputCmd => ({ seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, slot: 0, viewTick: 0, ...o });

function run(s: SimState, n: number, i: Partial<InputCmd> = {}, ev: SimEvent[] = []) {
  for (let k = 0; k < n; k++) stepSim(s, inp(i), INPUT_DT, { world, playerId: 1, canAttack: true }, ev);
  return ev;
}

function flatSpot() {
  // somewhere flat on the island away from structures: search the plains
  for (let x = -60; x < 60; x += 4) for (let z = 250; z < 380; z += 4) {
    if (terrain.slopeAt(x, z) < 0.05 && terrain.heightAt(x, z) > 3 && !world.overlaps(x, terrain.heightAt(x, z) + 0.1, terrain.heightAt(x, z) + 6, z, 6)) {
      return { x, z, y: terrain.heightAt(x, z) };
    }
  }
  throw new Error('no flat spot');
}

describe('movement', () => {
  it('lands on the skyport deck and stays grounded', () => {
    const s = createSim(SKYPORT.x - 20, SKYPORT.y + 3, SKYPORT.z);
    run(s, 60);
    expect(s.grounded).toBe(true);
    expect(s.y).toBeCloseTo(SKYPORT.y, 1);
  });

  it('runs forward at run speed and faster when sprinting', () => {
    const p = flatSpot();
    const s = createSim(p.x, p.y + 0.5, p.z);
    run(s, 30);
    const z0 = s.z;
    run(s, 60, { mz: 1 });
    const walked = z0 - s.z;
    expect(walked).toBeGreaterThan(5);
    expect(walked).toBeLessThan(6.6);
    const z1 = s.z;
    run(s, 60, { mz: 1, buttons: BTN.SPRINT });
    expect(z1 - s.z).toBeGreaterThan(walked + 1);
  });

  it('jumps and lands', () => {
    const p = flatSpot();
    const s = createSim(p.x, p.y + 0.2, p.z);
    run(s, 20);
    const ev = run(s, 1, { buttons: BTN.JUMP });
    expect(ev.some((e) => e.t === 'jump')).toBe(true);
    let maxY = s.y;
    for (let k = 0; k < 60; k++) {
      run(s, 1);
      maxY = Math.max(maxY, s.y);
    }
    expect(maxY - p.y).toBeGreaterThan(1.0);
    expect(s.grounded).toBe(true);
  });

  it('is blocked by a built wall and can climb a ramp', () => {
    const p = flatSpot();
    const i = Math.floor(p.x / GRID), k = Math.floor(p.z / GRID);
    const j = Math.floor((terrain.heightAt((i + 0.5) * GRID, (k + 0.5) * GRID) + 0.3) / GRID);
    const mk = (type: Piece['type'], ii: number, jj: number, kk: number, d: number): Piece => ({
      id: grid.allocId(), type, i: ii, j: jj, k: kk, d, variant: 0, mat: 0, hp: 150, maxHp: 150, owner: 1, team: 0,
      anchored: false, grounded: true, tint: 0, buildStart: 0, buildTime: 0, colliderIds: [],
    });
    // wall on the -Z edge of the cell in front
    const wall = mk('wall', i, j, k - 1, 0);
    grid.add(wall);
    const s = createSim((i + 0.5) * GRID, p.y + 0.3, (k + 0.5) * GRID);
    run(s, 20);
    run(s, 120, { mz: 1 }); // walk toward -Z
    expect(s.z).toBeGreaterThan((k - 1) * GRID);
    grid.remove(wall.id);

    // ramp rising towards -Z in the next cell
    const ramp = mk('ramp', i, j, k - 1, 3);
    grid.add(ramp);
    const s2 = createSim((i + 0.5) * GRID, p.y + 0.3, (k + 0.5) * GRID);
    run(s2, 20);
    let top = s2.y;
    for (let n = 0; n < 90; n++) {
      run(s2, 1, { mz: 1 });
      top = Math.max(top, s2.y);
    }
    expect(top).toBeGreaterThan(j * GRID + 3);
    grid.remove(ramp.id);
  });

  it('mantles onto a crate-height ledge', () => {
    const p = flatSpot();
    const i = Math.floor(p.x / GRID), k = Math.floor(p.z / GRID);
    const bx = (i + 0.5) * GRID;
    const bz = (k - 1) * GRID;
    const g = terrain.heightAt(bx, bz);
    const c = world.add({ shape: 0, minX: bx - 2, minY: g, minZ: bz - 3, maxX: bx + 2, maxY: g + 1.5, maxZ: bz, dir: 0, y0: 0, ownerKind: 0, ownerId: 0, blocksShots: true });
    const s = createSim(bx, g + 0.2, bz + 0.8);
    run(s, 20);
    const ev = run(s, 1, { mz: 1, buttons: BTN.JUMP });
    expect(ev.some((e) => e.t === 'mantle')).toBe(true);
    run(s, 40, { mz: 0 });
    expect(s.mode).toBe(Mode.Walk);
    expect(s.y).toBeGreaterThan(g + 1.4);
    world.remove(c.id);
  });

  it('skydives, auto-deploys the glider and lands', () => {
    const p = flatSpot();
    const s = createSim(p.x, p.y + 180, p.z);
    s.mode = Mode.Skydive;
    const ev: SimEvent[] = [];
    let n = 0;
    while ((s.mode as Mode) !== Mode.Walk && n < 60 * 60) {
      run(s, 1, {}, ev);
      n++;
    }
    expect(ev.some((e) => e.t === 'deploy')).toBe(true);
    expect(s.mode).toBe(Mode.Walk);
    expect(Math.abs(s.y - terrain.heightAt(s.x, s.z))).toBeLessThan(1.5);
  });

  it('swims in deep water', () => {
    // find deep sea
    const s = createSim(0, 5, 610);
    s.mode = Mode.Walk;
    run(s, 120);
    expect(s.mode).toBe(Mode.Swim);
    expect(s.y).toBeLessThan(0);
  });
});

describe('weapons', () => {
  it('fires, respects fire rate and reloads', () => {
    const p = flatSpot();
    const s = createSim(p.x, p.y + 0.2, p.z);
    s.inv.slots[1] = makeStack('vanguard', 2);
    s.inv.ammo[1] = 60;
    run(s, 10, { slot: 1 });
    run(s, 30, { slot: 1 }); // equip
    const ev = run(s, 60, { slot: 1, buttons: BTN.FIRE });
    const shots = ev.filter((e) => e.t === 'shot').length;
    const w = ITEM_BY_ID.vanguard.weapon!;
    expect(shots).toBeGreaterThanOrEqual(Math.floor(1 / w.interval) - 1);
    expect(shots).toBeLessThanOrEqual(Math.ceil(1 / w.interval) + 1);
    expect(s.inv.slots[1]!.mag).toBe(30 - shots);
    run(s, 1, { slot: 1, buttons: BTN.RELOAD });
    run(s, 200, { slot: 1 });
    expect(s.inv.slots[1]!.mag).toBe(30);
    expect(s.inv.ammo[1]).toBe(60 - shots);
  });

  it('shotgun pellets are deterministic per shot', async () => {
    const { shotDirections } = await import('../src/shared/sim');
    const a = shotDirections(7, 3, 0, 0, -1, 6, 10);
    const b = shotDirections(7, 3, 0, 0, -1, 6, 10);
    const c = shotDirections(7, 4, 0, 0, -1, 6, 10);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(30);
  });
});

describe('build grid', () => {
  it('validates support and collapses unsupported pieces', () => {
    const p = flatSpot();
    const i = Math.floor(p.x / GRID) + 3, k = Math.floor(p.z / GRID) + 3;
    const j = Math.floor((terrain.heightAt((i + 0.5) * GRID, (k + 0.5) * GRID) + 0.3) / GRID);
    const mk = (type: Piece['type'], ii: number, jj: number, kk: number, d: number): Piece => ({
      id: grid.allocId(), type, i: ii, j: jj, k: kk, d, variant: 0, mat: 0, hp: 150, maxHp: 150, owner: 1, team: 0,
      anchored: false, grounded: false, tint: 0, buildStart: 0, buildTime: 0, colliderIds: [],
    });
    const floating = { type: 'floor' as const, i, j: j + 3, k, d: 0 };
    expect(grid.canPlace(floating, terrain).ok).toBe(false);
    const w1 = mk('wall', i, j, k, 0);
    w1.grounded = isPieceGrounded(w1, terrain);
    expect(w1.grounded).toBe(true);
    grid.add(w1);
    const w2 = mk('wall', i, j + 1, k, 0);
    expect(grid.canPlace(w2, terrain).ok).toBe(true);
    grid.add(w2);
    const f = mk('floor', i, j + 2, k, 0);
    expect(grid.canPlace(f, terrain).ok).toBe(true);
    grid.add(f);
    expect(grid.canPlace(f, terrain).reason).toBe('occupied');
    // remove the bottom wall: everything above should collapse
    grid.remove(w1.id);
    const doomed = grid.findUnsupported(grid.neighbors(w1, w1.id));
    expect(doomed.sort()).toEqual([w2.id, f.id].sort());
    for (const id of doomed) grid.remove(id);
    expect(grid.byKey.has(slotKey(f))).toBe(false);
  });

  it('targets the cell in front when looking forward', () => {
    const t = buildTarget('wall', 2, 0, 2, 0, 0, null); // facing -Z from cell (0,0)
    expect(t).toMatchObject({ type: 'wall', i: 0, k: 0, d: 0 });
    const r = buildTarget('ramp', 2, 0, 2, Math.PI / 2, 0, null); // facing -X
    expect(r).toMatchObject({ type: 'ramp', i: -1, k: 0, d: 2 });
  });
});
