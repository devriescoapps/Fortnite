// Stylized procedural characters: chunky proportions, cosmetic outfits/headwear/backpacks/
// gliders, and a procedural animation state machine (run, crouch, slide, jump, skydive, glide,
// swim, downed, mantle, vehicle, melee, emotes). Hitboxes are identical for every cosmetic.
import * as THREE from 'three';
import { COSMETIC_BY_ID } from '../../shared/progression';
import type { CosmeticLoadout } from '../../shared/protocol';
import { Mode } from '../../shared/sim';
import { cachedItemGeometry } from './models';
import { box, build, cone, cyl, sphere, torus } from './util';

export interface AnimState {
  mode: Mode;
  speed: number;
  grounded: boolean;
  crouch: boolean;
  sprint: boolean;
  ads: boolean;
  slide: boolean;
  reload: boolean;
  using: boolean;
  building: boolean;
  vy: number;
  pitch: number;
  emote: number;
  item: number; // held item code, 254 = building, 255 = none
  rarity: number;
}

const matCache = new Map<number, THREE.MeshLambertMaterial>();
function mat(hex: number) {
  let m = matCache.get(hex);
  if (!m) matCache.set(hex, (m = new THREE.MeshLambertMaterial({ color: hex })));
  return m;
}
const vcMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const gliderMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: 0x333333 });
const glowMat = (hex: number) => new THREE.MeshBasicMaterial({ color: hex });

const capsule = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 4, 8);

export class CharacterModel {
  root = new THREE.Group();
  private body = new THREE.Group(); // pelvis pivot (y = hip height)
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private hand = new THREE.Group();
  private back = new THREE.Group();
  private hat = new THREE.Group();
  private glider = new THREE.Group();
  private held: THREE.Mesh | null = null;
  private heldKey = '';
  private far: THREE.Mesh;
  private detail = new THREE.Group();
  private phase = 0;
  private swingT = 0;
  private fireT = 0;
  private emoteT = 0;
  private lastEmote = 0;
  private lean = 0;
  private skyTilt = 0;
  cos: CosmeticLoadout;
  nameTag: HTMLDivElement | null = null;

  constructor(cos: CosmeticLoadout) {
    this.cos = cos;
    this.root.add(this.detail);
    this.detail.add(this.body);
    this.body.position.y = 0.82;
    this.body.add(this.torso);
    this.torso.add(this.head);
    this.head.position.y = 0.78;
    this.torso.add(this.armL, this.armR);
    this.armL.position.set(-0.33, 0.52, 0);
    this.armR.position.set(0.33, 0.52, 0);
    this.body.add(this.legL, this.legR);
    this.legL.position.set(-0.13, 0, 0);
    this.legR.position.set(0.13, 0, 0);
    this.armR.add(this.hand);
    this.hand.position.set(0, -0.5, 0);
    this.torso.add(this.back);
    this.back.position.set(0, 0.35, 0.27);
    this.head.add(this.hat);
    this.root.add(this.glider);
    this.glider.position.y = 2.6;
    this.glider.visible = false;
    this.far = new THREE.Mesh(capsule(0.35, 1.0), mat(0xffffff));
    this.far.position.y = 0.9;
    this.far.visible = false;
    this.root.add(this.far);
    this.setCosmetics(cos);
  }

