// Tactile, soft, synthesised sound effects. Rendered once into buffers at unlock; positional when given a
// cabin position (HRTF panner) and always sent a little into the cabin room.
import type { Engine } from './engine';
import { Biquad, Noise, type F32, dcBlock, fadeEdges, normalizePeak, onePoleLP, white } from './dsp';
import { SFX_NAMES, type SfxName } from './types';
import { safeDisconnect } from './util';

const TAU = Math.PI * 2;

function env(t: number, a: number, d: number) {
  return (t < a ? t / a : 1) * Math.exp(-Math.max(0, t - a) / d);
}

function blank(fs: number, s: number) {
  return new Float32Array(Math.round(fs * s));
}

/** A tiny percussive "tok": a resonant ping plus a click of noise. */
function tok(out: F32, fs: number, at: number, f: number, decay: number, amp: number, noiseAmp: number, seed: number) {
  const n = new Noise(seed);
  const start = Math.round(at * fs);
  const len = Math.min(out.length - start, Math.round(fs * decay * 8));
  const bp = Biquad.bp(fs, f * 2.3, 2);
  for (let i = 0; i < len; i++) {
    const t = i / fs;
    out[start + i] += Math.sin(TAU * f * t) * amp * env(t, 0.0004, decay) + bp.process(n.next()) * noiseAmp * Math.exp(-t / 0.0015);
  }
}

