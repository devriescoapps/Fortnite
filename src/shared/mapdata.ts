// Deterministic island content: POI structures (made of destructible build pieces),
// scenery props, loot/chest spawn points, vehicles, traversal and rebirth spires.
// Server and client both call generateMap() and get byte-identical results.
import { BuildGrid, MAT_BY_ID, PieceSpec, PieceType, WallVariant, isPieceGrounded, slotKey } from './build';
import { CollisionWorld, OwnerKind, Shape } from './collision';
import { GRID, MAP_SEED, SKYPORT } from './constants';
import { POIS, Poi, poiById } from './pois';
import { RNG } from './rng';
import { Terrain, biomeAt, getRoadSegments, roadDistance } from './terrain';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PropType {
  id: string;
  hp: number; // 0 = indestructible scenery
  harvest: 'timber' | 'stone' | 'alloy' | null;
  perHit: number;
  half: [number, number, number];
  collide: boolean;
}

export const PROP_TYPES: PropType[] = [
  { id: 'pine', hp: 260, harvest: 'timber', perHit: 8, half: [0.35, 3.4, 0.35], collide: true },
  { id: 'oak', hp: 300, harvest: 'timber', perHit: 9, half: [0.45, 2.6, 0.45], collide: true },
  { id: 'birch', hp: 200, harvest: 'timber', perHit: 7, half: [0.3, 3.2, 0.3], collide: true },
  { id: 'palm', hp: 180, harvest: 'timber', perHit: 7, half: [0.3, 3.6, 0.3], collide: true },
  { id: 'snowpine', hp: 260, harvest: 'timber', perHit: 8, half: [0.35, 3.4, 0.35], collide: true },
  { id: 'cactus', hp: 120, harvest: 'timber', perHit: 6, half: [0.4, 1.7, 0.4], collide: true },
  { id: 'rock', hp: 350, harvest: 'stone', perHit: 9, half: [1.3, 0.9, 1.3], collide: true },
  { id: 'boulder', hp: 700, harvest: 'stone', perHit: 12, half: [2.6, 1.9, 2.6], collide: true },
  { id: 'car', hp: 400, harvest: 'alloy', perHit: 7, half: [1.0, 0.75, 2.1], collide: true },
  { id: 'truck', hp: 600, harvest: 'alloy', perHit: 9, half: [1.2, 1.4, 3.2], collide: true },
  { id: 'container', hp: 700, harvest: 'alloy', perHit: 10, half: [1.25, 1.3, 3.0], collide: true },
  { id: 'crate', hp: 100, harvest: 'timber', perHit: 6, half: [0.6, 0.6, 0.6], collide: true },
  { id: 'barrel', hp: 80, harvest: 'alloy', perHit: 4, half: [0.4, 0.55, 0.4], collide: true },
  { id: 'haybale', hp: 80, harvest: 'timber', perHit: 5, half: [0.8, 0.6, 0.6], collide: true },
  { id: 'fence', hp: 60, harvest: 'timber', perHit: 4, half: [2.0, 0.6, 0.1], collide: true },
  { id: 'lamp', hp: 120, harvest: 'alloy', perHit: 4, half: [0.12, 3, 0.12], collide: true },
  { id: 'bush', hp: 0, harvest: null, perHit: 0, half: [0.9, 0.6, 0.9], collide: false },
  { id: 'silo', hp: 0, harvest: null, perHit: 0, half: [3, 7, 3], collide: true },
  { id: 'tank', hp: 0, harvest: null, perHit: 0, half: [3.5, 3.5, 3.5], collide: true },
  { id: 'dish', hp: 0, harvest: null, perHit: 0, half: [2.2, 3, 2.2], collide: true },
  { id: 'antenna', hp: 0, harvest: null, perHit: 0, half: [0.4, 9, 0.4], collide: true },
  { id: 'crane', hp: 0, harvest: null, perHit: 0, half: [1, 11, 1], collide: true },
  { id: 'spire', hp: 0, harvest: null, perHit: 0, half: [0.7, 3.5, 0.7], collide: true },
  { id: 'watertower', hp: 0, harvest: null, perHit: 0, half: [2, 5, 2], collide: true },
  { id: 'chimney', hp: 0, harvest: null, perHit: 0, half: [1.2, 8, 1.2], collide: true },
  { id: 'pillar', hp: 0, harvest: null, perHit: 0, half: [0.25, 2, 0.25], collide: true },
  { id: 'pump', hp: 150, harvest: 'alloy', perHit: 5, half: [0.4, 0.8, 0.3], collide: true },
  { id: 'boat', hp: 300, harvest: 'timber', perHit: 8, half: [1.2, 0.6, 3], collide: true },
  { id: 'bench', hp: 60, harvest: 'timber', perHit: 4, half: [1, 0.4, 0.3], collide: true },
  { id: 'bunkerlamp', hp: 0, harvest: null, perHit: 0, half: [0.5, 0.1, 0.5], collide: false },
  { id: 'dumpster', hp: 250, harvest: 'alloy', perHit: 6, half: [1.1, 0.7, 0.7], collide: true },
  { id: 'tractor', hp: 400, harvest: 'alloy', perHit: 8, half: [1, 1.1, 1.8], collide: true },
  { id: 'launchpad', hp: 0, harvest: null, perHit: 0, half: [1.2, 0.15, 1.2], collide: false },
  { id: 'deadtree', hp: 150, harvest: 'timber', perHit: 7, half: [0.3, 2.6, 0.3], collide: true },
];
export const PROP_INDEX: Record<string, number> = Object.fromEntries(PROP_TYPES.map((p, i) => [p.id, i]));

export interface PropInst {
  id: number;
  t: number; // PROP_TYPES index
  x: number;
  y: number;
  z: number;
  rot: number; // radians (boxes use multiples of PI/2)
  s: number; // scale
  tint: number;
}

export function propAABB(p: PropInst) {
  const T = PROP_TYPES[p.t];
  let hx = T.half[0] * p.s, hz = T.half[2] * p.s;
  const hy = T.half[1] * p.s;
  const q = Math.round(p.rot / (Math.PI / 2)) & 1;
  if (q === 1) {
    const t = hx;
    hx = hz;
    hz = t;
  }
  return { minX: p.x - hx, minY: p.y, minZ: p.z - hz, maxX: p.x + hx, maxY: p.y + hy * 2, maxZ: p.z + hz };
}

