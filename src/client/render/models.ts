// Procedural model library: scenery props, weapons & items, vehicles, the Skywhale transport,
// loot containers. Everything is built from primitives with baked vertex colors.
import * as THREE from 'three';
import { ITEM_BY_CODE, RARITIES } from '../../shared/items';
import { Part, box, build, cone, cyl, dodeca, ico, sphere, torus } from './util';

const D = Math.PI / 180;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

const TRUNK = 0x8b5a2b;
const LEAF = 0x3fae49;
const LEAF2 = 0x2f8f3c;

export function propGeometry(id: string): THREE.BufferGeometry {
  const P: Part[] = [];
  switch (id) {
    case 'pine':
    case 'snowpine': {
      const snow = id === 'snowpine';
      P.push({ g: cyl(0.22, 0.35, 2.2, 6), color: TRUNK, pos: [0, 1.1, 0] });
      P.push({ g: cone(2.3, 3.2, 7), color: snow ? 0x2e7d5b : LEAF2, pos: [0, 3.1, 0], jitter: 0.12 });
      P.push({ g: cone(1.8, 2.7, 7), color: snow ? 0x357f63 : 0x3a9e45, pos: [0, 4.6, 0], jitter: 0.12 });
      P.push({ g: cone(1.2, 2.1, 7), color: snow ? 0xeef6ff : 0x49b653, pos: [0, 5.9, 0], jitter: 0.12 });
      if (snow) P.push({ g: cone(1.9, 0.8, 7), color: 0xf4fbff, pos: [0, 4.0, 0] });
      break;
    }
    case 'oak':
      P.push({ g: cyl(0.3, 0.45, 2.6, 7), color: TRUNK, pos: [0, 1.3, 0] });
      P.push({ g: ico(1.9, 1), color: LEAF, pos: [0, 3.9, 0], jitter: 0.15 });
      P.push({ g: ico(1.35, 1), color: 0x52c15a, pos: [1.2, 3.4, 0.4], jitter: 0.15 });
      P.push({ g: ico(1.4, 1), color: LEAF2, pos: [-1.1, 3.5, -0.3], jitter: 0.15 });
      P.push({ g: ico(1.1, 1), color: 0x5fcf62, pos: [0.2, 4.8, -0.4], jitter: 0.15 });
      break;
    case 'birch':
      P.push({ g: cyl(0.2, 0.28, 4.2, 6), color: 0xf2efe6, pos: [0, 2.1, 0] });
      P.push({ g: box(0.3, 0.12, 0.3), color: 0x333333, pos: [0, 1.4, 0] });
      P.push({ g: box(0.3, 0.1, 0.3), color: 0x333333, pos: [0, 2.6, 0] });
      P.push({ g: ico(1.4, 1), color: 0x9bd44f, pos: [0, 4.6, 0], jitter: 0.15 });
      P.push({ g: ico(1.0, 1), color: 0xb4e05a, pos: [0.7, 5.3, 0.3], jitter: 0.15 });
      P.push({ g: ico(0.9, 1), color: 0x8ccc48, pos: [-0.6, 4.1, -0.3], jitter: 0.15 });
      break;
    case 'palm': {
      for (let i = 0; i < 6; i++) P.push({ g: cyl(0.22, 0.28, 1.25, 6), color: i % 2 ? 0xa67c52 : 0x8d6541, pos: [i * i * 0.02, 0.6 + i * 1.2, 0] });
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        P.push({ g: cone(0.55, 3.2, 4), color: k % 2 ? 0x3fae49 : 0x55c45d, pos: [0.7 + Math.cos(a) * 1.4, 7.2, Math.sin(a) * 1.4], rot: [Math.sin(a) * 1.2, 0, -Math.cos(a) * 1.2 - 0.0], scale: [1, 1, 0.25] });
      }
      P.push({ g: sphere(0.25, 6, 5), color: 0x6b4423, pos: [0.6, 6.9, 0.2] });
      break;
    }
    case 'cactus':
      P.push({ g: cyl(0.38, 0.42, 3.2, 8), color: 0x4c9a52, pos: [0, 1.6, 0] });
      P.push({ g: sphere(0.38, 8, 6), color: 0x4c9a52, pos: [0, 3.2, 0] });
      P.push({ g: cyl(0.22, 0.22, 1.1, 7), color: 0x57a85c, pos: [0.55, 1.9, 0], rot: [0, 0, 90 * D] });
      P.push({ g: cyl(0.22, 0.22, 1.0, 7), color: 0x57a85c, pos: [1.05, 2.4, 0] });
      P.push({ g: cyl(0.2, 0.2, 0.9, 7), color: 0x57a85c, pos: [-0.5, 1.4, 0], rot: [0, 0, 90 * D] });
      P.push({ g: cyl(0.2, 0.2, 0.9, 7), color: 0x57a85c, pos: [-0.95, 1.8, 0] });
      P.push({ g: sphere(0.16, 6, 5), color: 0xff6fa3, pos: [0, 3.55, 0] });
      break;
    case 'deadtree':
      P.push({ g: cyl(0.18, 0.32, 4.5, 6), color: 0x7a6a5a, pos: [0, 2.25, 0] });
      P.push({ g: cyl(0.08, 0.12, 1.8, 5), color: 0x7a6a5a, pos: [0.6, 3.6, 0], rot: [0, 0, -50 * D] });
      P.push({ g: cyl(0.08, 0.12, 1.5, 5), color: 0x7a6a5a, pos: [-0.5, 3.1, 0.2], rot: [0.3, 0, 45 * D] });
      break;
    case 'rock':
      P.push({ g: dodeca(1.3), color: 0x9aa1ab, pos: [0, 0.7, 0], scale: [1.3, 0.75, 1.15], jitter: 0.12 });
      break;
    case 'boulder':
      P.push({ g: dodeca(2.6), color: 0x8c939e, pos: [0, 1.5, 0], scale: [1.1, 0.8, 1.0], jitter: 0.12 });
      P.push({ g: dodeca(1.2), color: 0x9aa1ab, pos: [1.8, 0.6, 1.1], jitter: 0.12 });
      break;
    case 'car':
      P.push({ g: box(2, 0.75, 4.2), color: 0xffffff, pos: [0, 0.75, 0] });
      P.push({ g: box(1.8, 0.65, 2.1), color: 0xdddddd, pos: [0, 1.45, 0.2] });
      P.push({ g: box(1.82, 0.5, 1.6), color: 0x9fdcff, pos: [0, 1.45, 0.2] });
      for (const [x, z] of [[-0.95, -1.3], [0.95, -1.3], [-0.95, 1.35], [0.95, 1.35]]) P.push({ g: cyl(0.42, 0.42, 0.3, 10), color: 0x222222, pos: [x, 0.42, z], rot: [0, 0, 90 * D] });
      P.push({ g: box(0.4, 0.15, 0.05), color: 0xfff6b0, pos: [-0.6, 0.85, -2.11] }, { g: box(0.4, 0.15, 0.05), color: 0xfff6b0, pos: [0.6, 0.85, -2.11] });
      break;
    case 'truck':
      P.push({ g: box(2.4, 1.8, 2), color: 0xffffff, pos: [0, 1.3, -2.1] });
      P.push({ g: box(2.3, 0.7, 1.6), color: 0x9fdcff, pos: [0, 1.7, -2.3] });
      P.push({ g: box(2.4, 2.6, 4.2), color: 0xe8e8e8, pos: [0, 1.7, 1.0] });
      for (const [x, z] of [[-1.1, -2.2], [1.1, -2.2], [-1.1, 1.8], [1.1, 1.8], [-1.1, 0.6], [1.1, 0.6]]) P.push({ g: cyl(0.5, 0.5, 0.35, 10), color: 0x222222, pos: [x, 0.5, z], rot: [0, 0, 90 * D] });
      break;
    case 'container':
      P.push({ g: box(2.5, 2.6, 6), color: 0xffffff, pos: [0, 1.3, 0] });
      for (let i = -2; i <= 2; i++) P.push({ g: box(2.56, 2.5, 0.12), color: 0xd0d0d0, pos: [0, 1.3, i * 1.2] });
      P.push({ g: box(2.3, 2.4, 0.08), color: 0xbbbbbb, pos: [0, 1.3, 3.02] });
      break;
    case 'crate':
      P.push({ g: box(1.2, 1.2, 1.2), color: 0xc98b4c, pos: [0, 0.6, 0] });
      P.push({ g: box(1.25, 0.15, 1.25), color: 0x8b5a2b, pos: [0, 1.12, 0] }, { g: box(1.25, 0.15, 1.25), color: 0x8b5a2b, pos: [0, 0.08, 0] });
      P.push({ g: box(0.15, 1.2, 1.25), color: 0x8b5a2b, pos: [0.55, 0.6, 0] }, { g: box(0.15, 1.2, 1.25), color: 0x8b5a2b, pos: [-0.55, 0.6, 0] });
      break;
    case 'barrel':
      P.push({ g: cyl(0.4, 0.4, 1.1, 10), color: 0xffffff, pos: [0, 0.55, 0] });
      P.push({ g: cyl(0.42, 0.42, 0.08, 10), color: 0x555555, pos: [0, 0.3, 0] }, { g: cyl(0.42, 0.42, 0.08, 10), color: 0x555555, pos: [0, 0.8, 0] });
      break;
    case 'haybale':
      P.push({ g: cyl(0.6, 0.6, 1.6, 10), color: 0xe9c46a, pos: [0, 0.6, 0], rot: [0, 0, 90 * D], jitter: 0.08 });
      P.push({ g: cyl(0.62, 0.62, 0.08, 10), color: 0xc9a227, pos: [0.4, 0.6, 0], rot: [0, 0, 90 * D] }, { g: cyl(0.62, 0.62, 0.08, 10), color: 0xc9a227, pos: [-0.4, 0.6, 0], rot: [0, 0, 90 * D] });
      break;
    case 'fence':
      for (const x of [-1.9, 0, 1.9]) P.push({ g: box(0.15, 1.2, 0.15), color: 0xf5f5f5, pos: [x, 0.6, 0] });
      P.push({ g: box(4, 0.15, 0.08), color: 0xffffff, pos: [0, 0.9, 0] }, { g: box(4, 0.15, 0.08), color: 0xffffff, pos: [0, 0.45, 0] });
      break;
    case 'lamp':
      P.push({ g: cyl(0.08, 0.12, 6, 6), color: 0x4a5160, pos: [0, 3, 0] });
      P.push({ g: box(1.2, 0.1, 0.1), color: 0x4a5160, pos: [-0.5, 5.95, 0] });
      P.push({ g: box(0.5, 0.18, 0.3), color: 0xfff3b0, pos: [-1.0, 5.85, 0] });
      break;
    case 'bush':
      P.push({ g: ico(0.9, 1), color: 0x3f9e44, pos: [0, 0.6, 0], jitter: 0.2 });
      P.push({ g: ico(0.65, 1), color: 0x52b957, pos: [0.6, 0.45, 0.2], jitter: 0.2 });
      P.push({ g: ico(0.6, 1), color: 0x35903c, pos: [-0.5, 0.4, -0.3], jitter: 0.2 });
      break;
    case 'silo':
      P.push({ g: cyl(3, 3, 12, 14), color: 0xd5d8dc, pos: [0, 6, 0] });
      P.push({ g: sphere(3, 14, 8), color: 0xc0392b, pos: [0, 12, 0], scale: [1, 0.6, 1] });
      for (let i = 1; i < 4; i++) P.push({ g: cyl(3.05, 3.05, 0.2, 14), color: 0x95a5a6, pos: [0, i * 3, 0] });
      break;
    case 'tank':
      P.push({ g: cyl(3.5, 3.5, 6.6, 16), color: 0xecf0f1, pos: [0, 3.3, 0] });
      P.push({ g: cyl(3.6, 3.6, 0.3, 16), color: 0xe67e22, pos: [0, 6.6, 0] });
      P.push({ g: box(0.3, 6.6, 0.3), color: 0x7f8c8d, pos: [3.6, 3.3, 0] });
      break;
    case 'dish':
      P.push({ g: cyl(0.3, 0.5, 3, 8), color: 0x95a5a6, pos: [0, 1.5, 0] });
      P.push({ g: sphere(2.2, 14, 8, ), color: 0xf0f3f4, pos: [0, 3.8, 0], rot: [-50 * D, 0, 0], scale: [1, 0.35, 1] });
      P.push({ g: cyl(0.06, 0.06, 1.6, 5), color: 0x7f8c8d, pos: [0, 4.4, -0.5], rot: [-40 * D, 0, 0] });
      break;
    case 'antenna':
      P.push({ g: cyl(0.12, 0.4, 18, 4), color: 0xdfe6e9, pos: [0, 9, 0] });
      for (let i = 1; i < 6; i++) P.push({ g: box(1.6 - i * 0.2, 0.08, 0.08), color: 0xb2bec3, pos: [0, i * 3, 0] });
      P.push({ g: sphere(0.3, 8, 6), color: 0xff3b3b, pos: [0, 18.2, 0] });
      break;
    case 'crane':
      P.push({ g: box(1.6, 22, 1.6), color: 0xf1c40f, pos: [0, 11, 0] });
      P.push({ g: box(22, 1.2, 1.2), color: 0xf39c12, pos: [-6, 22.5, 0] });
      P.push({ g: box(2.2, 2, 2.2), color: 0x34495e, pos: [0, 21, 0] });
      P.push({ g: cyl(0.05, 0.05, 10, 4), color: 0x333333, pos: [-14, 17.5, 0] });
      P.push({ g: box(3, 1.5, 3), color: 0x7f8c8d, pos: [-14, 12, 0] });
      break;
    case 'spire':
      P.push({ g: cyl(0.2, 0.7, 6, 4), color: 0x4b3f72, pos: [0, 3, 0], rot: [0, 45 * D, 0] });
      P.push({ g: box(1.8, 0.4, 1.8), color: 0x2d2a4a, pos: [0, 0.2, 0] });
      P.push({ g: ico(0.6, 0), color: 0x7ff5ff, pos: [0, 7, 0] });
      break;
    case 'watertower':
      for (const [x, z] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) P.push({ g: cyl(0.15, 0.15, 6, 5), color: 0x8e5b3a, pos: [x, 3, z] });
      P.push({ g: cyl(2.1, 2.1, 3.4, 12), color: 0xd98e5f, pos: [0, 7.6, 0] });
      P.push({ g: cone(2.3, 1.2, 12), color: 0xa0522d, pos: [0, 9.9, 0] });
      break;
    case 'chimney':
      P.push({ g: cyl(1.1, 1.4, 16, 10), color: 0xb5533c, pos: [0, 8, 0] });
      P.push({ g: cyl(1.2, 1.2, 0.8, 10), color: 0xf2f2f2, pos: [0, 14.5, 0] });
      break;
    case 'pillar':
      P.push({ g: box(0.5, 4, 0.5), color: 0xf5f5f5, pos: [0, 2, 0] });
      break;
    case 'pump':
      P.push({ g: box(0.8, 1.6, 0.6), color: 0xe53935, pos: [0, 0.8, 0] });
      P.push({ g: box(0.5, 0.35, 0.05), color: 0x263238, pos: [0, 1.25, -0.31] });
      break;
    case 'boat':
      P.push({ g: box(2.4, 0.9, 6), color: 0xffffff, pos: [0, 0.45, 0] });
      P.push({ g: cone(1.2, 1.8, 4), color: 0xffffff, pos: [0, 0.45, -3.9], rot: [-90 * D, 45 * D, 0], scale: [1.2, 1, 0.5] });
      P.push({ g: box(1.6, 1.1, 1.8), color: 0xeeeeee, pos: [0, 1.4, 0.8] });
      break;
    case 'bench':
      P.push({ g: box(2, 0.12, 0.5), color: 0xa0522d, pos: [0, 0.5, 0] }, { g: box(2, 0.5, 0.1), color: 0xa0522d, pos: [0, 0.8, 0.22] });
      P.push({ g: box(0.1, 0.5, 0.5), color: 0x333333, pos: [-0.9, 0.25, 0] }, { g: box(0.1, 0.5, 0.5), color: 0x333333, pos: [0.9, 0.25, 0] });
      break;
    case 'bunkerlamp':
      P.push({ g: box(1.6, 0.12, 0.5), color: 0x9ff0ff, pos: [0, 0.06, 0] });
      break;
    case 'dumpster':
      P.push({ g: box(2.2, 1.3, 1.4), color: 0x2e8b57, pos: [0, 0.7, 0] }, { g: box(2.3, 0.1, 1.5), color: 0x1f6f45, pos: [0, 1.4, 0] });
      break;
    case 'tractor':
      P.push({ g: box(1.4, 1.1, 2.6), color: 0xd63031, pos: [0, 1.1, 0] });
      P.push({ g: box(1.2, 1.2, 1.2), color: 0xb2e5ff, pos: [0, 2.2, 0.5] });
      P.push({ g: cyl(0.9, 0.9, 0.4, 12), color: 0x222222, pos: [-0.9, 0.9, 0.8], rot: [0, 0, 90 * D] }, { g: cyl(0.9, 0.9, 0.4, 12), color: 0x222222, pos: [0.9, 0.9, 0.8], rot: [0, 0, 90 * D] });
      P.push({ g: cyl(0.5, 0.5, 0.3, 10), color: 0x222222, pos: [-0.8, 0.5, -1.0], rot: [0, 0, 90 * D] }, { g: cyl(0.5, 0.5, 0.3, 10), color: 0x222222, pos: [0.8, 0.5, -1.0], rot: [0, 0, 90 * D] });
      break;
    case 'launchpad':
      P.push({ g: cyl(1.25, 1.35, 0.3, 16), color: 0x3a3a5a, pos: [0, 0.15, 0] });
      P.push({ g: cyl(1.0, 1.0, 0.34, 16), color: 0xff4fd8, pos: [0, 0.17, 0] });
      P.push({ g: cone(0.5, 0.2, 3), color: 0xfff35c, pos: [0, 0.4, 0], rot: [0, 0, 0] });
      break;
    default:
      P.push({ g: box(1, 1, 1), color: 0xff00ff, pos: [0, 0.5, 0] });
  }
  return build(P);
}

