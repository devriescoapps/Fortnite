// Pooled visual effects: tracers, particles (sparks/debris/dust/trails), explosions, smoke
// clouds, muzzle flashes and floating damage numbers.
import * as THREE from 'three';
import { radialTexture } from './util';

const MAX_TRACERS = 128;
const MAX_PARTICLES = 3000;

export class Effects {
  private tracerGeo: THREE.BufferGeometry;
  private tracerPos: Float32Array;
  private tracerCol: Float32Array;
  private tracers: { a: THREE.Vector3; b: THREE.Vector3; life: number; max: number; color: THREE.Color }[] = [];
  private pGeo: THREE.BufferGeometry;
  private pPos: Float32Array;
  private pCol: Float32Array;
  private pSize: Float32Array;
  private parts: { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; r: number; g: number; b: number; size: number; grav: number }[] = [];
  private booms: { mesh: THREE.Mesh; life: number; r: number }[] = [];
  private smokes: { sprites: THREE.Sprite[]; until: number; x: number; y: number; z: number }[] = [];
  private flashes: { sprite: THREE.Sprite; life: number }[] = [];
  private light: THREE.PointLight;
  private lightLife = 0;
  private numbers: { el: HTMLDivElement; pos: THREE.Vector3; life: number; vy: number }[] = [];
  private flashTex = radialTexture('rgba(255,240,180,1)', 'rgba(255,160,40,0)');
  private smokeTex = radialTexture('rgba(190,140,255,0.9)', 'rgba(160,110,240,0)', 64);
  private boomGeo = new THREE.SphereGeometry(1, 16, 12);

  constructor(private scene: THREE.Scene, private numberLayer: HTMLElement) {
    this.tracerGeo = new THREE.BufferGeometry();
    this.tracerPos = new Float32Array(MAX_TRACERS * 6);
    this.tracerCol = new Float32Array(MAX_TRACERS * 6);
    this.tracerGeo.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracerGeo.setAttribute('color', new THREE.BufferAttribute(this.tracerCol, 3).setUsage(THREE.DynamicDrawUsage));
    const tl = new THREE.LineSegments(this.tracerGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    tl.frustumCulled = false;
    scene.add(tl);

    this.pGeo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pCol = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.pGeo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.pGeo.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    const pm = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      uniforms: { scale: { value: 600 } },
      vertexShader: `attribute float size; varying vec3 vColor; uniform float scale;
        void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vColor; void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c,c); if (d > 0.25) discard; gl_FragColor = vec4(vColor, 1.0 - d*2.0); }`,
    });
    const points = new THREE.Points(this.pGeo, pm);
    points.frustumCulled = false;
    scene.add(points);

