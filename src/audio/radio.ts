// The cabin radio: three bands (generative stations, the player's own "tape", internet "link"), a tuning
// dial with static between stations, a vintage speaker, and a physical position in the cabin (HRTF panner,
// distance/angle dulling and a send into the cabin room).
import { Rng, hash, hashString } from '../core/rng';
import { Engine } from './engine';
import { LinkPlayer, type LinkResult, TapeDeck } from './media';
import { Glue, Speaker } from './speaker';
import { StationPlayer, makeStations, stationOffset } from './stations';
import { Tuner } from './tuner';
import { type RadioBand, type RadioInfo, STYLE_LABELS, type StationDef, type Vec3 } from './types';
import { clamp, setParam, sliderGain, smoothstep, vecDot, vecLen, vecNorm, vecSub } from './util';

interface RadioNodes {
  stationsIn: GainNode;
  glue: Glue;
  mixTap: GainNode;
  mediaIn: GainNode;
  speaker: Speaker;
  warm: BiquadFilterNode;
  power: GainNode;
  knob: GainNode;
  analyser: AnalyserNode;
  out: GainNode;
  direct: BiquadFilterNode;
  panner: PannerNode;
  roomSend: GainNode;
}

interface DialAnim {
  t0: number;
  dur: number;
  from: number;
  via1: number;
  via2: number;
  to: number;
}

export const DIAL_MIN = 87.5;
export const DIAL_MAX = 108.5;
/** Output makeup so the radio sits near -18 LUFS at the default knob and listening position. */
export const RADIO_GAIN = 1.57;
/** Level trim for the player's own (already mastered) music. */
export const MEDIA_TRIM = 0.42;
export const ROOM_SEND = 0.3;

/** Reception vs dial offset (MHz): locked within 50 kHz, gone beyond ~250 kHz. */
export function signalAt(delta: number): number {
  const d = Math.abs(delta);
  if (d <= 0.05) return 1;
  const x = (d - 0.05) / 0.085;
  return Math.exp(-x * x);
}

export class Radio {
  private _on = true;
  private _band: RadioBand = 'stations';
  private volume = 0.75;
  private character = 0.7;
  private dial = 96.5;
  private dialTarget = 96.5;
  private anim: DialAnim | null = null;
  private stations: StationDef[] = [];
  private epochs: number[] = [];
  private players: (StationPlayer | null)[] = [];
  private retired: StationPlayer[] = [];
  private pos: Vec3 = [0.55, 0.85, -0.75];
  private fwd: Vec3 = vecNorm([-0.55, 0.2, 0.8]);
  private eng: Engine | null = null;
  private n: RadioNodes | null = null;
  private tuner: Tuner | null = null;
  private tape = new TapeDeck();
  private link = new LinkPlayer();
  private subs = new Set<(i: RadioInfo) => void>();
  private lastInfo = -1;
  private lastTick = -1;
  private burstUntil = 0;
  private offSince = -1;
  private phantoms: number[] = [];
  private dirCut = 20000;
  private timeBuf: Float32Array<ArrayBuffer> | null = null;
  private infoDirty = true;

  get on() {
    return this._on;
  }
  get band() {
    return this._band;
  }
  get frequency() {
    return this.dial;
  }
  get stationList(): readonly StationDef[] {
    return this.stations;
  }

  // ------------------------------------------------------------------------------------------ setup