// ---------------------------------------------------------------------------
// Map data
// ---------------------------------------------------------------------------

export interface MapPiece extends PieceSpec {
  variant: number;
  mat: number;
  tint: number;
}

export interface Spot {
  x: number;
  y: number;
  z: number;
  tier: number;
  rot?: number;
}

export interface StaticBox {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  color: number;
}

export interface MapData {
  props: PropInst[];
  pieces: MapPiece[];
  lootSpots: Spot[];
  chestSpots: Spot[];
  ammoSpots: Spot[];
  vehicleSpots: { x: number; z: number; yaw: number }[];
  launchPads: { x: number; y: number; z: number }[];
  spires: { x: number; y: number; z: number }[];
  statics: StaticBox[];
  lights: { x: number; y: number; z: number; color: number }[];
  undervault: { minX: number; minZ: number; maxX: number; maxZ: number; y: number };
}

const cellOf = (v: number) => Math.floor(v / GRID);

const WALL_TINTS = [0xf6e7c8, 0xcfe8ff, 0xffd6d6, 0xd8f5c8, 0xfff1a8, 0xe6d6ff, 0xffe0bd];
const ROOF_TINTS = [0xd9534f, 0x3f7fbf, 0x4caf50, 0x8d5b3a, 0x6a4c9c, 0xe07b39];
const CONTAINER_TINTS = [0xd64541, 0x2f78c4, 0x3aa35b, 0xe89a2c, 0x7a52c7, 0x2bb3b1];
const CAR_TINTS = [0xff5a5f, 0x2ec4b6, 0xffd23f, 0x3a86ff, 0xf7f7ff, 0x8338ec, 0xfb5607];

class MapBuilder {
  pieces: MapPiece[] = [];
  keys = new Map<string, number>();
  props: PropInst[] = [];
  lootSpots: Spot[] = [];
  chestSpots: Spot[] = [];
  ammoSpots: Spot[] = [];
  lights: MapData['lights'] = [];

  constructor(public terrain: Terrain, public rng: RNG) {}

  piece(type: PieceType, i: number, j: number, k: number, d: number, mat: string, variant = 0, tint = 0) {
    const spec = { type, i, j, k, d };
    const key = slotKey(spec);
    const mp: MapPiece = { ...spec, variant, mat: MAT_BY_ID[mat].code, tint };
    const ex = this.keys.get(key);
    if (ex !== undefined) {
      this.pieces[ex] = mp;
      return;
    }
    this.keys.set(key, this.pieces.length);
    this.pieces.push(mp);
  }
  floor(i: number, j: number, k: number, mat: string, tint = 0) {
    this.piece('floor', i, j, k, 0, mat, 0, tint);
  }
  wall(i: number, j: number, k: number, d: number, mat: string, variant = 0, tint = 0) {
    this.piece('wall', i, j, k, d, mat, variant, tint);
  }
  ramp(i: number, j: number, k: number, dir: number, mat: string, tint = 0) {
    this.piece('ramp', i, j, k, dir, mat, 0, tint);
  }
  roof(i: number, j: number, k: number, mat: string, tint = 0) {
    this.piece('roof', i, j, k, 0, mat, 0, tint);
  }
  removeSlot(spec: PieceSpec) {
    const key = slotKey(spec);
    const ex = this.keys.get(key);
    if (ex === undefined) return;
    this.pieces[ex] = null as unknown as MapPiece;
    this.keys.delete(key);
  }
  prop(type: string, x: number, z: number, opts: { y?: number; rot?: number; s?: number; tint?: number } = {}) {
    const y = opts.y ?? this.terrain.surfaceAt(x, z);
    this.props.push({ id: this.props.length, t: PROP_INDEX[type], x, y, z, rot: opts.rot ?? 0, s: opts.s ?? 1, tint: opts.tint ?? 0 });
  }
  loot(x: number, y: number, z: number, tier: number) {
    this.lootSpots.push({ x, y, z, tier });
  }
  chest(x: number, y: number, z: number, tier: number, rot = 0) {
    this.chestSpots.push({ x, y, z, tier, rot });
  }

