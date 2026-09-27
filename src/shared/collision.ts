// Collision world: terrain + spatially-hashed colliders (props, build pieces).
// Used identically by the server (authoritative) and the client (prediction).
import { GRID } from './constants';
import { rayAABB } from './math';
import { NO_GROUND, Terrain } from './terrain';

export const enum Shape {
  Box = 0,
  Ramp = 1, // sloped slab rising along `dir`
  Roof = 2, // pyramid ("cone") piece
}

export const enum OwnerKind {
  Static = 0, // non-harvestable scenery
  Prop = 1, // harvestable prop (tree, rock, car...)
  Piece = 2, // build piece (map or player)
}

export interface Collider {
  id: number;
  shape: Shape;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  dir: number; // ramp rise direction 0:+X 1:+Z 2:-X 3:-Z
  y0: number; // base height for ramp/roof
  ownerKind: OwnerKind;
  ownerId: number;
  blocksShots: boolean;
  _q: number; // query stamp (dedupe)
}

export interface RayHit {
  t: number;
  x: number;
  y: number;
  z: number;
  kind: 'terrain' | 'collider';
  collider?: Collider;
}

const CELL = 8;
const OFF = 2048;
const cellKey = (ix: number, iz: number) => (ix + OFF) * 8192 + (iz + OFF);
export const RAMP_THICK = 0.35;
export const ROOF_PEAK = 1.6;

export function rampSurface(c: Collider, x: number, z: number) {
  const size = c.maxX - c.minX;
  let t: number;
  switch (c.dir) {
    case 0: t = (x - c.minX) / size; break;
    case 1: t = (z - c.minZ) / size; break;
    case 2: t = (c.maxX - x) / size; break;
    default: t = (c.maxZ - z) / size; break;
  }
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return c.y0 + t * size;
}

export function roofSurface(c: Collider, x: number, z: number) {
  const size = c.maxX - c.minX;
  const u = Math.abs((x - (c.minX + c.maxX) * 0.5) / size);
  const v = Math.abs((z - (c.minZ + c.maxZ) * 0.5) / size);
  const m = Math.min(0.5, Math.max(u, v));
  return c.y0 + ROOF_PEAK * (1 - m * 2);
}

function surfaceOf(c: Collider, x: number, z: number) {
  const cx = x < c.minX ? c.minX : x > c.maxX ? c.maxX : x;
  const cz = z < c.minZ ? c.minZ : z > c.maxZ ? c.maxZ : z;
  return c.shape === Shape.Ramp ? rampSurface(c, cx, cz) : roofSurface(c, cx, cz);
}

export class CollisionWorld {
  readonly colliders = new Map<number, Collider>();
  private cells = new Map<number, number[]>();
  private nextId = 1;
  private stamp = 1;
  private tmp: Collider[] = [];

  constructor(public terrain: Terrain) {}