const SYNTH: Record<SfxName, (fs: number) => F32> = {
  click(fs) {
    const o = blank(fs, 0.08);
    tok(o, fs, 0.001, 1900, 0.004, 0.5, 0.8, 11);
    tok(o, fs, 0.001, 190, 0.012, 0.35, 0, 12);
    Biquad.lp(fs, 6000, 0.7).run(o);
    return o;
  },
  switch(fs) {
    const o = blank(fs, 0.18);
    tok(o, fs, 0.002, 2400, 0.003, 0.25, 0.4, 21);
    tok(o, fs, 0.02, 650, 0.012, 0.8, 1.0, 22);
    tok(o, fs, 0.02, 115, 0.025, 0.5, 0, 23);
    Biquad.lp(fs, 6500, 0.7).run(o);
    return o;
  },
  knob(fs) {
    const o = blank(fs, 0.05);
    tok(o, fs, 0.001, 1250, 0.004, 0.35, 0.9, 31);
    Biquad.hp(fs, 400, 0.7).run(o);
    Biquad.lp(fs, 7000, 0.7).run(o);
    return o;
  },
  button(fs) {
    const o = blank(fs, 0.2);
    tok(o, fs, 0.002, 900, 0.006, 0.4, 0.5, 41);
    tok(o, fs, 0.002, 140, 0.03, 0.6, 0, 42);
    tok(o, fs, 0.085, 1100, 0.004, 0.18, 0.25, 43);
    Biquad.lp(fs, 3500, 0.7).run(o);
    return o;
  },
  beep(fs) {
    const o = blank(fs, 0.26);
    let ph = 0;
    for (let i = 0; i < o.length; i++) {
      const t = i / fs;
      const f = (t < 0.09 ? 880 : 1174.7) * (1 + 0.002 * Math.sin(TAU * 6 * t));
      ph += (TAU * f) / fs;
      const a = Math.min(1, t / 0.008) * (t < 0.09 ? 1 : 0.85) * Math.min(1, Math.max(0, (0.22 - t) / 0.05));
      o[i] = (Math.sin(ph) + 0.08 * Math.sin(2 * ph)) * a * 0.5;
    }
    Biquad.lp(fs, 3500, 0.7).run(o);
    return o;
  },
  bump(fs) {
    const o = blank(fs, 0.7);
    const nz = white(o.length, 51);
    onePoleLP(nz, fs, 300);
    const hull = white(o.length, 52);
    Biquad.bp(fs, 178, 9).run(hull);
    let ph = 0;
    for (let i = 0; i < o.length; i++) {
      const t = i / fs;
      ph += (TAU * (58 + 45 * Math.exp(-t / 0.04))) / fs;
      o[i] = Math.sin(ph) * env(t, 0.002, 0.12) * 0.9 + nz[i] * Math.exp(-t / 0.025) * 1.2 + hull[i] * Math.exp(-t / 0.25) * 0.5;
    }
    Biquad.lp(fs, 1800, 0.7).run(o);
    return o;
  },
  'warp-spool'(fs) {
    const o = blank(fs, 2.7);
    const nz = white(o.length, 61);
    let ph = 0;
    const n = o.length;
    const blocks = 64;
    const bl = Math.ceil(n / blocks);
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = i / n;
      const f = 70 * Math.pow(260 / 70, k * k);
      ph += (TAU * f) / fs;
      tone[i] = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph) + 0.12 * Math.sin(4 * ph)) * 0.4;
    }
    for (let b = 0; b < blocks; b++) {
      const k = b / blocks;
      const lp = Biquad.lp(fs, 300 + 2400 * k * k, 0.8);
      const bp = Biquad.bp(fs, 400 + 3800 * k * k, 1.5);
      for (let i = b * bl; i < Math.min(n, (b + 1) * bl); i++) {
        const a = Math.pow(i / n, 1.6);
        o[i] = lp.process(tone[i]) * a + bp.process(nz[i]) * a * 0.6;
      }
    }
    return o;
  },
  'warp-jump'(fs) {
    const o = blank(fs, 2.4);
    const nz = white(o.length, 71);
    const n = o.length;
    const blocks = 64;
    const bl = Math.ceil(n / blocks);
    let ph = 0;
    for (let b = 0; b < blocks; b++) {
      const k = b / blocks;
      const bp = Biquad.bp(fs, 5000 * Math.pow(200 / 5000, Math.sqrt(k)), 1.1);
      for (let i = b * bl; i < Math.min(n, (b + 1) * bl); i++) {
        const t = i / fs;
        ph += (TAU * (40 + 50 * Math.exp(-t / 0.15))) / fs;
        o[i] = bp.process(nz[i]) * env(t, 0.05, 0.7) * 1.1 + Math.sin(ph) * env(t, 0.005, 0.5) * 0.9;
      }
    }
    return o;
  },
  'warp-exit'(fs) {
    const o = blank(fs, 2.4);
    const nz = white(o.length, 81);
    const n = o.length;
    const blocks = 64;
    const bl = Math.ceil(n / blocks);
    for (let b = 0; b < blocks; b++) {
      const k = b / blocks;
      const bp = Biquad.bp(fs, k < 0.35 ? 200 + 2800 * (k / 0.35) : 3000 * Math.pow(0.15, (k - 0.35) / 0.65), 1.2);
      for (let i = b * bl; i < Math.min(n, (b + 1) * bl); i++) {
        const t = i / fs;
        const a = t < 0.8 ? Math.pow(t / 0.8, 2) : Math.exp(-(t - 0.8) / 0.45);
        o[i] = bp.process(nz[i]) * a;
      }
    }
    tok(o, fs, 0.85, 52, 0.18, 0.5, 0, 82);
    return o;
  },
  seat(fs) {
    const o = blank(fs, 0.7);
    const nz = new Noise(91);
    const n = o.length;
    const exc = new Float32Array(n);
    let t = 0.02 * fs;
    while (t < n * 0.85) {
      exc[Math.round(t)] = (0.6 + nz.u() * 0.4) * (nz.u() < 0.5 ? 1 : -1);
      t += fs / (40 + 25 * Math.sin((t / n) * Math.PI));
    }
    const blocks = 24;
    const bl = Math.ceil(n / blocks);
    for (let b = 0; b < blocks; b++) {
      const f = 330 + 140 * Math.sin((b / blocks) * Math.PI);
      const r1 = Biquad.bp(fs, f, 12);
      const r2 = Biquad.bp(fs, f * 2.6, 8);
      for (let i = b * bl; i < Math.min(n, (b + 1) * bl); i++) o[i] = r1.process(exc[i]) + 0.35 * r2.process(exc[i]);
    }
    const rub = white(n, 92);
    onePoleLP(rub, fs, 700);
    for (let i = 0; i < n; i++) o[i] = o[i] * Math.sin((Math.PI * i) / n) + rub[i] * 0.08 * Math.sin((Math.PI * i) / n);
    return o;
  },
  telescope(fs) {
    const o = blank(fs, 1.0);
    const n = o.length;
    const fr = white(n, 101);
    const modes = [1180, 2870, 4550];
    const blocks = 40;
    const bl = Math.ceil(n / blocks);
    for (let b = 0; b < blocks; b++) {
      const k = b / blocks;
      const filters = modes.map((m) => Biquad.bp(fs, m * (1 + 0.08 * k), 25));
      const body = Biquad.bp(fs, 240, 3);
      for (let i = b * bl; i < Math.min(n, (b + 1) * bl); i++) {
        const t = i / fs;
        const a = t < 0.75 ? Math.min(1, t / 0.05) * (0.7 + 0.3 * Math.sin(TAU * 11 * t)) : Math.max(0, 1 - (t - 0.75) / 0.03);
        const x = fr[i] * a;
        o[i] = filters[0].process(x) * 1.0 + filters[1].process(x) * 0.6 + filters[2].process(x) * 0.3 + body.process(x) * 0.5;
      }
    }
    tok(o, fs, 0.78, 520, 0.02, 0.6, 0.7, 102);
    tok(o, fs, 0.78, 1650, 0.05, 0.25, 0, 103);
    return o;
  },
  pour(fs) {
    const o = blank(fs, 3.0);
    const n = o.length;
    const nz = new Noise(111);
    // stream
    const stream = white(n, 112);
    Biquad.bp(fs, 1600, 0.7).run(stream);
    let am = 0;
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      if (i % 64 === 0) am = 0.5 + 0.5 * nz.u();
      const e = Math.min(1, t / 0.15) * Math.min(1, Math.max(0, (2.9 - t) / 0.45));
      o[i] = stream[i] * e * 0.12 * am;
    }
    // bubbles whose pitch rises as the cup fills
    let t = 0.08;
    while (t < 2.7) {
      t += -Math.log(Math.max(1e-6, nz.u())) / 28;
      const fill = t / 2.7;
      const f0 = (420 + 700 * fill) * (0.7 + nz.u() * 0.8);
      const dur = 0.008 + nz.u() * 0.018;
      const at = Math.round(t * fs);
      const L = Math.round(dur * fs * 4);
      let ph = 0;
      const amp = 0.25 + nz.u() * 0.35;
      for (let i = 0; i < L && at + i < n; i++) {
        const tt = i / fs;
        ph += (TAU * f0 * (1 + 0.6 * (tt / (dur * 4)))) / fs;
        o[at + i] += Math.sin(ph) * amp * env(tt, 0.001, dur);
      }
    }
    Biquad.lp(fs, 5000, 0.7).run(o);
    return o;
  },
};

