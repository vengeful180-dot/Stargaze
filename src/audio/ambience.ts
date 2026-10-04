// The cabin bed: a very quiet ship hum (filtered brown noise + a soft harmonic drone), an air vent, a deep
// warp rumble that swells with warp, and rare soft creaks and thermal ticks somewhere in the cabin.
import type { Engine } from './engine';
import { Biquad, Noise, type F32, fadeEdges, normalizePeak, white } from './dsp';
import type { ShipState } from './types';
import { clamp, safeDisconnect, safeStop } from './util';

export const AMB_LEVEL = {
  hum: 0.036,
  drone: 0.009,
  vent: 0.006,
  warp: 0.16,
  sub: 0.05,
  whoosh: 0.03,
  creak: 0.05,
  tick: 0.03,
};

function renderCreak(fs: number, seed: number): F32 {
  const n = new Noise(seed);
  const len = Math.round(fs * (0.35 + n.u() * 0.4));
  const out = new Float32Array(len);
  // stick-slip: a train of tiny impulses exciting a resonant body whose pitch glides
  const f0 = 260 + n.u() * 260;
  const glide = 1 + (n.u() - 0.5) * 0.35;
  let t = 0;
  const exc = new Float32Array(len);
  while (t < len) {
    exc[Math.round(t)] += (0.5 + n.u() * 0.5) * (n.u() < 0.5 ? 1 : -1);
    t += fs / (35 + n.u() * 50);
  }
  const blocks = 16;
  const bl = Math.ceil(len / blocks);
  for (let b = 0; b < blocks; b++) {
    const f = f0 * (1 + (glide - 1) * (b / blocks));
    const bq = Biquad.bp(fs, f, 14);
    const bq2 = Biquad.bp(fs, f * 2.7, 10);
    for (let i = b * bl; i < Math.min(len, (b + 1) * bl); i++) out[i] = bq.process(exc[i]) + 0.4 * bq2.process(exc[i]);
  }
  for (let i = 0; i < len; i++) out[i] *= Math.sin((Math.PI * i) / len);
  fadeEdges(out, 64, 256);
  return normalizePeak(out, 0.8);
}

function renderTick(fs: number, seed: number): F32 {
  const n = new Noise(seed);
  const len = Math.round(fs * 0.08);
  const out = white(len, seed);
  const f = 1800 + n.u() * 1800;
  Biquad.bp(fs, f, 6).run(out);
  for (let i = 0; i < len; i++) out[i] *= Math.exp(-i / (fs * 0.006));
  fadeEdges(out, 8, 64);
  return normalizePeak(out, 0.7);
}

export class Ambience {
  private state: ShipState = { throttle: 0, speed: 0, warp: 0 };
  private eng: Engine | null = null;
  private nodes: AudioNode[] = [];
  private srcs: AudioScheduledSourceNode[] = [];
  private humLP: BiquadFilterNode | null = null;
  private humG: GainNode | null = null;
  private drone: OscillatorNode[] = [];
  private droneG: GainNode | null = null;
  private ventG: GainNode | null = null;
  private warpLP: BiquadFilterNode | null = null;
  private warpG: GainNode | null = null;
  private subG: GainNode | null = null;
  private sub: OscillatorNode | null = null;
  private whooshBP: BiquadFilterNode | null = null;
  private whooshG: GainNode | null = null;
  private bed: GainNode | null = null;
  private creaks: AudioBuffer[] = [];
  private ticks: AudioBuffer[] = [];
  private nextEvent = 0;
  private enabled = true;