export const GLOW_PROPS = new Set(['bunkerlamp', 'launchpad', 'spire', 'lamp']);

// ---------------------------------------------------------------------------
// Weapons & items
// ---------------------------------------------------------------------------

const GUN = 0x3a3f4b;
const GUN2 = 0x23262e;
const WOOD = 0x8d5b3a;

/** Weapon/item model. Forward is -Z, origin at the grip. */
export function itemGeometry(code: number, rarity: number): THREE.BufferGeometry {
  const def = ITEM_BY_CODE[code];
  const acc = RARITIES[rarity]?.hex ?? 0xffffff;
  const P: Part[] = [];
  switch (def.id) {
    case 'pryhammer':
      P.push({ g: cyl(0.035, 0.035, 0.9, 6), color: 0x6d4c41, pos: [0, 0.3, 0] });
      P.push({ g: box(0.14, 0.16, 0.42), color: 0xff8f1f, pos: [0, 0.72, -0.05] });
      P.push({ g: box(0.1, 0.1, 0.18), color: 0x2ec4b6, pos: [0, 0.72, 0.22] });
      break;
    case 'slugger':
      P.push({ g: cyl(0.07, 0.035, 1.0, 8), color: 0xd7a86e, pos: [0, 0.45, 0] });
      P.push({ g: torus(0.06, 0.02, 4, 10), color: acc, pos: [0, 0.75, 0], rot: [90 * D, 0, 0] });
      break;
    case 'vanguard':
    case 'tritap':
      P.push({ g: box(0.1, 0.16, 0.6), color: GUN, pos: [0, 0.06, -0.15] });
      P.push({ g: cyl(0.028, 0.028, 0.4, 6), color: GUN2, pos: [0, 0.08, -0.62], rot: [90 * D, 0, 0] });
      P.push({ g: box(0.08, 0.12, 0.28), color: GUN2, pos: [0, 0.02, 0.28] });
      P.push({ g: box(0.07, 0.2, 0.09), color: GUN2, pos: [0, -0.1, -0.1], rot: [0.25, 0, 0] });
      P.push({ g: box(0.05, 0.14, 0.06), color: GUN2, pos: [0, -0.08, 0.06] });
      P.push({ g: box(0.105, 0.03, 0.4), color: acc, pos: [0, 0.1, -0.2] });
      P.push({ g: box(0.05, 0.06, 0.12), color: 0x111111, pos: [0, 0.17, -0.1] });
      if (def.id === 'tritap') P.push({ g: box(0.11, 0.06, 0.1), color: acc, pos: [0, 0.16, -0.35] });
      break;
    case 'buzzcut':
    case 'hornet':
      P.push({ g: box(0.1, 0.15, 0.38), color: GUN, pos: [0, 0.06, -0.08] });
      P.push({ g: cyl(0.025, 0.025, 0.18, 6), color: GUN2, pos: [0, 0.07, -0.34], rot: [90 * D, 0, 0] });
      P.push({ g: box(0.06, def.id === 'hornet' ? 0.34 : 0.24, 0.07), color: GUN2, pos: [0, -0.15, -0.12] });
      P.push({ g: box(0.05, 0.14, 0.06), color: GUN2, pos: [0, -0.08, 0.06] });
      P.push({ g: box(0.105, 0.03, 0.26), color: acc, pos: [0, 0.1, -0.1] });
      break;
    case 'thumper':
    case 'rattler':
      P.push({ g: box(0.1, 0.14, 0.4), color: GUN, pos: [0, 0.06, -0.1] });
      P.push({ g: cyl(0.035, 0.035, 0.6, 7), color: GUN2, pos: [0, 0.1, -0.55], rot: [90 * D, 0, 0] });
      P.push({ g: cyl(0.03, 0.03, 0.45, 7), color: GUN2, pos: [0, 0.03, -0.5], rot: [90 * D, 0, 0] });
      P.push({ g: box(0.09, 0.08, 0.22), color: def.id === 'thumper' ? WOOD : acc, pos: [0, 0.02, -0.52] });
      P.push({ g: box(0.08, 0.14, 0.32), color: WOOD, pos: [0, 0.0, 0.25], rot: [-0.15, 0, 0] });
      P.push({ g: box(0.105, 0.03, 0.3), color: acc, pos: [0, 0.14, -0.1] });
      break;
    case 'longshot':
    case 'marksman':
      P.push({ g: box(0.1, 0.14, 0.7), color: def.id === 'longshot' ? 0x4b5320 : GUN, pos: [0, 0.05, -0.1] });
      P.push({ g: cyl(0.025, 0.025, 0.6, 6), color: GUN2, pos: [0, 0.07, -0.75], rot: [90 * D, 0, 0] });
      P.push({ g: cyl(0.045, 0.045, 0.36, 8), color: 0x111111, pos: [0, 0.2, -0.12], rot: [90 * D, 0, 0] });
      P.push({ g: box(0.08, 0.15, 0.3), color: def.id === 'longshot' ? 0x4b5320 : GUN2, pos: [0, 0.0, 0.35] });
      P.push({ g: box(0.06, 0.12, 0.08), color: GUN2, pos: [0, -0.1, -0.05] });
      P.push({ g: box(0.105, 0.03, 0.3), color: acc, pos: [0, 0.13, -0.3] });
      break;
    case 'pip':
    case 'mauler':
      P.push({ g: box(0.07, 0.1, def.id === 'mauler' ? 0.34 : 0.24), color: GUN, pos: [0, 0.07, -0.08] });
      P.push({ g: box(0.06, 0.15, 0.07), color: def.id === 'mauler' ? WOOD : GUN2, pos: [0, -0.04, 0.02], rot: [0.2, 0, 0] });
      if (def.id === 'mauler') P.push({ g: cyl(0.05, 0.05, 0.08, 8), color: GUN2, pos: [0, 0.06, -0.02], rot: [90 * D, 0, 0] });
      P.push({ g: box(0.075, 0.025, 0.14), color: acc, pos: [0, 0.12, -0.1] });
      break;
    case 'boomtube':
      P.push({ g: cyl(0.1, 0.1, 1.1, 10), color: 0x556b2f, pos: [0, 0.12, -0.2], rot: [90 * D, 0, 0] });
      P.push({ g: cyl(0.12, 0.1, 0.12, 10), color: GUN2, pos: [0, 0.12, -0.78], rot: [90 * D, 0, 0] });
      P.push({ g: box(0.06, 0.15, 0.07), color: GUN2, pos: [0, -0.04, 0.0] });
      P.push({ g: box(0.14, 0.1, 0.12), color: acc, pos: [0, 0.26, -0.1] });
      break;
    case 'popper':
      P.push({ g: sphere(0.09, 8, 6), color: 0x4caf50, pos: [0, 0.05, 0] }, { g: cyl(0.03, 0.03, 0.05, 6), color: 0xcccccc, pos: [0, 0.15, 0] });
      break;
    case 'haze':
      P.push({ g: cyl(0.06, 0.06, 0.2, 8), color: 0x9c6bff, pos: [0, 0.08, 0] }, { g: cyl(0.065, 0.065, 0.04, 8), color: 0xffffff, pos: [0, 0.19, 0] });
      break;
    case 'springpad':
      P.push({ g: cyl(0.25, 0.25, 0.08, 12), color: 0xff4fd8, pos: [0, 0.05, 0] }, { g: cyl(0.2, 0.2, 0.1, 12), color: 0x333333, pos: [0, 0.1, 0] });
      break;
    case 'popfort':
      P.push({ g: box(0.22, 0.22, 0.22), color: 0x6f8fb8, pos: [0, 0.11, 0] }, { g: box(0.24, 0.05, 0.24), color: 0xffd23f, pos: [0, 0.2, 0] });
      break;
    case 'patch':
      P.push({ g: box(0.22, 0.08, 0.16), color: 0xffffff, pos: [0, 0.04, 0] }, { g: box(0.12, 0.085, 0.03), color: 0xff4d4d, pos: [0, 0.045, 0] }, { g: box(0.03, 0.085, 0.1), color: 0xff4d4d, pos: [0, 0.045, 0] });
      break;
    case 'medcrate':
      P.push({ g: box(0.4, 0.26, 0.3), color: 0xffffff, pos: [0, 0.13, 0] }, { g: box(0.2, 0.27, 0.06), color: 0x2ecc71, pos: [0, 0.135, 0] }, { g: box(0.06, 0.27, 0.2), color: 0x2ecc71, pos: [0, 0.135, 0] });
      break;
    case 'cell':
      P.push({ g: cyl(0.06, 0.06, 0.18, 8), color: 0x3fc8ff, pos: [0, 0.09, 0] }, { g: cyl(0.065, 0.065, 0.03, 8), color: 0xeeeeee, pos: [0, 0.19, 0] });
      break;
    case 'canister':
      P.push({ g: cyl(0.12, 0.12, 0.34, 10), color: 0x2f7dff, pos: [0, 0.17, 0] }, { g: cyl(0.06, 0.06, 0.08, 8), color: 0xeeeeee, pos: [0, 0.38, 0] });
      break;
    case 'fizzpop':
      P.push({ g: cyl(0.08, 0.1, 0.3, 10), color: 0xc26bff, pos: [0, 0.15, 0] }, { g: cyl(0.04, 0.06, 0.1, 8), color: 0xc26bff, pos: [0, 0.35, 0] }, { g: box(0.2, 0.08, 0.02), color: 0xffe066, pos: [0, 0.15, -0.1] });
      break;
    case 'chip':
      P.push({ g: box(0.3, 0.02, 0.2), color: 0x7ff5ff, pos: [0, 0.1, 0] }, { g: box(0.1, 0.03, 0.1), color: 0xffffff, pos: [0, 0.11, 0] });
      break;
    default:
      if (def.category === 'ammo') {
        const c = { ammo_light: 0x7ecbff, ammo_medium: 0x7fe08a, ammo_heavy: 0xff8f6b, ammo_shells: 0xffd23f, ammo_rockets: 0xff5a5a }[def.id] ?? 0xffffff;
        P.push({ g: box(0.34, 0.2, 0.22), color: 0x444b3a, pos: [0, 0.1, 0] }, { g: box(0.35, 0.06, 0.23), color: c, pos: [0, 0.14, 0] });
      } else if (def.category === 'material') {
        const c = def.material === 'timber' ? 0xc8904f : def.material === 'stone' ? 0x9aa3ad : 0x6f8fb8;
        for (let i = 0; i < 3; i++) P.push({ g: box(0.4, 0.09, 0.18), color: c, pos: [0, 0.05 + i * 0.1, (i % 2) * 0.05], rot: [0, i * 0.3, 0], jitter: 0.1 });
      } else P.push({ g: box(0.2, 0.2, 0.2), color: 0xffffff, pos: [0, 0.1, 0] });
  }
  return build(P);
}