export const SFX_LEVEL: Record<SfxName, number> = {
  click: 0.35, switch: 0.45, knob: 0.22, button: 0.4, beep: 0.22, bump: 0.6,
  'warp-spool': 0.35, 'warp-jump': 0.5, 'warp-exit': 0.35, seat: 0.4, telescope: 0.35, pour: 0.4,
};

export class Sfx {
  private eng: Engine | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();

  attach(eng: Engine) {
    if (this.eng) return;
    this.eng = eng;
    for (const name of SFX_NAMES) this.buffer(name);
  }

  private buffer(name: SfxName): AudioBuffer | null {
    const eng = this.eng;
    if (!eng) return null;
    let b = this.buffers.get(name);
    if (!b) {
      const fs = eng.ctx.sampleRate;
      const d = SYNTH[name](fs);
      dcBlock(d, fs, 20);
      fadeEdges(d, 16, Math.round(fs * 0.01));
      normalizePeak(d, 0.9);
      b = eng.ctx.createBuffer(1, d.length, fs);
      b.copyToChannel(d, 0);
      this.buffers.set(name, b);
    }
    return b;
  }

  /** Play a sound; with `pos` (cabin frame, metres) it comes from that point in the cabin. */
  play(name: SfxName, pos?: readonly number[], opts: { gain?: number; rate?: number } = {}) {
    const eng = this.eng;
    if (!eng) return;
    const buf = this.buffer(name);
    if (!buf) return;
    const ctx = eng.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (opts.rate ?? 1) * (1 + (Math.random() - 0.5) * 0.04);
    const g = ctx.createGain();
    g.gain.value = SFX_LEVEL[name] * (opts.gain ?? 1) * (0.92 + Math.random() * 0.08);
    const nodes: AudioNode[] = [src, g];
    src.connect(g);
    if (pos) {
      const p = eng.makePanner({ refDistance: 0.5, rolloffFactor: 1 });
      const pp = p as PannerNode & { positionX?: AudioParam };
      if (pp.positionX) {
        p.positionX.value = pos[0];
        p.positionY.value = pos[1];
        p.positionZ.value = pos[2];
      } else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos[0], pos[1], pos[2]);
      g.connect(p).connect(eng.sfxVol);
      nodes.push(p);
    } else g.connect(eng.sfxVol);
    eng.stats.addNodes(nodes.length);
    src.onended = () => {
      for (const n of nodes) safeDisconnect(n);
      eng.stats.removeNodes(nodes.length);
    };
    src.start();
  }
}
