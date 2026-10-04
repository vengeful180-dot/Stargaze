// Pre-rendered sounds: drum one-shots, Karplus-Strong guitar, additive felt piano, vinyl crackle, tape hiss,
// AM "chatter" and noise loops. All rendered with the JS DSP toolkit into Float32Arrays (deterministic).
import {
  Biquad, Noise, type F32, brown, crush, dcBlock, fadeEdges, normalizePeak, onePoleLP, pink, rmsOf, saturate, scale, tinyRoom, white,
} from '../dsp';
import type { DrumId } from '../music/drums';
import { midiToHz } from '../util';

const TAU = Math.PI * 2;

// ------------------------------------------------------------------------------------------------
// Drums

export function renderKick(fs: number, seed: number): F32 {
  const n = new Noise(seed);
  const len = Math.round(fs * 0.62);
  const out = new Float32Array(len);
  const fEnd = 53 + n.u() * 6;
  const fStart = 150 + n.u() * 25;
  const tp = 0.028 + n.u() * 0.008;
  const ta = 0.19 + n.u() * 0.06;
  let ph = 0;
  const clickLp = Biquad.lp(fs, 2600, 0.6);
  for (let i = 0; i < len; i++) {
    const t = i / fs;
    const f = fEnd + (fStart - fEnd) * Math.exp(-t / tp);
    ph += (TAU * f) / fs;
    const att = 1 - Math.exp(-t / 0.0012);
    const amp = att * (0.82 * Math.exp(-t / ta) + 0.18 * Math.exp(-t / 0.05));
    const body = Math.sin(ph) * amp;
    const click = clickLp.process(n.next()) * Math.exp(-t / 0.0011) * 0.5 + Math.sin(TAU * 1150 * t) * Math.exp(-t / 0.004) * 0.05;
    out[i] = body + click;
  }
  saturate(out, 1.5);
  Biquad.hp(fs, 26, 0.7).run(out);
  Biquad.lp(fs, 6500, 0.7).run(out);
  fadeEdges(out, 0, Math.round(fs * 0.03));
  return normalizePeak(out, 0.95);
}

export function renderSnare(fs: number, seed: number, crisp = false): F32 {
  const n = new Noise(seed);
  const len = Math.round(fs * 0.5);
  const body = new Float32Array(len);
  const f1 = 182 + n.u() * 16;
  let ph1 = 0;
  let ph2 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / fs;
    const f = f1 * (1 + 0.28 * Math.exp(-t / 0.014));
    ph1 += (TAU * f) / fs;
    ph2 += (TAU * f * 1.78) / fs;
    body[i] = (Math.sin(ph1) * Math.exp(-t / 0.055) * 0.7 + Math.sin(ph2) * Math.exp(-t / 0.035) * 0.3) * (1 - Math.exp(-t / 0.0006));
  }
  const noise = white(len, seed ^ 0x55aa);
  Biquad.hp(fs, crisp ? 1100 : 850, 0.7).run(noise);
  Biquad.lp(fs, crisp ? 9000 : 7000, 0.6).run(noise);
  const rattle = white(len, seed ^ 0x1234);
  Biquad.bp(fs, 3400 + n.u() * 600, 0.9).run(rattle);
  // the mid "crack" that makes a snare speak on small speakers
  const crack = white(len, seed ^ 0x2468);
  Biquad.bp(fs, 1500 + n.u() * 300, 1.1).run(crack);
  const tn = crisp ? 0.11 : 0.13;
  for (let i = 0; i < len; i++) {
    const t = i / fs;
    const env = (1 - Math.exp(-t / 0.0005)) * (0.85 * Math.exp(-t / tn) + 0.15 * Math.exp(-t / 0.26));
    noise[i] = noise[i] * env + rattle[i] * Math.exp(-t / 0.09) * 0.35 + crack[i] * Math.exp(-t / 0.045) * (crisp ? 1.1 : 0.9);
  }
  tinyRoom(noise, fs, crisp ? 0.18 : 0.3, seed);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = body[i] * 0.55 + noise[i] * (crisp ? 0.8 : 0.7);
  saturate(out, crisp ? 1.6 : 1.3);
  if (fs >= 44100) crush(out, 12, 2);
  Biquad.lp(fs, crisp ? 8500 : 6800, 0.7).run(out);
  dcBlock(out, fs, 30);
  fadeEdges(out, 0, Math.round(fs * 0.05));
  return normalizePeak(out, 0.9);
}

