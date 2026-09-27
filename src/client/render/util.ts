// Geometry helpers for building stylized low-poly models from primitives with baked
// vertex colors, plus procedural canvas textures. All art in SURGEFALL is generated in code.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export function colorize(g: THREE.BufferGeometry, hex: number, jitter = 0): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.attributes.position.count;
  const c = new THREE.Color(hex);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = jitter ? 1 + (Math.random() - 0.5) * jitter : 1;
    arr[i * 3] = c.r * j;
    arr[i * 3 + 1] = c.g * j;
    arr[i * 3 + 2] = c.b * j;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return geo;
}

export interface Part {
  g: THREE.BufferGeometry;
  color: number;
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
  jitter?: number;
}

/** Merge colored, transformed primitives into a single geometry. */
export function build(parts: Part[]): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (const p of parts) {
    const g = colorize(p.g.clone(), p.color, p.jitter ?? 0);
    e.set(...(p.rot ?? [0, 0, 0]));
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(...(p.pos ?? [0, 0, 0])), q, new THREE.Vector3(...(p.scale ?? [1, 1, 1])));
    g.applyMatrix4(m);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(k)) g.deleteAttribute(k);
    geos.push(g);
  }
  const out = mergeGeometries(geos, false)!;
  out.computeBoundingSphere();
  return out;
}

export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
export const sphere = (r: number, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
export const ico = (r: number, detail = 0) => new THREE.IcosahedronGeometry(r, detail);
export const cone = (r: number, h: number, seg = 8) => new THREE.ConeGeometry(r, h, seg);
export const dodeca = (r: number) => new THREE.DodecahedronGeometry(r, 0);
export const torus = (r: number, t: number, rs = 6, ts = 16) => new THREE.TorusGeometry(r, t, rs, ts);

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}

const texCache = new Map<string, THREE.Texture>();

/** Grayscale-ish detail textures, tinted by instance/material color. */
export function materialTexture(kind: string): THREE.Texture {
  const cached = texCache.get(kind);
  if (cached) return cached;
  let t: THREE.Texture;
  switch (kind) {
    case 'timber':
    case 'plank':
    case 'shingle':
      t = canvasTex(128, (g, s) => {
        g.fillStyle = '#f2f2f2';
        g.fillRect(0, 0, s, s);
        const rows = kind === 'shingle' ? 8 : 5;
        for (let r = 0; r < rows; r++) {
          const y = (r * s) / rows;
          g.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.06})`;
          g.fillRect(0, y, s, s / rows);
          g.fillStyle = 'rgba(0,0,0,0.28)';
          g.fillRect(0, y, s, 2);
          const off = (r % 2) * s * 0.5 + Math.random() * 10;
          g.fillRect(off % s, y, 2, s / rows);
          for (let k = 0; k < 6; k++) {
            g.fillStyle = 'rgba(0,0,0,0.06)';
            g.fillRect(Math.random() * s, y + 4 + Math.random() * (s / rows - 8), 20 + Math.random() * 30, 1);
          }
        }
        if (kind === 'timber') {
          g.strokeStyle = 'rgba(0,0,0,0.25)';
          g.lineWidth = 6;
          g.strokeRect(3, 3, s - 6, s - 6);
        }
      });
      break;
    case 'stone':
    case 'brick':
    case 'adobe':
      t = canvasTex(128, (g, s) => {
        g.fillStyle = '#eeeeee';
        g.fillRect(0, 0, s, s);
        const rows = kind === 'adobe' ? 3 : 8;
        const cols = kind === 'stone' ? 3 : 4;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols + 1; c++) {
            const w = s / cols;
            const x = c * w - ((r % 2) * w) / 2;
            const y = (r * s) / rows;
            g.fillStyle = `rgba(0,0,0,${0.02 + Math.random() * 0.1})`;
            g.fillRect(x + 2, y + 2, w - 4, s / rows - 4);
          }
          g.fillStyle = 'rgba(0,0,0,0.22)';
          g.fillRect(0, (r * s) / rows, s, 2);
        }
        if (kind === 'stone') {
          g.strokeStyle = 'rgba(0,0,0,0.2)';
          g.lineWidth = 6;
          g.strokeRect(3, 3, s - 6, s - 6);
        }
      });
      break;
    case 'alloy':
    case 'steel':
    case 'bunker':
      t = canvasTex(128, (g, s) => {
        g.fillStyle = '#e8e8e8';
        g.fillRect(0, 0, s, s);
        for (let i = 0; i < s; i += 16) {
          g.fillStyle = i % 32 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.12)';
          g.fillRect(i, 0, 16, s);
        }
        g.strokeStyle = 'rgba(0,0,0,0.3)';
        g.lineWidth = 4;
        g.strokeRect(2, 2, s - 4, s - 4);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        for (const [x, y] of [[10, 10], [s - 10, 10], [10, s - 10], [s - 10, s - 10]]) {
          g.beginPath();
          g.arc(x, y, 3, 0, Math.PI * 2);
          g.fill();
        }
        if (kind === 'alloy') {
          g.strokeStyle = 'rgba(0,0,0,0.18)';
          g.beginPath();
          g.moveTo(0, 0);
          g.lineTo(s, s);
          g.moveTo(s, 0);
          g.lineTo(0, s);
          g.stroke();
        }
      });
      break;
    case 'concrete':
      t = canvasTex(128, (g, s) => {
        g.fillStyle = '#f0f0f0';
        g.fillRect(0, 0, s, s);
        for (let i = 0; i < 400; i++) {
          g.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
          g.fillRect(Math.random() * s, Math.random() * s, 3, 3);
        }
        g.fillStyle = 'rgba(0,0,0,0.12)';
        g.fillRect(0, s / 2, s, 2);
      });
      break;
    case 'glass':
      t = canvasTex(64, (g, s) => {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(40,60,80,0.8)';
        g.lineWidth = 4;
        g.strokeRect(2, 2, s - 4, s - 4);
        g.fillStyle = 'rgba(255,255,255,0.9)';
        g.fillRect(10, 8, 6, 30);
      });
      break;
    default:
      t = canvasTex(8, (g, s) => {
        g.fillStyle = '#fff';
        g.fillRect(0, 0, s, s);
      });
  }
  texCache.set(kind, t);
  return t;
}

export function radialTexture(inner: string, outer: string, size = 64) {
  return canvasTex(size, (g, s) => {
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, inner);
    grd.addColorStop(1, outer);
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  });
}