  /** Box building with floors, perimeter walls, optional stairs and a roof. */
  building(o: {
    ci: number; ck: number; j: number; w: number; d: number; floors: number;
    wallMat: string; wallTint?: number; roof: 'gable' | 'flat' | 'none'; roofMat?: string; roofTint?: number;
    windowChance?: number; doorSide?: 'n' | 's' | 'e' | 'w'; tier: number; broken?: number; glassFloors?: boolean;
    chestChance?: number; floorMat?: string; tallWalls?: number;
  }) {
    const { ci, ck, j, w, d, floors, wallMat } = o;
    const rng = this.rng;
    const tint = o.wallTint ?? 0;
    const floorMat = o.floorMat ?? (wallMat === 'glass' ? 'concrete' : wallMat);
    const winC = o.windowChance ?? 0.35;
    const wallLevels = o.tallWalls ?? 1; // wall stacks per floor (warehouses are 2 high)
    const stairCells = new Set<string>();
    const useCore = floors > 1 && d >= 3 && w >= 2;
    for (let f = 0; f < floors; f++) {
      const lv = j + f * wallLevels;
      for (let i = ci; i < ci + w; i++) for (let k = ck; k < ck + d; k++) this.floor(i, lv, k, floorMat, 0);
      for (let s = 0; s < wallLevels; s++) {
        const wl = lv + s;
        const glassRow = o.glassFloors && f % 2 === 1;
        const mat = glassRow ? 'glass' : wallMat;
        for (let i = ci; i < ci + w; i++) {
          for (const kk of [ck, ck + d]) {
            if (o.broken && rng.chance(o.broken)) continue;
            const v = glassRow ? 0 : rng.chance(winC) && s === 0 ? WallVariant.Window : 0;
            this.wall(i, wl, kk, 0, mat, v, glassRow ? 0 : tint);
          }
        }
        for (let k = ck; k < ck + d; k++) {
          for (const ii of [ci, ci + w]) {
            if (o.broken && rng.chance(o.broken)) continue;
            const v = glassRow ? 0 : rng.chance(winC) && s === 0 ? WallVariant.Window : 0;
            this.wall(ii, wl, k, 1, mat, v, glassRow ? 0 : tint);
          }
        }
      }
    }
    // doors on the ground floor
    const side = o.doorSide ?? 's';
    const doorAt = (s: 'n' | 's' | 'e' | 'w') => {
      if (s === 'n' || s === 's') {
        const i = ci + Math.floor(w / 2);
        this.wall(i, j, s === 'n' ? ck : ck + d, 0, wallMat === 'glass' ? 'concrete' : wallMat, WallVariant.Door, tint);
      } else {
        const k = ck + Math.floor(d / 2);
        this.wall(s === 'w' ? ci : ci + w, j, k, 1, wallMat === 'glass' ? 'concrete' : wallMat, WallVariant.Door, tint);
      }
    };
    doorAt(side);
    if (w * d >= 9) doorAt(side === 's' ? 'n' : side === 'n' ? 's' : side === 'e' ? 'w' : 'e');

    // stairs
    const topLevel = j + floors * wallLevels;
    const stairsToRoof = o.roof === 'flat';
    const flights = floors - 1 + (stairsToRoof ? 1 : 0);
    if (wallLevels === 1) {
      for (let f = 0; f < flights; f++) {
        const lv = j + f;
        if (useCore) {
          // switchback core: column a (ci) rises +Z, column b (ci+1) rises -Z, rows ck..ck+2
          if (f % 2 === 0) {
            this.ramp(ci, lv, ck + 1, 1, floorMat);
            this.removeSlot({ type: 'floor', i: ci, j: lv + 1, k: ck + 1, d: 0 });
            stairCells.add(`${ci},${ck + 1}`);
          } else {
            this.ramp(ci + 1, lv, ck + 1, 3, floorMat);
            this.removeSlot({ type: 'floor', i: ci + 1, j: lv + 1, k: ck + 1, d: 0 });
            stairCells.add(`${ci + 1},${ck + 1}`);
          }
        } else if (w >= 2 && f < w - 1) {
          // straight diagonal staircase along +X
          const si = ci + f;
          this.ramp(si, lv, ck, 0, floorMat);
          this.removeSlot({ type: 'floor', i: si, j: lv + 1, k: ck, d: 0 });
          stairCells.add(`${si},${ck}`);
        }
      }
    }

    // roof
    if (o.roof === 'flat') {
      for (let i = ci; i < ci + w; i++) for (let k = ck; k < ck + d; k++) {
        if (!this.keys.has(slotKey({ type: 'ramp', i, j: topLevel - 1, k, d: 0 }))) this.floor(i, topLevel, k, o.roofMat ?? floorMat, o.roofTint ?? 0);
      }
    } else if (o.roof === 'gable') {
      const rm = o.roofMat ?? 'shingle';
      const rt = o.roofTint ?? 0;
      const half = Math.floor(d / 2);
      for (let i = ci; i < ci + w; i++) {
        for (let r = 0; r < half; r++) {
          this.ramp(i, topLevel + r, ck + r, 1, rm, rt);
          this.ramp(i, topLevel + r, ck + d - 1 - r, 3, rm, rt);
        }
        if (d % 2 === 1) this.floor(i, topLevel + half, ck + half, rm, rt);
      }
      // top floor ceiling so the attic is closed
      for (let i = ci; i < ci + w; i++) for (let k = ck; k < ck + d; k++) {
        if (!this.keys.has(slotKey({ type: 'ramp', i, j: topLevel - 1, k, d: 0 }))) this.floor(i, topLevel, k, floorMat, 0);
      }
      // gable end walls
      for (let r = 0; r < half; r++) {
        for (let k = ck + r + 1; k < ck + d - 1 - r; k++) {
          this.wall(ci, topLevel + r, k, 1, o.wallMat === 'glass' ? 'concrete' : o.wallMat, 0, tint);
          this.wall(ci + w, topLevel + r, k, 1, o.wallMat === 'glass' ? 'concrete' : o.wallMat, 0, tint);
        }
      }
    }

    // loot spots per floor
    for (let f = 0; f < floors; f++) {
      const lv = j + f * wallLevels;
      const n = 1 + (w * d > 6 ? 1 : 0) + (w * d > 12 ? 1 : 0);
      for (let q = 0; q < n; q++) {
        const i = ci + rng.int(0, w - 1);
        const k = ck + rng.int(0, d - 1);
        if (stairCells.has(`${i},${k}`)) continue;
        this.loot((i + 0.5) * GRID + rng.range(-1, 1), lv * GRID + 0.1, (k + 0.5) * GRID + rng.range(-1, 1), o.tier);
      }
    }
    if (o.roof === 'flat' && rng.chance(0.5)) {
      this.loot((ci + w - 0.5) * GRID, topLevel * GRID + 0.1, (ck + d - 0.5) * GRID, o.tier);
    }
    if (rng.chance(o.chestChance ?? 0.45)) {
      const f = rng.int(0, floors - 1);
      const lv = j + f * wallLevels;
      const i = ci + w - 1;
      const k = ck + d - 1;
      if (!stairCells.has(`${i},${k}`)) this.chest((i + 0.5) * GRID + 0.9, lv * GRID + 0.1, (k + 0.5) * GRID + 0.9, o.tier + 0.1, Math.PI);
    }
    if (rng.chance(0.3)) {
      this.ammoSpots.push({ x: (ci + 0.5) * GRID + 1, y: j * GRID + 0.1, z: (ck + d - 0.5) * GRID, tier: 1 });
    }
  }
}

// ---------------------------------------------------------------------------
// POI generators
// ---------------------------------------------------------------------------

