// A Band performs one composed track: it owns the instrument buses and effects for that track and turns
// score events into scheduled Web Audio voices. One Band per track keeps scheduling simple: skipping or
// ending a track just fades its Band out and disposes it (every node is stopped and disconnected).
import { Rng, hash } from '../../core/rng';
import type { DrumEv, FxEv, NoteEv, Score, ScoreEv, TrackPlan } from '../music/compose';
import type { DrumId } from '../music/drums';
import { type NodeStats, clamp, midiToHz, safeDisconnect, safeStop, tanhCurve, warmCurve } from '../util';
import type { SampleBank, SampledInst } from './bank';
import { type Voice, VoicePool } from './voices';

export interface BandHost {
  ctx: BaseAudioContext;
  bank: SampleBank;
  stats: NodeStats;
}

interface Waves {
  bass: PeriodicWave;
  pad: PeriodicWave;
  lead: PeriodicWave;
}
const waveCache = new WeakMap<BaseAudioContext, Waves>();
function waves(ctx: BaseAudioContext): Waves {
  let w = waveCache.get(ctx);
  if (w) return w;
  const mk = (amps: number[]) => {
    const real = new Float32Array(amps.length);
    const imag = new Float32Array(amps);
    return ctx.createPeriodicWave(real, imag);
  };
  const pad = [0];
  for (let n = 1; n <= 28; n++) pad.push(Math.pow(n, -1.35) * Math.exp(-n / 22));
  w = {
    bass: mk([0, 1, 0.5, 0.24, 0.11, 0.05, 0.02, 0.01]),
    pad: mk(pad),
    lead: mk([0, 1, 0.1, 0.11, 0.025, 0.03, 0.008, 0.008]),
  };
  waveCache.set(ctx, w);
  return w;
}

/** Instrument output levels (linear). Calibrated with tools/audio renders. */
export const MIX = {
  ep: 0.125,
  piano: 0.78,
  guitar: 0.75,
  nylonGain: 1,
  bass: 0.12,
  pad: 0.045,
  /** extra gain for pads that carry the chords (Drift) rather than a background layer */
  padChord: 2.2,
  lead: 0.11,
  bell: 0.1,
  kick: 0.23,
  snare: 0.31,
  rim: 0.28,
  snap: 0.28,
  brush: 0.46,
  hat: 0.33,
  ohat: 0.22,
  shaker: 0.2,
  crackle: 0.045,
  hiss: 0.0045,
  riser: 0.045,
  bandGain: 1,
};

/** Per-style output trim so switching stations does not jump in loudness. */
export const STYLE_GAIN: Record<string, number> = {
  'dusty-keys': 1,
  'sunday-tape': 1.06,
  'night-drive': 1,
  drift: 1.3,
  'cafe-boom-bap': 0.97,
};

const DRUM_LEVEL: Record<DrumId, number> = {
  kick: 1, snare: 1, rim: 1, snap: 1, brush: 1, hat: 1, ohat: 1, shaker: 1,
};

type Bus = 'ep' | 'piano' | 'guitar' | 'bass' | 'pad' | 'lead' | 'bell' | 'drums';

export class Band {
  readonly ctx: BaseAudioContext;
  readonly plan: TrackPlan;
  readonly out: GainNode;
  readonly t0: number;
  stopAt = Infinity;
  disposed = false;
  private mix: GainNode;
  private duck: GainNode;
  private secFilter: BiquadFilterNode;
  private flutter: ConstantSourceNode;
  private bus = {} as Record<Bus, AudioNode>;
  private fixed: AudioNode[] = [];
  private loops: AudioScheduledSourceNode[] = [];
  private voices: VoicePool;
  private cursor = 0;
  private rng: Rng;
  private filterValue = 20000;
  private fadeValue = 1;
  /** band output level (MIX.bandGain x style trim) */
  private gain = 1;
  private vibGain: GainNode | null = null;
  private lastLead: { end: number; m: number } | null = null;
  private nylon: boolean;
  private events: ScoreEv[];