    this.light = new THREE.PointLight(0xffc070, 0, 18, 1.6);
    scene.add(this.light);
  }

  tracer(a: THREE.Vector3, b: THREE.Vector3, color = 0xffe08a, life = 0.09) {
    if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
    this.tracers.push({ a: a.clone(), b: b.clone(), life, max: life, color: new THREE.Color(color) });
  }

  burst(x: number, y: number, z: number, n: number, color: number, speed = 4, life = 0.5, size = 0.12, grav = 9) {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      if (this.parts.length >= MAX_PARTICLES) this.parts.shift();
      const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
      const sp = speed * (0.4 + Math.random() * 0.6);
      this.parts.push({
        x, y, z, vx: Math.sin(ph) * Math.cos(th) * sp, vy: Math.abs(Math.cos(ph)) * sp + speed * 0.3, vz: Math.sin(ph) * Math.sin(th) * sp,
        life: life * (0.6 + Math.random() * 0.4), max: life, r: c.r, g: c.g, b: c.b, size: size * (0.7 + Math.random() * 0.6), grav,
      });
    }
  }

  trail(x: number, y: number, z: number, color: number, size = 0.18) {
    const c = new THREE.Color(color);
    if (this.parts.length >= MAX_PARTICLES) this.parts.shift();
    this.parts.push({ x: x + (Math.random() - 0.5) * 0.3, y, z: z + (Math.random() - 0.5) * 0.3, vx: 0, vy: 0.3, vz: 0, life: 0.8, max: 0.8, r: c.r, g: c.g, b: c.b, size, grav: -0.5 });
  }

  muzzle(pos: THREE.Vector3, big = false) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.position.copy(pos);
    s.scale.setScalar(big ? 1.4 : 0.8);
    this.scene.add(s);
    this.flashes.push({ sprite: s, life: 0.05 });
    this.light.position.copy(pos);
    this.light.intensity = big ? 60 : 30;
    this.lightLife = 0.05;
  }

  explosion(x: number, y: number, z: number, r: number) {
    const m = new THREE.Mesh(this.boomGeo, new THREE.MeshBasicMaterial({ color: 0xffa13d, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.set(x, y, z);
    this.scene.add(m);
    this.booms.push({ mesh: m, life: 0.5, r });
    this.burst(x, y, z, 60, 0xffc04d, r * 3, 0.9, 0.3, 6);
    this.burst(x, y, z, 30, 0x555555, r * 1.5, 1.6, 0.6, -1);
    this.light.position.set(x, y + 1, z);
    this.light.intensity = 400;
    this.lightLife = 0.25;
  }

  smoke(x: number, y: number, z: number, r: number, dur: number, now: number) {
    const sprites: THREE.Sprite[] = [];
    for (let i = 0; i < 22; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, depthWrite: false, opacity: 0.85 }));
      const a = Math.random() * Math.PI * 2, d = Math.random() * r * 0.8;
      s.position.set(x + Math.cos(a) * d, y + Math.random() * r * 0.7, z + Math.sin(a) * d);
      s.scale.setScalar(r * (0.7 + Math.random() * 0.6));
      this.scene.add(s);
      sprites.push(s);
    }
    this.smokes.push({ sprites, until: now + dur, x, y, z });
  }

  damageNumber(pos: THREE.Vector3, amount: number, kind: 'health' | 'shield' | 'head' | 'build') {
    const el = document.createElement('div');
    el.className = `dmg dmg-${kind}`;
    el.textContent = String(amount);
    this.numberLayer.appendChild(el);
    this.numbers.push({ el, pos: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.3, (Math.random() - 0.5) * 0.6)), life: 0.9, vy: 1.6 });
  }

  update(dt: number, camera: THREE.Camera, now: number, width: number, height: number) {
    // tracers
    let n = 0;
    this.tracers = this.tracers.filter((t) => (t.life -= dt) > 0);
    for (const t of this.tracers) {
      const k = t.life / t.max;
      this.tracerPos.set([t.a.x, t.a.y, t.a.z, t.b.x, t.b.y, t.b.z], n * 6);
      this.tracerCol.set([t.color.r * k * 0.4, t.color.g * k * 0.4, t.color.b * k * 0.4, t.color.r * k, t.color.g * k, t.color.b * k], n * 6);
      n++;
    }
    this.tracerGeo.setDrawRange(0, n * 2);
    (this.tracerGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.tracerGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    // particles
    let m = 0;
    const alive = [];
    for (const p of this.parts) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vx *= 0.985;
      p.vz *= 0.985;
      const k = p.life / p.max;
      this.pPos[m * 3] = p.x;
      this.pPos[m * 3 + 1] = p.y;
      this.pPos[m * 3 + 2] = p.z;
      this.pCol[m * 3] = p.r;
      this.pCol[m * 3 + 1] = p.g;
      this.pCol[m * 3 + 2] = p.b;
      this.pSize[m] = p.size * (0.4 + k * 0.6);
      m++;
      alive.push(p);
    }
    this.parts = alive;
    this.pGeo.setDrawRange(0, m);
    (this.pGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.pGeo.attributes.size as THREE.BufferAttribute).needsUpdate = true;

    // explosions
    this.booms = this.booms.filter((b) => {
      b.life -= dt;
      const k = 1 - b.life / 0.5;
      b.mesh.scale.setScalar(b.r * (0.3 + k * 1.1));
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k));
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        return false;
      }
      return true;
    });
    // smoke
    this.smokes = this.smokes.filter((s) => {
      const left = s.until - now;
      for (const sp of s.sprites) {
        sp.position.y += dt * 0.15;
        (sp.material as THREE.SpriteMaterial).opacity = Math.min(0.85, Math.max(0, left / 2));
      }
      if (left <= 0) {
        for (const sp of s.sprites) {
          this.scene.remove(sp);
          sp.material.dispose();
        }
        return false;
      }
      return true;
    });
    // flashes
    this.flashes = this.flashes.filter((f) => {
      f.life -= dt;
      if (f.life <= 0) {
        this.scene.remove(f.sprite);
        f.sprite.material.dispose();
        return false;
      }
      return true;
    });
    this.lightLife -= dt;
    if (this.lightLife <= 0) this.light.intensity = 0;
    else this.light.intensity *= 0.8;

    // damage numbers
    const v = new THREE.Vector3();
    this.numbers = this.numbers.filter((d) => {
      d.life -= dt;
      d.pos.y += d.vy * dt;
      d.vy *= 0.96;
      v.copy(d.pos).project(camera);
      if (d.life <= 0 || v.z > 1) {
        d.el.remove();
        return false;
      }
      d.el.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px) translate(-50%,-50%) scale(${0.8 + Math.min(1, d.life * 3) * 0.4})`;
      d.el.style.opacity = String(Math.min(1, d.life * 3));
      return true;
    });
  }

  smokeCenters() {
    return this.smokes.map((s) => ({ x: s.x, y: s.y, z: s.z }));
  }
}
