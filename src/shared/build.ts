// Building system: grid-snapped pieces, colliders, connectivity/support and targeting.
// Both map structures and player-built structures are made of these pieces, so every
// house on the island is destructible and harvestable.
import { BUILD_RANGE, GRID, STEP_HEIGHT } from './constants';
import { Collider, CollisionWorld, OwnerKind, ROOF_PEAK, Shape } from './collision';
import { NO_GROUND, Terrain } from './terrain';

export type PieceType = 'wall' | 'floor' | 'ramp' | 'roof';
export const PIECE_TYPES: PieceType[] = ['wall', 'floor', 'ramp', 'roof'];
export const PIECE_CODE: Record<PieceType, number> = { wall: 0, floor: 1, ramp: 2, roof: 3 };
export const PIECE_FROM_CODE: PieceType[] = ['wall', 'floor', 'ramp', 'roof'];

export const enum WallVariant {
  Solid = 0,
  Window = 1,
  Door = 2,
}

export type BuildMat = 'timber' | 'stone' | 'alloy';
export const BUILD_MATS: BuildMat[] = ['timber', 'stone', 'alloy'];

export interface MaterialDef {
  id: string;
  code: number;
  name: string;
  maxHp: number;
  buildTime: number; // seconds to reach full HP (player builds)
  harvest: BuildMat | null; // what hitting it with the harvest tool yields
  harvestPerHit: number;
  indestructible?: boolean;
  color: number;
}

export const MATERIALS: MaterialDef[] = [
  { id: 'timber', code: 0, name: 'Timber', maxHp: 150, buildTime: 2.5, harvest: null, harvestPerHit: 0, color: 0xc8904f },
  { id: 'stone', code: 1, name: 'Stone', maxHp: 300, buildTime: 5, harvest: null, harvestPerHit: 0, color: 0x9aa3ad },
  { id: 'alloy', code: 2, name: 'Alloy', maxHp: 500, buildTime: 8, harvest: null, harvestPerHit: 0, color: 0x6f8fb8 },
  { id: 'plank', code: 3, name: 'Plank', maxHp: 250, buildTime: 0, harvest: 'timber', harvestPerHit: 7, color: 0xe7d3a8 },
  { id: 'brick', code: 4, name: 'Brick', maxHp: 400, buildTime: 0, harvest: 'stone', harvestPerHit: 6, color: 0xc8644a },
  { id: 'concrete', code: 5, name: 'Concrete', maxHp: 500, buildTime: 0, harvest: 'stone', harvestPerHit: 6, color: 0xd4d8de },
  { id: 'steel', code: 6, name: 'Steel', maxHp: 550, buildTime: 0, harvest: 'alloy', harvestPerHit: 5, color: 0x8a9aa8 },
  { id: 'glass', code: 7, name: 'Glass', maxHp: 90, buildTime: 0, harvest: null, harvestPerHit: 0, color: 0x9fe3ff },
  { id: 'bunker', code: 8, name: 'Bunker Plate', maxHp: 99999, buildTime: 0, harvest: null, harvestPerHit: 0, indestructible: true, color: 0x505a66 },
  { id: 'adobe', code: 9, name: 'Adobe', maxHp: 350, buildTime: 0, harvest: 'stone', harvestPerHit: 6, color: 0xe0a26e },
  { id: 'shingle', code: 10, name: 'Shingle', maxHp: 250, buildTime: 0, harvest: 'timber', harvestPerHit: 6, color: 0x4f6fb0 },
];
export const MAT_BY_ID: Record<string, MaterialDef> = Object.fromEntries(MATERIALS.map((m) => [m.id, m]));

export interface PieceSpec {
  type: PieceType;
  i: number;
  j: number;
  k: number;
  d: number; // wall: 0 = spans X (at z=k*G), 1 = spans Z (at x=i*G). ramp: rise dir 0..3
}

export interface Piece extends PieceSpec {
  id: number;
  variant: number;
  mat: number; // material code
  hp: number;
  maxHp: number;
  owner: number; // player id, 0 = map
  team: number;
  anchored: boolean; // map pieces never collapse
  grounded: boolean;
  tint: number; // color tint for rendering
  buildStart: number; // match time when placed
  buildTime: number;
  colliderIds: number[];
}

export function slotKey(s: PieceSpec) {
  switch (s.type) {
    case 'wall': return `w${s.i},${s.j},${s.k},${s.d}`;
    case 'floor': return `f${s.i},${s.j},${s.k}`;
    case 'ramp': return `r${s.i},${s.j},${s.k}`;
    default: return `c${s.i},${s.j},${s.k}`;
  }
}

