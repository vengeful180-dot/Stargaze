// CPU gradient noise for generating meshes and lookup tables (the GPU has its own copy in glsl/noise.glsl).
import { Rng } from './rng';

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

export class Noise3 {
  private perm = new Uint8Array(512);

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = Array.from({ length: 256 }, (_, i) => i);
    rng.shuffle(p);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Gradient noise in roughly [-1, 1]. */
  noise(x: number, y: number, z: number): number {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const fx = x - X, fy = y - Y, fz = z - Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    const P = this.perm;
    const A = P[xi] + yi, AA = P[A] + zi, AB = P[A + 1] + zi;
    const B = P[xi + 1] + yi, BA = P[B] + zi, BB = P[B + 1] + zi;
    const g = (h: number, dx: number, dy: number, dz: number) => {
      const i = (h % 12) * 3;
      return GRAD3[i] * dx + GRAD3[i + 1] * dy + GRAD3[i + 2] * dz;
    };
    const x1 = lerp(g(P[AA], fx, fy, fz), g(P[BA], fx - 1, fy, fz), u);
    const x2 = lerp(g(P[AB], fx, fy - 1, fz), g(P[BB], fx - 1, fy - 1, fz), u);
    const x3 = lerp(g(P[AA + 1], fx, fy, fz - 1), g(P[BA + 1], fx - 1, fy, fz - 1), u);
    const x4 = lerp(g(P[AB + 1], fx, fy - 1, fz - 1), g(P[BB + 1], fx - 1, fy - 1, fz - 1), u);
    return lerp(lerp(x1, x2, v), lerp(x3, x4, v), w);
  }

  fbm(x: number, y: number, z: number, octaves = 5, lacunarity = 2.03, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x, y, z);
      norm += amp;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
      z *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1]: sharp crests, good for rock ridges. */
  ridged(x: number, y: number, z: number, octaves = 5, lacunarity = 2.1, gain = 0.5): number {
    let sum = 0, amp = 0.5, norm = 0, prev = 1;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(this.noise(x, y, z));
      n *= n;
      sum += n * amp * prev;
      norm += amp;
      prev = n;
      amp *= gain;
      x *= lacunarity;
      y *= lacunarity;
      z *= lacunarity;
    }
    return sum / norm;
  }
}

function fade(t: number) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** 1D smooth value noise over a seeded table, for ring profiles and similar. */
export function valueNoise1D(seed: number, size = 1024): (x: number) => number {
  const rng = new Rng(seed);
  const table = new Float32Array(size);
  for (let i = 0; i < size; i++) table[i] = rng.next();
  return (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = table[((i % size) + size) % size];
    const b = table[(((i + 1) % size) + size) % size];
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  };
}