  constructor(
    private host: BandHost,
    readonly score: Score,
    dest: AudioNode,
    t0: number,
  ) {
    const ctx = (this.ctx = host.ctx);
    this.plan = score.plan;
    this.t0 = t0;
    this.events = score.events;
    this.rng = new Rng(hash(this.plan.seed, 0xba4d));
    this.voices = new VoicePool(host.stats);
    this.nylon = this.plan.style === 'sunday-tape' ? this.rng.chance(0.75) : this.rng.chance(0.3);
    host.stats.bandsLive++;

    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      this.fixed.push(n);
      return n;
    };
    const filt = (type: BiquadFilterType, f: number, q = 0.707, gain = 0) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      n.gain.value = gain;
      this.fixed.push(n);
      return n;
    };
    const shaper = (curve: Float32Array<ArrayBuffer>, os: OverSampleType = '2x') => {
      const n = ctx.createWaveShaper();
      n.curve = curve;
      n.oversample = os;
      this.fixed.push(n);
      return n;
    };
    const lfo = (rate: number, depth: number, target: AudioParam, type: OscillatorType = 'sine') => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = rate;
      const d = g(depth);
      o.connect(d).connect(target);
      this.fixed.push(o);
      this.loops.push(o);
      return o;
    };

    // ---- master section of the band ----
    this.out = g(1);
    this.out.connect(dest);
    this.gain = MIX.bandGain * (STYLE_GAIN[this.plan.style] ?? 1);
    this.mix = g(this.gain);
    const tape = shaper(tanhCurve(1.25));
    this.secFilter = filt('lowpass', 20000, 0.75);
    const sum = g(1);
    this.duck = g(1);
    this.duck.connect(sum);
    const subShelf = filt('lowshelf', 75, 0.7, -3);
    sum.connect(subShelf).connect(this.secFilter).connect(tape).connect(this.mix).connect(this.out);

    // ---- wow & flutter: one shared pitch bus for every source of the track ----
    this.flutter = ctx.createConstantSource();
    this.flutter.offset.value = 0;
    this.fixed.push(this.flutter);
    this.loops.push(this.flutter);
    const w = this.plan.tex.wow;
    lfo(this.rng.range(0.45, 0.75), 6.5 * w, this.flutter.offset);
    lfo(this.rng.range(0.11, 0.17), 4 * w, this.flutter.offset);
    lfo(this.rng.range(5.5, 7.2), 1.4 * w, this.flutter.offset);
    // two slow incommensurate LFOs make the drift irregular
    lfo(this.rng.range(0.06, 0.08), 3 * w, this.flutter.offset);
    lfo(this.rng.range(0.26, 0.33), 2 * w, this.flutter.offset);

    // ---- instrument buses ----
    const used = new Set<string>();
    for (const e of this.events) if (e.k === 'n') used.add(e.inst);
    const toDuck = (n: AudioNode) => n.connect(this.duck);

    if (used.has('ep')) {
      const inp = g(1);
      const drive = shaper(warmCurve(this.plan.wurli ? 2.0 : 1.4, 0.1));
      const shelf = filt('lowshelf', 220, 0.7, 2.5);
      const lp = filt('lowpass', this.plan.wurli ? 5000 : 4600, 0.6);
      const pan = ctx.createStereoPanner();
      this.fixed.push(pan);
      lfo(this.rng.range(1.8, 3.6), this.rng.range(0.3, 0.55), pan.pan);
      inp.connect(drive).connect(shelf).connect(lp).connect(pan);
      const outN = g(1);
      pan.connect(outN);
      // stereo chorus
      const dl = ctx.createDelay(0.05);
      const dr = ctx.createDelay(0.05);
      dl.delayTime.value = 0.012;
      dr.delayTime.value = 0.017;
      this.fixed.push(dl, dr);
      lfo(0.43, 0.0016, dl.delayTime);
      lfo(0.31, 0.0021, dr.delayTime);
      const merge = ctx.createChannelMerger(2);
      this.fixed.push(merge);
      pan.connect(dl);
      pan.connect(dr);
      dl.connect(merge, 0, 0);
      dr.connect(merge, 0, 1);
      const wet = g(0.32);
      merge.connect(wet).connect(outN);
      toDuck(outN);
      this.bus.ep = inp;
    }
    if (used.has('piano')) {
      const inp = g(1);
      const shelf = filt('lowshelf', 180, 0.7, 1.5);
      const lp = filt('lowpass', 5200, 0.6);
      inp.connect(shelf).connect(lp);
      toDuck(lp);
      this.bus.piano = inp;
    }
    if (used.has('guitar')) {
      const inp = g(1);
      const lp = filt('lowpass', 6000, 0.6);
      const hp = filt('highpass', 90, 0.7);
      inp.connect(hp).connect(lp);
      toDuck(lp);
      this.bus.guitar = inp;
    }
    if (used.has('bass')) {
      const inp = g(1);
      const sat = shaper(warmCurve(1.6, 0.15));
      const lp = filt('lowpass', 950, 0.55);
      const hp = filt('highpass', 32, 0.7);
      inp.connect(sat).connect(lp).connect(hp);
      toDuck(hp);
      this.bus.bass = inp;
    }
    if (used.has('pad')) {
      const inp = g(1);
      const lp = filt('lowpass', this.rng.range(1300, 2000), 0.5);
      lfo(0.06, 280, lp.frequency);
      inp.connect(lp);
      toDuck(lp);
      this.bus.pad = inp;
    }
    if (used.has('lead')) {
      const inp = g(1);
      const lp = filt('lowpass', 3800, 0.6);
      inp.connect(lp);
      toDuck(lp);
      this.bus.lead = inp;
      // vibrato: LFO -> depth gain (automated per note) -> each lead oscillator's detune
      const vl = ctx.createOscillator();
      vl.frequency.value = this.rng.range(4.8, 5.6);
      this.fixed.push(vl);
      this.loops.push(vl);
      this.vibGain = g(0);
      vl.connect(this.vibGain);
    }
    if (used.has('bell')) {
      const inp = g(1);
      const lp = filt('lowpass', 6500, 0.6);
      if (this.plan.bell === 'vibes') {
        const trem = g(0.86);
        lfo(this.rng.range(4.6, 5.8), 0.14, trem.gain);
        inp.connect(trem).connect(lp);
      } else inp.connect(lp);
      toDuck(lp);
      this.bus.bell = inp;
    }
    // drums: own bus, not ducked
    {
      const inp = g(1);
      const hp = filt('highpass', 30, 0.7);
      const lp = filt('lowpass', this.plan.drums === 'crisp' ? 9000 : this.rng.range(7000, 8200), 0.6);
      const sat = shaper(warmCurve(1.3, 0.05));
      inp.connect(hp).connect(lp).connect(sat).connect(sum);
      this.bus.drums = inp;
    }

    // ---- record texture: crackle + tape hiss (after the section filter, before the player fade) ----
    {
      const cr = ctx.createBufferSource();
      cr.buffer = host.bank.crackle();
      cr.loop = true;
      cr.playbackRate.value = this.rng.range(0.94, 1.06);
      const cg = g(MIX.crackle * this.plan.tex.crackle);
      cr.connect(cg).connect(this.out);
      const hs = ctx.createBufferSource();
      hs.buffer = host.bank.hiss();
      hs.loop = true;
      const hg = g(MIX.hiss * this.plan.tex.hiss);
      hs.connect(hg).connect(this.out);
      this.fixed.push(cr, hs);
      this.loops.push(cr, hs);
    }

    // pre-render sampled notes this track needs
    const pn: { m: number; v: number }[] = [];
    const gn: { m: number; v: number }[] = [];
    for (const e of this.events) {
      if (e.k !== 'n') continue;
      if (e.inst === 'piano') pn.push({ m: e.m, v: e.v });
      if (e.inst === 'guitar') gn.push({ m: e.m, v: e.v });
    }
    if (pn.length) host.bank.prefetch('piano', pn);
    if (gn.length) host.bank.prefetch(this.nylon ? 'nylon' : 'guitar', gn);
    host.stats.addNodes(this.fixed.length);
  }

  /** Start the shared sources. If t0 lies in the past we join mid-track. */
  start(now: number) {
    const at = Math.max(now, this.t0);
    for (const s of this.loops) {
      if (s instanceof AudioBufferSourceNode && s.buffer && s.loop) s.start(at, this.rng.range(0, s.buffer.duration));
      else s.start(at);
    }
    if (this.t0 < now - 0.05) {
      // joining: bring FX state up to date and restart long notes that are still sounding
      this.out.gain.setValueAtTime(0, now);
      this.out.gain.setTargetAtTime(1, now, 0.12);
      while (this.cursor < this.events.length && this.t0 + this.events[this.cursor].t < now) {
        const ev = this.events[this.cursor++];
        if (ev.k === 'fx') this.applyFxNow(ev, now);
        else if (ev.k === 'n' && (ev.role === 'pad' || ev.role === 'chord' || ev.role === 'bass')) {
          const left = this.t0 + ev.t + ev.d - now;
          if (left > 0.4) this.playNote({ ...ev, d: left, v: ev.v * 0.75 }, now + 0.01, true);
        }
      }
    }
  }

  get finished() {
    return this.cursor >= this.events.length;
  }

  scheduleUntil(horizon: number) {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    const evs = this.events;
    while (this.cursor < evs.length) {
      const ev = evs[this.cursor];
      const when = this.t0 + ev.t;
      if (when >= horizon || when >= this.stopAt) break;
      this.cursor++;
      if (when < now - 0.03) {
        if (ev.k === 'fx') this.applyFxNow(ev, now);
        continue;
      }
      const t = Math.max(when, now);
      if (ev.k === 'n') this.playNote(ev, t, false);
      else if (ev.k === 'd') this.playDrum(ev, t);
      else this.playFx(ev, t);
    }
    this.voices.sweep(now);
  }

  /** Fade the band out from `at` and stop scheduling; dispose() once silent. */
  stop(at: number, fade = 0.4) {
    if (this.stopAt <= at) return;
    this.stopAt = at;
    const p = this.out.gain;
    try {
      p.cancelScheduledValues(at);
      p.setTargetAtTime(0, at, Math.max(0.01, fade / 4));
    } catch {
      /* ignore */
    }
  }

  /** Tape-stop the whole band (used when the player skips a track). */
  tapeStop(at: number, dur = 0.7) {
    this.flutter.offset.cancelScheduledValues(at);
    this.flutter.offset.setValueAtTime(0, at);
    this.flutter.offset.linearRampToValueAtTime(-2400, at + dur);
    this.stop(at + dur * 0.15, dur);
  }

  get stopDone() {
    return this.ctx.currentTime > this.stopAt + 0.6;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const now = this.ctx.currentTime;
    this.voices.stopAll(now);
    this.voices.releaseAll();
    for (const s of this.loops) safeStop(s);
    for (const n of this.fixed) safeDisconnect(n);
    this.host.stats.removeNodes(this.fixed.length);
    this.host.stats.bandsLive--;
    this.fixed = [];
    this.loops = [];
  }

  get liveVoices() {
    return this.voices.size;
  }

  // ------------------------------------------------------------------------------------------------

  private flut(src: AudioScheduledSourceNode & { detune?: AudioParam }, v: Voice) {
    const p = src.detune;
    if (!p) return;
    this.flutter.connect(p);
    v.mods.push({ from: this.flutter, param: p });
  }

  /** `audible` = when the voice has decayed below ~-26 dB (used for the polyphony count; sources stop later). */
  private newVoice(start: number, end: number, prio: number, counted = true, audible = end): Voice {
    if (counted) this.voices.makeRoom(start);
    return { start, end, audible: Math.min(end, audible), prio, counted, nodes: [], srcs: [], env: [], mods: [], done: false };
  }

  private playNote(ev: NoteEv, when: number, join: boolean) {
    switch (ev.inst) {
      case 'ep':
        return this.ep(ev, when, join);
      case 'piano':
        return this.sampled('piano', ev, when, join);
      case 'guitar':
        return this.sampled(this.nylon ? 'nylon' : 'guitar', ev, when, join);
      case 'bass':
        return this.bassNote(ev, when, join);
      case 'pad':
        return this.padNote(ev, when, join);
      case 'lead':
        return this.leadNote(ev, when);
      case 'bell':
        return this.bellNote(ev, when);
    }
  }

  private ep(ev: NoteEv, when: number, join: boolean) {
    const ctx = this.ctx;
    const f = midiToHz(ev.m);
    const vel = ev.v;
    const wurli = this.plan.wurli;
    const hiF = Math.min(1.25, Math.pow(261.6 / f, 0.3));
    const v2 = vel * vel;
    const idx0 = (wurli ? 1.4 + 2.3 * v2 : 0.8 + 2.2 * v2) * hiF;
    const idxS = (wurli ? 0.55 : 0.42) * hiF;
    const tauI = (wurli ? 0.16 : 0.3) * Math.pow(261.6 / f, 0.25);
    const peak = MIX.ep * (0.22 + 0.78 * Math.pow(vel, 1.4));
    const tSlow = clamp(3.2 * Math.pow(261.6 / f, 0.55), 0.9, 5) * (wurli ? 0.55 : 1);
    const off = when + ev.d;
    const rel = 0.075;
    const end = off + rel * 8;
    const v = this.newVoice(when, end, 2, true, off + rel * 3);
    const car = ctx.createOscillator();
    car.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.frequency.value = f;
    mod.detune.value = this.rng.range(-1.2, 1.2);
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(idx0 * f, when);
    mg.gain.setTargetAtTime(idxS * f, when, tauI);
    mod.connect(mg).connect(car.frequency);
    const amp = ctx.createGain();
    const atk = join ? 0.12 : 0.003;
    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(peak, when + atk);
    amp.gain.setTargetAtTime(peak * 0.55, when + atk, 0.3);
    if (off > when + 0.52) amp.gain.setTargetAtTime(0, when + 0.5, tSlow);
    amp.gain.setTargetAtTime(0, Math.max(off, when + atk), rel);
    car.connect(amp).connect(this.bus.ep);
    // tine: a short bright partial for the attack
    const k = clamp(Math.round(2800 / f), 3, 14);
    const tine = ctx.createOscillator();
    tine.frequency.value = f * k;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, when);
    tg.gain.linearRampToValueAtTime(join ? 0 : peak * (wurli ? 0.1 : 0.15) * (0.4 + vel), when + 0.0012);
    tg.gain.setTargetAtTime(0, when + 0.0012, wurli ? 0.008 : 0.012);
    tine.connect(tg).connect(this.bus.ep);
    for (const o of [mod, car, tine]) this.flut(o, v);
    mod.start(when);
    car.start(when);
    tine.start(when);
    tine.stop(when + 0.25);
    mod.stop(end);
    car.stop(end);
    v.nodes.push(mod, mg, car, amp, tine, tg);
    v.srcs.push(tine, mod, car);
    v.env.push(amp.gain);
    this.voices.add(v);
  }

  private sampled(inst: SampledInst, ev: NoteEv, when: number, join: boolean) {
    const ctx = this.ctx;
    const { buffer, rate } = this.host.bank.note(inst, ev.m, ev.v);
    const vel = ev.v;
    const isPiano = inst === 'piano';
    const off = when + ev.d;
    const rel = isPiano ? 0.11 : 0.14;
    const natural = when + buffer.duration / rate;
    const end = Math.min(natural, off + rel * 7);
    const v = this.newVoice(when, end, isPiano ? 2 : 1, true, Math.min(natural, off + rel * 3));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = isPiano ? 2600 + 6000 * vel * vel : 1400 + 6500 * Math.pow(vel, 1.5);
    lp.Q.value = 0.5;
    const amp = ctx.createGain();
    const level = (isPiano ? MIX.piano : MIX.guitar * (inst === 'nylon' ? MIX.nylonGain : 1)) * Math.pow(vel, isPiano ? 1.25 : 1.15);
    amp.gain.setValueAtTime(join ? 0 : level, when);
    if (join) amp.gain.setTargetAtTime(level, when, 0.05);
    if (off < natural) amp.gain.setTargetAtTime(0, off, rel);
    src.connect(lp).connect(amp).connect(this.bus[isPiano ? 'piano' : 'guitar']);
    this.flut(src, v);
    src.start(when, join ? 0.05 : 0);
    src.stop(end + 0.02);
    v.nodes.push(src, lp, amp);
    v.srcs.push(src);
    v.env.push(amp.gain);
    this.voices.add(v);
  }

  private bassNote(ev: NoteEv, when: number, join: boolean) {
    const ctx = this.ctx;
    const f = midiToHz(ev.m);
    const vel = ev.v;
    const off = when + ev.d;
    const rel = 0.05;
    const end = off + rel * 8;
    const v = this.newVoice(when, end, 4, true, off + rel * 3);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(waves(ctx).bass);
    osc.frequency.value = f;
    if (ev.slide) {
      osc.detune.setValueAtTime(ev.slide * 100, when);
      osc.detune.setTargetAtTime(0, when + 0.01, 0.035);
    }
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(700 + 1500 * vel, when);
    lp.frequency.setTargetAtTime(360, when, 0.09);
    const amp = ctx.createGain();
    const peak = MIX.bass * (0.45 + 0.55 * vel);
    const atk = join ? 0.1 : 0.007;
    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(peak, when + atk);
    amp.gain.setTargetAtTime(peak * 0.62, when + atk, 0.2);
    if (off > when + 0.6) amp.gain.setTargetAtTime(peak * 0.25, when + 0.6, 1.4);
    amp.gain.setTargetAtTime(0, Math.max(off, when + atk), rel);
    osc.connect(lp).connect(amp).connect(this.bus.bass);
    this.flut(osc, v);
    osc.start(when);
    osc.stop(end);
    v.nodes.push(osc, lp, amp);
    v.srcs.push(osc);
    v.env.push(amp.gain);
    this.voices.add(v);
  }

  private padNote(ev: NoteEv, when: number, join: boolean) {
    const ctx = this.ctx;
    const f = midiToHz(ev.m);
    const off = when + ev.d;
    const rel = 0.55;
    const end = off + rel * 7;
    const v = this.newVoice(when, end, 0, true, off + rel * 2.5);
    const peak = MIX.pad * ev.v * (ev.role === 'chord' ? MIX.padChord : 1);
    const atk = join ? 0.25 : this.plan.style === 'drift' ? 0.6 : 0.4;
    const w = waves(ctx).pad;
    const merge = ctx.createChannelMerger(2);
    for (let s = 0; s < 2; s++) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(w);
      o.frequency.value = f;
      o.detune.value = (s === 0 ? -1 : 1) * this.rng.range(4, 8);
      const a = ctx.createGain();
      a.gain.setValueAtTime(0, when);
      a.gain.setTargetAtTime(peak, when, atk);
      a.gain.setTargetAtTime(0, off, rel);
      o.connect(a).connect(merge, 0, s);
      this.flut(o, v);
      o.start(when);
      o.stop(end);
      v.nodes.push(o, a);
      v.srcs.push(o);
      v.env.push(a.gain);
    }
    merge.connect(this.bus.pad);
    v.nodes.push(merge);
    this.voices.add(v);
  }

  private leadNote(ev: NoteEv, when: number) {
    const ctx = this.ctx;
    const f = midiToHz(ev.m);
    const off = when + ev.d;
    const rel = 0.09;
    const end = off + rel * 8;
    const v = this.newVoice(when, end, 3, true, off + rel * 3);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(waves(ctx).lead);
    osc.frequency.value = f;
    // glide from the previous note when phrased legato
    const prev = this.lastLead;
    if (prev && when - prev.end < 0.06 && Math.abs(prev.m - ev.m) <= 5 && prev.m !== ev.m) {
      osc.detune.setValueAtTime((prev.m - ev.m) * 100, when);
      osc.detune.setTargetAtTime(0, when, 0.03);
    }
    this.lastLead = { end: off, m: ev.m };
    const amp = ctx.createGain();
    const peak = MIX.lead * (0.35 + 0.65 * ev.v);
    amp.gain.setValueAtTime(0, when);
    amp.gain.setTargetAtTime(peak, when, 0.025);
    amp.gain.setTargetAtTime(peak * 0.82, when + 0.12, 0.25);
    amp.gain.setTargetAtTime(0, off, rel);
    osc.connect(amp).connect(this.bus.lead);
    // breath noise around the note
    const nz = ctx.createBufferSource();
    nz.buffer = this.host.bank.noise('white');
    nz.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(6000, f * 2.2);
    bp.Q.value = 1.1;
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, when);
    bg.gain.setTargetAtTime(peak * 0.16, when, 0.018);
    bg.gain.setTargetAtTime(peak * 0.06, when + 0.08, 0.15);
    bg.gain.setTargetAtTime(0, off, rel);
    nz.connect(bp).connect(bg).connect(this.bus.lead);
    if (this.vibGain) {
      this.vibGain.gain.setTargetAtTime(0, when, 0.03);
      this.vibGain.gain.setTargetAtTime(13, when + 0.28, 0.25);
      this.vibGain.connect(osc.detune);
      v.mods.push({ from: this.vibGain, param: osc.detune });
    }
    this.flut(osc, v);
    osc.start(when);
    osc.stop(end);
    nz.start(when, this.rng.range(0, 3));
    nz.stop(end);
    v.nodes.push(osc, amp, nz, bp, bg);
    v.srcs.push(nz, osc);
    v.env.push(amp.gain, bg.gain);
    this.voices.add(v);
  }

  private bellNote(ev: NoteEv, when: number) {
    const ctx = this.ctx;
    const f = midiToHz(ev.m);
    const kind = this.plan.bell;
    const off = when + ev.d;
    const base = kind === 'marimba' ? 0.42 : kind === 'kalimba' ? 1.0 : kind === 'glock' ? 1.4 : 1.7;
    const tau = clamp(base * Math.pow(523 / f, 0.45), 0.25, 3.2);
    // mallets ring on, but arpeggios are damped sooner so they do not pile up
    const ringFor = ev.role === 'arp' ? Math.min(tau * 1.6, 1.8) : Math.min(tau * 2.4, 3.2);
    const ring = Math.max(off + 0.25, when + ringFor);
    const end = ring + 0.1;
    const v = this.newVoice(when, end, ev.role === 'arp' ? 0 : 1, true, Math.min(ring, when + tau * 1.2));
    const peak = MIX.bell * (0.3 + 0.7 * ev.v) * (kind === 'marimba' ? 1.2 : kind === 'glock' ? 0.7 : 1);
    const partials: [number, number, number][] =
      kind === 'vibes' ? [[1, 1, tau], [4, 0.2, 0.32]] :
      kind === 'kalimba' ? [[1, 1, tau], [6.27, 0.16, 0.035]] :
      kind === 'glock' ? [[1, 1, tau], [2.76, 0.1, 0.25], [5.4, 0.04, 0.07]] :
      [[1, 1, tau], [4, 0.09, 0.05]];
    let main: OscillatorNode | null = null;
    partials.forEach(([ratio, lvl, t], i) => {
      const o = ctx.createOscillator();
      o.frequency.value = f * ratio;
      if (kind === 'kalimba' && i === 0) {
        o.detune.setValueAtTime(-9, when);
        o.detune.setTargetAtTime(0, when, 0.02);
      }
      const a = ctx.createGain();
      a.gain.setValueAtTime(0, when);
      a.gain.linearRampToValueAtTime(peak * lvl, when + (i === 0 ? 0.002 : 0.001));
      a.gain.setTargetAtTime(0, when + 0.002, t);
      // damp at the end of the ring time (vibes pedal up / hand on the bar)
      if (i === 0) a.gain.setTargetAtTime(0, ring - 0.2, 0.06);
      o.connect(a).connect(this.bus.bell);
      this.flut(o, v);
      o.start(when);
      o.stop(i === 0 ? end : Math.min(end, when + t * 9 + 0.05));
      v.nodes.push(o, a);
      if (i === 0) main = o;
      else v.srcs.push(o);
      v.env.push(a.gain);
    });
    // the longest-lived source goes last: its 'ended' event triggers cleanup
    if (main) v.srcs.push(main);
    this.voices.add(v);
  }

  private playDrum(ev: DrumEv, when: number) {
    const ctx = this.ctx;
    const crisp = this.plan.drums === 'crisp';
    const variant = this.rng.int(0, 2);
    const buffer = this.host.bank.drum(ev.drum, variant, crisp);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const amp = ctx.createGain();
    const lvl = (MIX as Record<string, number>)[ev.drum] * DRUM_LEVEL[ev.drum];
    const curve = ev.drum === 'kick' ? 1.2 : ev.drum === 'hat' || ev.drum === 'shaker' ? 1.45 : 1.3;
    amp.gain.value = lvl * Math.pow(ev.v, curve);
    src.playbackRate.value = 1 + this.rng.range(-0.012, 0.012);
    src.connect(amp).connect(this.bus.drums);
    const v = this.newVoice(when, when + buffer.duration, 5, false);
    this.flut(src, v);
    src.start(when);
    v.nodes.push(src, amp);
    v.srcs.push(src);
    this.voices.add(v);
    if (ev.drum === 'kick' && ev.v > 0.5) {
      const depth = 0.2 * ev.v;
      this.duck.gain.setTargetAtTime(1 - depth, when, 0.005);
      this.duck.gain.setTargetAtTime(1, when + 0.05, 0.11);
    }
  }

  private playFx(ev: FxEv, when: number) {
    switch (ev.fx) {
      case 'filter': {
        const f = this.secFilter.frequency;
        if (ev.dur <= 0.02) f.setValueAtTime(ev.to, when);
        else {
          f.setValueAtTime(this.filterValue, when);
          f.exponentialRampToValueAtTime(Math.max(40, ev.to), when + ev.dur);
        }
        this.filterValue = ev.to;
        break;
      }
      case 'fade': {
        const gp = this.mix.gain;
        gp.setValueAtTime(this.fadeValue * this.gain, when);
        gp.linearRampToValueAtTime(Math.max(0, ev.to) * this.gain, when + ev.dur);
        this.fadeValue = ev.to;
        break;
      }
      case 'tapestop': {
        const o = this.flutter.offset;
        o.setValueAtTime(0, when);
        o.linearRampToValueAtTime(-2800, when + ev.dur);
        const gp = this.mix.gain;
        gp.setValueAtTime(this.fadeValue * this.gain, when);
        gp.setTargetAtTime(0, when + ev.dur * 0.35, ev.dur * 0.22);
        this.fadeValue = 0;
        break;
      }
      case 'riser':
        this.riser(when, ev.dur, ev.to);
        break;
    }
  }

  private applyFxNow(ev: FxEv, now: number) {
    if (ev.fx === 'filter') {
      this.secFilter.frequency.setValueAtTime(ev.to, now);
      this.filterValue = ev.to;
    } else if (ev.fx === 'fade' || ev.fx === 'tapestop') {
      this.fadeValue = ev.fx === 'fade' ? ev.to : 0;
      this.mix.gain.setValueAtTime(this.fadeValue * this.gain, now);
    }
  }

  private riser(when: number, dur: number, level: number) {
    const ctx = this.ctx;
    const end = when + dur + 0.3;
    const v = this.newVoice(when, end, 0, false);
    const src = ctx.createBufferSource();
    src.buffer = this.host.bank.noiseStereo();
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(300, when);
    bp.frequency.exponentialRampToValueAtTime(4800, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(MIX.riser * level, when + dur * 0.92);
    g.gain.setTargetAtTime(0, when + dur * 0.92, 0.04);
    src.connect(bp).connect(g).connect(this.mix);
    src.start(when, this.rng.range(0, 2));
    src.stop(end);
    v.nodes.push(src, bp, g);
    v.srcs.push(src);
    v.env.push(g.gain);
    this.voices.add(v);
  }
}
