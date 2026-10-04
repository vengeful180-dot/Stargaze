// What you hear between stations: band-limited static with crackle bursts, a heterodyne whistle whose pitch
// follows the detuning, faint murmuring AM voices, and the radio's own very low hiss floor.
import type { Engine } from './engine';
import { safeDisconnect, safeStop } from './util';

export interface TunerLevels {
  /** 0..1 static amount */
  static: number;
  /** 0..1 whistle amount */
  whistle: number;
  whistleHz: number;
  /** 0..1 chatter amount */
  chatter: number;
  /** 0..1 floor hiss amount */
  floor: number;
}

export const TUNER_LEVEL = {
  static: 0.2,
  crackle: 0.05,
  whistle: 0.022,
  chatter: 0.09,
  floor: 0.012,
};

export class Tuner {
  readonly out: GainNode;
  private staticG: GainNode;
  private crackG: GainNode;
  private whistleG: GainNode;
  private chatterG: GainNode;
  private floorG: GainNode;
  private whistle: OscillatorNode;
  private srcs: AudioScheduledSourceNode[] = [];
  private nodes: AudioNode[] = [];
  private ctx: BaseAudioContext;
  /** static/whistle/chatter mix; detached from the speaker while silent so it costs no CPU */
  private noise: GainNode;
  private dest: AudioNode | null = null;
  private attached = false;
  private silentSince = 0;

  constructor(private eng: Engine) {
    const ctx = (this.ctx = eng.ctx);
    const bank = eng.bank;
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      this.nodes.push(g);
      return g;
    };
    const loop = (b: AudioBuffer) => {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.loop = true;
      this.srcs.push(s);
      this.nodes.push(s);
      return s;
    };
    const filt = (type: BiquadFilterType, f: number, q: number) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      this.nodes.push(n);
      return n;
    };
    this.out = gain(1);
    this.noise = gain(1);
    // static hiss
    this.staticG = gain();
    loop(bank.noise('white')).connect(filt('bandpass', 1900, 0.35)).connect(filt('lowpass', 4800, 0.6)).connect(this.staticG).connect(this.noise);
    // static crackle bursts
    this.crackG = gain();
    loop(bank.staticCrackle()).connect(this.crackG).connect(this.noise);
    // heterodyne whistle
    this.whistle = ctx.createOscillator();
    this.whistle.frequency.value = 800;
    this.srcs.push(this.whistle);
    this.nodes.push(this.whistle);
    this.whistleG = gain();
    this.whistle.connect(this.whistleG).connect(this.noise);
    // AM chatter
    this.chatterG = gain();
    loop(bank.chatter()).connect(filt('bandpass', 1100, 0.6)).connect(this.chatterG).connect(this.noise);
    // floor
    this.floorG = gain();
    loop(bank.hiss()).connect(this.floorG).connect(this.out);
    eng.stats.addNodes(this.nodes.length);
  }

  /** Route the tuner into the radio (the floor is always connected; the rest only while audible). */
  connect(dest: AudioNode) {
    this.dest = dest;
    this.out.connect(dest);
    this.noise.connect(dest);
    this.attached = true;
  }

  start(at: number) {
    for (const s of this.srcs) {
      if (s instanceof AudioBufferSourceNode && s.buffer) s.start(at, Math.random() * s.buffer.duration);
      else s.start(at);
    }
  }

  set(l: TunerLevels, tau = 0.04) {
    const t = this.ctx.currentTime;
    const audible = l.static > 0.001 || l.whistle > 0.001 || l.chatter > 0.001;
    if (audible) {
      this.silentSince = 0;
      if (!this.attached && this.dest) {
        this.noise.connect(this.dest);
        this.attached = true;
      }
    } else if (this.attached) {
      if (!this.silentSince) this.silentSince = t;
      else if (t - this.silentSince > 0.6) {
        try {
          this.noise.disconnect();
        } catch {
          /* ignore */
        }
        this.attached = false;
      }
    }
    this.staticG.gain.setTargetAtTime(TUNER_LEVEL.static * l.static, t, tau);
    this.crackG.gain.setTargetAtTime(TUNER_LEVEL.crackle * Math.pow(l.static, 1.5), t, tau);
    this.whistleG.gain.setTargetAtTime(TUNER_LEVEL.whistle * l.whistle, t, tau);
    this.whistle.frequency.setTargetAtTime(Math.max(60, Math.min(9000, l.whistleHz)), t, 0.03);
    this.chatterG.gain.setTargetAtTime(TUNER_LEVEL.chatter * l.chatter, t, tau * 2);
    this.floorG.gain.setTargetAtTime(TUNER_LEVEL.floor * l.floor, t, 0.2);
  }

  dispose() {
    for (const s of this.srcs) safeStop(s);
    for (const n of this.nodes) safeDisconnect(n);
    this.eng.stats.removeNodes(this.nodes.length);
    this.nodes = [];
    this.srcs = [];
  }
}