function genCity(mb: MapBuilder, p: Poi) {
  const rng = mb.rng;
  const cx = cellOf(p.x), cz = cellOf(p.z);
  const j = p.h / GRID;
  const towers: [number, number][] = [[-12, -12], [-4, -12], [5, -12], [-12, -4], [5, -4], [-12, 5], [-4, 5], [5, 5]];
  for (const [dx, dz] of towers) {
    const floors = rng.int(3, 6);
    mb.building({
      ci: cx + dx, ck: cz + dz, j, w: 3, d: 3, floors, wallMat: 'concrete', wallTint: rng.pick([0xd4d8de, 0xbfc9d6, 0xe8e2d4, 0xc7d6e8]),
      roof: 'flat', windowChance: 0.65, glassFloors: true, tier: p.lootTier, doorSide: rng.pick(['n', 's', 'e', 'w'] as const), chestChance: 0.5,
    });
  }
  // Landmark: the Glasspoint Spire (4x4, 8 floors) with a rooftop cache
  mb.building({ ci: cx - 3, ck: cz - 3, j, w: 4, d: 4, floors: 8, wallMat: 'concrete', wallTint: 0xeaf2ff, roof: 'flat', windowChance: 0.7, glassFloors: true, tier: p.lootTier + 0.1, chestChance: 1 });
  mb.chest((cx - 3 + 3.5) * GRID, (j + 8) * GRID + 0.1, (cz - 3 + 3.5) * GRID, p.lootTier + 0.4);
  // Kiosks around the edge
  for (const [dx, dz] of [[-17, 0], [13, 0], [0, 13], [0, -17]] as const) {
    mb.building({ ci: cx + dx, ck: cz + dz, j, w: 2, d: 2, floors: 1, wallMat: 'brick', wallTint: rng.pick(WALL_TINTS), roof: 'flat', windowChance: 0.5, tier: p.lootTier, chestChance: 0.3 });
  }
  // Street props
  for (let n = 0; n < 26; n++) {
    const ax = rng.pick([-5, 3, 11]);
    const az = rng.range(-16, 14);
    const alongZ = rng.chance(0.5);
    const x = (cx + (alongZ ? ax : az) + 0.5) * GRID;
    const z = (cz + (alongZ ? az : ax) + 0.5) * GRID;
    if (rng.chance(0.55)) mb.prop('car', x, z, { rot: alongZ ? 0 : Math.PI / 2, tint: rng.pick(CAR_TINTS) });
    else if (rng.chance(0.5)) mb.prop('lamp', x + 1.5, z);
    else mb.prop(rng.pick(['bench', 'dumpster', 'crate']), x, z, { rot: alongZ ? 0 : Math.PI / 2 });
  }
}

function genTown(mb: MapBuilder, p: Poi) {
  const rng = mb.rng;
  const cx = cellOf(p.x), cz = cellOf(p.z);
  const j = p.h / GRID;
  const spots: [number, number][] = [[-12, -10], [-6, -12], [2, -12], [8, -9], [-13, -2], [9, -1], [-12, 6], [-5, 9], [3, 9], [10, 7]];
  for (const [dx, dz] of spots) {
    mb.building({
      ci: cx + dx, ck: cz + dz, j, w: 3, d: 2, floors: rng.chance(0.4) ? 2 : 1, wallMat: 'plank', wallTint: rng.pick(WALL_TINTS),
      roof: 'gable', roofTint: rng.pick(ROOF_TINTS), windowChance: 0.45, tier: p.lootTier, doorSide: dz < 0 ? 's' : 'n',
    });
  }
  // The big red barn (tall walls, gable roof)
  mb.building({ ci: cx - 2, ck: cz - 3, j, w: 5, d: 4, floors: 1, tallWalls: 2, wallMat: 'plank', wallTint: 0xc0392b, roof: 'gable', roofTint: 0x5d4037, windowChance: 0.1, tier: p.lootTier + 0.1, chestChance: 1, doorSide: 's' });
  // Hay loft floor in the barn
  for (let i = cx - 2; i < cx + 3; i++) mb.floor(i, j + 1, cz - 3, 'plank');
  mb.ramp(cx + 2, j, cz - 2, 3, 'plank');
  mb.loot((cx) * GRID, (j + 1) * GRID + 0.1, (cz - 3 + 0.5) * GRID, p.lootTier + 0.2);
  mb.prop('silo', (cx + 5) * GRID, (cz - 4) * GRID);
  for (let n = 0; n < 14; n++) mb.prop('haybale', (cx + rng.range(-16, 16)) * GRID, (cz + rng.range(12, 18)) * GRID, { rot: rng.chance(0.5) ? 0 : Math.PI / 2 });
  mb.prop('tractor', (cx + 6) * GRID, (cz + 14) * GRID, { rot: Math.PI / 2 });
  for (let n = 0; n < 12; n++) {
    const x = (cx - 18 + n * 3) * GRID;
    mb.prop('fence', x, (cz + 19) * GRID);
  }
}

function genIndustrial(mb: MapBuilder, p: Poi) {
  const rng = mb.rng;
  const cx = cellOf(p.x), cz = cellOf(p.z);
  const j = p.h / GRID;
  for (const [dx, dz] of [[-14, -12], [2, -12]] as const) {
    const ci = cx + dx, ck = cz + dz;
    mb.building({ ci, ck, j, w: 7, d: 5, floors: 1, tallWalls: 2, wallMat: 'steel', wallTint: rng.pick([0x8a9aa8, 0x9c7b5b, 0x6d8f8a]), roof: 'flat', roofMat: 'steel', windowChance: 0.15, tier: p.lootTier, chestChance: 1, doorSide: 's' });
    // stairs to the roof along the inside
    mb.ramp(ci + 1, j, ck + 1, 0, 'steel');
    mb.ramp(ci + 2, j + 1, ck + 1, 0, 'steel');
    mb.removeSlot({ type: 'floor', i: ci + 2, j: j + 2, k: ck + 1, d: 0 });
    for (let n = 0; n < 5; n++) mb.prop('crate', (ci + rng.range(1, 6)) * GRID, (ck + rng.range(2.5, 4.5)) * GRID, { y: j * GRID + 0.05, s: rng.range(0.9, 1.4) });
  }
  // Factory block with chimneys
  mb.building({ ci: cx - 6, ck: cz + 1, j, w: 4, d: 4, floors: 2, wallMat: 'brick', wallTint: 0xa0522d, roof: 'flat', windowChance: 0.4, tier: p.lootTier, chestChance: 0.8 });
  mb.prop('chimney', (cx - 5) * GRID, (cz + 7) * GRID);
  mb.prop('chimney', (cx - 2) * GRID, (cz + 7) * GRID);
  // Container yard
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 5; col++) {
      if (rng.chance(0.25)) continue;
      const x = (cx + 3 + col * 2.2) * GRID;
      const z = (cz + 2 + row * 2.8) * GRID;
      const stack = rng.int(1, 3);
      const base = mb.terrain.surfaceAt(x, z);
      for (let s = 0; s < stack; s++) mb.prop('container', x, z, { y: base + s * 2.6, tint: rng.pick(CONTAINER_TINTS) });
      if (rng.chance(0.3)) mb.loot(x, base + stack * 2.6 + 0.05, z, p.lootTier);
    }
  }
  mb.prop('crane', (cx + 16) * GRID, (cz + 6) * GRID);
  mb.prop('tank', (cx - 14) * GRID, (cz + 8) * GRID);
  mb.prop('tank', (cx - 14) * GRID, (cz + 13) * GRID);
  for (let n = 0; n < 16; n++) mb.prop('barrel', (cx + rng.range(-16, 16)) * GRID, (cz + rng.range(-16, 16)) * GRID, { tint: rng.pick([0xe74c3c, 0xf1c40f, 0x3498db]) });
  for (let n = 0; n < 3; n++) mb.prop('truck', (cx + rng.range(-10, 10)) * GRID, (cz + rng.range(-3, 0)) * GRID, { rot: Math.PI / 2, tint: rng.pick(CAR_TINTS) });
}

