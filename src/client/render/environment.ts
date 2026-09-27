// Environment rendering: sky dome, sun & ambient light, clouds, terrain chunks, water,
// the Skyport waiting area and the Surge (storm) wall.
import * as THREE from 'three';
import { MAP_HALF, TERRAIN_N, TERRAIN_RES, WATER_LEVEL } from '../../shared/constants';
import type { MapData } from '../../shared/mapdata';
import { fbm } from '../../shared/noise';
import { POIS } from '../../shared/pois';
import { Terrain, biomeAt, roadDistance } from '../../shared/terrain';
import type { Quality } from '../settings';
import { build, cyl, ico, sphere } from './util';

const BIOME_COLORS: Record<string, number> = {
  plains: 0x7ccf4f, forest: 0x4c9e3c, industrial: 0x9aa36b, facility: 0x8f9a75, mountain: 0x8b9a6b,
  city: 0x8fcf6a, town: 0x8bd35a, harbor: 0x9fd46a, desert: 0xe2a867,
};

export class Environment {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: THREE.Mesh;
  terrainChunks: THREE.Mesh[] = [];
  water: THREE.Mesh;
  waterMat: THREE.ShaderMaterial;
  storm: THREE.Mesh;
  stormMat: THREE.ShaderMaterial;
  nextCircle: THREE.Mesh;
  clouds: THREE.InstancedMesh;
  skyport: THREE.Group;
  fogColor = new THREE.Color(0xbfe3ff);

  constructor(private scene: THREE.Scene, terrain: Terrain, map: MapData, quality: Quality) {
    // --- lights ---
    this.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x6b8a4a, 1.35);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    this.sun.position.set(120, 200, 80);
    this.sun.castShadow = quality !== 'low';
    const ss = quality === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(ss, ss);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -70;
    sc.right = sc.top = 70;
    sc.near = 10;
    sc.far = 500;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.fog = new THREE.Fog(this.fogColor, 150, quality === 'low' ? 420 : quality === 'medium' ? 650 : 900);
    scene.background = this.fogColor;