export function renderRim(fs: number, seed: number): F32 {
  const n = new Noise(seed);
  const len = Math.round(fs * 0.14);
  const out = new Float32Array(len);
  const fa = 1650 + n.u() * 200;
  const fb = 450 + n.u() * 60;
  const nz = white(len, seed ^ 0x777);
  Biquad.hp(fs, 2000, 0.7).run(nz);
  for (let i = 0; i < len; i++) {
    const t = i / fs;
    out[i] = Math.sin(TAU * fa * t) * Math.exp(-t / 0.011) * 0.55 + Math.sin(TAU * fb * t) * Math.exp(-t / 0.02) * 0.45 + nz[i] * Math.exp(-t / 0.004) * 0.35;
    out[i] *= 1 - Math.exp(-t / 0.0003);
  }
  tinyRoom(out, fs, 0.25, seed);
  saturate(out, 1.3);
  Biquad.lp(fs, 7500, 0.7).run(out);
  fadeEdges(out, 0, Math.round(fs * 0.03));
  return normalizePeak(out, 0.85);
}

export function renderSnap(fs: number, seed: number): F32 {
  const len = Math.round(fs * 0.25);
  const a = white(len, seed);
  Biquad.bp(fs, 1900, 1.3).run(a);
  const b = white(len, seed ^ 0x99);
  Biquad.bp(fs, 2900, 1.6).run(b);
  const out = new Float32Array(len);
  const d2 = Math.round(fs * 0.006);
  for (let i = 0; i < len; i++) {
    const t = i / fs;
    out[i] = a[i] * Math.exp(-t / 0.028) * (1 - Math.exp(-t / 0.0003));
    if (i >= d2) out[i] += b[i] * Math.exp(-(i - d2) / fs / 0.02) * 0.5;
  }
  tinyRoom(out, fs, 0.45, seed);
  Biquad.lp(fs, 7000, 0.7).run(out);
  fadeEdges(out, 0, Math.round(fs * 0.05));
  return normalizePeak(out, 0.85);
}

export function renderBrush(fs: number, seed: number): F32 {
  const n = new Noise(seed);
  const len = Math.round(fs * 0.38);
  const out = white(len, seed);
  Biquad.bp(fs, 3000 + n.u() * 600, 0.6).run(out);
  for (let i = 0; i < len; i++) {
    const t = i / fs;
    const att = t < 0.012 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.012) : 1;
    out[i] = out[i] * att * Math.exp(-Math.max(0, t - 0.012) / 0.11) + Math.sin(TAU * 185 * t) * Math.exp(-t / 0.05) * 0.18;
  }
  Biquad.lp(fs, 7500, 0.7).run(out);
  fadeEdges(out, 0, Math.round(fs * 0.05));
  return normalizePeak(out, 0.8);
}

function metallic(len: number, fs: number, seed: number): F32 {
  // six detuned square waves (808-style), the classic metallic hat source
  const n = new Noise(seed);
  const freqs = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0].map((f) => f * (1.55 + n.u() * 0.1));
  const out = new Float32Array(len);
  const ph = freqs.map(() => n.u());
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let k = 0; k < freqs.length; k++) {
      ph[k] += freqs[k] / fs;
      if (ph[k] >= 1) ph[k] -= 1;
      s += ph[k] < 0.5 ? 1 : -1;
    }
    out[i] = s / freqs.length;
  }
  return out;
}

export function renderHat(fs: number, seed: number, open: boolean): F32 {
  const len = Math.round(fs * (open ? 0.7 : 0.14));
  const m = metallic(len, fs, seed);
  const nz = white(len, seed ^ 0x4242);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = m[i] * 0.55 + nz[i] * 0.6;
  Biquad.hp(fs, 6500, 0.7).run(out);
  Biquad.hp(fs, 5200, 0.7).run(out);
  Biquad.peak(fs, 9000, 1.2, -4).run(out);
  Biquad.lp(fs, 12000, 0.7).run(out);
  const td = open ? 0.2 : 0.034;
  for (let i = 0; i < len; i++) {
    const t = i / fs;
    out[i] *= (1 - Math.exp(-t / 0.0004)) * (0.8 * Math.exp(-t / td) + 0.2 * Math.exp(-t / (td * 0.3)));
  }
  if (fs >= 44100) crush(out, 11, 2);
  Biquad.lp(fs, 11000, 0.7).run(out);
  fadeEdges(out, 0, Math.round(fs * (open ? 0.1 : 0.02)));
  return normalizePeak(out, 0.8);
}

