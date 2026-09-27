// World object rendering with instancing and distance culling:
// props (trees/rocks/cars...), build pieces, ground loot, containers, pads, vehicles, transport.
import * as THREE from 'three';
import { GRID } from '../../shared/constants';
import { MATERIALS, Piece, PieceType } from '../../shared/build';
import { ROOF_PEAK } from '../../shared/collision';
import { ITEM_BY_CODE, RARITIES } from '../../shared/items';
import { MapData, PROP_TYPES, PropInst } from '../../shared/mapdata';
import type { ContainerInfo, GroundItemInfo, ProjSnap, VehSnap } from '../../shared/protocol';
import type { Quality } from '../settings';
import {
  GLOW_PROPS, ammoBoxGeometry, balloonGeometry, cachedItemGeometry, chestGeometry, propGeometry, roverModel, skywhaleModel, supplyGeometry,
} from './models';
import { box, build, cone, cyl, materialTexture, radialTexture, sphere } from './util';

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

const REGION = 256;

export class PropRenderer {
  private meshes: { mesh: THREE.InstancedMesh; cx: number; cz: number }[] = [];
  private where = new Map<number, { mesh: THREE.InstancedMesh; index: number }>();
  private hits = new Map<number, number>();
  private removed = new Set<number>();

  constructor(scene: THREE.Scene, private map: MapData, quality: Quality) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
    const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const groups = new Map<string, PropInst[]>();
    for (const p of map.props) {
      const k = `${p.t}|${Math.floor(p.x / REGION)}|${Math.floor(p.z / REGION)}`;
      let arr = groups.get(k);
      if (!arr) groups.set(k, (arr = []));
      arr.push(p);
    }
    const geoCache = new Map<number, THREE.BufferGeometry>();
    for (const [k, list] of groups) {
      const t = list[0].t;
      const T = PROP_TYPES[t];
      let geo = geoCache.get(t);
      if (!geo) geoCache.set(t, (geo = propGeometry(T.id)));
      const m = GLOW_PROPS.has(T.id) ? glow : T.id === 'rock' || T.id === 'boulder' ? rockMat : mat;
      const mesh = new THREE.InstancedMesh(geo, m, list.length);
      list.forEach((p, i) => {
        tmpQ.setFromAxisAngle(UP, p.rot);
        tmpM.compose(tmpV.set(p.x, p.y, p.z), tmpQ, tmpS.set(p.s, p.s, p.s));
        mesh.setMatrixAt(i, tmpM);
        mesh.setColorAt(i, tmpC.setHex(p.tint || 0xffffff));
        this.where.set(p.id, { mesh, index: i });
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      const shadowy = quality === 'high' && !['bush', 'launchpad', 'bunkerlamp'].includes(T.id);
      mesh.castShadow = shadowy;
      mesh.receiveShadow = false;
      const [, rx, rz] = k.split('|').map(Number);
      this.meshes.push({ mesh, cx: (rx + 0.5) * REGION, cz: (rz + 0.5) * REGION });
      scene.add(mesh);
    }
  }

  /** Restore every prop (new match). */
  restoreAll() {
    for (const id of this.removed) {
      const w = this.where.get(id);
      const p = this.map.props[id];
      if (!w || !p) continue;
      tmpQ.setFromAxisAngle(UP, p.rot);
      tmpM.compose(tmpV.set(p.x, p.y, p.z), tmpQ, tmpS.set(p.s, p.s, p.s));
      w.mesh.setMatrixAt(w.index, tmpM);
      w.mesh.instanceMatrix.needsUpdate = true;
    }
    this.removed.clear();
    this.hits.clear();
  }

  remove(id: number) {
    const w = this.where.get(id);
    if (!w) return;
    this.removed.add(id);
    this.hits.delete(id);
    tmpM.makeScale(0, 0, 0);
    w.mesh.setMatrixAt(w.index, tmpM);
    w.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Small wobble when hit. */
  hit(id: number) {
    if (!this.removed.has(id)) this.hits.set(id, 0.25);
  }

  update(dt: number, cam: THREE.Vector3, drawDist: number) {
    for (const r of this.meshes) {
      r.mesh.visible = Math.hypot(r.cx - cam.x, r.cz - cam.z) < drawDist + REGION * 0.75;
    }
    for (const [id, t] of this.hits) {
      const nt = t - dt;
      const w = this.where.get(id);
      const p = this.map.props[id];
      if (!w || !p) continue;
      const k = nt > 0 ? Math.sin(nt * 60) * nt * 0.25 : 0;
      tmpQ.setFromEuler(new THREE.Euler(k, p.rot, k * 0.6));
      tmpM.compose(tmpV.set(p.x, p.y, p.z), tmpQ, tmpS.set(p.s, p.s, p.s));
      w.mesh.setMatrixAt(w.index, tmpM);
      w.mesh.instanceMatrix.needsUpdate = true;
      if (nt <= 0) this.hits.delete(id);
      else this.hits.set(id, nt);
    }
  }
}

// ---------------------------------------------------------------------------
// Build pieces
// ---------------------------------------------------------------------------

function pieceGeometry(type: PieceType, variant: number): THREE.BufferGeometry {
  const G = GRID;
  const T = 0.3;
  switch (type) {
    case 'floor':
      return build([{ g: box(G, 0.3, G), color: 0xffffff, pos: [0, -0.1, 0] }]);
    case 'wall': {
      const segs: [number, number, number, number][] =
        variant === 1 ? [[0, 1.2, 0, G], [G - 1.2, G, 0, G], [1.2, G - 1.2, 0, 1.2], [1.2, G - 1.2, 2.8, G]]
          : variant === 2 ? [[0, 1.3, 0, G], [G - 1.3, G, 0, G], [1.3, G - 1.3, 2.7, G]]
            : [[0, G, 0, G]];
      return build(segs.map(([a0, a1, h0, h1]) => ({ g: box(a1 - a0, h1 - h0, T), color: 0xffffff, pos: [(a0 + a1) / 2 - G / 2, (h0 + h1) / 2, 0] as [number, number, number] })));
    }
    case 'ramp': {
      const L = G * Math.SQRT2;
      const off = (T / 2) * Math.SQRT1_2;
      return build([{ g: box(L, T, G), color: 0xffffff, pos: [off, G / 2 - off, 0], rot: [0, 0, Math.PI / 4] }]);
    }
    case 'roof': {
      const c = new THREE.ConeGeometry(G * Math.SQRT1_2 * 1.0, ROOF_PEAK, 4, 1);
      return build([{ g: c, color: 0xffffff, pos: [0, ROOF_PEAK / 2, 0], rot: [0, Math.PI / 4, 0] }]);
    }
  }
}

const MAT_TEX = ['timber', 'stone', 'alloy', 'plank', 'brick', 'concrete', 'steel', 'glass', 'bunker', 'adobe', 'shingle'];

class Pool {
  mesh: THREE.InstancedMesh;
  ids: number[] = [];
  index = new Map<number, number>();
  constructor(private scene: THREE.Scene, private geo: THREE.BufferGeometry, private mat: THREE.Material, cap: number, private shadows: boolean) {
    this.mesh = this.make(cap);
  }
  private make(cap: number) {
    const m = new THREE.InstancedMesh(this.geo, this.mat, cap);
    m.count = 0;
    m.castShadow = this.shadows;
    m.receiveShadow = this.shadows;
    m.frustumCulled = false;
    this.scene.add(m);
    return m;
  }
  add(id: number, matrix: THREE.Matrix4, color: THREE.Color) {
    if (this.ids.length >= this.mesh.instanceMatrix.count) {
      const old = this.mesh;
      const nm = this.make(old.instanceMatrix.count * 2);
      for (let i = 0; i < this.ids.length; i++) {
        old.getMatrixAt(i, tmpM);
        nm.setMatrixAt(i, tmpM);
        old.getColorAt(i, tmpC);
        nm.setColorAt(i, tmpC);
      }
      this.scene.remove(old);
      old.dispose();
      this.mesh = nm;
    }
    const i = this.ids.length;
    this.ids.push(id);
    this.index.set(id, i);
    this.mesh.setMatrixAt(i, matrix);
    this.mesh.setColorAt(i, color);
    this.mesh.count = this.ids.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
  remove(id: number) {
    const i = this.index.get(id);
    if (i === undefined) return;
    const last = this.ids.length - 1;
    if (i !== last) {
      const lastId = this.ids[last];
      this.mesh.getMatrixAt(last, tmpM);
      this.mesh.setMatrixAt(i, tmpM);
      this.mesh.getColorAt(last, tmpC);
      this.mesh.setColorAt(i, tmpC);
      this.ids[i] = lastId;
      this.index.set(lastId, i);
    }
    this.ids.pop();
    this.index.delete(id);
    this.mesh.count = this.ids.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
  setColor(id: number, c: THREE.Color) {
    const i = this.index.get(id);
    if (i === undefined) return;
    this.mesh.setColorAt(i, c);
    this.mesh.instanceColor!.needsUpdate = true;
  }
}

export function pieceMatrix(p: { type: PieceType; i: number; j: number; k: number; d: number }, out: THREE.Matrix4) {
  const G = GRID;
  let x: number, z: number, rot = 0;
  switch (p.type) {
    case 'wall':
      if (p.d === 0) {
        x = (p.i + 0.5) * G;
        z = p.k * G;
      } else {
        x = p.i * G;
        z = (p.k + 0.5) * G;
        rot = -Math.PI / 2;
      }
      break;
    case 'ramp':
      x = (p.i + 0.5) * G;
      z = (p.k + 0.5) * G;
      rot = [0, -Math.PI / 2, Math.PI, Math.PI / 2][p.d] ?? 0;
      break;
    default:
      x = (p.i + 0.5) * G;
      z = (p.k + 0.5) * G;
  }
  tmpQ.setFromAxisAngle(UP, rot);
  return out.compose(tmpV.set(x, p.j * G, z), tmpQ, tmpS.set(1, 1, 1));
}

export class PieceRenderer {
  private pools = new Map<string, Pool>();
  private geos = new Map<string, THREE.BufferGeometry>();
  private mats: THREE.Material[] = [];
  private where = new Map<number, string>();
  private flashes = new Map<number, number>();
  private pieces = new Map<number, Piece>();
  ghost: THREE.Mesh;
  private ghostGeos = new Map<string, THREE.BufferGeometry>();
  private ghostMat: THREE.MeshBasicMaterial;

  constructor(private scene: THREE.Scene, private quality: Quality) {
    for (const md of MATERIALS) {
      const tex = materialTexture(MAT_TEX[md.code]);
      if (md.id === 'glass') this.mats.push(new THREE.MeshLambertMaterial({ map: tex, transparent: true, opacity: 0.45, depthWrite: false }));
      else this.mats.push(new THREE.MeshLambertMaterial({ map: tex }));
    }
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x5cc8ff, transparent: true, opacity: 0.4, depthWrite: false });
    this.ghost = new THREE.Mesh(new THREE.BufferGeometry(), this.ghostMat);
    this.ghost.visible = false;
    this.ghost.renderOrder = 10;
    const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
    this.ghost.add(edges);
    scene.add(this.ghost);
  }

  private geo(type: PieceType, variant: number) {
    const k = `${type}${type === 'wall' ? variant : ''}`;
    let g = this.geos.get(k);
    if (!g) this.geos.set(k, (g = pieceGeometry(type, variant)));
    return { k, g };
  }

  private color(p: Piece, now: number, out: THREE.Color) {
    const md = MATERIALS[p.mat];
    out.setHex(p.tint || md.color);
    if (p.owner !== 0 && p.buildTime > 0) {
      const k = Math.min(1, Math.max(0, (now - p.buildStart) / p.buildTime));
      if (k < 1) out.lerp(tmpC.setHex(0xbfe9ff), 0.65 * (1 - k));
    }
    const hpK = p.hp / p.maxHp;
    if (hpK < 0.5 && !md.indestructible) out.multiplyScalar(0.65 + hpK * 0.7);
    return out;
  }

  add(p: Piece, now: number) {
    this.remove(p.id);
    const { k, g } = this.geo(p.type, p.variant);
    const key = `${k}|${p.mat}`;
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new Pool(this.scene, g, this.mats[p.mat], 64, this.quality !== 'low' && p.mat !== 7);
      this.pools.set(key, pool);
    }
    pieceMatrix(p, tmpM);
    pool.add(p.id, tmpM, this.color(p, now, new THREE.Color()));
    this.where.set(p.id, key);
    this.pieces.set(p.id, p);
  }

  remove(id: number) {
    const key = this.where.get(id);
    if (!key) return;
    this.pools.get(key)!.remove(id);
    this.where.delete(id);
    this.pieces.delete(id);
  }

  flash(id: number) {
    this.flashes.set(id, 0.12);
  }

  clear() {
    for (const pool of this.pools.values()) {
      this.scene.remove(pool.mesh);
      pool.mesh.dispose();
    }
    this.pools.clear();
    this.where.clear();
    this.pieces.clear();
    this.flashes.clear();
  }

  has(id: number) {
    return this.where.has(id);
  }

  /** Recolor pieces that are building up or flashing. */
  update(dt: number, now: number) {
    const c = new THREE.Color();
    for (const [id, t] of this.flashes) {
      const p = this.pieces.get(id);
      const key = this.where.get(id);
      if (!p || !key) {
        this.flashes.delete(id);
        continue;
      }
      const nt = t - dt;
      this.color(p, now, c);
      if (nt > 0) c.lerp(tmpC.setHex(0xffffff), 0.6);
      this.pools.get(key)!.setColor(id, c);
      if (nt <= 0) this.flashes.delete(id);
      else this.flashes.set(id, nt);
    }
    for (const p of this.pieces.values()) {
      if (p.owner === 0 || p.buildTime <= 0) continue;
      const age = now - p.buildStart;
      if (age < p.buildTime + 0.2) this.pools.get(this.where.get(p.id)!)?.setColor(p.id, this.color(p, now, c));
    }
  }

  refresh(p: Piece, now: number) {
    const key = this.where.get(p.id);
    if (key) this.pools.get(key)!.setColor(p.id, this.color(p, now, new THREE.Color()));
  }

  setGhost(spec: { type: PieceType; i: number; j: number; k: number; d: number } | null, valid: boolean) {
    if (!spec) {
      this.ghost.visible = false;
      return;
    }
    const k = spec.type;
    let g = this.ghostGeos.get(k);
    if (!g) {
      g = pieceGeometry(spec.type, 0);
      this.ghostGeos.set(k, g);
    }
    if (this.ghost.geometry !== g) {
      this.ghost.geometry = g;
      const edges = this.ghost.children[0] as THREE.LineSegments;
      edges.geometry.dispose();
      edges.geometry = new THREE.EdgesGeometry(g, 30);
    }
    pieceMatrix(spec, tmpM);
    tmpM.decompose(this.ghost.position, this.ghost.quaternion, this.ghost.scale);
    this.ghostMat.color.setHex(valid ? 0x5cc8ff : 0xff5a5a);
    this.ghost.visible = true;
  }
}

// ---------------------------------------------------------------------------
// Ground loot, containers, pads, spires
// ---------------------------------------------------------------------------

interface ItemView {
  info: GroundItemInfo;
  group: THREE.Group;
  model: THREE.Mesh;
  beam?: THREE.Mesh;
  t: number;
  from?: THREE.Vector3;
}

interface ContainerView {
  info: ContainerInfo;
  group: THREE.Group;
  mesh: THREE.Mesh;
  glow?: THREE.Mesh;
  balloon?: THREE.Mesh;
}

export class LootRenderer {
  items = new Map<number, ItemView>();
  containers = new Map<number, ContainerView>();
  private mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private ringGeo = new THREE.RingGeometry(0.35, 0.5, 20);
  private beamGeo = new THREE.CylinderGeometry(0.12, 0.3, 14, 8, 1, true);
  private ringMats: THREE.MeshBasicMaterial[];
  private beamMats: THREE.MeshBasicMaterial[];
  private glowTex = radialTexture('rgba(255,230,120,0.9)', 'rgba(255,200,60,0)');
  private chestClosed = chestGeometry(false);
  private chestOpen = chestGeometry(true);
  private ammoClosed = ammoBoxGeometry(false);
  private ammoOpen = ammoBoxGeometry(true);
  private supply = supplyGeometry();
  private balloon = balloonGeometry();
  pads = new Map<number, THREE.Mesh>();
  private padGeo = propGeometry('launchpad');
  private padMat = new THREE.MeshBasicMaterial({ vertexColors: true });