    // --- sky dome ---
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(0x3d8bff) }, mid: { value: new THREE.Color(0x9fd3ff) }, bottom: { value: new THREE.Color(0xe8f6ff) }, sunDir: { value: new THREE.Vector3(0.5, 0.75, 0.35).normalize() } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; uniform vec3 sunDir; varying vec3 vDir;
        void main(){ float h = vDir.y; vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : mix(mid, bottom, pow(-h, 0.5));
        float s = max(dot(normalize(vDir), sunDir), 0.0); c += vec3(1.0,0.9,0.7) * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.25);
        gl_FragColor = vec4(c, 1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 24, 16), skyMat);
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    // --- clouds ---
    const cloudGeo = build([
      { g: ico(1, 1), color: 0xffffff, pos: [0, 0, 0] },
      { g: ico(0.8, 1), color: 0xf4f8ff, pos: [1.1, -0.1, 0.2] },
      { g: ico(0.75, 1), color: 0xf4f8ff, pos: [-1.1, -0.15, -0.1] },
      { g: ico(0.6, 1), color: 0xeef4ff, pos: [0.3, 0.45, -0.3] },
    ]);
    const cloudMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0xb8c8dc, transparent: true, opacity: 0.88, fog: false });
    const nClouds = 34;
    this.clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, nClouds);
    const m = new THREE.Matrix4();
    for (let i = 0; i < nClouds; i++) {
      const a = Math.random() * Math.PI * 2, r = 250 + Math.random() * 1100;
      const s = 12 + Math.random() * 16;
      m.compose(new THREE.Vector3(Math.cos(a) * r, 340 + Math.random() * 110, Math.sin(a) * r), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.random() * 6, 0)), new THREE.Vector3(s * 1.8, s * 0.6, s));
      this.clouds.setMatrixAt(i, m);
    }
    scene.add(this.clouds);

    // --- terrain ---
    this.buildTerrain(terrain, quality);

    // --- water ---
    this.waterMat = new THREE.ShaderMaterial({
      transparent: true,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: { value: 0 }, deep: { value: new THREE.Color(0x1f7fd1) }, shallow: { value: new THREE.Color(0x4fe0d8) } }]),
      vertexShader: `varying vec3 vW;
        #include <fog_pars_vertex>
        uniform float time; void main(){ vec3 p = position; vec4 w = modelMatrix * vec4(p,1.0);
        w.y += sin(w.x*0.08 + time*1.3)*0.18 + cos(w.z*0.07 + time*1.1)*0.18; vW = w.xyz;
        vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: `uniform vec3 deep; uniform vec3 shallow; uniform float time; varying vec3 vW;
        #include <fog_pars_fragment>
        void main(){ float d = length(vW.xz); float k = smoothstep(700.0, 520.0, d);
        vec3 c = mix(deep, shallow, k*0.8);
        float wave = sin(vW.x*0.35 + time*2.0)*sin(vW.z*0.3 - time*1.7);
        c += vec3(0.9,1.0,1.0) * smoothstep(0.82, 1.0, wave) * 0.35;
        gl_FragColor = vec4(c, 0.86);
        #include <fog_fragment>
        }`,
    });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000, 1, 1), this.waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = WATER_LEVEL;
    this.water.renderOrder = 1;
    scene.add(this.water);

    // --- skyport ---
    this.skyport = new THREE.Group();
    for (const s of map.statics) {
      const g = new THREE.BoxGeometry(s.maxX - s.minX, s.maxY - s.minY, s.maxZ - s.minZ);
      const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: s.color }));
      mesh.position.set((s.minX + s.maxX) / 2, (s.minY + s.maxY) / 2, (s.minZ + s.maxZ) / 2);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.skyport.add(mesh);
    }
    const S = map.statics[0];
    const balloon = new THREE.Mesh(build([{ g: sphere(8, 16, 12), color: 0xff6fb5 }, { g: cyl(0.1, 0.1, 14), color: 0xffffff, pos: [0, -12, 0] }]), new THREE.MeshLambertMaterial({ vertexColors: true }));
    for (const [dx, dz] of [[-30, -22], [30, -22], [-30, 22], [30, 22]]) {
      const b = balloon.clone();
      b.position.set((S.minX + S.maxX) / 2 + dx, S.maxY + 30, (S.minZ + S.maxZ) / 2 + dz);
      this.skyport.add(b);
    }
    scene.add(this.skyport);

    // --- storm wall ---
    this.stormMat = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: { time: { value: 0 }, color: { value: new THREE.Color(0xb44dff) }, color2: { value: new THREE.Color(0x4d6bff) } },
      vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
      fragmentShader: `uniform float time; uniform vec3 color; uniform vec3 color2; varying vec2 vUv; varying vec3 vW;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float n(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
        void main(){ float a = atan(vW.z, vW.x); vec2 p = vec2(a*40.0, vW.y*0.05 - time*0.4);
        float v = n(p) * 0.6 + n(p*2.3 + time*0.2) * 0.4;
        float bands = 0.5 + 0.5*sin(vW.y*0.08 + time*1.5 + v*4.0);
        float fade = smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.7, 1.0, vUv.y));
        vec3 c = mix(color2, color, bands) * (0.35 + v*0.6);
        gl_FragColor = vec4(c, (0.28 + v*0.35) * fade); }`,
    });
    this.storm = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 96, 1, true), this.stormMat);
    this.storm.visible = false;
    this.storm.renderOrder = 5;
    scene.add(this.storm);
    this.nextCircle = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 96, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.nextCircle.visible = false;
    scene.add(this.nextCircle);
  }

  private buildTerrain(t: Terrain, quality: Quality) {
    const N = TERRAIN_N;
    const CH = 32; // cells per chunk
    const nC = Math.ceil((N - 1) / CH);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: quality === 'low' });
    const col = new THREE.Color();
    const tmp = new THREE.Color();
    const colorAt = (x: number, z: number, h: number) => {
      const biome = biomeAt(x, z);
      col.setHex(BIOME_COLORS[biome]);
      const n = fbm(x * 0.05, z * 0.05, 91, 2) * 0.12;
      col.offsetHSL(0, 0, n);
      const slope = t.slopeAt(x, z);
      if (h < 2.2) col.lerp(tmp.setHex(0xf2dca0), Math.min(1, (2.2 - h) / 1.2)); // beach
      if (h < -0.5) col.lerp(tmp.setHex(0xc9b07a), 0.6);
      if (slope > 0.8) col.lerp(tmp.setHex(biome === 'desert' ? 0xc0633c : 0x8a8f99), Math.min(1, (slope - 0.8) * 1.6));
      if (biome === 'mountain' && h > 52) col.lerp(tmp.setHex(0xf6fbff), Math.min(1, (h - 52) / 10));
      if (biome === 'desert' && h > 14) col.lerp(tmp.setHex(0xd98b55), 0.35);
      const rd = roadDistance(x, z);
      if (rd < 4.5 && h > 1) col.lerp(tmp.setHex(0x6e6a64), Math.min(1, (4.5 - rd) / 1.5) * 0.9);
      for (const p of POIS) {
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < p.r * 0.85 && (p.kind === 'city' || p.kind === 'facility' || p.kind === 'industrial' || p.kind === 'junction')) {
          const pave = p.kind === 'city' ? 0xb7bcc6 : p.kind === 'industrial' ? 0xa39a83 : 0x9da3a0;
          const grid = p.kind === 'city' && ((Math.floor(x / 4) % 8 === 0) || (Math.floor(z / 4) % 8 === 0)) ? 0.1 : 0;
          col.lerp(tmp.setHex(pave), 0.85).offsetHSL(0, 0, -grid);
        }
        if (p.kind === 'town' && d > p.r * 0.6 && d < p.r * 1.3 && z > p.z + 30) {
          // crop fields
          const stripe = Math.floor(x / 3) % 2 === 0;
          col.lerp(tmp.setHex(stripe ? 0xd8c24a : 0x9ccc4a), 0.7);
        }
      }
      return col;
    };
    // per-vertex colors computed once for the whole grid
    const colArr = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -MAP_HALF + i * TERRAIN_RES, z = -MAP_HALF + j * TERRAIN_RES;
        const c = colorAt(x, z, t.heights[j * N + i]);
        const o = (j * N + i) * 3;
        colArr[o] = c.r;
        colArr[o + 1] = c.g;
        colArr[o + 2] = c.b;
      }
    }
    for (let cz = 0; cz < nC; cz++) {
      for (let cx = 0; cx < nC; cx++) {
        const i0 = cx * CH, j0 = cz * CH;
        const i1 = Math.min(N - 1, i0 + CH), j1 = Math.min(N - 1, j0 + CH);
        const w = i1 - i0 + 1;
        const positions: number[] = [];
        const colors: number[] = [];
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            positions.push(-MAP_HALF + i * TERRAIN_RES, t.heights[j * N + i], -MAP_HALF + j * TERRAIN_RES);
            const o = (j * N + i) * 3;
            colors.push(colArr[o], colArr[o + 1], colArr[o + 2]);
          }
        }
        const index: number[] = [];
        for (let j = j0; j < j1; j++) {
          for (let i = i0; i < i1; i++) {
            if (t.holes[j * (N - 1) + i]) continue;
            const a = (j - j0) * w + (i - i0); // 00
            const b = a + 1; // 10
            const c = a + w; // 01
            const d = c + 1; // 11
            // triangles (00,01,10) and (10,01,11) — must match Terrain.surfaceAt
            index.push(a, c, b, b, c, d);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        g.setIndex(index);
        g.computeVertexNormals();
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, mat);
        mesh.receiveShadow = quality !== 'low';
        this.scene.add(mesh);
        this.terrainChunks.push(mesh);
      }
    }
    // ocean floor skirt far away
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshLambertMaterial({ color: 0xc9b07a }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -16.5;
    this.scene.add(floor);
  }

  update(dt: number, camPos: THREE.Vector3, time: number) {
    this.waterMat.uniforms.time.value = time;
    this.stormMat.uniforms.time.value = time;
    this.sky.position.copy(camPos);
    // shadow camera follows the viewer
    this.sun.position.set(camPos.x + 90, camPos.y + 160, camPos.z + 60);
    this.sun.target.position.set(camPos.x, camPos.y, camPos.z);
    this.clouds.rotation.y += dt * 0.002;
  }

  setStorm(cx: number, cz: number, r: number, next: { x: number; z: number; r: number } | null, inStorm: boolean) {
    this.storm.visible = r < 790;
    this.storm.position.set(cx, 150, cz);
    this.storm.scale.set(r, 500, r);
    if (next && next.r < r - 1) {
      this.nextCircle.visible = true;
      this.nextCircle.position.set(next.x, 40, next.z);
      this.nextCircle.scale.set(next.r, 220, next.r);
    } else this.nextCircle.visible = false;
    const target = inStorm ? 0x8d5bc9 : 0xbfe3ff;
    this.fogColor.lerp(new THREE.Color(target), 0.05);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(this.fogColor);
  }
}
