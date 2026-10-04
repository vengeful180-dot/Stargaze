// Radio stations: deterministic station lists per star system, and the StationPlayer that runs a station's
// endless "live" programme. A station keeps a virtual timeline (track i starts at a known time), so tuning
// in joins the current track mid-song, like real radio. Audio is only rendered while the station is audible.
import { Rng, hash, hashFloat } from '../core/rng';
import { makeWord } from '../space/names';
import { type TrackPlan, TRACK_GAP, composeTrack, planTrack } from './music/compose';
import { STATION_STYLES, STYLE_LABELS, type StationDef, type StationStyle } from './types';
import { Band } from './synth/band';
import type { Engine } from './engine';
import { safeDisconnect } from './util';

const ADJ = ['Velvet', 'Amber', 'Moonlit', 'Quiet', 'Hazy', 'Cozy', 'Golden', 'Lantern', 'Dusty', 'Sleepy', 'Soft', 'Late', 'Starlit', 'Honey', 'Paper', 'Copper', 'Warm'];
const NOUN = ['Hour', 'Lounge', 'Room', 'Porch', 'Kettle', 'Harbour', 'Orbit', 'Window', 'Blanket', 'Hearth', 'Satellite', 'Signal', 'Corner', 'Attic'];
const STYLE_NOUN: Record<StationStyle, readonly string[]> = {
  'dusty-keys': ['Keys', 'Records', 'Wax', 'Crates'],
  'sunday-tape': ['Tapes', 'Sundays', 'Strings', 'Porch'],
  'night-drive': ['Nights', 'Highway', 'Neon', 'Afterhours'],
  drift: ['Observatory', 'Drift', 'Nebula', 'Skies'],
  'cafe-boom-bap': ['Café', 'Corner', 'Beats', 'Espresso'],
};

function stationName(rng: Rng, style: StationStyle): string {
  const r = rng.next();
  if (r < 0.28) return `${makeWord(rng, 2, 2)} FM`;
  if (r < 0.45) return `Radio ${makeWord(rng, 2, 3)}`;
  if (r < 0.72) return `${rng.pick(ADJ)} ${rng.pick(STYLE_NOUN[style])}`;
  if (r < 0.88) return `The ${rng.pick(ADJ)} ${rng.pick(NOUN)}`;
  return `${makeWord(rng, 1, 2)} ${rng.pick(STYLE_NOUN[style])}`;
}

/** 2-4 stations for a star system, deterministic from its seed. */
export function makeStations(systemSeed: number): StationDef[] {
  const rng = new Rng(hash(systemSeed, 0x4ad10));
  const count = rng.weighted([[2, 0.35], [3, 0.45], [4, 0.2]] as const);
  const styles = rng.shuffle([...STATION_STYLES]).slice(0, count);
  const freqs: number[] = [];
  let guard = 0;
  while (freqs.length < count && guard++ < 400) {
    const f = Math.round((88.1 + 0.2 * rng.int(0, 99)) * 10) / 10;
    if (freqs.every((x) => Math.abs(x - f) >= 1.6)) freqs.push(f);
  }
  while (freqs.length < count) freqs.push(Math.round((88.1 + freqs.length * 4) * 10) / 10);
  freqs.sort((a, b) => a - b);
  const names = new Set<string>();
  return freqs.map((freq, i) => {
    const style = styles[i];
    let name = stationName(rng, style);
    while (names.has(name)) name = stationName(rng, style);
    names.add(name);
    return { seed: hash(systemSeed, i, 0x57a7), freq, name, style };
  });
}

export function styleLabel(s: StationStyle) {
  return STYLE_LABELS[s];
}

interface Cursor {
  index: number;
  start: number;
  plan: TrackPlan;
}

/** Plays one station. Owns a reception stage (signal gain + "weak signal" low-pass) and the current Band. */
export class StationPlayer {
  active = false;
  signal = 0;
  band: Band | null = null;
  private next: Band | null = null;
  private retired: Band[] = [];
  private cur: Cursor;
  private rxGain: GainNode | null = null;
  private rxLP: BiquadFilterNode | null = null;
  private rxDisposeAt = 0;

  constructor(
    readonly def: StationDef,
    private eng: Engine,
    private dest: AudioNode,
    epoch: number,
  ) {
    this.cur = { index: 0, start: epoch, plan: planTrack(def.seed, def.style, 0) };
  }

  /** Advance the virtual timeline so `cur` is the track playing at time t (or the one about to start). */
  private locate(t: number) {
    let guard = 0;
    while (t >= this.cur.start + this.cur.plan.duration + TRACK_GAP && guard++ < 10000) {
      const start = this.cur.start + this.cur.plan.duration + TRACK_GAP;
      const index = this.cur.index + 1;
      this.cur = { index, start, plan: planTrack(this.def.seed, this.def.style, index) };
    }
  }