export function renderShaker(fs: number, seed: number): F32 {
  const len = Math.round(fs * 0.16);
  const out = white(len, seed);
  Biquad.bp(fs, 5200, 1.1).run(out);
  Biquad.hp(fs, 2800, 0.7).run(out);
  const n = new Noise(seed ^ 0x3131);
  const a = 0.006 + n.u() * 0.006;
  for (let i = 0; i < len; i++) {
    const t = i / fs;
    const att = t < a ? 0.5 - 0.5 * Math.cos((Math.PI * t) / a) : 1;
    out[i] *= att * Math.exp(-Math.max(0, t - a) / 0.042) * (0.75 + 0.25 * n.u());
  }
  Biquad.lp(fs, 9000, 0.7).run(out);
  fadeEdges(out, 0, Math.round(fs * 0.02));
  return normalizePeak(out, 0.7);
}

export function renderDrum(id: DrumId, fs: number, variant: number, crisp: boolean): F32 {
  const seed = 0xd2a0 + variant * 7919 + id.length * 131;
  switch (id) {
    case 'kick':
      return renderKick(fs, seed);
    case 'snare':
      return renderSnare(fs, seed, crisp);
    case 'rim':
      return renderRim(fs, seed);
    case 'snap':
      return renderSnap(fs, seed);
    case 'brush':
      return renderBrush(fs, seed);
    case 'hat':
      return renderHat(fs, seed, false);
    case 'ohat':
      return renderHat(fs, seed, true);
    case 'shaker':
      return renderShaker(fs, seed);
  }
}

// ------------------------------------------------------------------------------------------------
// Karplus-Strong guitar (nylon / clean electric)

