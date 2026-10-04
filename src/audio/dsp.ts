// Tiny offline DSP toolkit for rendering one-shots, instrument multisamples, textures and impulse responses
// into Float32Arrays (then AudioBuffers). Deterministic when given a seed.

export type F32 = Float32Array<ArrayBuffer>;

/** RBJ cookbook biquad (direct form I). */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }

  static lp(fs: number, f: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * Math.min(f, fs * 0.49)) / fs;
    const c = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    return new Biquad().set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  static hp(fs: number, f: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * Math.min(f, fs * 0.49)) / fs;
    const c = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    return new Biquad().set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  /** band-pass with 0 dB peak */
  static bp(fs: number, f: number, q = 1) {
    const w = (2 * Math.PI * Math.min(f, fs * 0.49)) / fs;
    const c = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    return new Biquad().set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }
  static peak(fs: number, f: number, q: number, db: number) {
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * Math.min(f, fs * 0.49)) / fs;
    const c = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    return new Biquad().set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  static lowshelf(fs: number, f: number, db: number) {
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * f) / fs;
    const c = Math.cos(w);
    const al = (Math.sin(w) / 2) * Math.SQRT2;
    const s = 2 * Math.sqrt(A) * al;
    return new Biquad().set(
      A * (A + 1 - (A - 1) * c + s), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - s),
      A + 1 + (A - 1) * c + s, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - s,
    );
  }
  static highshelf(fs: number, f: number, db: number) {
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * Math.min(f, fs * 0.49)) / fs;
    const c = Math.cos(w);
    const al = (Math.sin(w) / 2) * Math.SQRT2;
    const s = 2 * Math.sqrt(A) * al;
    return new Biquad().set(
      A * (A + 1 + (A - 1) * c + s), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - s),
      A + 1 - (A - 1) * c + s, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - s,
    );
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  run(buf: F32, from = 0, to = buf.length): F32 {
    for (let i = from; i < to; i++) buf[i] = this.process(buf[i]);
    return buf;
  }
}

/** Fast deterministic noise source (xorshift32), uniform in [-1, 1). */
export class Noise {
  private s: number;
  constructor(seed = 0x12345678) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.s = s;
    return s / 2147483648 - 1;
  }
  /** uniform [0, 1) */
  u(): number {
    return (this.next() + 1) * 0.5;
  }
  gauss(): number {
    const a = Math.max(1e-9, this.u());
    const b = this.u();
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
  }
}

export function white(len: number, seed: number, amp = 1): F32 {
  const n = new Noise(seed);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = n.next() * amp;
  return out;
}

/** Pink-ish noise (Paul Kellet's economy filter), roughly unit peak. */
export function pink(len: number, seed: number): F32 {
  const n = new Noise(seed);
  const out = new Float32Array(len);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = n.next();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  return out;
}

/** Brown (red) noise, roughly unit peak. */
export function brown(len: number, seed: number): F32 {
  const n = new Noise(seed);
  const out = new Float32Array(len);
  let b = 0;
  for (let i = 0; i < len; i++) {
    b = (b + 0.02 * n.next()) / 1.02;
    out[i] = b * 3.5;
  }
  return out;
}

export function peakOf(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

export function rmsOf(buf: Float32Array, from = 0, to = buf.length): number {
  let s = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / n);
}

export function scale(buf: F32, g: number): F32 {
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

export function normalizePeak(buf: F32, target = 0.9): F32 {
  const p = peakOf(buf);
  return p > 0 ? scale(buf, target / p) : buf;
}

/** Raised-cosine fades at both ends (in samples) so a buffer can never click. */
export function fadeEdges(buf: F32, fadeIn: number, fadeOut: number): F32 {
  const n = buf.length;
  const fi = Math.min(fadeIn, n);
  for (let i = 0; i < fi; i++) buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
  const fo = Math.min(fadeOut, n);
  for (let i = 0; i < fo; i++) buf[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
  return buf;
}

/** Remove DC with a one-pole high-pass. */
export function dcBlock(buf: F32, fs: number, f = 15): F32 {
  const r = Math.exp((-2 * Math.PI * f) / fs);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = x - x1 + r * y1;
    x1 = x;
    y1 = y;
    buf[i] = y;
  }
  return buf;
}

export function onePoleLP(buf: F32, fs: number, f: number): F32 {
  const a = 1 - Math.exp((-2 * Math.PI * f) / fs);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y += a * (buf[i] - y);
    buf[i] = y;
  }
  return buf;
}

export function saturate(buf: F32, drive: number): F32 {
  const k = Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(drive * buf[i]) / k;
  return buf;
}

/** "Dusty sampler": reduce bit depth and hold every `hold` samples (gentle sample-rate reduction). */
export function crush(buf: F32, bits: number, hold: number): F32 {
  const q = Math.pow(2, bits - 1);
  let h = 0;
  for (let i = 0; i < buf.length; i++) {
    if (i % hold === 0) h = Math.round(buf[i] * q) / q;
    buf[i] = h;
  }
  return buf;
}

/** Mix `src` into `dst` at offset with gain. */
export function mixInto(dst: F32, src: Float32Array, offset = 0, gain = 1): F32 {
  const n = Math.min(src.length, dst.length - offset);
  for (let i = 0; i < n; i++) dst[offset + i] += src[i] * gain;
  return dst;
}

/** A few parallel damped combs: a cheap small "room" for one-shots. */
export function tinyRoom(buf: F32, fs: number, mix: number, seed: number): F32 {
  const n = new Noise(seed);
  const delays = [0.0071, 0.0113, 0.0137, 0.0179].map((d) => Math.round(d * fs * (0.95 + 0.1 * n.u())));
  const wet = new Float32Array(buf.length);
  for (const d of delays) {
    const line = new Float32Array(d);
    let idx = 0;
    let lp = 0;
    for (let i = 0; i < buf.length; i++) {
      const y = line[idx];
      lp += 0.45 * (y - lp);
      line[idx] = buf[i] + lp * 0.42;
      idx = (idx + 1) % d;
      wet[i] += y * 0.25;
    }
  }
  for (let i = 0; i < buf.length; i++) buf[i] += wet[i] * mix;
  return buf;
}
