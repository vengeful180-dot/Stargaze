// The audio engine: master bus, room reverb, listener, volume groups and the scheduler tick.
// Works with a realtime AudioContext or an OfflineAudioContext (same graph, same code path).
import { renderRoomIR } from './room';
import { SampleBank } from './synth/bank';
import type { Vec3, Volumes } from './types';
import { NodeStats, setParam, sliderGain, softClipCurve } from './util';

export type Ticker = (now: number, horizon: number) => void;

/** 'high': HRTF panning, full room, chorus, 28 voices. 'low' (phones / weak CPUs): equal-power panning,
 * a shorter room, no Rhodes chorus, 18 voices. */
export type AudioQuality = 'high' | 'low';

export class Engine {
  readonly ctx: BaseAudioContext;
  readonly stats = new NodeStats();
  readonly bank: SampleBank;
  /** everything audible sums here */
  readonly master: GainNode;
  readonly masterVol: GainNode;
  /** final node (connected to ctx.destination unless an offline harness reroutes it) */
  readonly out: AudioNode;
  readonly roomIn: GainNode;
  readonly roomOut: GainNode;
  readonly musicVol: GainNode;
  readonly ambVol: GainNode;
  readonly sfxVol: GainNode;
  readonly offline: boolean;
  readonly quality: AudioQuality;
  /** synth polyphony limit */
  readonly maxVoices: number;
  /** seconds scheduled ahead of currentTime */
  lookahead = 0.2;
  hiddenLookahead = 1.6;
  listener = { pos: [0, 1.15, 0] as Vec3, fwd: [0, 0, -1] as Vec3, up: [0, 1, 0] as Vec3 };
  private tickers: Ticker[] = [];
  private vols = { master: 1, music: 1, ambience: 1, sfx: 1 };
  private hasListenerParams: boolean;

  constructor(ctx: BaseAudioContext, opts: { offline?: boolean; quality?: AudioQuality } = {}) {
    this.ctx = ctx;
    this.offline = !!opts.offline;
    this.quality = opts.quality ?? 'high';
    this.maxVoices = this.quality === 'low' ? 18 : 28;
    this.bank = new SampleBank(ctx);

    this.master = ctx.createGain();
    this.masterVol = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    const pre = ctx.createGain();
    pre.gain.value = 0.5;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve(0.8, 0.88, 2);
    clip.oversample = '2x';
    this.master.connect(this.masterVol).connect(limiter).connect(pre).connect(clip);
    this.out = clip;
    clip.connect(ctx.destination);

    // cabin room
    const conv = ctx.createConvolver();
    conv.normalize = false;
    const [l, r] = renderRoomIR(ctx.sampleRate, this.quality === 'low' ? { rt60: 0.45 } : {});
    const ir = ctx.createBuffer(2, l.length, ctx.sampleRate);
    ir.copyToChannel(l, 0);
    ir.copyToChannel(r, 1);
    conv.buffer = ir;
    this.roomIn = ctx.createGain();
    this.roomOut = ctx.createGain();
    this.roomOut.gain.value = 1;
    this.roomIn.connect(conv).connect(this.roomOut).connect(this.master);

    this.musicVol = ctx.createGain();
    this.ambVol = ctx.createGain();
    this.sfxVol = ctx.createGain();
    this.ambVol.connect(this.master);
    this.sfxVol.connect(this.master);
    // ambience and SFX live in the same room (sends are post-volume so the sliders scale the reverb too)
    const ambRoom = ctx.createGain();
    ambRoom.gain.value = 0.25;
    this.ambVol.connect(ambRoom).connect(this.roomIn);
    const sfxRoom = ctx.createGain();
    sfxRoom.gain.value = 0.35;
    this.sfxVol.connect(sfxRoom).connect(this.roomIn);
    // music routing (direct + room) is done by the radio, which owns the speaker position

    const L = ctx.listener as AudioListener & { positionX?: AudioParam };
    this.hasListenerParams = !!L.positionX;
    this.applyListener(true);
    this.applyVolumes(true);
  }

  onTick(fn: Ticker) {
    this.tickers.push(fn);
  }

