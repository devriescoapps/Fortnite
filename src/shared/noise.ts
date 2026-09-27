// Seeded 2D value noise + fractal helpers used for terrain generation.
import { hashFloat } from './rng';

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function valueNoise(x: number, z: number, seed: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const a = hashFloat(xi, zi, seed);
  const b = hashFloat(xi + 1, zi, seed);
  const c = hashFloat(xi, zi + 1, seed);
  const d = hashFloat(xi + 1, zi + 1, seed);
  const u = fade(xf);
  const v = fade(zf);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v; // [0,1]
}

/** Fractal brownian motion, returns roughly [-1,1]. */
export function fbm(x: number, z: number, seed: number, octaves = 5, lacunarity = 2, gain = 0.5) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise(x * freq, z * freq, seed + o * 101) * 2 - 1) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal for mountain ridges, returns [0,1]. */
export function ridged(x: number, z: number, seed: number, octaves = 5) {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x * freq, z * freq, seed + o * 37) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}