/** Center of a piece in world space (for range checks / effects). */
export function pieceCenter(s: PieceSpec) {
  const G = GRID;
  switch (s.type) {
    case 'wall':
      return s.d === 0
        ? { x: (s.i + 0.5) * G, y: (s.j + 0.5) * G, z: s.k * G }
        : { x: s.i * G, y: (s.j + 0.5) * G, z: (s.k + 0.5) * G };
    case 'floor': return { x: (s.i + 0.5) * G, y: s.j * G, z: (s.k + 0.5) * G };
    case 'ramp': return { x: (s.i + 0.5) * G, y: (s.j + 0.5) * G, z: (s.k + 0.5) * G };
    default: return { x: (s.i + 0.5) * G, y: s.j * G + ROOF_PEAK * 0.5, z: (s.k + 0.5) * G };
  }
}

type ColliderInit = Omit<Collider, 'id' | '_q' | 'ownerKind' | 'ownerId' | 'blocksShots'>;

/** Collider shapes for a piece (walls with windows/doors are split into segments). */
export function pieceColliderShapes(s: PieceSpec, variant = 0): ColliderInit[] {
  const G = GRID;
  const x0 = s.i * G, y0 = s.j * G, z0 = s.k * G;
  const out: ColliderInit[] = [];
  const box = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) =>
    out.push({ shape: Shape.Box, minX, minY, minZ, maxX, maxY, maxZ, dir: 0, y0: 0 });
  const T = 0.15;
  switch (s.type) {
    case 'floor':
      box(x0, y0 - 0.25, z0, x0 + G, y0 + 0.05, z0 + G);
      break;
    case 'wall': {
      // segments along the wall's length axis (a) and height (y)
      const segs: [number, number, number, number][] = []; // a0,a1,h0,h1 (relative)
      if (variant === WallVariant.Window) {
        segs.push([0, 1.2, 0, G], [G - 1.2, G, 0, G], [1.2, G - 1.2, 0, 1.2], [1.2, G - 1.2, 2.8, G]);
      } else if (variant === WallVariant.Door) {
        segs.push([0, 1.3, 0, G], [G - 1.3, G, 0, G], [1.3, G - 1.3, 2.7, G]);
      } else {
        segs.push([0, G, 0, G]);
      }
      for (const [a0, a1, h0, h1] of segs) {
        if (s.d === 0) box(x0 + a0, y0 + h0, z0 - T, x0 + a1, y0 + h1, z0 + T);
        else box(x0 - T, y0 + h0, z0 + a0, x0 + T, y0 + h1, z0 + a1);
      }
      break;
    }
    case 'ramp':
      out.push({ shape: Shape.Ramp, minX: x0, minY: y0 - 0.4, minZ: z0, maxX: x0 + G, maxY: y0 + G, maxZ: z0 + G, dir: s.d, y0 });
      break;
    case 'roof':
      out.push({ shape: Shape.Roof, minX: x0, minY: y0 - 0.4, minZ: z0, maxX: x0 + G, maxY: y0 + ROOF_PEAK, maxZ: z0 + G, dir: 0, y0 });
      break;
  }
  return out;
}