function genHarbor(mb: MapBuilder, p: Poi) {
  const rng = mb.rng;
  const cx = cellOf(p.x), cz = cellOf(p.z);
  const j = p.h / GRID;
  // Lighthouse (red/white brick, 6 floors + roof access)
  mb.building({ ci: cx + 6, ck: cz - 8, j, w: 3, d: 3, floors: 6, wallMat: 'brick', wallTint: 0xf2f2f2, roof: 'flat', roofMat: 'brick', roofTint: 0xd63031, windowChance: 0.25, tier: p.lootTier + 0.2, chestChance: 1 });
  mb.chest((cx + 7.5) * GRID, (j + 6) * GRID + 0.1, (cz - 6.5) * GRID, p.lootTier + 0.4);
  mb.lights.push({ x: (cx + 7.5) * GRID, y: (j + 6) * GRID + 3, z: (cz - 6.5) * GRID, color: 0xfff2a8 });
  // Boathouses & market
  for (const [dx, dz] of [[-8, -6], [-8, 0], [-2, 5], [-10, 6]] as const) {
    mb.building({ ci: cx + dx, ck: cz + dz, j, w: 3, d: 2, floors: 1, wallMat: 'plank', wallTint: rng.pick([0x7fb3d5, 0xf5cba7, 0xa9dfbf, 0xf9e79f]), roof: 'gable', roofTint: rng.pick(ROOF_TINTS), windowChance: 0.4, tier: p.lootTier, doorSide: 'e' });
  }
  mb.building({ ci: cx - 3, ck: cz - 3, j, w: 4, d: 3, floors: 1, wallMat: 'plank', wallTint: 0xfdebd0, roof: 'flat', windowChance: 0.6, tier: p.lootTier, chestChance: 0.6 });
  // Docks out over the water (east)
  const dockLen = 18;
  for (let n = 0; n < dockLen; n++) {
    mb.floor(cx + 2 + n, j, cz + 1, 'plank', 0xb08968);
    mb.floor(cx + 2 + n, j, cz + 2, 'plank', 0xb08968);
    if (n % 5 === 4) {
      for (let s = 1; s <= 4; s++) mb.floor(cx + 2 + n, j, cz + 2 + s, 'plank', 0xb08968);
      mb.prop('boat', (cx + 3.5 + n) * GRID, (cz + 5) * GRID, { y: -0.4, rot: 0, tint: rng.pick(CAR_TINTS) });
    }
    if (n % 6 === 3) mb.prop('crate', (cx + 2.5 + n) * GRID, (cz + 1.5) * GRID, { y: j * GRID + 0.05 });
  }
  // ladder ramps out of the water at the dock end
  const endI = cx + 2 + dockLen;
  mb.ramp(endI, j - 2, cz + 1, 2, 'plank', 0xb08968);
  mb.ramp(endI, j - 1, cz + 2, 2, 'plank', 0xb08968);
  mb.loot((cx + 2 + dockLen - 0.5) * GRID, j * GRID + 0.1, (cz + 2) * GRID, p.lootTier + 0.2);
  for (let n = 0; n < 8; n++) mb.prop('palm', (cx + rng.range(-14, 4)) * GRID, (cz + rng.range(8, 14)) * GRID, { s: rng.range(0.9, 1.2) });
}

function genMountain(mb: MapBuilder, p: Poi) {
  const cx = cellOf(p.x), cz = cellOf(p.z);
  const j = p.h / GRID;
  mb.building({ ci: cx - 2, ck: cz - 2, j, w: 3, d: 3, floors: 2, wallMat: 'concrete', wallTint: 0xdfe6e9, roof: 'flat', windowChance: 0.5, tier: p.lootTier, chestChance: 1 });
  mb.building({ ci: cx + 2, ck: cz + 2, j, w: 2, d: 2, floors: 1, wallMat: 'plank', wallTint: 0x8e5b3a, roof: 'gable', roofTint: 0xecf0f1, windowChance: 0.4, tier: p.lootTier });
  mb.prop('antenna', (cx - 0.5) * GRID, (cz - 0.5) * GRID, { y: (j + 2) * GRID });
  mb.prop('dish', (cx - 4) * GRID, (cz + 3) * GRID);
  mb.chest((cx + 3.5) * GRID, j * GRID + 0.1, (cz - 3) * GRID, p.lootTier + 0.3);
}