export function renderGuitar(fs: number, midi: number, nylon: boolean, seed: number): F32 {
  const f = midiToHz(midi);
  const t60 = Math.max(0.9, Math.min(3.6, (nylon ? 3.0 : 3.8) * Math.pow(110 / f, 0.42)));
  const len = Math.round(fs * Math.min(4.2, t60 * 1.15 + 0.2));
  const out = new Float32Array(len);
  const period = fs / f;
  const loopDelay = period - 0.5; // the averaging loss filter adds half a sample
  let L = Math.floor(loopDelay);
  let d = loopDelay - L;
  if (d < 0.5) {
    d += 1;
    L -= 1;
  }
  const C = (1 - d) / (1 + d);
  const buf = new Float32Array(L);
  // excitation: soft pluck (low-passed noise) with a pick-position comb
  const n = new Noise(seed);
  const exc = new Float32Array(L);
  for (let i = 0; i < L; i++) exc[i] = n.next();
  onePoleLP(exc, fs, nylon ? 1600 + 2.2 * f : 2600 + 3 * f);
  const pp = Math.max(1, Math.round(L * (nylon ? 0.16 : 0.12)));
  for (let i = L - 1; i >= pp; i--) exc[i] -= exc[i - pp];
  let m = 0;
  for (let i = 0; i < L; i++) m += exc[i];
  m /= L;
  for (let i = 0; i < L; i++) buf[i] = exc[i] - m;
  const g = Math.pow(10, -3 / (t60 * f));
  let idx = 0;
  let prev = 0;
  let apx = 0;
  let apy = 0;
  for (let i = 0; i < len; i++) {
    const x = buf[idx];
    const avg = 0.5 * (x + prev);
    prev = x;
    const ap = C * avg + apx - C * apy;
    apx = avg;
    apy = ap;
    buf[idx] = ap * g;
    idx++;
    if (idx >= L) idx = 0;
    out[i] = x;
  }
  // body
  if (nylon) {
    Biquad.peak(fs, 102, 2.5, 5).run(out);
    Biquad.peak(fs, 210, 3, 3).run(out);
    Biquad.peak(fs, 420, 2, 1.5).run(out);
    Biquad.highshelf(fs, 3000, -4).run(out);
    Biquad.lp(fs, 5200, 0.6).run(out);
  } else {
    Biquad.peak(fs, 180, 1.5, 2).run(out);
    Biquad.peak(fs, 2400, 1.2, 2).run(out);
    Biquad.lp(fs, 6500, 0.6).run(out);
  }
  dcBlock(out, fs, 25);
  fadeEdges(out, Math.round(fs * 0.0008), Math.round(fs * 0.12));
  // equal loudness across the neck: normalise the first 300 ms
  const r = rmsOf(out, 0, Math.min(len, Math.round(fs * 0.3)));
  if (r > 0) scale(out, 0.16 / r);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Additive felt piano (two velocity layers)

export function renderPiano(fs: number, midi: number, hard: boolean, seed: number): F32 {
  const f = midiToHz(midi);
  const n = new Noise(seed);
  const B = 1.6e-4 * Math.pow(2, (midi - 48) / 18);
  const T = Math.max(1.4, Math.min(4.6, 2.6 * Math.pow(261.6 / f, 0.5)));
  const len = Math.round(fs * (T + 0.4));
  const out = new Float32Array(len);
  const maxF = hard ? 6000 : 4500;
  const np = Math.max(1, Math.min(16, Math.floor(maxF / f)));
  const roll = hard ? 0.26 : 0.4;
  for (let k = 1; k <= np; k++) {
    const fk = k * f * Math.sqrt(1 + B * k * k);
    if (fk > fs * 0.45) break;
    let a = Math.pow(k, -1.1) * Math.exp(-(k - 1) * roll) * (0.35 + 0.65 * Math.abs(Math.sin(Math.PI * k * 0.117)));
    if (k === 1) a *= 0.9;
    const tau = T / (1 + 0.38 * (k - 1));
    const dPrompt = Math.exp(-1 / (fs * tau * 0.28));
    const dAfter = Math.exp(-1 / (fs * tau * 1.5));
    for (let s = 0; s < 2; s++) {
      const cents = (s === 0 ? -1 : 1) * (0.4 + 0.25 * n.u()) * (k === 1 ? 1 : 1.4);
      const w = (TAU * fk * Math.pow(2, cents / 1200)) / fs;
      const c2 = 2 * Math.cos(w);
      const ph = n.u() * TAU * 0.15;
      let y1 = Math.sin(ph - w);
      let y2 = Math.sin(ph - 2 * w);
      let e1 = 0.62 * a * 0.5;
      let e2 = 0.38 * a * 0.5;
      for (let i = 0; i < len; i++) {
        const y = c2 * y1 - y2;
        y2 = y1;
        y1 = y;
        out[i] += y * (e1 + e2);
        e1 *= dPrompt;
        e2 *= dAfter;
      }
    }
  }
  // felt hammer thump
  const th = white(Math.round(fs * 0.06), seed ^ 0x6666);
  onePoleLP(th, fs, hard ? 900 : 550);
  for (let i = 0; i < th.length; i++) out[i] += th[i] * Math.exp(-i / fs / 0.012) * (hard ? 0.05 : 0.03);
  Biquad.lp(fs, hard ? 5200 : 3300, 0.6).run(out);
  Biquad.lowshelf(fs, 200, 1.5).run(out);
  dcBlock(out, fs, 20);
  fadeEdges(out, Math.round(fs * (hard ? 0.0015 : 0.003)), Math.round(fs * 0.2));
  const r = rmsOf(out, 0, Math.min(len, Math.round(fs * 0.35)));
  if (r > 0) scale(out, (hard ? 0.2 : 0.14) / r);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Textures

/** Stereo vinyl crackle loop: sparse band-limited clicks, rare pops and faint surface noise. */
export function renderCrackle(fs: number, seconds: number, seed: number, density = 1): [F32, F32] {
  const len = Math.round(fs * seconds);
  const n = new Noise(seed);
  const chans: [F32, F32] = [new Float32Array(len), new Float32Array(len)];
  const addClick = (ch: F32, at: number, amp: number, tau: number) => {
    const L = Math.round(fs * tau * 6);
    for (let i = 0; i < L && at + i < len; i++) ch[at + i] += n.next() * amp * Math.exp(-i / (fs * tau));
  };
  // shared clicks (both channels, as on a real record) plus a few per-channel ones
  const rate = 9 * density;
  let t = 0;
  while (t < seconds) {
    t += -Math.log(Math.max(1e-6, n.u())) / rate;
    const at = Math.round(t * fs);
    // log-normal click sizes, but bounded: a few stand out, none explode
    const amp = 0.12 * Math.min(2.6, Math.exp(n.gauss() * 0.55));
    const tau = 0.00012 + n.u() * 0.0003;
    const r = n.u();
    if (r < 0.7) {
      addClick(chans[0], at, amp, tau);
      addClick(chans[1], at, amp * (0.6 + 0.4 * n.u()), tau);
    } else addClick(chans[r < 0.85 ? 0 : 1], at, amp, tau);
  }
  // rare soft pops (low-passed, so they thump rather than snap)
  t = 0;
  while (t < seconds) {
    t += -Math.log(Math.max(1e-6, n.u())) / (0.25 * density);
    const at = Math.round(t * fs);
    const amp = 0.16 + n.u() * 0.2;
    const tau = 0.0012 + n.u() * 0.0018;
    for (const ch of chans) {
      const L = Math.round(fs * tau * 6);
      for (let i = 0; i < L && at + i < len; i++) ch[at + i] += Math.sin((i / L) * Math.PI) * (n.next() * 0.4 + 0.6) * amp * Math.exp(-i / (fs * tau));
    }
  }
  for (const ch of chans) {
    Biquad.hp(fs, 350, 0.7).run(ch);
    Biquad.lp(fs, 5200, 0.7).run(ch);
  }
  // surface noise with a once-per-revolution swish (33 rpm)
  const surf = [pink(len, seed ^ 0xabc), pink(len, seed ^ 0xdef)];
  for (let c = 0; c < 2; c++) {
    Biquad.lp(fs, 2600, 0.7).run(surf[c]);
    Biquad.hp(fs, 200, 0.7).run(surf[c]);
    for (let i = 0; i < len; i++) {
      const sw = 0.6 + 0.4 * Math.sin((TAU * 0.555 * i) / fs + c);
      chans[c][i] += surf[c][i] * 0.022 * sw;
    }
  }
  // seamless loop: crossfade the tail into the head
  const xf = Math.round(fs * 0.05);
  for (const ch of chans) {
    for (let i = 0; i < xf; i++) {
      const w = i / xf;
      ch[i] = ch[i] * w + ch[len - xf + i] * (1 - w);
    }
  }
  // normalise by energy (RMS 0.05), not by the single loudest click
  const r = Math.sqrt((rmsOf(chans[0]) ** 2 + rmsOf(chans[1]) ** 2) / 2);
  for (const ch of chans) scale(ch, 0.05 / (r || 1));
  return [chans[0].slice(0, len - xf), chans[1].slice(0, len - xf)];
}

/** Mono tape hiss loop. */
export function renderHiss(fs: number, seconds: number, seed: number): F32 {
  const len = Math.round(fs * seconds);
  const out = pink(len, seed);
  Biquad.hp(fs, 900, 0.7).run(out);
  Biquad.lp(fs, 8500, 0.7).run(out);
  return normalizePeak(loopify(out, Math.round(fs * 0.05)), 0.5);
}

/** Murmuring AM voices for the static between stations: voiced pulses through moving formants. */
export function renderChatter(fs: number, seconds: number, seed: number): F32 {
  const len = Math.round(fs * seconds);
  const n = new Noise(seed);
  const out = new Float32Array(len);
  let i = 0;
  let pitch = 120 + n.u() * 60;
  let ph = 0;
  while (i < len) {
    // a "word": 2-4 syllables, then a pause
    const syl = 2 + Math.floor(n.u() * 3);
    for (let s = 0; s < syl && i < len; s++) {
      const L = Math.round(fs * (0.09 + n.u() * 0.15));
      const f1 = Biquad.bp(fs, 350 + n.u() * 500, 4);
      const f2 = Biquad.bp(fs, 900 + n.u() * 1400, 6);
      const p0 = pitch * (0.9 + n.u() * 0.25);
      for (let k = 0; k < L && i < len; k++, i++) {
        const env = Math.sin((Math.PI * k) / L);
        ph += (p0 * (1 + 0.04 * Math.sin((k / L) * Math.PI))) / fs;
        let src = 0;
        if (ph >= 1) {
          ph -= 1;
          src = 1;
        }
        src += n.next() * 0.08;
        out[i] = (f1.process(src) * 1.0 + f2.process(src) * 0.6) * env;
      }
    }
    pitch = 110 + n.u() * 90;
    i += Math.round(fs * (0.12 + n.u() * 0.5));
  }
  Biquad.hp(fs, 300, 0.7).run(out);
  Biquad.lp(fs, 2800, 0.7).run(out);
  return normalizePeak(loopify(out, Math.round(fs * 0.05)), 0.8);
}

export function renderNoise(kind: 'white' | 'pink' | 'brown', fs: number, seconds: number, seed: number): F32 {
  const len = Math.round(fs * seconds);
  const out = kind === 'white' ? white(len, seed) : kind === 'pink' ? pink(len, seed) : brown(len, seed);
  if (kind === 'brown') dcBlock(out, fs, 8);
  return normalizePeak(loopify(out, Math.round(fs * 0.05)), kind === 'white' ? 0.7 : 0.9);
}

/** Make a buffer loop seamlessly: crossfade its tail into its head and drop the tail. */
function loopify(buf: F32, xf: number): F32 {
  const len = buf.length;
  for (let i = 0; i < xf; i++) {
    const w = i / xf;
    buf[i] = buf[i] * w + buf[len - xf + i] * (1 - w);
  }
  return buf.slice(0, len - xf);
}