  /** Build the radio's audio graph (called by AudioSystem.unlock, or by the offline renderer). */
  attach(eng: Engine) {
    if (this.eng) return;
    this.eng = eng;
    const ctx = eng.ctx;
    const stationsIn = ctx.createGain();
    const glue = new Glue(ctx);
    const mixTap = ctx.createGain();
    const mediaIn = ctx.createGain();
    mediaIn.gain.value = MEDIA_TRIM;
    const speaker = new Speaker(ctx);
    speaker.setCharacter(this.character, true);
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = this._on ? 20000 : 300;
    warm.Q.value = 0.6;
    const power = ctx.createGain();
    power.gain.value = this._on ? 1 : 0;
    const knob = ctx.createGain();
    knob.gain.value = sliderGain(this.volume);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.6;
    const out = ctx.createGain();
    out.gain.value = RADIO_GAIN;
    const direct = ctx.createBiquadFilter();
    direct.type = 'lowpass';
    direct.frequency.value = 20000;
    direct.Q.value = 0.5;
    const panner = eng.makePanner({ refDistance: 0.6, rolloffFactor: 0.9, coneInnerAngle: 150, coneOuterAngle: 320, coneOuterGain: 0.6 });
    Engine.placePanner(panner, this.pos, this.fwd, ctx, true);
    const roomSend = ctx.createGain();
    roomSend.gain.value = ROOM_SEND;

    stationsIn.connect(glue.input);
    glue.output.connect(mixTap).connect(speaker.input);
    mediaIn.connect(speaker.input);
    speaker.output.connect(warm).connect(power).connect(knob);
    knob.connect(analyser);
    knob.connect(out).connect(eng.musicVol);
    eng.musicVol.connect(direct).connect(panner).connect(eng.master);
    eng.musicVol.connect(roomSend).connect(eng.roomIn);
    this.n = { stationsIn, glue, mixTap, mediaIn, speaker, warm, power, knob, analyser, out, direct, panner, roomSend };
    eng.stats.addNodes(13 + glue.nodes.length);

    this.tuner = new Tuner(eng);
    this.tuner.out.connect(speaker.input);
    this.tuner.start(ctx.currentTime);
    this.tape.attach(ctx, mediaIn);
    this.link.attach(ctx, mediaIn);

    if (this.stations.length === 0) this.setStations(makeStations(hashString('stargaze')));
    else this.resetEpochs(ctx.currentTime, true);
    if (this._on) {
      // valve warm-up when the radio first comes on
      const t = ctx.currentTime;
      power.gain.setValueAtTime(0, t);
      power.gain.setTargetAtTime(1, t + 0.1, 0.42);
      warm.frequency.setValueAtTime(400, t);
      warm.frequency.setTargetAtTime(20000, t + 0.1, 0.55);
      this.burstUntil = t + 0.8;
    }
    eng.onTick((now, horizon) => this.update(now, horizon));
  }

  /** Broadcast mix before the radio (for analysis / offline capture). */
  get mixTap(): AudioNode | null {
    return this.n?.mixTap ?? null;
  }

  // ------------------------------------------------------------------------------------------ controls

  setPosition(pos: readonly number[], forward: readonly number[]) {
    this.pos = [pos[0], pos[1], pos[2]];
    this.fwd = vecNorm(forward);
    if (this.n && this.eng) Engine.placePanner(this.n.panner, this.pos, this.fwd, this.eng.ctx);
  }

  setPower(on: boolean) {
    if (on === this._on) return;
    this._on = on;
    this.infoDirty = true;
    const eng = this.eng;
    if (!eng || !this.n) return;
    const t = eng.ctx.currentTime;
    const { power, warm } = this.n;
    if (on) {
      this.offSince = -1;
      power.gain.setTargetAtTime(1, t + 0.12, 0.42);
      warm.frequency.setTargetAtTime(20000, t + 0.12, 0.55);
      this.burstUntil = t + 0.9;
      if (this._band === 'tape') this.tape.play();
      if (this._band === 'link') this.link.resume();
    } else {
      this.offSince = t;
      power.gain.setTargetAtTime(0, t, 0.05);
      warm.frequency.setTargetAtTime(300, t, 0.08);
      this.tape.pause();
      this.link.pause();
    }
    this.syncDirectVolume();
  }

  /** The radio's own volume knob, 0..1. */
  setVolume(v: number) {
    this.volume = clamp(v, 0, 1);
    if (this.n && this.eng) setParam(this.n.knob.gain, sliderGain(this.volume), this.eng.ctx, 0.04);
    this.syncDirectVolume();
  }

  /** 0 = clean hi-fi, 1 = full vintage speaker. */
  setCharacter(amount: number) {
    this.character = clamp(amount, 0, 1);
    this.n?.speaker.setCharacter(this.character);
  }

  setStations(list: StationDef[]) {
    const sorted = [...list].sort((a, b) => a.freq - b.freq);
    const eng = this.eng;
    this.phantoms = this.makePhantoms(sorted);
    if (!eng) {
      this.stations = sorted;
      this.dial = this.dialTarget = sorted[0]?.freq ?? 96.5;
      return;
    }
    const now = eng.ctx.currentTime;
    for (const p of this.players) if (p) {
      p.deactivate(now);
      this.retired.push(p);
    }
    this.stations = sorted;
    this.players = sorted.map(() => null);
    const target = this.nearestIndex(this.dial);
    this.resetEpochs(now, false, target);
    if (target >= 0) this.animateTo(sorted[target].freq, now);
    this.infoDirty = true;
  }

