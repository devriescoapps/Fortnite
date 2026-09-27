// Heightmap terrain shared by server (collision/validation) and client (render + prediction).
// Generation is deterministic from MAP_SEED so both sides build identical grids.
import { MAP_HALF, MAP_SEED, TERRAIN_N, TERRAIN_RES, WATER_LEVEL } from './constants';
import { clamp, lerp, smoothstep } from './math';
import { fbm, ridged } from './noise';
import { BIOME_CENTERS, Biome, LAKE, POIS, ROADS, poiById } from './pois';

export const NO_GROUND = -1e9;

export class Terrain {
  readonly n = TERRAIN_N;
  readonly res = TERRAIN_RES;
  readonly heights: Float32Array;
  /** One flag per terrain cell (n-1)^2: 1 = hole (no terrain surface, e.g. bunker shafts). */
  readonly holes: Uint8Array;

  constructor() {
    this.heights = new Float32Array(this.n * this.n);
    this.holes = new Uint8Array((this.n - 1) * (this.n - 1));
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const x = -MAP_HALF + i * this.res;
        const z = -MAP_HALF + j * this.res;
        this.heights[j * this.n + i] = rawHeight(x, z);
      }
    }
  }

  /** Mark a world-space rectangle (aligned to 4m cells) as holes. */
  addHole(minX: number, minZ: number, maxX: number, maxZ: number) {
    const n1 = this.n - 1;
    const i0 = Math.floor((minX + MAP_HALF) / this.res);
    const i1 = Math.ceil((maxX + MAP_HALF) / this.res) - 1;
    const j0 = Math.floor((minZ + MAP_HALF) / this.res);
    const j1 = Math.ceil((maxZ + MAP_HALF) / this.res) - 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (i >= 0 && j >= 0 && i < n1 && j < n1) this.holes[j * n1 + i] = 1;
    }
  }

  isHole(x: number, z: number) {
    const n1 = this.n - 1;
    const i = Math.floor((x + MAP_HALF) / this.res);
    const j = Math.floor((z + MAP_HALF) / this.res);
    if (i < 0 || j < 0 || i >= n1 || j >= n1) return false;
    return this.holes[j * n1 + i] === 1;
  }

  /** Raw surface height ignoring holes (used for rendering/placement). */
  surfaceAt(x: number, z: number): number {
    const fx = (x + MAP_HALF) / this.res;
    const fz = (z + MAP_HALF) / this.res;
    const n1 = this.n - 1;
    if (fx < 0 || fz < 0 || fx >= n1 || fz >= n1) return -16; // open ocean floor
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h = this.heights;
    const n = this.n;
    const h00 = h[j * n + i];
    const h10 = h[j * n + i + 1];
    const h01 = h[(j + 1) * n + i];
    const h11 = h[(j + 1) * n + i + 1];
    // Matches the render triangulation: (00,01,10) and (10,01,11)
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }

  /** Walkable ground height (NO_GROUND inside holes). */
  heightAt(x: number, z: number): number {
    if (this.isHole(x, z)) return NO_GROUND;
    return this.surfaceAt(x, z);
  }

  slopeAt(x: number, z: number) {
    const e = 1.5;
    const dx = this.surfaceAt(x + e, z) - this.surfaceAt(x - e, z);
    const dz = this.surfaceAt(x, z + e) - this.surfaceAt(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  }

  isLand(x: number, z: number) {
    return this.surfaceAt(x, z) > WATER_LEVEL + 0.8;
  }

  /** Ray march against the terrain. Returns distance or -1. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    const step = 1.0;
    let prevT = 0;
    let prevAbove = oy - this.heightAt(ox, oz);
    if (prevAbove < 0 && prevAbove > -50) return 0;
    for (let t = step; t <= maxT + step; t += step) {
      const tt = Math.min(t, maxT);
      const x = ox + dx * tt;
      const y = oy + dy * tt;
      const z = oz + dz * tt;
      if (y > 260 && dy > 0) return -1;
      const g = this.heightAt(x, z);
      const above = y - g;
      if (above <= 0 && g !== NO_GROUND) {
        // bisection refine
        let a = prevT;
        let b = tt;
        for (let k = 0; k < 8; k++) {
          const m = (a + b) * 0.5;
          const gm = this.heightAt(ox + dx * m, oz + dz * m);
          if (oy + dy * m - gm <= 0 && gm !== NO_GROUND) b = m;
          else a = m;
        }
        return b;
      }
      prevT = tt;
      prevAbove = above;
      if (tt >= maxT) break;
    }
    return -1;
  }
}

// ---------------------------------------------------------------------------
// Height function
// ---------------------------------------------------------------------------

const MOUNTAIN = { x: 360, z: -320 };
const DESERT = { x: -380, z: 320 };

export function rawHeight(x: number, z: number): number {
  const s = MAP_SEED;
  // Island silhouette with a wobbly coastline
  const wobble = fbm(x * 0.0035, z * 0.0035, s + 11, 4) * 0.2;
  const d = Math.hypot(x, z) / 560 + wobble;
  const land = smoothstep(1.04, 0.8, d);
  let h = -16 + land * 22;

  // Rolling hills
  h += fbm(x * 0.007, z * 0.007, s + 23, 5) * 9 * land;
  h += fbm(x * 0.02, z * 0.02, s + 29, 3) * 1.6 * land;

  // Frostpeak mountain range (north-east)
  const md = Math.hypot(x - MOUNTAIN.x, z - MOUNTAIN.z);
  const mMask = Math.exp(-Math.pow(md / 150, 2));
  h += mMask * 82 + ridged(x * 0.011, z * 0.011, s + 41, 5) * 34 * Math.exp(-Math.pow(md / 200, 2));
  // secondary ridge towards the facility
  const rd = Math.hypot(x - 200, z + 420);
  h += Math.exp(-Math.pow(rd / 90, 2)) * 30;

  // Sunscorch mesas (south-west): terraced plateaus
  const dd = Math.hypot(x - DESERT.x, z - DESERT.z);
  const dMask = smoothstep(230, 110, dd) * land;
  if (dMask > 0) {
    const mn = fbm(x * 0.011, z * 0.011, s + 53, 4);
    // three terrace levels (10 / 20 / 32m) with steep cliff edges between them
    const terr = 10 + smoothstep(-0.12, -0.05, mn) * 10 + smoothstep(0.17, 0.22, mn) * 12;
    h = lerp(h, terr + fbm(x * 0.05, z * 0.05, s + 57, 2) * 0.6, dMask);
  }

  // Mirror Lake in the forest
  const ld = Math.hypot(x - LAKE.x, z - LAKE.z);
  h = lerp(h, LAKE.depth, smoothstep(LAKE.r + 22, LAKE.r - 6, ld));

  // Flatten POIs to grid-aligned plateaus
  for (const p of POIS) {
    const pd = Math.hypot(x - p.x, z - p.z);
    const blend = p.kind === 'mountain' ? 30 : 46;
    const w = smoothstep(p.r + blend, p.r, pd);
    if (w > 0) h = lerp(h, p.h, w);
  }

  // Gentle road beds (smooth out bumps along roads)
  const rd2 = roadDistance(x, z);
  if (rd2 < 10 && h > 1) {
    const w = smoothstep(10, 3, rd2) * 0.5;
    h = lerp(h, Math.round(h), w);
  }
  return h;
}

let roadSegs: { ax: number; az: number; bx: number; bz: number }[] | null = null;
export function getRoadSegments() {
  if (!roadSegs) {
    roadSegs = ROADS.map(([a, b]) => {
      const pa = poiById(a);
      const pb = poiById(b);
      return { ax: pa.x, az: pa.z, bx: pb.x, bz: pb.z };
    });
  }
  return roadSegs;
}

export function roadDistance(x: number, z: number) {
  let best = Infinity;
  for (const s of getRoadSegments()) {
    const vx = s.bx - s.ax;
    const vz = s.bz - s.az;
    const l2 = vx * vx + vz * vz;
    const t = clamp(((x - s.ax) * vx + (z - s.az) * vz) / l2, 0, 1);
    const d = Math.hypot(x - (s.ax + vx * t), z - (s.az + vz * t));
    if (d < best) best = d;
  }
  return best;
}

/** Biome classification (weighted nearest region with noisy borders). */
export function biomeAt(x: number, z: number): Biome {
  const n = fbm(x * 0.01, z * 0.01, MAP_SEED + 71, 3) * 60;
  let best: Biome = 'plains';
  let bd = Infinity;
  for (const c of BIOME_CENTERS) {
    const d = (Math.hypot(x - c.x, z - c.z) + n) / c.w;
    if (d < bd) {
      bd = d;
      best = c.biome;
    }
  }
  return best;
}
