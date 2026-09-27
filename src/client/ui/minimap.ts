// Minimap + full map: pre-rendered island image, storm circles, safe-zone line, teammates,
// pings, supply drops and transport path.
import { MAP_HALF, MAP_SIZE } from '../../shared/constants';
import { POIS } from '../../shared/pois';
import type { Circle } from '../../shared/storm';
import { Terrain, biomeAt, roadDistance } from '../../shared/terrain';

const BIOME_RGB: Record<string, [number, number, number]> = {
  plains: [124, 207, 79], forest: [66, 150, 58], industrial: [154, 163, 107], facility: [143, 154, 117], mountain: [140, 150, 110],
  city: [150, 205, 110], town: [139, 211, 90], harbor: [159, 212, 106], desert: [226, 168, 103],
};

export interface MapMarks {
  me: { x: number; z: number; yaw: number } | null;
  mates: { x: number; z: number; color: string; name: string; down: boolean }[];
  storm: Circle | null;
  next: Circle | null;
  pings: { x: number; z: number; color: string }[];
  supplies: { x: number; z: number }[];
  bus: { x0: number; z0: number; x1: number; z1: number; px: number; pz: number } | null;
  vehicles?: { x: number; z: number }[];
}

export class MapPainter {
  base: HTMLCanvasElement;
  constructor(terrain: Terrain) {
    const S = 512;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const img = g.createImageData(S, S);
    for (let py = 0; py < S; py++) {
      for (let px = 0; px < S; px++) {
        const x = -MAP_HALF + (px / S) * MAP_SIZE;
        const z = -MAP_HALF + (py / S) * MAP_SIZE;
        const h = terrain.surfaceAt(x, z);
        let r: number, gg: number, b: number;
        if (h < 0) {
          const d = Math.min(1, -h / 14);
          r = 60 - d * 30;
          gg = 170 - d * 70;
          b = 220 - d * 30;
        } else {
          [r, gg, b] = BIOME_RGB[biomeAt(x, z)];
          if (h < 2.2) [r, gg, b] = [240, 220, 160];
          const shade = 0.85 + Math.min(0.35, h / 200);
          r *= shade;
          gg *= shade;
          b *= shade;
          if (h > 52 && biomeAt(x, z) === 'mountain') [r, gg, b] = [245, 250, 255];
          if (roadDistance(x, z) < 4 && h > 1) [r, gg, b] = [110, 106, 100];
          const sl = terrain.slopeAt(x, z);
          if (sl > 0.8) {
            r *= 0.8;
            gg *= 0.8;
            b *= 0.8;
          }
        }
        const i = (py * S + px) * 4;
        img.data[i] = r;
        img.data[i + 1] = gg;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // POI footprints
    for (const p of POIS) {
      const [px, py] = [((p.x + MAP_HALF) / MAP_SIZE) * S, ((p.z + MAP_HALF) / MAP_SIZE) * S];
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.beginPath();
      g.arc(px, py, (p.r / MAP_SIZE) * S * 0.8, 0, Math.PI * 2);
      g.fill();
    }
    this.base = c;
  }

  /** Draw map. `view` = world rect center+half-size; labels only for the big map. */
  draw(canvas: HTMLCanvasElement, marks: MapMarks, cx: number, cz: number, half: number, labels: boolean, time: number) {
    const g = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height;
    const sx = (x: number) => ((x - (cx - half)) / (half * 2)) * W;
    const sz = (z: number) => ((z - (cz - half)) / (half * 2)) * H;
    const sl = (l: number) => (l / (half * 2)) * W;
    g.fillStyle = '#2a6fb0';
    g.fillRect(0, 0, W, H);
    const S = this.base.width;
    const src = (v: number) => ((v + MAP_HALF) / MAP_SIZE) * S;
    const sw = (half * 2 / MAP_SIZE) * S;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.base, src(cx - half), src(cz - half), sw, sw, 0, 0, W, H);

    if (marks.storm && marks.storm.r < 790) {
      g.save();
      g.fillStyle = 'rgba(130, 50, 220, 0.42)';
      g.beginPath();
      g.rect(0, 0, W, H);
      g.arc(sx(marks.storm.x), sz(marks.storm.z), sl(marks.storm.r), 0, Math.PI * 2, true);
      g.fill('evenodd');
      g.strokeStyle = '#c77dff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(sx(marks.storm.x), sz(marks.storm.z), sl(marks.storm.r), 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
    if (marks.next) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.beginPath();
      g.arc(sx(marks.next.x), sz(marks.next.z), sl(marks.next.r), 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      if (marks.me) {
        const d = Math.hypot(marks.me.x - marks.next.x, marks.me.z - marks.next.z);
        if (d > marks.next.r) {
          const k = (d - marks.next.r) / d;
          g.strokeStyle = 'rgba(255,255,255,0.8)';
          g.setLineDash([3, 4]);
          g.beginPath();
          g.moveTo(sx(marks.me.x), sz(marks.me.z));
          g.lineTo(sx(marks.me.x + (marks.next.x - marks.me.x) * k), sz(marks.me.z + (marks.next.z - marks.me.z) * k));
          g.stroke();
          g.setLineDash([]);
        }
      }
    }
    if (marks.bus) {
      const b = marks.bus;
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = 3;
      g.setLineDash([10, 8]);
      g.beginPath();
      g.moveTo(sx(b.x0), sz(b.z0));
      g.lineTo(sx(b.x1), sz(b.z1));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#8b5cff';
      g.beginPath();
      g.arc(sx(b.px), sz(b.pz), 7, 0, Math.PI * 2);
      g.fill();
    }
    if (labels) {
      g.font = 'bold 15px Rubik, sans-serif';
      g.textAlign = 'center';
      for (const p of POIS) {
        const x = sx(p.x), y = sz(p.z);
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillText(p.name.toUpperCase(), x + 1, y + 1);
        g.fillStyle = '#fff';
        g.fillText(p.name.toUpperCase(), x, y);
      }
    }
    for (const s of marks.supplies) {
      g.fillStyle = '#3ff0ff';
      g.fillRect(sx(s.x) - 5, sz(s.z) - 5, 10, 10);
      g.strokeStyle = '#000';
      g.strokeRect(sx(s.x) - 5, sz(s.z) - 5, 10, 10);
    }
    if (marks.vehicles) for (const v of marks.vehicles) {
      g.fillStyle = '#ffd23f';
      g.beginPath();
      g.arc(sx(v.x), sz(v.z), 3, 0, Math.PI * 2);
      g.fill();
    }
    for (const p of marks.pings) {
      g.fillStyle = p.color;
      const y = sz(p.z) - 4 - Math.abs(Math.sin(time * 4)) * 4;
      g.beginPath();
      g.moveTo(sx(p.x), y + 8);
      g.lineTo(sx(p.x) - 6, y - 4);
      g.lineTo(sx(p.x) + 6, y - 4);
      g.fill();
    }
    for (const m of marks.mates) {
      g.fillStyle = m.down ? '#ff5a6a' : m.color;
      g.strokeStyle = '#000';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(sx(m.x), sz(m.z), 5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    if (marks.me) {
      const x = sx(marks.me.x), y = sz(marks.me.z);
      g.save();
      g.translate(x, y);
      g.rotate(-marks.me.yaw);
      g.fillStyle = '#ffd23f';
      g.strokeStyle = '#140c2c';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, -9);
      g.lineTo(6, 7);
      g.lineTo(0, 3);
      g.lineTo(-6, 7);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
    }
  }
}