function genFacility(mb: MapBuilder, p: Poi): MapData['undervault'] {
  const rng = mb.rng;
  const cx = cellOf(p.x), cz = cellOf(p.z);
  const j = p.h / GRID;
  // Broken lab blocks
  mb.building({ ci: cx - 12, ck: cz - 10, j, w: 4, d: 3, floors: 2, wallMat: 'concrete', wallTint: 0xb2bec3, roof: 'flat', windowChance: 0.3, broken: 0.22, tier: p.lootTier, chestChance: 1 });
  mb.building({ ci: cx + 6, ck: cz - 10, j, w: 4, d: 4, floors: 2, wallMat: 'concrete', wallTint: 0xa4b0be, roof: 'flat', windowChance: 0.3, broken: 0.22, tier: p.lootTier, chestChance: 0.8 });
  mb.building({ ci: cx + 6, ck: cz + 8, j, w: 3, d: 3, floors: 1, wallMat: 'steel', wallTint: 0x7f8c8d, roof: 'flat', windowChance: 0.1, broken: 0.15, tier: p.lootTier });
  mb.prop('dish', (cx - 10) * GRID, (cz + 8) * GRID, { s: 1.4 });
  for (let n = 0; n < 12; n++) mb.prop(rng.pick(['barrel', 'crate']), (cx + rng.range(-16, 16)) * GRID, (cz + rng.range(-16, 16)) * GRID, { tint: 0xf1c40f });
  // perimeter fence
  for (let n = -4; n <= 4; n++) {
    mb.prop('fence', (cx + n * 4) * GRID, (cz - 17) * GRID);
    mb.prop('fence', (cx + n * 4) * GRID, (cz + 17) * GRID);
  }

  // ---- The Undervault: stair shaft + bunker ----
  const B = 'bunker';
  const T = 0x505a66;
  // shaft cells: (cx, cz-3..cz-1), descending southwards
  for (let s = 0; s < 3; s++) {
    const k = cz - 3 + s;
    mb.ramp(cx, j - 1 - s, k, 3, B, 0x6c7a89);
    for (let lv = 1; lv <= j - 1; lv++) {
      mb.wall(cx, lv, k, 1, B, 0, T);
      mb.wall(cx + 1, lv, k, 1, B, 0, T);
    }
  }
  for (let lv = 1; lv <= j - 1; lv++) mb.wall(cx, lv, cz - 3, 0, B, 0, T);
  for (let lv = 2; lv <= j - 1; lv++) mb.wall(cx, lv, cz, 0, B, 0, T);
  mb.terrain.addHole(cx * GRID, (cz - 3) * GRID, (cx + 1) * GRID, cz * GRID);
  // bunker room: i in [cx-3, cx+3], k in [cz, cz+5], floor level 1, ceiling level 2
  const i0 = cx - 3, i1 = cx + 3, k0 = cz, k1 = cz + 5;
  for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
    mb.floor(i, 1, k, B, 0x3d4652);
    mb.floor(i, 2, k, B, 0x2d3440);
  }
  for (let i = i0; i <= i1; i++) {
    if (i !== cx) mb.wall(i, 1, k0, 0, B, 0, T);
    mb.wall(i, 1, k1 + 1, 0, B, 0, T);
  }
  for (let k = k0; k <= k1; k++) {
    mb.wall(i0, 1, k, 1, B, 0, T);
    mb.wall(i1 + 1, 1, k, 1, B, 0, T);
  }
  // vault partition with a door
  for (let i = i0; i <= i1; i++) mb.wall(i, 1, k1 - 1, 0, B, i === cx ? WallVariant.Door : 0, 0x8a6d3b);
  mb.chest((cx - 1.5) * GRID, GRID + 0.1, (k1 + 0.6) * GRID, 1.9);
  mb.chest((cx + 2.5) * GRID, GRID + 0.1, (k1 + 0.6) * GRID, 1.9);
  mb.loot((cx + 0.5) * GRID, GRID + 0.1, (k1 + 0.5) * GRID, 1.8);
  for (let n = 0; n < 4; n++) mb.loot((i0 + 1 + n * 1.6) * GRID, GRID + 0.1, (k0 + 2) * GRID, 1.5);
  mb.chest((i0 + 0.7) * GRID, GRID + 0.1, (k0 + 1.5) * GRID, 1.5, Math.PI / 2);
  for (let n = 0; n < 5; n++) {
    const lx = (i0 + 0.5 + n * 1.5) * GRID, lz = (k0 + 2.5) * GRID;
    mb.prop('bunkerlamp', lx, lz, { y: 2 * GRID - 0.35 });
    mb.lights.push({ x: lx, y: 2 * GRID - 0.6, z: lz, color: 0x7fdcff });
  }
  mb.prop('crate', (i1 - 0.2) * GRID, (k0 + 1) * GRID, { y: GRID + 0.05 });
  mb.prop('crate', (i1 - 0.6) * GRID, (k0 + 2.2) * GRID, { y: GRID + 0.05, s: 1.3 });
  return { minX: i0 * GRID, minZ: k0 * GRID, maxX: (i1 + 1) * GRID, maxZ: (k1 + 1) * GRID, y: GRID };
}

function genDesert(mb: MapBuilder, p: Poi) {
  const rng = mb.rng;
  const cx = cellOf(p.x), cz = cellOf(p.z);
  const j = p.h / GRID;
  const spots: [number, number, number, number][] = [[-9, -8, 3, 2], [-2, -10, 2, 2], [5, -7, 3, 3], [-10, 2, 2, 3], [4, 3, 3, 2], [-3, 6, 4, 3]];
  for (const [dx, dz, w, d] of spots) {
    mb.building({ ci: cx + dx, ck: cz + dz, j, w, d, floors: rng.chance(0.35) ? 2 : 1, wallMat: 'adobe', wallTint: rng.pick([0xe0a26e, 0xd98e5f, 0xf0c090, 0xc97b4f]), roof: 'flat', windowChance: 0.4, tier: p.lootTier });
  }
  mb.prop('watertower', (cx + 1) * GRID, (cz - 1) * GRID);
  for (let n = 0; n < 6; n++) mb.prop('barrel', (cx + rng.range(-12, 12)) * GRID, (cz + rng.range(-12, 12)) * GRID, { tint: 0x8e5b3a });
}

function genForest(mb: MapBuilder, p: Poi) {
  const rng = mb.rng;
  const cx = cellOf(p.x), cz = cellOf(p.z);
  const j = p.h / GRID;
  mb.building({ ci: cx - 2, ck: cz - 1, j, w: 5, d: 3, floors: 2, wallMat: 'plank', wallTint: 0x8d5b3a, roof: 'gable', roofTint: 0x2e7d32, windowChance: 0.45, tier: p.lootTier + 0.1, chestChance: 1, doorSide: 's' });
  for (const [dx, dz] of [[-8, -6], [5, -6], [-8, 5], [6, 5]] as const) {
    mb.building({ ci: cx + dx, ck: cz + dz, j, w: 2, d: 2, floors: 1, wallMat: 'plank', wallTint: rng.pick([0xa0522d, 0x8b5a2b, 0x9c6b3e]), roof: 'gable', roofTint: rng.pick([0x2e7d32, 0x5d4037, 0x1b5e20]), windowChance: 0.5, tier: p.lootTier });
  }
}