  private ensureRx() {
    if (this.rxGain) return;
    const ctx = this.eng.ctx;
    this.rxLP = ctx.createBiquadFilter();
    this.rxLP.type = 'lowpass';
    this.rxLP.frequency.value = 2000;
    this.rxLP.Q.value = 0.6;
    this.rxGain = ctx.createGain();
    this.rxGain.gain.value = 0;
    this.rxLP.connect(this.rxGain).connect(this.dest);
    this.eng.stats.addNodes(2);
  }

  private disposeRx() {
    if (!this.rxGain) return;
    safeDisconnect(this.rxLP);
    safeDisconnect(this.rxGain);
    this.rxGain = null;
    this.rxLP = null;
    this.eng.stats.removeNodes(2);
  }

  private makeBand(c: Cursor, now: number): Band {
    const score = composeTrack(c.plan);
    const b = new Band(this.eng, score, this.rxLP as AudioNode, c.start);
    if (this.eng.offline) this.eng.bank.flush();
    b.start(now);
    return b;
  }

  activate(now: number) {
    if (this.active) return;
    this.active = true;
    this.ensureRx();
    this.rxDisposeAt = 0;
    this.locate(now);
    this.band = this.makeBand(this.cur, now);
  }

  deactivate(now: number) {
    if (!this.active) return;
    this.active = false;
    if (this.rxGain) this.rxGain.gain.setTargetAtTime(0, now, 0.05);
    for (const b of [this.band, this.next]) if (b) {
      b.stop(now, 0.25);
      this.retired.push(b);
    }
    this.band = null;
    this.next = null;
    this.rxDisposeAt = now + 0.8;
  }

  setSignal(s: number, now: number) {
    this.signal = s;
    if (!this.rxGain || !this.rxLP) return;
    this.rxGain.gain.setTargetAtTime(Math.pow(s, 1.3), now, 0.04);
    this.rxLP.frequency.setTargetAtTime(Math.min(20000, 700 * Math.pow(2, s * 4.9)), now, 0.04);
  }

  update(now: number, horizon: number) {
    // clean up faded bands
    if (this.retired.length) {
      this.retired = this.retired.filter((b) => {
        if (b.stopDone) {
          b.dispose();
          return false;
        }
        return true;
      });
    }
    if (!this.active) {
      if (this.rxDisposeAt && now > this.rxDisposeAt && this.retired.length === 0) {
        this.disposeRx();
        this.rxDisposeAt = 0;
      }
      return;
    }
    if (!this.band) return;
    this.band.scheduleUntil(horizon);
    const nextStart = this.cur.start + this.cur.plan.duration + TRACK_GAP;
    if (!this.next && horizon + 3 >= nextStart) {
      const index = this.cur.index + 1;
      const c: Cursor = { index, start: nextStart, plan: planTrack(this.def.seed, this.def.style, index) };
      this.next = this.makeBand(c, now);
      this.nextCursor = c;
    }
    if (this.next) this.next.scheduleUntil(horizon);
    if (this.next && this.nextCursor && now >= nextStart - 0.02) {
      this.band.stop(now, 1.2);
      this.retired.push(this.band);
      this.band = this.next;
      this.cur = this.nextCursor;
      this.next = null;
      this.nextCursor = null;
    }
  }
  private nextCursor: Cursor | null = null;

  /** Skip to the next track: tape-stop (or fade) the current one, start the next after a short breath. */
  nextTrack(now: number) {
    const index = this.cur.index + 1;
    const start = now + 1.1;
    const c: Cursor = { index, start, plan: planTrack(this.def.seed, this.def.style, index) };
    if (!this.active) {
      this.cur = c;
      return;
    }
    if (this.band) {
      this.band.tapeStop(now, 0.65);
      this.retired.push(this.band);
    }
    if (this.next) {
      this.next.stop(now, 0.05);
      this.retired.push(this.next);
    }
    this.next = null;
    this.nextCursor = null;
    this.cur = c;
    this.band = this.makeBand(c, now);
  }

  info(now: number) {
    const p = this.cur.plan;
    const elapsed = Math.max(0, Math.min(p.duration, now - this.cur.start));
    return { title: p.title, bpm: p.bpm, key: p.keyLabel, elapsed, duration: p.duration, index: this.cur.index, plan: p };
  }

  get liveBands() {
    return (this.band ? 1 : 0) + (this.next ? 1 : 0) + this.retired.length;
  }

  dispose() {
    for (const b of [this.band, this.next, ...this.retired]) b?.dispose();
    this.band = null;
    this.next = null;
    this.retired = [];
    this.disposeRx();
    this.active = false;
  }
}

/** Per-station start offsets so tuning around lands mid-song on most stations. */
export function stationOffset(def: StationDef): number {
  return hashFloat(def.seed, 0x0ff5) * 60;
}