const itemGeoCache = new Map<string, THREE.BufferGeometry>();
export function cachedItemGeometry(code: number, rarity: number) {
  const k = `${code}:${rarity}`;
  let g = itemGeoCache.get(k);
  if (!g) {
    g = itemGeometry(code, rarity);
    itemGeoCache.set(k, g);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Vehicles, transport, containers
// ---------------------------------------------------------------------------

export function roverModel(color: number): { group: THREE.Group; wheels: THREE.Object3D[] } {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const body = new THREE.Mesh(build([
    { g: box(2.2, 0.55, 3.8), color, pos: [0, 0.75, 0] },
    { g: box(2.0, 0.35, 1.2), color, pos: [0, 1.15, -1.1] },
    { g: box(1.9, 0.08, 0.9), color: 0x9fdcff, pos: [0, 1.55, -0.55], rot: [-0.6, 0, 0] },
    { g: box(0.1, 0.9, 0.1), color: 0x333333, pos: [-0.95, 1.5, 0.3] },
    { g: box(0.1, 0.9, 0.1), color: 0x333333, pos: [0.95, 1.5, 0.3] },
    { g: box(2.0, 0.1, 0.1), color: 0x333333, pos: [0, 1.95, 0.3] },
    { g: box(0.5, 0.25, 0.6), color: 0x333333, pos: [-0.45, 1.1, -0.1] },
    { g: box(0.5, 0.25, 0.6), color: 0x333333, pos: [0.45, 1.1, -0.1] },
    { g: box(0.5, 0.25, 0.6), color: 0x333333, pos: [-0.45, 1.25, 1.05] },
    { g: box(0.5, 0.25, 0.6), color: 0x333333, pos: [0.45, 1.25, 1.05] },
    { g: box(0.35, 0.15, 0.05), color: 0xfff6b0, pos: [-0.7, 0.85, -1.92] },
    { g: box(0.35, 0.15, 0.05), color: 0xfff6b0, pos: [0.7, 0.85, -1.92] },
  ]), mat);
  body.castShadow = true;
  group.add(body);
  const wheelGeo = build([{ g: cyl(0.48, 0.48, 0.38, 12), color: 0x222222, rot: [0, 0, 90 * D] }, { g: cyl(0.25, 0.25, 0.4, 8), color: 0xcccccc, rot: [0, 0, 90 * D] }]);
  const wheels: THREE.Object3D[] = [];
  for (const [x, z] of [[-1.15, -1.25], [1.15, -1.25], [-1.15, 1.3], [1.15, 1.3]]) {
    const w = new THREE.Mesh(wheelGeo, mat);
    w.position.set(x, 0.48, z);
    group.add(w);
    wheels.push(w);
  }
  return { group, wheels };
}

/** The Skywhale: a friendly blimp-whale that carries everyone over the island. */
export function skywhaleModel(): { group: THREE.Group; props: THREE.Object3D[] } {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x3a3f7a });
  const body = new THREE.Mesh(build([
    { g: sphere(6, 24, 16), color: 0x6c7cff, scale: [1, 0.85, 2.4] },
    { g: sphere(5.2, 20, 12), color: 0xd9e0ff, pos: [0, -1.6, -1], scale: [0.95, 0.6, 2.1] },
    { g: cone(3, 5, 4), color: 0x5a67e6, pos: [0, 0.5, 15.5], rot: [90 * D, 0, 0], scale: [2.2, 1, 0.3] },
    { g: cone(1.4, 4, 4), color: 0x5a67e6, pos: [0, 5.2, 6], rot: [-0.5, 0, 0], scale: [0.3, 1, 1] },
    { g: box(3.4, 2.2, 7), color: 0xfff1d6, pos: [0, -6.2, -1] },
    { g: box(3.5, 0.8, 7.1), color: 0xff7a59, pos: [0, -5.0, -1] },
    { g: box(3.45, 0.7, 5.5), color: 0x7fd6ff, pos: [0, -6.0, -1] },
    { g: sphere(0.7, 10, 8), color: 0xffffff, pos: [-3.6, 1.2, -11.5] },
    { g: sphere(0.7, 10, 8), color: 0xffffff, pos: [3.6, 1.2, -11.5] },
    { g: sphere(0.35, 8, 6), color: 0x111133, pos: [-3.9, 1.25, -12] },
    { g: sphere(0.35, 8, 6), color: 0x111133, pos: [3.9, 1.25, -12] },
    { g: torus(1.2, 0.18, 6, 16), color: 0xff8fb3, pos: [0, -1.8, -13.5], rot: [0.3, 0, 0], scale: [1, 0.4, 1] },
  ]), mat);
  body.castShadow = true;
  group.add(body);
  const props: THREE.Object3D[] = [];
  const propGeo = build([{ g: box(0.4, 4, 0.15), color: 0x333333 }, { g: sphere(0.4, 8, 6), color: 0xffd23f }]);
  for (const x of [-6.5, 6.5]) {
    const hub = new THREE.Mesh(build([{ g: cyl(0.6, 0.8, 2, 8), color: 0xff7a59, rot: [90 * D, 0, 0] }]), mat);
    hub.position.set(x, -3.5, 2);
    group.add(hub);
    const p = new THREE.Mesh(propGeo, mat);
    p.position.set(x, -3.5, 3.1);
    group.add(p);
    props.push(p);
  }
  return { group, props };
}