function genJunction(mb: MapBuilder, p: Poi) {
  const cx = cellOf(p.x), cz = cellOf(p.z);
  const j = p.h / GRID;
  mb.building({ ci: cx - 4, ck: cz - 4, j, w: 3, d: 2, floors: 1, wallMat: 'brick', wallTint: 0xfff3e0, roof: 'flat', roofMat: 'concrete', roofTint: 0xe53935, windowChance: 0.6, tier: p.lootTier, chestChance: 0.8, doorSide: 's' });
  // fuel canopy
  for (let i = cx - 1; i < cx + 3; i++) for (let k = cz - 3; k < cz - 1; k++) mb.floor(i, j + 1, k, 'concrete', 0xe53935);
  for (const [px, pz] of [[cx - 1, cz - 3], [cx + 3, cz - 3], [cx - 1, cz - 1], [cx + 3, cz - 1]]) mb.prop('pillar', px * GRID, pz * GRID);
  mb.prop('pump', (cx + 0.5) * GRID, (cz - 2) * GRID);
  mb.prop('pump', (cx + 1.5) * GRID, (cz - 2) * GRID);
  mb.loot((cx + 1) * GRID, (j + 1) * GRID + 0.1, (cz - 2) * GRID, p.lootTier + 0.2);
  mb.building({ ci: cx + 4, ck: cz + 2, j, w: 4, d: 2, floors: 1, wallMat: 'plank', wallTint: 0x81d4fa, roof: 'flat', roofMat: 'plank', roofTint: 0xffffff, windowChance: 0.7, tier: p.lootTier, doorSide: 'n' });
}

// ---------------------------------------------------------------------------
// Scatter: trees, rocks, bushes, cars along roads
// ---------------------------------------------------------------------------

function scatter(mb: MapBuilder) {
  const rng = new RNG(MAP_SEED ^ 0x7ee5);
  const t = mb.terrain;
  const step = 8;
  for (let z = -600; z <= 600; z += step) {
    for (let x = -600; x <= 600; x += step) {
      const px = x + rng.range(-3.5, 3.5);
      const pz = z + rng.range(-3.5, 3.5);
      const h = t.surfaceAt(px, pz);
      const r1 = rng.float(), r2 = rng.float(), r3 = rng.float();
      if (h < 1.6) continue;
      let inPoi = false;
      for (const p of POIS) {
        const d = Math.hypot(px - p.x, pz - p.z);
        if (d < p.r * 0.95) inPoi = true;
      }
      if (inPoi) continue;
      if (roadDistance(px, pz) < 6) continue;
      const slope = t.slopeAt(px, pz);
      const biome = biomeAt(px, pz);
      let treeD = 0.06, rockD = 0.02, bushD = 0.06;
      switch (biome) {
        case 'forest': treeD = 0.72; bushD = 0.2; rockD = 0.02; break;
        case 'plains': treeD = 0.08; bushD = 0.08; break;
        case 'town': treeD = 0.1; bushD = 0.06; break;
        case 'city': treeD = 0.03; break;
        case 'industrial': treeD = 0.04; rockD = 0.03; break;
        case 'facility': treeD = 0.1; rockD = 0.04; break;
        case 'mountain': treeD = h > 70 ? 0.05 : 0.3; rockD = 0.08; bushD = 0.02; break;
        case 'harbor': treeD = 0.09; bushD = 0.05; break;
        case 'desert': treeD = 0.07; rockD = 0.07; bushD = 0.02; break;
      }
      if (slope > 1.1) {
        treeD *= 0.3;
        rockD *= 2;
      }
      if (r1 < treeD) {
        let type = 'oak';
        if (biome === 'forest') type = r2 < 0.55 ? 'pine' : r2 < 0.8 ? 'oak' : 'birch';
        else if (biome === 'mountain') type = h > 48 ? 'snowpine' : 'pine';
        else if (biome === 'desert') type = r2 < 0.8 ? 'cactus' : 'deadtree';
        else if (biome === 'harbor' || h < 3.5) type = 'palm';
        else if (biome === 'facility') type = r2 < 0.5 ? 'deadtree' : 'pine';
        else type = r2 < 0.6 ? 'oak' : r2 < 0.85 ? 'birch' : 'pine';
        mb.prop(type, px, pz, { s: 0.8 + r3 * 0.55, rot: r2 * Math.PI * 2 });
      } else if (r1 < treeD + rockD) {
        mb.prop(r2 < 0.8 ? 'rock' : 'boulder', px, pz, { s: 0.7 + r3 * 0.8, rot: 0, y: h - 0.3 });
      } else if (r1 < treeD + rockD + bushD) {
        mb.prop('bush', px, pz, { s: 0.7 + r3 * 0.6, rot: r2 * 6.28 });
      }
    }
  }
}

// ---------------------------------------------------------------------------