  setCosmetics(cos: CosmeticLoadout) {
    this.cos = cos;
    const outfit = COSMETIC_BY_ID[cos.outfit] ?? COSMETIC_BY_ID.rookie;
    const c = outfit.colors!;
    for (const g of [this.torso, this.head, this.armL, this.armR, this.legL, this.legR, this.back, this.hat, this.glider]) {
      for (const ch of [...g.children]) if (ch instanceof THREE.Mesh && ch !== this.held) g.remove(ch);
    }
    // torso
    const torso = new THREE.Mesh(capsule(0.25, 0.32), mat(c.primary));
    torso.scale.set(1.12, 1, 0.82);
    torso.position.y = 0.36;
    const belt = new THREE.Mesh(cyl(0.29, 0.29, 0.09, 12), mat(c.accent));
    belt.scale.set(1, 1, 0.8);
    belt.position.y = 0.08;
    const hips = new THREE.Mesh(capsule(0.22, 0.05), mat(c.secondary));
    hips.scale.set(1.15, 1, 0.8);
    hips.position.y = 0.02;
    this.torso.add(torso, belt, hips);
    // head
    const skull = new THREE.Mesh(sphere(0.27, 16, 12), mat(c.skin));
    skull.scale.set(1, 1.05, 0.98);
    const eyeG = new THREE.SphereGeometry(0.045, 8, 6);
    const eyeL = new THREE.Mesh(eyeG, mat(0x1a1a2a));
    eyeL.position.set(-0.09, 0.03, -0.24);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.09;
    this.head.add(skull, eyeL, eyeR);
    switch (outfit.style) {
      case 'visor': {
        const v = new THREE.Mesh(box(0.46, 0.1, 0.12), mat(c.accent));
        v.position.set(0, 0.04, -0.2);
        this.head.add(v);
        break;
      }
      case 'goggles': {
        for (const x of [-0.1, 0.1]) {
          const g = new THREE.Mesh(torus(0.065, 0.02, 6, 12), mat(c.accent));
          g.position.set(x, 0.05, -0.245);
          this.head.add(g);
        }
        const strap = new THREE.Mesh(torus(0.275, 0.02, 4, 20), mat(c.secondary));
        strap.rotation.x = Math.PI / 2;
        strap.position.y = 0.05;
        this.head.add(strap);
        break;
      }
      case 'mask': {
        const m = new THREE.Mesh(sphere(0.2, 10, 8, ), mat(c.accent));
        m.scale.set(1.1, 0.55, 0.7);
        m.position.set(0, -0.1, -0.12);
        this.head.add(m);
        break;
      }
      case 'helm': {
        const h = new THREE.Mesh(sphere(0.3, 14, 10), mat(c.secondary));
        h.scale.set(1, 1, 1);
        h.position.set(0, 0.06, 0.03);
        const v = new THREE.Mesh(box(0.44, 0.14, 0.1), glowMat(c.accent));
        v.position.set(0, 0.03, -0.25);
        this.head.add(h, v);
        break;
      }
      default: {
        const mouth = new THREE.Mesh(torus(0.06, 0.015, 4, 10, ), mat(0x5a2a2a));
        mouth.rotation.z = Math.PI;
        mouth.position.set(0, -0.08, -0.25);
        (mouth.geometry as THREE.TorusGeometry).dispose();
        mouth.geometry = new THREE.TorusGeometry(0.06, 0.015, 4, 10, Math.PI);
        this.head.add(mouth);
      }
    }
    // limbs
    for (const [arm, side] of [[this.armL, -1], [this.armR, 1]] as const) {
      const sh = new THREE.Mesh(sphere(0.11, 8, 6), mat(c.primary));
      const up = new THREE.Mesh(capsule(0.085, 0.32), mat(c.primary));
      up.position.y = -0.22;
      const hand = new THREE.Mesh(sphere(0.085, 8, 6), mat(c.skin));
      hand.position.y = -0.47;
      arm.add(sh, up, hand);
      void side;
    }
    for (const leg of [this.legL, this.legR]) {
      const l = new THREE.Mesh(capsule(0.11, 0.42), mat(c.secondary));
      l.position.y = -0.34;
      const shoe = new THREE.Mesh(box(0.2, 0.13, 0.32), mat(c.accent));
      shoe.position.set(0, -0.74, -0.05);
      leg.add(l, shoe);
    }
    this.buildHat(cos.headwear, c);
    this.buildBack(cos.backpack, c);
    this.buildGlider(cos.glider, c);
    (this.far.material as THREE.MeshLambertMaterial) = mat(c.primary);
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
      }
    });
  }

  private buildHat(id: string, c: { primary: number; secondary: number; accent: number }) {
    const add = (g: THREE.BufferGeometry, m: THREE.Material, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], sc: [number, number, number] = [1, 1, 1]) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(...pos);
      mesh.rotation.set(...rot);
      mesh.scale.set(...sc);
      this.hat.add(mesh);
    };
    switch (id) {
      case 'cap':
        add(new THREE.SphereGeometry(0.285, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(c.accent), [0, 0.06, 0]);
        add(box(0.3, 0.03, 0.2), mat(c.accent), [0, 0.07, -0.3]);
        break;
      case 'beanie':
        add(new THREE.SphereGeometry(0.29, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(c.secondary), [0, 0.04, 0], [0, 0, 0], [1, 1.15, 1]);
        add(sphere(0.08, 8, 6), mat(0xffffff), [0, 0.38, 0]);
        break;
      case 'headphones':
        add(torus(0.29, 0.03, 6, 16, ), mat(0x222222), [0, 0.05, 0], [0, 0, 0], [1, 1, 1]);
        add(cyl(0.09, 0.09, 0.08, 10), mat(c.accent), [-0.29, 0, 0], [0, 0, Math.PI / 2]);
        add(cyl(0.09, 0.09, 0.08, 10), mat(c.accent), [0.29, 0, 0], [0, 0, Math.PI / 2]);
        break;
      case 'foxears':
        add(cone(0.08, 0.2, 4), mat(0xff9f1c), [-0.15, 0.3, 0], [0, 0, 0.3]);
        add(cone(0.08, 0.2, 4), mat(0xff9f1c), [0.15, 0.3, 0], [0, 0, -0.3]);
        break;
      case 'partyhat':
        add(cone(0.15, 0.4, 10), mat(0xff4fd8), [0, 0.42, 0]);
        add(sphere(0.05, 6, 5), mat(0xffd23f), [0, 0.64, 0]);
        break;
      case 'mohawk':
        for (let i = 0; i < 5; i++) add(box(0.05, 0.16 + (i === 2 ? 0.06 : 0), 0.1), mat(c.accent), [0, 0.3, -0.18 + i * 0.09]);
        break;
      case 'halo':
        add(torus(0.2, 0.025, 6, 20), glowMat(0xfff3a0), [0, 0.46, 0], [Math.PI / 2, 0, 0]);
        break;
      case 'crown':
        add(cyl(0.2, 0.2, 0.12, 10), mat(0xffc93c), [0, 0.3, 0]);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          add(cone(0.04, 0.12, 4), mat(0xffc93c), [Math.cos(a) * 0.18, 0.42, Math.sin(a) * 0.18]);
        }
        break;
      default:
        break;
    }
  }

  private buildBack(id: string, c: { primary: number; secondary: number; accent: number }) {
    const add = (g: THREE.BufferGeometry, m: THREE.Material, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0], sc: [number, number, number] = [1, 1, 1]) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(...pos);
      mesh.rotation.set(...rot);
      mesh.scale.set(...sc);
      this.back.add(mesh);
    };
    switch (id) {
      case 'satchel':
        add(box(0.4, 0.42, 0.18), mat(0x8d5b3a), [0, 0, 0.02]);
        add(box(0.42, 0.12, 0.2), mat(0x6d4428), [0, 0.15, 0.02]);
        break;
      case 'rocketpack':
        add(cyl(0.1, 0.1, 0.5, 10), mat(0xdddddd), [-0.12, 0, 0.05]);
        add(cyl(0.1, 0.1, 0.5, 10), mat(0xdddddd), [0.12, 0, 0.05]);
        add(cone(0.1, 0.15, 10), mat(0xff5a36), [-0.12, -0.32, 0.05], [Math.PI, 0, 0]);
        add(cone(0.1, 0.15, 10), mat(0xff5a36), [0.12, -0.32, 0.05], [Math.PI, 0, 0]);
        break;
      case 'shell':
        add(new THREE.SphereGeometry(0.34, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x4caf50), [0, -0.05, -0.02], [Math.PI / 2, 0, 0], [1, 1.2, 0.8]);
        break;
      case 'guitar':
        add(sphere(0.2, 10, 8), mat(0xc0392b), [0, -0.1, 0.06], [0, 0, 0], [1, 1.2, 0.35]);
        add(box(0.06, 0.6, 0.04), mat(0x5d4037), [0, 0.35, 0.06]);
        break;
      case 'wings':
        add(cone(0.18, 0.6, 3), mat(0xffffff), [-0.3, 0.05, 0.05], [0, 0, 1.2], [1, 1, 0.2]);
        add(cone(0.18, 0.6, 3), mat(0xffffff), [0.3, 0.05, 0.05], [0, 0, -1.2], [1, 1, 0.2]);
        break;
      case 'flag':
        add(cyl(0.02, 0.02, 1.0, 5), mat(0xdddddd), [0.12, 0.3, 0.05]);
        add(box(0.02, 0.28, 0.42), mat(c.accent), [0.12, 0.66, 0.26]);
        break;
      default:
        break;
    }
  }

  private buildGlider(id: string, c: { primary: number; accent: number }) {
    let g: THREE.BufferGeometry;
    switch (id) {
      case 'parafoil':
        g = build([{ g: box(3.4, 0.2, 1.4), color: c.accent, pos: [0, 0.6, 0] }, { g: box(3.2, 0.12, 1.3), color: 0xffffff, pos: [0, 0.45, 0] }, { g: cyl(0.01, 0.01, 1.2, 3), color: 0x333333, pos: [-1.2, 0, 0], rot: [0, 0, 0.6] }, { g: cyl(0.01, 0.01, 1.2, 3), color: 0x333333, pos: [1.2, 0, 0], rot: [0, 0, -0.6] }]);
        break;
      case 'kite':
        g = build([{ g: box(2.4, 0.08, 2.4), color: c.accent, pos: [0, 0.3, 0], rot: [0, Math.PI / 4, 0] }, { g: box(0.06, 0.06, 3.2), color: 0x333333, pos: [0, 0.35, 0] }, { g: box(3.2, 0.06, 0.06), color: 0x333333, pos: [0, 0.35, 0] }]);
        break;
      case 'leaf':
        g = build([{ g: sphere(1.6, 12, 6), color: 0xe67e22, pos: [0, 0.4, 0], scale: [1.2, 0.12, 0.8] }, { g: box(0.05, 0.05, 2.6), color: 0x8d5b3a, pos: [0, 0.45, 0] }]);
        break;
      case 'manta':
        g = build([{ g: sphere(1.7, 12, 6), color: 0x2b2d42, pos: [0, 0.4, 0], scale: [1.3, 0.15, 0.7] }, { g: cone(0.1, 1.6, 4), color: 0x2b2d42, pos: [0, 0.4, 1.5], rot: [Math.PI / 2, 0, 0] }, { g: sphere(0.2, 6, 5), color: 0x7ff5ff, pos: [0, 0.5, -0.9] }]);
        break;
      default:
        g = build([{ g: cone(2.2, 2.6, 3), color: c.accent, pos: [0, 0.4, 0.2], rot: [-Math.PI / 2, 0, 0], scale: [1, 1, 0.08] }, { g: box(0.06, 0.06, 2), color: 0x333333, pos: [0, 0.45, 0] }]);
    }
    const m = new THREE.Mesh(g, gliderMat);
    m.castShadow = true;
    m.scale.setScalar(0.85);
    this.glider.add(m);
  }

  private setHeld(code: number, rarity: number) {
    const key = `${code}:${rarity}`;
    if (key === this.heldKey) return;
    this.heldKey = key;
    if (this.held) {
      this.hand.remove(this.held);
      this.held = null;
    }
    if (code === 255) return;
    if (code === 254) {
      // building: show a glowing blueprint tablet
      const m = new THREE.Mesh(box(0.25, 0.02, 0.18), glowMat(0x5cc8ff));
      m.rotation.x = -0.3;
      this.held = m;
    } else {
      this.held = new THREE.Mesh(cachedItemGeometry(code, rarity), vcMat);
      this.held.castShadow = true;
    }
    this.hand.add(this.held);
  }

  triggerSwing() {
    this.swingT = 0.32;
  }
  triggerFire() {
    this.fireT = 0.1;
  }

  setLod(far: boolean) {
    this.detail.visible = !far;
    this.far.visible = far;
  }

  update(dt: number, st: AnimState, time: number) {
    this.setHeld(st.item, st.rarity);
    this.swingT = Math.max(0, this.swingT - dt);
    this.fireT = Math.max(0, this.fireT - dt);
    const b = this.body, t = this.torso;
    // reset pose
    b.position.set(0, 0.82, 0);
    b.rotation.set(0, 0, 0);
    t.rotation.set(0, 0, 0);
    t.position.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    this.armL.rotation.set(0, 0, 0);
    this.armR.rotation.set(0, 0, 0);
    this.legL.rotation.set(0, 0, 0);
    this.legR.rotation.set(0, 0, 0);
    this.root.rotation.x = 0;
    this.hand.rotation.set(0, 0, 0);
    this.glider.visible = st.mode === Mode.Glide;
    if (this.held) this.held.visible = st.mode === Mode.Walk || st.mode === Mode.Mantle;

    const holding = st.item !== 255 && st.item !== 254 && st.item !== 0 && !st.sprint && st.mode === Mode.Walk;
    const gunPose = holding && st.item !== 12;
    const sp = Math.min(1.3, st.speed / 6.2);
    this.phase += dt * (3 + st.speed * 1.35);
    const s = Math.sin(this.phase);
    const targetLean = st.mode === Mode.Walk && st.grounded ? (st.sprint ? 0.2 : sp * 0.08) : 0;
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 8);

    if (st.emote !== this.lastEmote) {
      this.lastEmote = st.emote;
      this.emoteT = 0;
    }
    this.emoteT += dt;

    switch (st.mode) {
      case Mode.Skydive: {
        this.skyTilt += (1 - this.skyTilt) * Math.min(1, dt * 4);
        b.rotation.x = -1.3 * this.skyTilt + st.pitch * 0.2;
        b.position.y = 1.0;
        this.armL.rotation.z = -1.4 + Math.sin(time * 6) * 0.08;
        this.armR.rotation.z = 1.4 - Math.sin(time * 6) * 0.08;
        this.armL.rotation.x = 0.4;
        this.armR.rotation.x = 0.4;
        this.legL.rotation.z = -0.35;
        this.legR.rotation.z = 0.35;
        this.legL.rotation.x = -0.4;
        this.legR.rotation.x = -0.4;
        return;
      }
      case Mode.Glide:
        this.skyTilt = 0;
        b.rotation.x = -0.25;
        this.armL.rotation.set(Math.PI - 0.15, 0, 0.35);
        this.armR.rotation.set(Math.PI - 0.15, 0, -0.35);
        this.legL.rotation.x = 0.35 + Math.sin(time * 3) * 0.12;
        this.legR.rotation.x = 0.2 - Math.sin(time * 3) * 0.12;
        return;
      case Mode.Swim:
        b.rotation.x = -1.1;
        b.position.y = 1.35;
        this.armL.rotation.x = Math.sin(time * 5) * 1.6 + 1.5;
        this.armR.rotation.x = -Math.sin(time * 5) * 1.6 + 1.5;
        this.legL.rotation.x = Math.sin(time * 8) * 0.4;
        this.legR.rotation.x = -Math.sin(time * 8) * 0.4;
        return;
      case Mode.Downed:
        b.rotation.x = -1.25;
        b.position.y = 0.35;
        this.armL.rotation.x = 2.2 + s * 0.5 * Math.min(1, st.speed);
        this.armR.rotation.x = 2.2 - s * 0.5 * Math.min(1, st.speed);
        this.legL.rotation.x = -0.2 + s * 0.3 * Math.min(1, st.speed);
        this.legR.rotation.x = -0.2 - s * 0.3 * Math.min(1, st.speed);
        this.head.rotation.x = 0.9;
        return;
      case Mode.Vehicle:
        b.position.y = 0.55;
        this.legL.rotation.x = 1.45;
        this.legR.rotation.x = 1.45;
        this.armL.rotation.x = 1.1;
        this.armR.rotation.x = 1.1;
        return;
      case Mode.Mantle:
        this.armL.rotation.x = 2.8;
        this.armR.rotation.x = 2.8;
        this.legL.rotation.x = 0.9;
        this.legR.rotation.x = -0.3;
        return;
      default:
        this.skyTilt = 0;
    }

    // --- emotes ---
    if (st.emote) {
      this.playEmote(st.emote, this.emoteT);
      return;
    }

    // --- walking / idle / airborne ---
    if (st.slide) {
      b.position.y = 0.5;
      b.rotation.x = 0.55;
      this.legL.rotation.x = 1.3;
      this.legR.rotation.x = 0.4;
      this.armL.rotation.x = 0.6;
    } else if (!st.grounded) {
      const up = st.vy > 0;
      this.legL.rotation.x = up ? 0.9 : 0.4;
      this.legR.rotation.x = up ? -0.2 : -0.1;
      this.armL.rotation.z = -0.6;
      this.armR.rotation.z = 0.6;
    } else if (st.crouch) {
      b.position.y = 0.5;
      this.legL.rotation.x = 1.2 + s * 0.35 * sp;
      this.legR.rotation.x = 0.3 - s * 0.35 * sp;
      b.rotation.x = -0.25;
    } else if (st.speed > 0.4) {
      const amp = 0.55 + sp * 0.45;
      this.legL.rotation.x = s * amp;
      this.legR.rotation.x = -s * amp;
      b.position.y = 0.82 + Math.abs(Math.cos(this.phase)) * 0.06 * sp;
      this.armL.rotation.x = -s * amp * 0.8;
      this.armR.rotation.x = s * amp * 0.8;
    } else {
      b.position.y = 0.82 + Math.sin(time * 2) * 0.01;
      this.armL.rotation.z = -0.08;
      this.armR.rotation.z = 0.08;
    }
    t.rotation.x = -this.lean;

    // --- upper body: aiming / holding ---
    const aimPitch = st.pitch;
    if (st.building) {
      this.armR.rotation.x = 1.1;
      this.armL.rotation.x = 0.9;
      this.armL.rotation.z = 0.3;
      this.hand.rotation.x = -Math.PI / 2;
    } else if (gunPose) {
      const kick = this.fireT > 0 ? this.fireT * 2.5 : 0;
      this.armR.rotation.x = Math.PI / 2 + aimPitch + kick;
      this.armR.rotation.z = 0.05;
      this.armL.rotation.x = Math.PI / 2 + aimPitch - 0.1 + kick;
      this.armL.rotation.z = -0.55;
      this.armL.rotation.y = 0.3;
      this.hand.rotation.x = -Math.PI / 2;
      t.rotation.y = st.ads ? 0.2 : 0.1;
      if (st.reload) {
        this.armL.rotation.x = 0.8 + Math.sin(time * 12) * 0.3;
        this.armR.rotation.x = 1.0;
      }
      if (st.using) {
        this.armR.rotation.x = 2.2;
        this.armL.rotation.x = 0.3;
      }
    } else if (holding) {
      // melee weapon / consumables
      this.armR.rotation.x = 0.6;
      this.hand.rotation.x = -1.2;
      if (st.using) this.armR.rotation.x = 2.2;
    } else if (st.item === 0 && st.mode === Mode.Walk && !st.sprint) {
      this.armR.rotation.x = 0.5;
      this.hand.rotation.x = -1.25;
    }
    if (this.swingT > 0) {
      const k = 1 - this.swingT / 0.32;
      this.armR.rotation.x = 2.7 - k * 3.1;
      this.armR.rotation.z = 0.2;
      this.hand.rotation.x = -1.25;
      t.rotation.y = 0.5 - k * 0.8;
    }
    this.head.rotation.x = aimPitch * 0.5;
  }

  private playEmote(id: number, t: number) {
    const b = this.body;
    switch (id) {
      case 1: // wave
        this.armR.rotation.set(Math.PI - 0.2, 0, -0.3 + Math.sin(t * 10) * 0.5);
        break;
      case 2: // cheer
        this.armL.rotation.set(Math.PI - 0.2, 0, 0.3);
        this.armR.rotation.set(Math.PI - 0.2, 0, -0.3);
        b.position.y = 0.82 + Math.abs(Math.sin(t * 7)) * 0.3;
        break;
      case 3: // head bop
        b.position.y = 0.82 + Math.abs(Math.sin(t * 6)) * 0.1;
        this.head.rotation.x = Math.sin(t * 12) * 0.3;
        this.armL.rotation.x = 0.6 + Math.sin(t * 6) * 0.4;
        this.armR.rotation.x = 0.6 - Math.sin(t * 6) * 0.4;
        this.legL.rotation.x = Math.max(0, Math.sin(t * 6)) * 0.5;
        break;
      case 4: { // servo shuffle (robot)
        const step = Math.floor(t * 4) % 4;
        this.armL.rotation.set((Math.PI / 2) * (step % 2), 0, 0);
        this.armR.rotation.set((Math.PI / 2) * ((step + 1) % 2), 0, 0);
        this.torso.rotation.y = (step - 1.5) * 0.25;
        this.head.rotation.y = -(step - 1.5) * 0.3;
        break;
      }
      case 5: // twirl
        this.root.rotation.y += 0.25;
        this.armL.rotation.z = -1.3;
        this.armR.rotation.z = 1.3;
        break;
      case 6: // flex
        this.armL.rotation.set(0, 0, -1.4);
        this.armR.rotation.set(0, 0, 1.4);
        this.armL.rotation.x = Math.sin(t * 4) * 0.3 - 0.2;
        this.armR.rotation.x = Math.sin(t * 4) * 0.3 - 0.2;
        this.torso.rotation.z = Math.sin(t * 2) * 0.1;
        break;
      case 7: // take a seat
        b.position.y = 0.35;
        this.legL.rotation.x = 1.5;
        this.legR.rotation.x = 1.5;
        this.armL.rotation.x = -0.3;
        this.armR.rotation.x = -0.3;
        this.torso.rotation.x = 0.2;
        break;
    }
  }
}