export function chestGeometry(open: boolean): THREE.BufferGeometry {
  const P: Part[] = [
    { g: box(1.2, 0.55, 0.75), color: 0x6b3fa0, pos: [0, 0.28, 0] },
    { g: box(1.24, 0.08, 0.79), color: 0xffd23f, pos: [0, 0.5, 0] },
    { g: box(0.08, 0.57, 0.79), color: 0xffd23f, pos: [-0.5, 0.28, 0] },
    { g: box(0.08, 0.57, 0.79), color: 0xffd23f, pos: [0.5, 0.28, 0] },
  ];
  if (open) P.push({ g: box(1.2, 0.5, 0.12), color: 0x5a3590, pos: [0, 0.85, 0.42], rot: [-0.3, 0, 0] });
  else {
    P.push({ g: box(1.2, 0.3, 0.75), color: 0x7d4bc0, pos: [0, 0.7, 0] });
    P.push({ g: box(0.2, 0.2, 0.05), color: 0xffe680, pos: [0, 0.55, -0.4] });
  }
  return build(P);
}

export function ammoBoxGeometry(open: boolean): THREE.BufferGeometry {
  return build([
    { g: box(0.9, 0.45, 0.55), color: 0x4a6b3a, pos: [0, 0.23, 0] },
    { g: box(0.92, open ? 0.02 : 0.12, 0.57), color: 0x2f4a24, pos: [0, 0.48, 0] },
    { g: box(0.3, 0.12, 0.02), color: 0xffd23f, pos: [0, 0.3, -0.29] },
  ]);
}

export function supplyGeometry(): THREE.BufferGeometry {
  return build([
    { g: box(1.6, 1.4, 1.6), color: 0x2ec4b6, pos: [0, 0.7, 0] },
    { g: box(1.64, 0.2, 1.64), color: 0xffd23f, pos: [0, 1.2, 0] },
    { g: box(1.64, 0.2, 1.64), color: 0xffd23f, pos: [0, 0.2, 0] },
  ]);
}

export function balloonGeometry(): THREE.BufferGeometry {
  return build([
    { g: sphere(1.8, 12, 10), color: 0xff4fd8, pos: [0, 5.5, 0], scale: [1, 1.15, 1] },
    { g: cyl(0.03, 0.03, 3.6, 4), color: 0xffffff, pos: [0, 2.8, 0] },
  ]);
}