  constructor(private scene: THREE.Scene) {
    this.ringMats = RARITIES.map((r) => new THREE.MeshBasicMaterial({ color: r.hex, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    this.beamMats = RARITIES.map((r) => new THREE.MeshBasicMaterial({ color: r.hex, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  }

  addItem(info: GroundItemInfo, from?: [number, number, number]) {
    this.removeItem(info.id);
    const group = new THREE.Group();
    const model = new THREE.Mesh(cachedItemGeometry(info.code, info.rarity), this.mat);
    const def = ITEM_BY_CODE[info.code];
    const scale = def.category === 'weapon' ? 1.25 : 1.6;
    model.scale.setScalar(scale);
    model.position.y = 0.35;
    if (def.category === 'weapon') model.rotation.z = Math.PI / 2;
    group.add(model);
    const ring = new THREE.Mesh(this.ringGeo, this.ringMats[info.rarity] ?? this.ringMats[0]);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    group.add(ring);
    let beam: THREE.Mesh | undefined;
    if ((def.category === 'weapon' && info.rarity >= 2) || def.category === 'special') {
      beam = new THREE.Mesh(this.beamGeo, this.beamMats[info.rarity]);
      beam.position.y = 7;
      group.add(beam);
    }
    group.position.set(info.x, info.y, info.z);
    this.scene.add(group);
    const v: ItemView = { info, group, model, beam, t: Math.random() * 10 };
    if (from) {
      v.from = new THREE.Vector3(...from);
      group.position.copy(v.from);
      v.t = 0;
    }
    this.items.set(info.id, v);
  }

  removeItem(id: number) {
    const v = this.items.get(id);
    if (!v) return;
    this.scene.remove(v.group);
    this.items.delete(id);
  }

  addContainer(info: ContainerInfo) {
    this.removeContainer(info.id);
    const group = new THREE.Group();
    const geo = info.kind === 'chest' ? (info.open ? this.chestOpen : this.chestClosed) : info.kind === 'ammo' ? (info.open ? this.ammoOpen : this.ammoClosed) : this.supply;
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.castShadow = true;
    group.add(mesh);
    let glow: THREE.Mesh | undefined;
    if (info.kind !== 'ammo' && !info.open) {
      glow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshBasicMaterial({ map: this.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.position.y = 0.6;
      group.add(glow);
    }
    let balloon: THREE.Mesh | undefined;
    if (info.kind === 'supply') {
      balloon = new THREE.Mesh(this.balloon, this.mat);
      group.add(balloon);
    }
    group.position.set(info.x, info.y, info.z);
    group.rotation.y = info.rot;
    this.scene.add(group);
    this.containers.set(info.id, { info, group, mesh, glow, balloon });
  }

  openContainer(id: number) {
    const c = this.containers.get(id);
    if (!c) return;
    c.info.open = true;
    if (c.info.kind === 'chest') c.mesh.geometry = this.chestOpen;
    else if (c.info.kind === 'ammo') c.mesh.geometry = this.ammoOpen;
    if (c.glow) {
      c.group.remove(c.glow);
      c.glow = undefined;
    }
    if (c.balloon) {
      c.group.remove(c.balloon);
      c.balloon = undefined;
    }
  }

  removeContainer(id: number) {
    const c = this.containers.get(id);
    if (!c) return;
    this.scene.remove(c.group);
    this.containers.delete(id);
  }

  clear() {
    for (const id of [...this.items.keys()]) this.removeItem(id);
    for (const id of [...this.containers.keys()]) this.removeContainer(id);
    for (const m of this.pads.values()) this.scene.remove(m);
    this.pads.clear();
  }

  addPad(id: number, x: number, y: number, z: number) {
    if (this.pads.has(id)) return;
    const m = new THREE.Mesh(this.padGeo, this.padMat);
    m.position.set(x, y, z);
    this.scene.add(m);
    this.pads.set(id, m);
  }

  update(dt: number, cam: THREE.Vector3, camera: THREE.Camera, time: number) {
    for (const v of this.items.values()) {
      v.t += dt;
      const d = Math.hypot(v.info.x - cam.x, v.info.z - cam.z);
      const near = d < 90;
      v.model.visible = near;
      v.group.visible = near || (!!v.beam && d < 220);
      if (!v.group.visible) continue;
      if (v.from && v.t < 0.5) {
        const k = v.t / 0.5;
        v.group.position.set(v.from.x + (v.info.x - v.from.x) * k, v.from.y + (v.info.y - v.from.y) * k + Math.sin(k * Math.PI) * 1.2, v.from.z + (v.info.z - v.from.z) * k);
      } else v.group.position.set(v.info.x, v.info.y, v.info.z);
      v.model.rotation.y += dt * 0.8;
      v.model.position.y = 0.35 + Math.sin(v.t * 2) * 0.06;
    }
    for (const c of this.containers.values()) {
      const d = Math.hypot(c.info.x - cam.x, c.info.z - cam.z);
      c.group.visible = d < 200 || c.info.kind === 'supply';
      if (c.glow) {
        c.glow.quaternion.copy(camera.quaternion);
        (c.glow.material as THREE.MeshBasicMaterial).opacity = 0.6 + Math.sin(time * 4) * 0.25;
      }
      if (c.info.kind === 'supply' && c.info.land !== undefined && c.info.y0 !== undefined) {
        const k = Math.max(0, Math.min(1, 1 - (c.info.land - time) / ((c.info.y0 - c.info.y) / 7)));
        c.group.position.y = c.info.y0 + (c.info.y - c.info.y0) * k;
        c.group.rotation.y += dt * 0.3;
      }
    }
    for (const p of this.pads.values()) p.rotation.y += dt * 1.5;
  }
}

// ---------------------------------------------------------------------------
// Vehicles & transport
// ---------------------------------------------------------------------------

interface VehView {
  group: THREE.Group;
  wheels: THREE.Object3D[];
  prev: VehSnap;
  cur: VehSnap;
  t0: number;
  t1: number;
  spin: number;
}

const ROVER_COLORS = [0xff5a5f, 0x2ec4b6, 0xffd23f, 0x3a86ff, 0x8338ec, 0xfb5607];

export class VehicleRenderer {
  views = new Map<number, VehView>();
  /** Locally predicted vehicle (the one we drive) — rendered from prediction, not interpolation. */
  predicted: { id: number; x: number; y: number; z: number; yaw: number; pitch: number; roll: number; speed: number } | null = null;
  bus: { group: THREE.Group; props: THREE.Object3D[] };
  constructor(private scene: THREE.Scene) {
    this.bus = skywhaleModel();
    this.bus.group.visible = false;
    scene.add(this.bus.group);
  }

  sync(list: VehSnap[], t: number) {
    const seen = new Set<number>();
    for (const v of list) {
      seen.add(v.id);
      let view = this.views.get(v.id);
      if (!view) {
        const m = roverModel(ROVER_COLORS[v.id % ROVER_COLORS.length]);
        this.scene.add(m.group);
        view = { group: m.group, wheels: m.wheels, prev: v, cur: v, t0: t, t1: t, spin: 0 };
        this.views.set(v.id, view);
      }
      view.prev = view.cur;
      view.t0 = view.t1;
      view.cur = v;
      view.t1 = t;
    }
    for (const [id, v] of this.views) if (!seen.has(id)) {
      this.scene.remove(v.group);
      this.views.delete(id);
    }
  }

  remove(id: number) {
    const v = this.views.get(id);
    if (v) {
      this.scene.remove(v.group);
      this.views.delete(id);
    }
  }

  update(dt: number, renderT: number) {
    for (const v of this.views.values()) {
      const span = Math.max(0.001, v.t1 - v.t0);
      const k = Math.min(1.5, Math.max(0, (renderT - v.t0) / span));
      const a = v.prev, b = v.cur;
      const pr = this.predicted && this.predicted.id === b.id ? this.predicted : null;
      v.group.rotation.set(0, 0, 0);
      if (pr) {
        v.group.position.set(pr.x, pr.y, pr.z);
        v.group.rotateY(pr.yaw);
        v.group.rotateX(pr.pitch);
        v.group.rotateZ(pr.roll);
      } else {
        v.group.position.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
        let dy = b.yaw - a.yaw;
        if (dy > Math.PI) dy -= Math.PI * 2;
        if (dy < -Math.PI) dy += Math.PI * 2;
        v.group.rotateY(a.yaw + dy * k);
        // positive pitch = nose up (front is -Z), positive roll = right side up
        v.group.rotateX(a.pitch + (b.pitch - a.pitch) * k);
        v.group.rotateZ(a.roll + (b.roll - a.roll) * k);
      }
      v.spin += (pr ? pr.speed : b.speed) * dt / 0.48;
      for (const w of v.wheels) w.rotation.x = -v.spin;
    }
  }

  clear() {
    for (const v of this.views.values()) this.scene.remove(v.group);
    this.views.clear();
  }

  setBus(p: { x: number; y: number; z: number; yaw: number } | null, dt: number) {
    this.bus.group.visible = !!p;
    if (!p) return;
    this.bus.group.position.set(p.x, p.y + 6, p.z);
    this.bus.group.rotation.set(0, p.yaw, 0);
    for (const pr of this.bus.props) pr.rotation.z += dt * 20;
  }
}

// ---------------------------------------------------------------------------
// Projectiles in flight (rockets, grenades, smoke canisters, sniper bullets)
// ---------------------------------------------------------------------------

interface ProjView {
  mesh: THREE.Object3D;
  kind: number;
  prev: THREE.Vector3;
  cur: THREE.Vector3;
  t0: number;
  t1: number;
  pos: THREE.Vector3;
}

interface LocalBullet {
  mesh: THREE.Object3D;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  gravity: number;
  range: number;
}

export class ProjectileRenderer {
  views = new Map<number, ProjView>();
  private locals: LocalBullet[] = [];
  /** Predicted bullets spawned so far (diagnostics / e2e). */
  spawned = 0;
  /** World ray test used to stop predicted bullets; returns hit distance or null. */
  raycast: (o: THREE.Vector3, d: THREE.Vector3, max: number) => number | null = () => null;
  onImpact: (p: THREE.Vector3) => void = () => {};
  private geos: THREE.BufferGeometry[];
  private mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private glow = new THREE.MeshBasicMaterial({ color: 0xfff2c0 });
  onTrail: (kind: number, p: THREE.Vector3) => void = () => {};

  constructor(private scene: THREE.Scene) {
    this.geos = [
      build([
        { g: cyl(0.09, 0.09, 0.7, 8), color: 0x556b2f, rot: [Math.PI / 2, 0, 0] },
        { g: cone(0.09, 0.25, 8), color: 0xff5a36, pos: [0, 0, -0.47], rot: [-Math.PI / 2, 0, 0] },
      ]),
      build([{ g: sphere(0.12, 8, 6), color: 0x4caf50 }]),
      build([{ g: cyl(0.07, 0.07, 0.22, 8), color: 0x9c6bff }]),
      build([{ g: box(0.05, 0.05, 1.6), color: 0xffffff }]),
    ];
  }

  sync(list: ProjSnap[], t: number) {
    const seen = new Set<number>();
    for (const p of list) {
      seen.add(p.id);
      let v = this.views.get(p.id);
      if (!v) {
        const mesh = new THREE.Mesh(this.geos[p.kind] ?? this.geos[1], p.kind === 3 ? this.glow : this.mat);
        this.scene.add(mesh);
        const at = new THREE.Vector3(p.x, p.y, p.z);
        v = { mesh, kind: p.kind, prev: at.clone(), cur: at.clone(), t0: t, t1: t, pos: at.clone() };
        this.views.set(p.id, v);
      } else {
        v.prev.copy(v.cur);
        v.t0 = v.t1;
      }
      v.cur.set(p.x, p.y, p.z);
      v.t1 = t;
    }
    for (const [id, v] of this.views) if (!seen.has(id)) {
      this.scene.remove(v.mesh);
      this.views.delete(id);
    }
  }

  clear() {
    for (const v of this.views.values()) this.scene.remove(v.mesh);
    this.views.clear();
    for (const b of this.locals) this.scene.remove(b.mesh);
    this.locals.length = 0;
  }

  /** Visual-only bullet for the local shooter (the server simulates the real one). */
  spawnLocal(pos: THREE.Vector3, vel: THREE.Vector3, gravity: number, range: number) {
    const mesh = new THREE.Mesh(this.geos[3], this.glow);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.locals.push({ mesh, pos: pos.clone(), vel: vel.clone(), gravity, range });
    this.spawned++;
  }

  private stepLocals(dt: number) {
    const dir = new THREE.Vector3();
    for (let i = this.locals.length - 1; i >= 0; i--) {
      const b = this.locals[i];
      b.vel.y -= b.gravity * dt;
      const len = b.vel.length() * dt;
      b.range -= len;
      dir.copy(b.vel).normalize();
      const hit = this.raycast(b.pos, dir, len);
      if (hit !== null || b.range <= 0 || b.pos.y < -30) {
        if (hit !== null) {
          b.pos.addScaledVector(dir, hit);
          this.onImpact(b.pos);
        }
        this.scene.remove(b.mesh);
        this.locals.splice(i, 1);
        continue;
      }
      b.pos.addScaledVector(dir, len);
      b.mesh.position.copy(b.pos);
      b.mesh.lookAt(b.pos.clone().sub(dir));
      this.onTrail(3, b.pos);
    }
  }

  update(dt: number, renderT: number) {
    this.stepLocals(dt);
    for (const v of this.views.values()) {
      const span = Math.max(0.001, v.t1 - v.t0);
      const k = Math.min(1.6, Math.max(0, (renderT - v.t0) / span));
      const last = v.pos.clone();
      v.pos.lerpVectors(v.prev, v.cur, k);
      v.mesh.position.copy(v.pos);
      const d = v.pos.clone().sub(last);
      if (d.lengthSq() > 1e-6) v.mesh.lookAt(v.pos.clone().sub(d));
      if (v.kind === 1 || v.kind === 2) v.mesh.rotation.x += dt * 12;
      this.onTrail(v.kind, v.pos);
    }
  }
}
