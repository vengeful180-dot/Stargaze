// Procedural impulse response for the cabin: a small wood-panelled room.
// Pre-delay, a cluster of early reflections (3-16 ms), then a diffuse tail whose high frequencies die
// faster than the lows (absorption). Rendered once per context into a stereo ConvolverNode buffer.
import { Biquad, Noise, type F32, white } from './dsp';

export interface RoomOptions {
  rt60?: number;
  preDelay?: number;
  seed?: number;
}

export function renderRoomIR(fs: number, o: RoomOptions = {}): [F32, F32] {
  const rt = o.rt60 ?? 0.62;
  const pre = o.preDelay ?? 0.008;
  const seed = o.seed ?? 0x400d;
  // the tail beyond ~1.25 x RT60 is below -50 dB: not worth convolving
  const len = Math.round(fs * (pre + rt * 1.25));
  const out: [F32, F32] = [new Float32Array(len), new Float32Array(len)];
  const n = new Noise(seed);
  // early reflections
  const taps = 14;
  for (let c = 0; c < 2; c++) {
    const er = new Float32Array(len);
    for (let i = 0; i < taps; i++) {
      const t = pre + 0.003 + (0.013 * (i + n.u() * 0.9)) / taps + (c ? 0.0004 : 0) * n.u();
      const idx = Math.round(t * fs);
      const amp = (0.75 - 0.4 * (i / taps)) * (0.55 + 0.45 * n.u()) * (n.u() < 0.35 ? -1 : 1);
      // a short smooth blip instead of a single-sample impulse
      for (let k = -2; k <= 2; k++) if (idx + k >= 0 && idx + k < len) er[idx + k] += amp * (0.5 + 0.5 * Math.cos((Math.PI * k) / 3));
    }
    Biquad.lp(fs, 6500, 0.7).run(er);
    // diffuse tail with band-dependent decay
    const tail0 = Math.round((pre + 0.004) * fs);
    const lo = white(len, seed + 11 + c * 101);
    const mid = white(len, seed + 23 + c * 101);
    const hi = white(len, seed + 37 + c * 101);
    Biquad.lp(fs, 320, 0.7).run(lo);
    Biquad.hp(fs, 320, 0.7).run(mid);
    Biquad.lp(fs, 2800, 0.7).run(mid);
    Biquad.hp(fs, 2800, 0.7).run(hi);
    const kLo = -6.91 / (rt * 1.15);
    const kMid = -6.91 / rt;
    const kHi = -6.91 / (rt * 0.5);
    const ch = out[c];
    for (let i = 0; i < len; i++) {
      ch[i] = er[i];
      if (i < tail0) continue;
      const t = (i - tail0) / fs;
      const build = Math.min(1, t / 0.018);
      const s = lo[i] * Math.exp(kLo * t) * 0.9 + mid[i] * Math.exp(kMid * t) + hi[i] * Math.exp(kHi * t) * 0.6;
      ch[i] += s * build * 0.42;
    }
    // wood: a little warmth around 250 Hz, softer top
    Biquad.peak(fs, 250, 1.0, 1.5).run(ch);
    Biquad.highshelf(fs, 5000, -3).run(ch);
    // fade the very end
    const fo = Math.round(fs * 0.08);
    for (let i = 0; i < fo; i++) ch[len - 1 - i] *= i / fo;
  }
  // unit energy per channel
  for (const ch of out) {
    let e = 0;
    for (let i = 0; i < ch.length; i++) e += ch[i] * ch[i];
    const g = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < ch.length; i++) ch[i] *= g;
  }
  return out;
}