  private resetEpochs(now: number, fresh: boolean, freshIndex = -1) {
    const idx = freshIndex >= 0 ? freshIndex : this.nearestIndex(this.dial);
    this.epochs = this.stations.map((d, i) => (i === idx ? now + (fresh ? 0.3 : 1.0) : now - stationOffset(d)));
    this.players = this.stations.map(() => null);
  }

  /** Move the dial (MHz). Between stations you hear static; the signal fades in near a station. */
  tune(freq: number) {
    this.anim = null;
    this.dialTarget = clamp(freq, DIAL_MIN, DIAL_MAX);
    if (!this.eng) this.dial = this.dialTarget;
    this.infoDirty = true;
  }

  nextStation() {
    this.stepStation(1);
  }

  prevStation() {
    this.stepStation(-1);
  }

  private stepStation(dir: 1 | -1) {
    const n = this.stations.length;
    if (!n) return;
    const cur = this.nearestIndex(this.dial);
    let idx: number;
    if (Math.abs(this.stations[cur].freq - this.dialTarget) < 0.06) idx = (cur + dir + n) % n;
    else {
      // between stations: go to the next one in that direction
      const f = this.dialTarget;
      const cands = this.stations.map((s, i) => ({ i, d: (s.freq - f) * dir })).filter((x) => x.d > 0).sort((a, b) => a.d - b.d);
      idx = cands.length ? cands[0].i : dir > 0 ? 0 : n - 1;
    }
    const target = this.stations[idx].freq;
    if (!this.eng) {
      this.dial = this.dialTarget = target;
      return;
    }
    this.animateTo(target, this.eng.ctx.currentTime);
  }

  private animateTo(to: number, now: number) {
    const from = this.dial;
    const up = to >= from ? 1 : -1;
    const via1 = clamp(from + 0.45 * up, DIAL_MIN, DIAL_MAX);
    const via2 = clamp(to - 0.45 * up, DIAL_MIN, DIAL_MAX);
    this.anim = { t0: now, dur: 1.3, from, via1, via2, to };
    this.dialTarget = to;
    this.infoDirty = true;
  }

  nextTrack() {
    const eng = this.eng;
    if (this._band === 'tape') {
      this.tape.next();
      return;
    }
    if (this._band !== 'stations' || !eng) return;
    const i = this.nearestIndex(this.dial);
    const p = i >= 0 ? this.players[i] : null;
    if (p) p.nextTrack(eng.ctx.currentTime);
    this.infoDirty = true;
  }

  setBand(b: RadioBand) {
    if (b === this._band) return;
    this._band = b;
    this.infoDirty = true;
    const now = this.eng?.ctx.currentTime ?? 0;
    this.burstUntil = now + 0.35;
    if (b === 'tape' && this._on) this.tape.play();
    else this.tape.pause();
    if (b === 'link' && this._on) this.link.resume();
    else this.link.pause();
    this.syncDirectVolume();
  }

  loadTape(files: File[]) {
    this.tape.load(files);
    if (this._band === 'tape' && this._on) this.tape.play();
    this.infoDirty = true;
  }

  async playLink(url: string): Promise<LinkResult> {
    this.syncDirectVolume();
    const r = await this.link.play(url);
    if (this._band !== 'link' || !this._on) this.link.pause();
    this.syncDirectVolume();
    this.infoDirty = true;
    return r;
  }

  onInfo(cb: (info: RadioInfo) => void): () => void {
    this.subs.add(cb);
    cb(this.makeInfo(this.eng?.ctx.currentTime ?? 0));
    return () => this.subs.delete(cb);
  }

  getInfo(): RadioInfo {
    return this.makeInfo(this.eng?.ctx.currentTime ?? 0);
  }