  add(c: Omit<Collider, 'id' | '_q'>): Collider {
    const col = c as Collider;
    col.id = this.nextId++;
    col._q = 0;
    this.colliders.set(col.id, col);
    const ix0 = Math.floor(col.minX / CELL), ix1 = Math.floor(col.maxX / CELL);
    const iz0 = Math.floor(col.minZ / CELL), iz1 = Math.floor(col.maxZ / CELL);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const k = cellKey(ix, iz);
      let arr = this.cells.get(k);
      if (!arr) this.cells.set(k, (arr = []));
      arr.push(col.id);
    }
    return col;
  }

  remove(id: number) {
    const col = this.colliders.get(id);
    if (!col) return;
    this.colliders.delete(id);
    const ix0 = Math.floor(col.minX / CELL), ix1 = Math.floor(col.maxX / CELL);
    const iz0 = Math.floor(col.minZ / CELL), iz1 = Math.floor(col.maxZ / CELL);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const arr = this.cells.get(cellKey(ix, iz));
      if (!arr) continue;
      const i = arr.indexOf(id);
      if (i >= 0) {
        arr[i] = arr[arr.length - 1];
        arr.pop();
      }
    }
  }

  /** Collect colliders whose XZ bounds overlap the rectangle. Result array is reused. */
  queryXZ(minX: number, minZ: number, maxX: number, maxZ: number): Collider[] {
    const out = this.tmp;
    out.length = 0;
    const s = ++this.stamp;
    const ix0 = Math.floor(minX / CELL), ix1 = Math.floor(maxX / CELL);
    const iz0 = Math.floor(minZ / CELL), iz1 = Math.floor(maxZ / CELL);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const arr = this.cells.get(cellKey(ix, iz));
      if (!arr) continue;
      for (let n = 0; n < arr.length; n++) {
        const c = this.colliders.get(arr[n])!;
        if (c._q === s) continue;
        c._q = s;
        if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
        out.push(c);
      }
    }
    return out;
  }

  /**
   * Highest walkable surface under a player footprint whose height is <= topY.
   * Returns NO_GROUND when nothing is below (holes / off map).
   */
  groundAt(x: number, z: number, topY: number, r: number): number {
    let best = this.terrain.heightAt(x, z);
    if (best > topY) best = NO_GROUND; // terrain above feet (inside hill) is not ground from here
    const list = this.queryXZ(x - r, z - r, x + r, z + r);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      let top: number;
      if (c.shape === Shape.Box) {
        top = c.maxY;
      } else {
        if (x < c.minX - 0.05 || x > c.maxX + 0.05 || z < c.minZ - 0.05 || z > c.maxZ + 0.05) continue;
        top = surfaceOf(c, x, z);
      }
      if (top <= topY && top > best) best = top;
    }
    return best;
  }

  /** Does a player box [x±r, yLo..yHi, z±r] overlap any solid collider? */
  overlaps(x: number, yLo: number, yHi: number, z: number, r: number): Collider | null {
    const list = this.queryXZ(x - r, z - r, x + r, z + r);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.shape === Shape.Box) {
        if (c.maxY > yLo && c.minY < yHi) return c;
      } else {
        const s = surfaceOf(c, x, z);
        if (s > yLo && s - RAMP_THICK < yHi) return c;
      }
    }
    return null;
  }

  /** Raycast against colliders and terrain. `filter` can reject colliders. */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxT: number,
    filter?: (c: Collider) => boolean,
    skipTerrain = false,
  ): RayHit | null {
    let bestT = maxT;
    let bestC: Collider | null = null;
    const s = ++this.stamp;
    // 2D DDA across hash cells
    let ix = Math.floor(ox / CELL);
    let iz = Math.floor(oz / CELL);
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dx) > 1e-9 ? Math.abs(CELL / dx) : Infinity;
    const tDeltaZ = Math.abs(dz) > 1e-9 ? Math.abs(CELL / dz) : Infinity;
    let tMaxX = Math.abs(dx) > 1e-9 ? ((dx > 0 ? (ix + 1) * CELL - ox : ox - ix * CELL) / Math.abs(dx)) : Infinity;
    let tMaxZ = Math.abs(dz) > 1e-9 ? ((dz > 0 ? (iz + 1) * CELL - oz : oz - iz * CELL) / Math.abs(dz)) : Infinity;
    let tCell = 0;
    for (let guard = 0; guard < 400; guard++) {
      if (tCell > bestT) break;
      const arr = this.cells.get(cellKey(ix, iz));
      if (arr) {
        for (let n = 0; n < arr.length; n++) {
          const c = this.colliders.get(arr[n])!;
          if (c._q === s) continue;
          c._q = s;
          if (!c.blocksShots) continue;
          if (filter && !filter(c)) continue;
          const t = rayCollider(c, ox, oy, oz, dx, dy, dz, bestT);
          if (t >= 0 && t < bestT) {
            bestT = t;
            bestC = c;
          }
        }
      }
      if (tMaxX < tMaxZ) {
        tCell = tMaxX;
        tMaxX += tDeltaX;
        ix += stepX;
      } else {
        tCell = tMaxZ;
        tMaxZ += tDeltaZ;
        iz += stepZ;
      }
    }
    if (!skipTerrain) {
      const tt = this.terrain.raycast(ox, oy, oz, dx, dy, dz, bestT);
      if (tt >= 0 && tt < bestT) {
        return { t: tt, x: ox + dx * tt, y: oy + dy * tt, z: oz + dz * tt, kind: 'terrain' };
      }
    }
    if (bestC) {
      return { t: bestT, x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT, kind: 'collider', collider: bestC };
    }
    return null;
  }
}

function rayCollider(c: Collider, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  const tBox = rayAABB(ox, oy, oz, dx, dy, dz, c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ, maxT);
  if (tBox < 0) return -1;
  if (c.shape === Shape.Box) return tBox;
  // Ramp / roof: march inside the bounds until the ray passes below the surface slab.
  const tExit = Math.min(maxT, tBox + (c.maxX - c.minX) * 2.5 + (c.maxY - c.minY) * 2);
  const step = 0.08;
  for (let t = tBox; t <= tExit; t += step) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    if (x < c.minX - 0.01 || x > c.maxX + 0.01 || z < c.minZ - 0.01 || z > c.maxZ + 0.01) continue;
    const s = c.shape === Shape.Ramp ? rampSurface(c, x, z) : roofSurface(c, x, z);
    if (y <= s && y >= s - RAMP_THICK - 0.1) return t;
  }
  return -1;
}

export const GRID_SIZE = GRID;
