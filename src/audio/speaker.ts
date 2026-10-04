// Master glue for the broadcast (gentle bus compression, soft clip, rumble filter) and the radio's
// speaker colouration: a vintage tabletop set (AGC, warm valve-ish saturation, small cabinet, paper cone).
// setCharacter() equal-power crossfades between a clean hi-fi path and the vintage path.
import { setParam, softClipCurve, warmCurve } from './util';

export class Glue {
  /** linear trim after the compressor (cancels its automatic make-up gain) */
  static TRIM = 0.7;
  readonly input: GainNode;
  readonly output: GainNode;
  readonly nodes: AudioNode[] = [];

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 2;
    comp.attack.value = 0.02;
    comp.release.value = 0.25;
    // Web Audio compressors add automatic make-up gain; take it back out so the glue only touches peaks
    const pre = ctx.createGain();
    pre.gain.value = Glue.TRIM / 2; // soft clipper curve spans +-2
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve(0.72, 0.86, 2);
    clip.oversample = '4x';
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 30;
    hp.Q.value = 0.7;
    this.output = ctx.createGain();
    this.input.connect(comp).connect(pre).connect(clip).connect(hp).connect(this.output);
    this.nodes.push(this.input, comp, pre, clip, hp, this.output);
  }
}

export class Speaker {
  readonly input: GainNode;
  readonly output: GainNode;
  private clean: GainNode;
  private vintage: GainNode;
  private ctx: BaseAudioContext;
  /** level match so the vintage path is about as loud as the clean one (measured, see tools/audio) */
  static VINTAGE_MAKEUP = 0.56;
  /** level into the valve stage */
  static DRIVE = 0.7;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    // the radio is mono: downmix whatever comes in
    this.input = ctx.createGain();
    this.input.channelCount = 1;
    this.input.channelCountMode = 'explicit';
    this.input.channelInterpretation = 'speakers';
    this.output = ctx.createGain();
    this.clean = ctx.createGain();
    this.vintage = ctx.createGain();
    this.input.connect(this.clean).connect(this.output);

    const agc = ctx.createDynamicsCompressor();
    agc.threshold.value = -22;
    agc.knee.value = 12;
    agc.ratio.value = 2;
    agc.attack.value = 0.008;
    agc.release.value = 0.35;
    const drive = ctx.createGain();
    drive.gain.value = Speaker.DRIVE;
    const valve = ctx.createWaveShaper();
    valve.curve = warmCurve(1.6, 0.14);
    valve.oversample = '2x';
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 170;
    hp.Q.value = 0.8;
    const box = ctx.createBiquadFilter();
    box.type = 'peaking';
    box.frequency.value = 260;
    box.Q.value = 1.4;
    box.gain.value = 1;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 1250;
    presence.Q.value = 0.75;
    presence.gain.value = 3.5;
    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.value = 5800;
    lp1.Q.value = 0.7;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 7500;
    lp2.Q.value = 0.5;
    const makeup = ctx.createGain();
    makeup.gain.value = Speaker.VINTAGE_MAKEUP;
    this.input.connect(agc).connect(drive).connect(valve).connect(hp).connect(box).connect(presence).connect(lp1).connect(lp2).connect(makeup).connect(this.vintage).connect(this.output);
    this.setCharacter(0.7, true);
  }

  setCharacter(c: number, immediate = false) {
    const x = Math.max(0, Math.min(1, c));
    // equal-power crossfade with a taper, so the default 0.7 is mostly the vintage speaker
    const a = (Math.pow(x, 0.65) * Math.PI) / 2;
    if (immediate) {
      this.clean.gain.value = Math.cos(a);
      this.vintage.gain.value = Math.sin(a);
    } else {
      setParam(this.clean.gain, Math.cos(a), this.ctx, 0.05);
      setParam(this.vintage.gain, Math.sin(a), this.ctx, 0.05);
    }
  }
}