  getLevels(): { rms: number; peak: number } {
    const a = this.n?.analyser;
    if (!a) return { rms: 0, peak: 0 };
    if (!this.timeBuf || this.timeBuf.length !== a.fftSize) this.timeBuf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.timeBuf);
    let s = 0;
    let p = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const x = this.timeBuf[i];
      s += x * x;
      const ax = Math.abs(x);
      if (ax > p) p = ax;
    }
    return { rms: Math.sqrt(s / this.timeBuf.length), peak: p };
  }

  getSpectrum(out: Uint8Array) {
    const a = this.n?.analyser;
    if (!a) {
      out.fill(0);
      return;
    }
    a.getByteFrequencyData(out as Uint8Array<ArrayBuffer>);
  }

  /** Tools: the station sum before the glue compressor. */
  debugRawMixTap(): AudioNode {
    if (!this.n) throw new Error('radio not attached');
    return this.n.stationsIn;
  }

  /** Tools: align a station's programme (the context time at which its track 0 started). */
  debugSetEpoch(index: number, epoch: number) {
    if (index >= 0 && index < this.epochs.length) {
      this.epochs[index] = epoch;
      if (this.players[index] && !this.players[index]!.active) this.players[index] = null;
    }
  }

  /** Diagnostics for tools: live bands / voices per station. */
  debugState() {
    return {
      dial: this.dial,
      players: this.players.map((p, i) => ({ name: this.stations[i]?.name, active: !!p?.active, signal: p?.signal ?? 0, bands: p?.liveBands ?? 0 })),
      retired: this.retired.length,
    };
  }

  /** Called by AudioSystem.setVolumes (direct no-CORS playback follows the volumes outside the graph). */
  volumesChanged() {
    this.syncDirectVolume();
  }

  // ------------------------------------------------------------------------------------------ internals

  private syncDirectVolume() {
    const eng = this.eng;
    const vols = eng?.volumes ?? { master: 1, music: 1, ambience: 1, sfx: 1 };
    const v = this._on && this._band === 'link' ? sliderGain(this.volume) * sliderGain(vols.music) * sliderGain(vols.master) : 0;
    this.link.setDirectVolume(v);
  }

  private nearestIndex(f: number): number {
    let best = -1;
    let bd = Infinity;
    this.stations.forEach((s, i) => {
      const d = Math.abs(s.freq - f);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  private makePhantoms(list: StationDef[]): number[] {
    const seed = list.length ? list[0].seed : 1;
    const rng = new Rng(hash(seed, 0xa3));
    const out: number[] = [];
    let guard = 0;
    while (out.length < 3 && guard++ < 100) {
      const f = rng.range(88, 108);
      if (list.every((s) => Math.abs(s.freq - f) > 0.6) && out.every((x) => Math.abs(x - f) > 1)) out.push(f);
    }
    return out;
  }

  private dialAt(now: number): number {
    const a = this.anim;
    if (!a) return this.dial;
    const k = (now - a.t0) / a.dur;
    if (k >= 1) {
      this.anim = null;
      this.infoDirty = true;
      return a.to;
    }
    if (k < 0.36) return a.from + (a.via1 - a.from) * smoothstep(0, 1, k / 0.36);
    if (k < 0.44) return k < 0.4 ? a.via1 : a.via2;
    return a.via2 + (a.to - a.via2) * (1 - Math.pow(1 - (k - 0.44) / 0.56, 2));
  }

  private update(now: number, horizon: number) {
    const eng = this.eng;
    const n = this.n;
    if (!eng || !n || !this.tuner) return;
    const dt = this.lastTick < 0 ? 0 : Math.max(0, now - this.lastTick);
    this.lastTick = now;
    // dial
    if (this.anim) this.dial = this.dialAt(now);
    else this.dial += (this.dialTarget - this.dial) * (1 - Math.exp(-dt / 0.06));
    // reception
    const poweredDown = !this._on && this.offSince >= 0 && now - this.offSince > 0.6;
    const listening = this._band === 'stations' && !poweredDown;
    let maxS = 0;
    let nearD = Infinity;
    this.stations.forEach((def, i) => {
      const d = this.dial - def.freq;
      const s = listening ? signalAt(d) : 0;
      if (Math.abs(d) < Math.abs(nearD)) nearD = d;
      maxS = Math.max(maxS, s);
      let p = this.players[i];
      if (s > 0.003) {
        if (!p) p = this.players[i] = new StationPlayer(def, eng, n.stationsIn, this.epochs[i] ?? now);
        if (!p.active) p.activate(now);
        p.setSignal(s, now);
      } else if (p?.active) p.deactivate(now);
    });
    for (const p of this.players) p?.update(now, horizon);
    if (this.retired.length) {
      for (const p of this.retired) p.update(now, horizon);
      this.retired = this.retired.filter((p) => {
        if (p.liveBands === 0) {
          p.dispose();
          return false;
        }
        return true;
      });
    }
    // static, whistle, chatter
    const burst = now < this.burstUntil ? 0.7 : 0;
    let stat = 0;
    let whistle = 0;
    let chatter = 0;
    const ad = Math.abs(nearD);
    if (this._band === 'stations') {
      stat = Math.max(Math.pow(1 - maxS, 1.2), burst);
      if (Number.isFinite(ad) && ad > 0.035) whistle = Math.exp(-Math.pow((ad - 0.13) / 0.1, 2)) * (1 - signalAt(ad) * 0.7);
      for (const f of this.phantoms) chatter = Math.max(chatter, Math.exp(-Math.pow((this.dial - f) / 0.16, 2)));
      if (this.anim) {
        const k = (now - this.anim.t0) / this.anim.dur;
        chatter = Math.max(chatter, 0.55 * Math.sin(Math.PI * clamp(k, 0, 1)));
      }
      chatter *= 1 - maxS;
    } else stat = burst;
    if (!this._on) {
      stat = 0;
      whistle = 0;
      chatter = 0;
    }
    this.tuner.set({ static: stat, whistle, whistleHz: 90 + 6500 * (Number.isFinite(ad) ? ad : 0.3), chatter, floor: this._on ? 1 : 0 });
    // the speaker is duller and quieter when you are far away or behind it
    const rel = vecSub(eng.listener.pos, this.pos);
    const dist = Math.max(0.05, vecLen(rel));
    const cosA = vecDot(this.fwd, [rel[0] / dist, rel[1] / dist, rel[2] / dist]);
    const behind = (1 - cosA) / 2;
    const cut = clamp(18000 * Math.pow(0.7 / Math.max(0.7, dist), 0.8) * (1 - 0.72 * Math.pow(behind, 1.5)), 1500, 20000);
    if (Math.abs(cut - this.dirCut) / this.dirCut > 0.02) {
      this.dirCut = cut;
      n.direct.frequency.setTargetAtTime(cut, now, 0.08);
    }
    // info
    if (this.subs.size && (this.infoDirty || now - this.lastInfo > 0.25)) {
      this.infoDirty = false;
      this.lastInfo = now;
      const info = this.makeInfo(now);
      for (const cb of this.subs) cb(info);
    }
  }

  private makeInfo(now: number): RadioInfo {
    const base: RadioInfo = {
      band: this._band, on: this._on, freq: Math.round(this.dial * 10) / 10, station: null, stationFreq: null, style: null, styleLabel: null,
      title: null, bpm: null, key: null, elapsed: 0, duration: null, signal: 0, trackIndex: 0, status: 'off', tapeCount: this.tape.count,
    };
    if (!this._on) return base;
    if (this._band === 'stations') {
      const i = this.nearestIndex(this.dial);
      const def = i >= 0 ? this.stations[i] : null;
      const s = def ? signalAt(this.dial - def.freq) : 0;
      base.signal = s;
      base.status = this.anim ? 'tuning' : s > 0.85 ? 'playing' : s > 0.25 ? 'weak' : 'static';
      if (def && s > 0.25) {
        base.station = def.name;
        base.stationFreq = def.freq;
        base.style = def.style;
        base.styleLabel = STYLE_LABELS[def.style];
        const p = this.players[i];
        if (p) {
          const inf = p.info(now);
          base.title = inf.title;
          base.bpm = inf.bpm;
          base.key = inf.key;
          base.elapsed = inf.elapsed;
          base.duration = inf.duration;
          base.trackIndex = inf.index;
        }
      }
      return base;
    }
    const m = this._band === 'tape' ? this.tape.info() : this.link.info();
    base.station = this._band === 'tape' ? 'Tape' : 'Link';
    base.title = m.title;
    base.elapsed = m.elapsed;
    base.duration = m.duration;
    base.status = m.status;
    base.trackIndex = m.index;
    base.signal = m.status === 'playing' || m.status === 'no-cors' ? 1 : 0;
    return base;
  }
}
