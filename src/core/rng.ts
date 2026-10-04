// Deterministic hashing and random numbers. Every procedural thing in Stargaze derives from these,
// so the same seed always rebuilds the same galaxy, planets, rocks and music.

/** murmur3 finaliser: good avalanche for 32-bit ints. */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash any number of integers (floats are truncated) into one uint32. */
export function hash(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = mix32((h ^ (x | 0)) >>> 0);
    h = (Math.imul(h, 0x27d4eb2d) + 0x165667b1) >>> 0;
  }
  return mix32(h);
}

/** FNV-1a over UTF-16 code units, then avalanche. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h >>> 0);
}

/** Hash to a float in [0, 1). */
export function hashFloat(...xs: number[]): number {
  return hash(...xs) / 4294967296;
}

export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
    // warm up so nearby seeds diverge immediately
    this.next();
    this.next();
  }

  /** mulberry32, uniform in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uint(): number {
    return Math.floor(this.next() * 4294967296) >>> 0;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Integer in [a, b] inclusive. */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of items) total += w;
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r <= 0) return v;
    }
    return items[items.length - 1][0];
  }

  /** Standard normal via Box-Muller. */
  gauss(): number {
    const u = Math.max(1e-12, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Log-uniform in [a, b] (a, b > 0). */
  logRange(a: number, b: number): number {
    return Math.exp(this.range(Math.log(a), Math.log(b)));
  }

  /** Uniform direction on the unit sphere. */
  unitVector(out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {
    const z = this.range(-1, 1);
    const a = this.range(0, Math.PI * 2);
    const r = Math.sqrt(1 - z * z);
    out.x = r * Math.cos(a);
    out.y = r * Math.sin(a);
    out.z = z;
    return out;
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Independent child stream; the same label always gives the same child. */
  fork(label: string | number): Rng {
    const l = typeof label === 'number' ? label : hashString(label);
    return new Rng(hash(this.s, l));
  }
}