/** Grid edges (between adjacent grid vertices) a piece touches; shared edges = connection. */
export function pieceEdges(s: PieceSpec): string[] {
  const { i, j, k } = s;
  const e = (a: number[], b: number[]) => {
    const ka = `${a[0]},${a[1]},${a[2]}`;
    const kb = `${b[0]},${b[1]},${b[2]}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const cellEdges = (lvl: number) => [
    e([i, lvl, k], [i + 1, lvl, k]),
    e([i, lvl, k + 1], [i + 1, lvl, k + 1]),
    e([i, lvl, k], [i, lvl, k + 1]),
    e([i + 1, lvl, k], [i + 1, lvl, k + 1]),
  ];
  switch (s.type) {
    case 'floor':
    case 'roof':
      return cellEdges(j);
    case 'wall':
      if (s.d === 0) {
        return [
          e([i, j, k], [i + 1, j, k]),
          e([i, j + 1, k], [i + 1, j + 1, k]),
          e([i, j, k], [i, j + 1, k]),
          e([i + 1, j, k], [i + 1, j + 1, k]),
        ];
      }
      return [
        e([i, j, k], [i, j, k + 1]),
        e([i, j + 1, k], [i, j + 1, k + 1]),
        e([i, j, k], [i, j + 1, k]),
        e([i, j, k + 1], [i, j + 1, k + 1]),
      ];
    case 'ramp': {
      const low = cellEdges(j);
      const high = cellEdges(j + 1);
      // dir: 0 +X (low edge at x=i), 1 +Z (low at z=k), 2 -X (low at x=i+1), 3 -Z (low at z=k+1)
      const lowIdx = [2, 0, 3, 1][s.d];
      const highIdx = [3, 1, 2, 0][s.d];
      const sideIdx = s.d % 2 === 0 ? [0, 1] : [2, 3];
      return [low[lowIdx], high[highIdx], low[sideIdx[0]], low[sideIdx[1]], high[sideIdx[0]], high[sideIdx[1]]];
    }
  }
}

/** Is the piece touching (or buried in) terrain? */
export function isPieceGrounded(s: PieceSpec, terrain: Terrain): boolean {
  const G = GRID;
  const y = s.j * G;
  const pts: [number, number][] = [];
  const x0 = s.i * G, z0 = s.k * G;
  switch (s.type) {
    case 'floor':
    case 'roof':
      pts.push([x0 + 0.3, z0 + 0.3], [x0 + G - 0.3, z0 + 0.3], [x0 + 0.3, z0 + G - 0.3], [x0 + G - 0.3, z0 + G - 0.3], [x0 + G / 2, z0 + G / 2]);
      break;
    case 'wall':
      if (s.d === 0) pts.push([x0 + 0.3, z0], [x0 + G / 2, z0], [x0 + G - 0.3, z0]);
      else pts.push([x0, z0 + 0.3], [x0, z0 + G / 2], [x0, z0 + G - 0.3]);
      break;
    case 'ramp': {
      const lo: [number, number][] = [
        [[x0 + 0.3, z0 + 0.3], [x0 + 0.3, z0 + G - 0.3]],
        [[x0 + 0.3, z0 + 0.3], [x0 + G - 0.3, z0 + 0.3]],
        [[x0 + G - 0.3, z0 + 0.3], [x0 + G - 0.3, z0 + G - 0.3]],
        [[x0 + 0.3, z0 + G - 0.3], [x0 + G - 0.3, z0 + G - 0.3]],
      ][s.d] as [number, number][];
      pts.push(...lo, [x0 + G / 2, z0 + G / 2]);
      break;
    }
  }
  for (const [px, pz] of pts) {
    const h = terrain.heightAt(px, pz);
    if (h !== NO_GROUND && h >= y - 0.6) return true;
  }
  return false;
}

export interface PlaceResult {
  ok: boolean;
  reason?: string;
}

/**
 * Authoritative piece storage with support graph. The server owns the truth; clients
 * mirror it from replication events (and predict their own placements).
 */
export class BuildGrid {
  readonly pieces = new Map<number, Piece>();
  readonly byKey = new Map<string, number>();
  private edges = new Map<string, Set<number>>();
  private nextId = 1;

  constructor(public world: CollisionWorld) {}

  allocId() {
    return this.nextId++;
  }

  get(id: number) {
    return this.pieces.get(id);
  }

  at(spec: PieceSpec) {
    const id = this.byKey.get(slotKey(spec));
    return id !== undefined ? this.pieces.get(id) : undefined;
  }

  add(p: Piece) {
    if (p.id >= this.nextId) this.nextId = p.id + 1;
    const key = slotKey(p);
    const existing = this.byKey.get(key);
    if (existing !== undefined) this.remove(existing);
    this.pieces.set(p.id, p);
    this.byKey.set(key, p.id);
    for (const e of pieceEdges(p)) {
      let s = this.edges.get(e);
      if (!s) this.edges.set(e, (s = new Set()));
      s.add(p.id);
    }
    p.colliderIds = [];
    for (const shape of pieceColliderShapes(p, p.variant)) {
      const c = this.world.add({ ...shape, ownerKind: OwnerKind.Piece, ownerId: p.id, blocksShots: true });
      p.colliderIds.push(c.id);
    }
  }

  remove(id: number): Piece | undefined {
    const p = this.pieces.get(id);
    if (!p) return undefined;
    this.pieces.delete(id);
    const key = slotKey(p);
    if (this.byKey.get(key) === id) this.byKey.delete(key);
    for (const e of pieceEdges(p)) {
      const s = this.edges.get(e);
      if (s) {
        s.delete(id);
        if (s.size === 0) this.edges.delete(e);
      }
    }
    for (const cid of p.colliderIds) this.world.remove(cid);
    return p;
  }

  neighbors(spec: PieceSpec, selfId = -1): number[] {
    const out = new Set<number>();
    for (const e of pieceEdges(spec)) {
      const s = this.edges.get(e);
      if (!s) continue;
      for (const id of s) if (id !== selfId) out.add(id);
    }
    return [...out];
  }

  /** Validate a player placement (slot free, supported, sane height). */
  canPlace(spec: PieceSpec, terrain: Terrain): PlaceResult {
    if (spec.j < -3 || spec.j > 45) return { ok: false, reason: 'height' };
    if (spec.type === 'wall' && spec.d !== 0 && spec.d !== 1) return { ok: false, reason: 'dir' };
    if (spec.type === 'ramp' && (spec.d < 0 || spec.d > 3)) return { ok: false, reason: 'dir' };
    if (this.byKey.has(slotKey(spec))) return { ok: false, reason: 'occupied' };
    if (isPieceGrounded(spec, terrain)) return { ok: true };
    if (this.neighbors(spec).length > 0) return { ok: true };
    return { ok: false, reason: 'unsupported' };
  }

  /**
   * After pieces were removed, find pieces that lost their path to the ground.
   * Returns ids that should collapse.
   */
  findUnsupported(candidateIds: Iterable<number>): number[] {
    const doomed = new Set<number>();
    const safe = new Set<number>();
    for (const start of candidateIds) {
      if (!this.pieces.has(start) || doomed.has(start) || safe.has(start)) continue;
      const visited = new Set<number>([start]);
      const queue = [start];
      let grounded = false;
      while (queue.length && visited.size < 4000) {
        const id = queue.shift()!;
        const p = this.pieces.get(id)!;
        if (p.anchored || p.grounded || safe.has(id)) {
          grounded = true;
          break;
        }
        for (const n of this.neighbors(p, id)) {
          if (!visited.has(n) && this.pieces.has(n) && !doomed.has(n)) {
            visited.add(n);
            queue.push(n);
          }
        }
      }
      if (visited.size >= 4000) grounded = true; // bail out: treat huge structures as supported
      for (const id of visited) (grounded ? safe : doomed).add(id);
    }
    return [...doomed];
  }
}

// ---------------------------------------------------------------------------
// Targeting: where a piece goes given the player's position and view.
// ---------------------------------------------------------------------------

export function buildTarget(
  type: PieceType,
  x: number,
  feetY: number,
  z: number,
  yaw: number,
  pitch: number,
  grid: BuildGrid | null,
): PieceSpec {
  const G = GRID;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const alongX = Math.abs(fx) >= Math.abs(fz);
  const sgn = alongX ? (fx >= 0 ? 1 : -1) : fz >= 0 ? 1 : -1;
  const ci = Math.floor(x / G);
  const ck = Math.floor(z / G);
  let level = Math.floor((feetY + 0.3) / G);
  // Standing on a ramp that rises the way we face: target the level above (ramp rushing).
  let onRampUp = false;
  if (grid) {
    const lvl = Math.floor((feetY - 0.1) / G);
    const r = grid.at({ type: 'ramp', i: ci, j: lvl, k: ck, d: 0 });
    if (r) {
      const rampDir = [1, 1, -1, -1][r.d];
      const rampAlongX = r.d % 2 === 0;
      if (rampAlongX === alongX && rampDir === sgn) {
        onRampUp = true;
        level = r.j + 1;
      } else level = r.j;
    }
  }
  const fi = ci + (alongX ? sgn : 0);
  const fk = ck + (alongX ? 0 : sgn);
  const rampDir = alongX ? (sgn > 0 ? 0 : 2) : sgn > 0 ? 1 : 3;
  switch (type) {
    case 'wall': {
      const lv = level + (pitch > 0.75 ? 1 : 0);
      if (alongX) return { type, i: sgn > 0 ? ci + 1 : ci, j: lv, k: ck, d: 1 };
      return { type, i: ci, j: lv, k: sgn > 0 ? ck + 1 : ck, d: 0 };
    }
    case 'floor':
      if (pitch < -0.8 && !onRampUp) return { type, i: ci, j: level, k: ck, d: 0 };
      if (pitch > 0.7) return { type, i: ci, j: level + 1, k: ck, d: 0 };
      return { type, i: fi, j: level, k: fk, d: 0 };
    case 'ramp':
      if (pitch < -0.85 && !onRampUp) return { type, i: ci, j: level, k: ck, d: rampDir };
      return { type, i: fi, j: level, k: fk, d: rampDir };
    case 'roof':
      if (pitch > 0) return { type, i: ci, j: level + 1, k: ck, d: 0 };
      return { type, i: fi, j: level + 1, k: fk, d: 0 };
  }
}

export function inBuildRange(spec: PieceSpec, x: number, y: number, z: number) {
  const c = pieceCenter(spec);
  return Math.hypot(c.x - x, c.y - y, c.z - z) <= BUILD_RANGE + STEP_HEIGHT;
}