export function generateMap(terrain: Terrain): MapData {
  const rng = new RNG(MAP_SEED);
  const mb = new MapBuilder(terrain, rng);
  let undervault: MapData['undervault'] = { minX: 0, minZ: 0, maxX: 0, maxZ: 0, y: 0 };
  for (const p of POIS) {
    switch (p.kind) {
      case 'city': genCity(mb, p); break;
      case 'town': genTown(mb, p); break;
      case 'industrial': genIndustrial(mb, p); break;
      case 'harbor': genHarbor(mb, p); break;
      case 'mountain': genMountain(mb, p); break;
      case 'facility': undervault = genFacility(mb, p); break;
      case 'desert': genDesert(mb, p); break;
      case 'forest': genForest(mb, p); break;
      case 'junction': genJunction(mb, p); break;
    }
  }
  scatter(mb);

  // Outdoor caches & ammo near rocks and in the wild
  const wild = new RNG(MAP_SEED ^ 0xabc);
  let placed = 0;
  for (let n = 0; n < 400 && placed < 26; n++) {
    const x = wild.range(-500, 500), z = wild.range(-500, 500);
    const h = terrain.surfaceAt(x, z);
    if (h < 2 || terrain.slopeAt(x, z) > 0.5 || Math.hypot(x, z) > 520) continue;
    let near = false;
    for (const p of POIS) if (Math.hypot(x - p.x, z - p.z) < p.r + 20) near = true;
    if (near) continue;
    mb.chest(x, h + 0.05, z, 1.0, wild.range(0, 6.28));
    if (placed % 2 === 0) mb.ammoSpots.push({ x: x + 2, y: h + 0.05, z: z + 1, tier: 1 });
    placed++;
  }

  // Vehicles along roads
  const vehicleSpots: MapData['vehicleSpots'] = [];
  for (const s of getRoadSegments()) {
    for (const t of [0.3, 0.72]) {
      const x = s.ax + (s.bx - s.ax) * t;
      const z = s.az + (s.bz - s.az) * t;
      const yaw = Math.atan2(-(s.bx - s.ax), -(s.bz - s.az));
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const vx = x + rx * 5, vz = z + rz * 5;
      if (terrain.isLand(vx, vz)) vehicleSpots.push({ x: vx, z: vz, yaw });
    }
  }
  const pit = poiById('pitstop');
  vehicleSpots.push({ x: pit.x + 12, z: pit.z + 4, yaw: 0 }, { x: pit.x + 17, z: pit.z + 4, yaw: 0 });

  // Launch pads on the summit, the city spire roof and a desert mesa
  const fp = poiById('frostpeak');
  const launchPads = [
    { x: fp.x + 14, y: terrain.surfaceAt(fp.x + 14, fp.z + 14), z: fp.z + 14 },
    { x: fp.x - 16, y: terrain.surfaceAt(fp.x - 16, fp.z - 4), z: fp.z - 4 },
  ];
  const cityP = poiById('glasspoint');
  launchPads.push({ x: (cellOf(cityP.x) - 3 + 0.5) * GRID, y: (cityP.h / GRID + 8) * GRID + 0.05, z: (cellOf(cityP.z) - 3 + 0.5) * GRID });
  for (const lp of launchPads) mb.prop('launchpad', lp.x, lp.z, { y: lp.y });

  // Rebirth spires at POI outskirts
  const spires: MapData['spires'] = [];
  const angles = [0.3, 2.1, 4.0, 5.5, 1.2, 3.3, 4.8, 0.8, 2.7];
  POIS.forEach((p, idx) => {
    if (p.kind === 'mountain') return;
    const a = angles[idx % angles.length];
    const x = p.x + Math.cos(a) * (p.r + 14);
    const z = p.z + Math.sin(a) * (p.r + 14);
    if (!terrain.isLand(x, z)) return;
    const y = terrain.surfaceAt(x, z);
    spires.push({ x, y, z });
    mb.prop('spire', x, z, { y });
  });

  // Skyport (pre-game waiting area) deck
  const S = SKYPORT;
  const statics: StaticBox[] = [
    { minX: S.x - S.halfX, minY: S.y - 1.5, minZ: S.z - S.halfZ, maxX: S.x + S.halfX, maxY: S.y, maxZ: S.z + S.halfZ, color: 0x5ee7df },
    { minX: S.x - S.halfX, minY: S.y, minZ: S.z - S.halfZ, maxX: S.x + S.halfX, maxY: S.y + 1.2, maxZ: S.z - S.halfZ + 0.4, color: 0xffffff },
    { minX: S.x - S.halfX, minY: S.y, minZ: S.z + S.halfZ - 0.4, maxX: S.x + S.halfX, maxY: S.y + 1.2, maxZ: S.z + S.halfZ, color: 0xffffff },
    { minX: S.x - S.halfX, minY: S.y, minZ: S.z - S.halfZ, maxX: S.x - S.halfX + 0.4, maxY: S.y + 1.2, maxZ: S.z + S.halfZ, color: 0xffffff },
    { minX: S.x + S.halfX - 0.4, minY: S.y, minZ: S.z - S.halfZ, maxX: S.x + S.halfX, maxY: S.y + 1.2, maxZ: S.z + S.halfZ, color: 0xffffff },
    { minX: S.x - 6, minY: S.y, minZ: S.z - 6, maxX: S.x + 6, maxY: S.y + 2, maxZ: S.z + 6, color: 0xb388ff },
    { minX: S.x - 20, minY: S.y, minZ: S.z + 8, maxX: S.x - 14, maxY: S.y + 4, maxZ: S.z + 14, color: 0xffd166 },
    { minX: S.x + 14, minY: S.y, minZ: S.z - 14, maxX: S.x + 20, maxY: S.y + 4, maxZ: S.z - 8, color: 0xef476f },
  ];

  return {
    props: mb.props,
    pieces: mb.pieces.filter((p) => p !== null),
    lootSpots: mb.lootSpots,
    chestSpots: mb.chestSpots,
    ammoSpots: mb.ammoSpots,
    vehicleSpots,
    launchPads,
    spires,
    statics,
    lights: mb.lights,
    undervault,
  };
}

/** Build the collision world + build grid for a generated map. */
export function buildWorld(terrain: Terrain, map: MapData) {
  const world = new CollisionWorld(terrain);
  const grid = new BuildGrid(world);
  const propColliders = new Map<number, number>(); // prop id -> collider id
  for (const p of map.props) {
    const T = PROP_TYPES[p.t];
    if (!T.collide) continue;
    const bb = propAABB(p);
    const c = world.add({ shape: Shape.Box, ...bb, dir: 0, y0: 0, ownerKind: T.hp > 0 ? OwnerKind.Prop : OwnerKind.Static, ownerId: p.id, blocksShots: true });
    propColliders.set(p.id, c.id);
  }
  for (const s of map.statics) {
    world.add({ shape: Shape.Box, minX: s.minX, minY: s.minY, minZ: s.minZ, maxX: s.maxX, maxY: s.maxY, maxZ: s.maxZ, dir: 0, y0: 0, ownerKind: OwnerKind.Static, ownerId: 0, blocksShots: true });
  }
  for (const mp of map.pieces) {
    const md = Object.values(MAT_BY_ID).find((m) => m.code === mp.mat)!;
    grid.add({
      ...mp,
      id: grid.allocId(),
      hp: md.maxHp,
      maxHp: md.maxHp,
      owner: 0,
      team: -1,
      anchored: true,
      grounded: isPieceGrounded(mp, terrain),
      buildStart: -100,
      buildTime: 0,
      colliderIds: [],
    });
  }
  return { world, grid, propColliders };
}

/** Deterministic world setup used by both server and client. */
export function createIsland() {
  const terrain = new Terrain();
  const map = generateMap(terrain);
  const { world, grid, propColliders } = buildWorld(terrain, map);
  return { terrain, map, world, grid, propColliders };
}