  /** Called by the clock (worker in realtime, suspend points offline). */
  tick() {
    const now = this.ctx.currentTime;
    const hidden = !this.offline && typeof document !== 'undefined' && document.hidden;
    const horizon = now + (hidden ? this.hiddenLookahead : this.lookahead);
    for (const t of this.tickers) {
      try {
        t(now, horizon);
      } catch (e) {
        console.error('[audio] tick failed', e);
      }
    }
    // render upcoming instrument samples in small slices so the main thread never stalls
    this.bank.work(this.offline ? Infinity : 4);
  }

  setVolumes(v: Volumes) {
    for (const k of ['master', 'music', 'ambience', 'sfx'] as const) {
      const x = v[k];
      if (typeof x === 'number' && Number.isFinite(x)) this.vols[k] = Math.max(0, Math.min(1, x));
    }
    this.applyVolumes(false);
  }

  private applyVolumes(immediate: boolean) {
    const set = (p: AudioParam, v: number) => (immediate ? (p.value = v) : setParam(p, v, this.ctx, 0.05));
    set(this.masterVol.gain, sliderGain(this.vols.master));
    set(this.musicVol.gain, sliderGain(this.vols.music));
    set(this.ambVol.gain, sliderGain(this.vols.ambience));
    set(this.sfxVol.gain, sliderGain(this.vols.sfx));
  }

  get volumes() {
    return { ...this.vols };
  }

  setListener(pos: readonly number[], fwd: readonly number[], up: readonly number[]) {
    const l = this.listener;
    l.pos = [pos[0], pos[1], pos[2]];
    l.fwd = [fwd[0], fwd[1], fwd[2]];
    l.up = [up[0], up[1], up[2]];
    this.applyListener(false);
  }

  private applyListener(immediate: boolean) {
    const L = this.ctx.listener;
    const { pos, fwd, up } = this.listener;
    if (this.hasListenerParams) {
      const t = this.ctx.currentTime;
      const params: [AudioParam, number][] = [
        [L.positionX, pos[0]], [L.positionY, pos[1]], [L.positionZ, pos[2]],
        [L.forwardX, fwd[0]], [L.forwardY, fwd[1]], [L.forwardZ, fwd[2]],
        [L.upX, up[0]], [L.upY, up[1]], [L.upZ, up[2]],
      ];
      for (const [p, v] of params) {
        if (immediate) p.value = v;
        else if (Math.abs(p.value - v) > 1e-4) p.setTargetAtTime(v, t, 0.02);
      }
    } else {
      // Firefox: no AudioParams on the listener
      const anyL = L as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void };
      anyL.setPosition(pos[0], pos[1], pos[2]);
      anyL.setOrientation(fwd[0], fwd[1], fwd[2], up[0], up[1], up[2]);
    }
  }

  /** A positional source in the cabin (HRTF), routed into `dest`. */
  makePanner(opts: Partial<PannerOptions> = {}): PannerNode {
    const p = this.ctx.createPanner();
    p.panningModel = this.quality === 'low' ? 'equalpower' : 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = opts.refDistance ?? 0.6;
    p.maxDistance = opts.maxDistance ?? 30;
    p.rolloffFactor = opts.rolloffFactor ?? 0.9;
    p.coneInnerAngle = opts.coneInnerAngle ?? 360;
    p.coneOuterAngle = opts.coneOuterAngle ?? 360;
    p.coneOuterGain = opts.coneOuterGain ?? 1;
    return p;
  }

  static placePanner(p: PannerNode, pos: readonly number[], fwd: readonly number[] | null, ctx: BaseAudioContext, immediate = false) {
    const pp = p as PannerNode & { positionX?: AudioParam };
    if (pp.positionX) {
      const t = ctx.currentTime;
      const set = (a: AudioParam, v: number) => (immediate ? (a.value = v) : a.setTargetAtTime(v, t, 0.02));
      set(p.positionX, pos[0]);
      set(p.positionY, pos[1]);
      set(p.positionZ, pos[2]);
      if (fwd) {
        set(p.orientationX, fwd[0]);
        set(p.orientationY, fwd[1]);
        set(p.orientationZ, fwd[2]);
      }
    } else {
      const anyP = p as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(x: number, y: number, z: number): void };
      anyP.setPosition(pos[0], pos[1], pos[2]);
      if (fwd) anyP.setOrientation(fwd[0], fwd[1], fwd[2]);
    }
  }
}