  attach(eng: Engine) {
    if (this.eng) return;
    this.eng = eng;
    const ctx = eng.ctx;
    const bank = eng.bank;
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      this.nodes.push(g);
      return g;
    };
    const filt = (type: BiquadFilterType, f: number, q = 0.7) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      this.nodes.push(b);
      return b;
    };
    const loop = (b: AudioBuffer, rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.loop = true;
      s.playbackRate.value = rate;
      this.nodes.push(s);
      this.srcs.push(s);
      return s;
    };
    this.bed = gain(0);
    this.bed.connect(eng.ambVol);
    // hum
    this.humLP = filt('lowpass', 110, 0.8);
    this.humG = gain(AMB_LEVEL.hum);
    loop(bank.noise('brown')).connect(this.humLP).connect(this.humG).connect(this.bed);
    // harmonic drone with a slow beat
    this.droneG = gain(AMB_LEVEL.drone);
    const droneLP = filt('lowpass', 400, 0.5);
    droneLP.connect(this.droneG).connect(this.bed);
    [1, 2.004, 3.01].forEach((h, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = 46.5 * h;
      const g = gain([1, 0.45, 0.18][i]);
      o.connect(g).connect(droneLP);
      this.nodes.push(o);
      this.srcs.push(o);
      this.drone.push(o);
    });
    // air vent (slightly positional: above and behind)
    this.ventG = gain(AMB_LEVEL.vent);
    const ventPan = eng.makePanner({ refDistance: 1, rolloffFactor: 0.5 });
    this.nodes.push(ventPan);
    const ventBP = filt('bandpass', 1500, 0.45);
    const ventShelf = filt('highshelf', 4500, 0.7);
    ventShelf.gain.value = -8;
    loop(bank.noise('pink'), 0.97).connect(ventBP).connect(ventShelf).connect(this.ventG).connect(ventPan).connect(this.bed);
    const ventLfo = ctx.createOscillator();
    ventLfo.frequency.value = 0.09;
    const ventLfoG = gain(AMB_LEVEL.vent * 0.18);
    ventLfo.connect(ventLfoG).connect(this.ventG.gain);
    this.nodes.push(ventLfo);
    this.srcs.push(ventLfo);
    placePannerNow(ventPan, [-0.3, 2.1, 0.6]);
    // warp rumble, sub and whoosh
    this.warpLP = filt('lowpass', 60, 0.9);
    this.warpG = gain(0);
    loop(bank.noise('brown'), 0.83).connect(this.warpLP).connect(this.warpG).connect(this.bed);
    this.sub = ctx.createOscillator();
    this.sub.frequency.value = 31;
    this.subG = gain(0);
    this.sub.connect(this.subG).connect(this.bed);
    this.nodes.push(this.sub);
    this.srcs.push(this.sub);
    this.whooshBP = filt('bandpass', 400, 0.8);
    this.whooshG = gain(0);
    loop(bank.noiseStereo()).connect(this.whooshBP).connect(this.whooshG).connect(this.bed);

    const now = ctx.currentTime;
    for (const s of this.srcs) {
      if (s instanceof AudioBufferSourceNode && s.buffer) s.start(now, Math.random() * s.buffer.duration);
      else s.start(now);
    }
    // fade the bed in
    this.bed.gain.setValueAtTime(0, now);
    this.bed.gain.setTargetAtTime(this.enabled ? 1 : 0, now + 0.3, 1.2);
    for (let i = 0; i < 4; i++) this.creaks.push(this.toBuffer(renderCreak(ctx.sampleRate, 0xc7ea + i * 31)));
    for (let i = 0; i < 4; i++) this.ticks.push(this.toBuffer(renderTick(ctx.sampleRate, 0x71c + i * 17)));
    eng.stats.addNodes(this.nodes.length);
    this.nextEvent = now + 8 + Math.random() * 12;
    this.apply(true);
    eng.onTick((t) => this.update(t));
  }

  private toBuffer(d: F32): AudioBuffer {
    const ctx = (this.eng as Engine).ctx;
    const b = ctx.createBuffer(1, d.length, ctx.sampleRate);
    b.copyToChannel(d, 0);
    return b;
  }

  setShipState(s: Partial<ShipState>) {
    if (typeof s.throttle === 'number') this.state.throttle = clamp(s.throttle, 0, 1);
    if (typeof s.speed === 'number') this.state.speed = clamp(s.speed, 0, 1);
    if (typeof s.warp === 'number') this.state.warp = clamp(s.warp, 0, 1);
    this.apply(false);
  }

  /** Turn the whole bed on/off (e.g. for menus or analysis renders). */
  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.bed && this.eng) this.bed.gain.setTargetAtTime(on ? 1 : 0, this.eng.ctx.currentTime, 0.4);
  }

  private apply(immediate: boolean) {
    const eng = this.eng;
    if (!eng || !this.humLP) return;
    const t = eng.ctx.currentTime;
    const { throttle, speed, warp } = this.state;
    const set = (p: AudioParam, v: number, tau: number) => (immediate ? p.setValueAtTime(v, t) : p.setTargetAtTime(v, t, tau));
    const energy = 0.6 * speed + 0.4 * throttle;
    set(this.humLP.frequency, 100 + 140 * energy + 60 * warp, 0.6);
    set(this.humG!.gain, AMB_LEVEL.hum * (1 + 0.5 * energy), 0.6);
    const f0 = 46.5 * (1 + 0.1 * speed + 0.05 * throttle + 0.08 * warp);
    [1, 2.004, 3.01].forEach((h, i) => set(this.drone[i].frequency, f0 * h, 0.8));
    set(this.droneG!.gain, AMB_LEVEL.drone * (1 + 0.6 * energy), 0.6);
    set(this.ventG!.gain, AMB_LEVEL.vent * (1 + 0.25 * throttle), 1.0);
    set(this.warpLP!.frequency, 45 + 230 * warp, 0.4);
    set(this.warpG!.gain, AMB_LEVEL.warp * warp * warp, 0.35);
    set(this.sub!.frequency, 28 + 14 * warp, 0.5);
    set(this.subG!.gain, AMB_LEVEL.sub * warp, 0.4);
    set(this.whooshBP!.frequency, 250 + 2600 * warp * warp, 0.3);
    set(this.whooshG!.gain, AMB_LEVEL.whoosh * Math.pow(warp, 1.5), 0.3);
  }

  private update(now: number) {
    const eng = this.eng;
    if (!eng || !this.enabled) return;
    if (now < this.nextEvent) return;
    // a soft creak or a thermal tick somewhere in the cabin
    this.nextEvent = now + 14 + Math.random() * 30;
    const isCreak = Math.random() < 0.45;
    const list = isCreak ? this.creaks : this.ticks;
    const buf = list[Math.floor(Math.random() * list.length)];
    const ctx = eng.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const g = ctx.createGain();
    g.gain.value = (isCreak ? AMB_LEVEL.creak : AMB_LEVEL.tick) * (0.5 + Math.random() * 0.5);
    const pan = eng.makePanner({ refDistance: 0.8, rolloffFactor: 0.8 });
    const a = Math.random() * Math.PI * 2;
    placePannerNow(pan, [Math.cos(a) * (0.8 + Math.random()), 0.4 + Math.random() * 1.8, Math.sin(a) * (0.8 + Math.random())]);
    src.connect(g).connect(pan).connect(this.bed!);
    const nodes: AudioNode[] = [src, g, pan];
    eng.stats.addNodes(nodes.length);
    src.onended = () => {
      for (const n of nodes) safeDisconnect(n);
      eng.stats.removeNodes(nodes.length);
    };
    src.start(now + 0.05);
  }

  dispose() {
    for (const s of this.srcs) safeStop(s);
    for (const n of this.nodes) safeDisconnect(n);
    this.eng?.stats.removeNodes(this.nodes.length);
    this.nodes = [];
    this.srcs = [];
  }
}

function placePannerNow(p: PannerNode, pos: readonly number[]) {
  const pp = p as PannerNode & { positionX?: AudioParam };
  if (pp.positionX) {
    p.positionX.value = pos[0];
    p.positionY.value = pos[1];
    p.positionZ.value = pos[2];
  } else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos[0], pos[1], pos[2]);
}
