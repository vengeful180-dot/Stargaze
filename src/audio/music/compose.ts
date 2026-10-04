// The generative lofi composer: seed + style -> a fully arranged track (a sorted list of timed events).
// Pure and deterministic: the same station seed and track index always give the same music.
import { Rng, hash } from '../../core/rng';
import { trackTitle } from '../../space/names';
import type { StationStyle } from '../types';
import { STYLES, type BassStyle, type BellKind, type CompStyle, type DrumStyle, type InstId } from './styles';
import {
  type Chord, type Key, type Quality, QUALITIES, SCALES, keyName, melodyAllowed, mod12, voiceChord,
} from './theory';
import { type PChord, evolveLoop, parseProgression, pickProgression, toAbsolute } from './progressions';
import { type DrumId, type FillKind, drumBar, makeGroove } from './drums';
import {
  type ChordSeg, type MelNote, type MelodyCtx, type Motif, type Slot, PHRASE_PLANS, clashes, makeAnswer, makeMotif, realiseMotif, varyMotif,
} from './melody';

export type SectionName = 'intro' | 'A' | 'B' | 'break' | 'A2' | 'B2' | 'outro';

export interface SectionPlan {
  name: SectionName;
  bars: number;
}

export type Ending = 'fade' | 'tapestop' | 'filter';

export interface TrackPlan {
  stationSeed: number;
  index: number;
  seed: number;
  style: StationStyle;
  title: string;
  bpm: number;
  swing: number;
  key: Key;
  keyLabel: string;
  sections: SectionPlan[];
  bars: number;
  barDur: number;
  /** seconds, including the release tail */
  duration: number;
  twoBar: boolean;
  chordInst: InstId;
  melodyInst: InstId;
  bell: BellKind;
  pad: boolean;
  wurli: boolean;
  drums: DrumStyle;
  bassStyle: BassStyle;
  comp: CompStyle;
  ending: Ending;
  tex: { crackle: number; hiss: number; wow: number };
}

export type Role = 'chord' | 'melody' | 'bass' | 'pad' | 'arp';

export interface NoteEv {
  k: 'n';
  t: number; // seconds from track start
  p: number; // 16th position (for dumps)
  inst: InstId;
  m: number; // MIDI note
  v: number; // velocity 0..1
  d: number; // seconds
  /** start this many semitones away and glide to the note */
  slide?: number;
  role: Role;
}
export interface DrumEv {
  k: 'd';
  t: number;
  p: number;
  drum: DrumId;
  v: number;
}
export type FxKind = 'filter' | 'riser' | 'fade' | 'tapestop';
export interface FxEv {
  k: 'fx';
  t: number;
  p: number;
  fx: FxKind;
  /** target value (filter Hz, fade gain) */
  to: number;
  /** ramp duration (s) */
  dur: number;
}
export type ScoreEv = NoteEv | DrumEv | FxEv;

export interface ChordSpan {
  start: number; // 16ths
  len: number; // 16ths
  chord: Chord;
  section: SectionName;
  sectionIndex: number;
  voicing: number[];
  pad: number[];
}

export interface SectionSpan {
  name: SectionName;
  startBar: number;
  bars: number;
  t: number;
}

export interface Score {
  plan: TrackPlan;
  events: ScoreEv[];
  chords: ChordSpan[];
  sections: SectionSpan[];
  duration: number;
  /** names of the progressions used (for dumps) */
  progressions: string[];
  /** diagnostic notes from the composer */
  notes: string[];
}

/** Silence between tracks on a station (crackle keeps running). */
export const TRACK_GAP = 1.0;

const KEY_WEIGHTS: readonly (readonly [number, number])[] = [
  [0, 1.1], [1, 1.0], [2, 1.0], [3, 1.3], [4, 0.8], [5, 1.3], [6, 0.5], [7, 1.0], [8, 1.2], [9, 1.0], [10, 1.2], [11, 0.6],
];

const S = (name: SectionName, bars: number): SectionPlan => ({ name, bars });
const SONG_FORMS: readonly (readonly SectionPlan[])[] = [
  [S('intro', 4), S('A', 8), S('B', 8), S('break', 4), S('A2', 8), S('outro', 4)],
  [S('intro', 4), S('A', 8), S('B', 8), S('break', 4), S('A2', 8), S('B2', 8), S('outro', 4)],
  [S('intro', 4), S('A', 8), S('B', 8), S('A2', 8), S('break', 4), S('B2', 8), S('outro', 4)],
  [S('intro', 4), S('A', 8), S('B', 8), S('break', 8), S('A2', 8), S('B2', 8), S('outro', 4)],
  [S('intro', 8), S('A', 8), S('B', 8), S('break', 4), S('A2', 8), S('B2', 8), S('outro', 4)],
  [S('intro', 4), S('A', 8), S('B', 8), S('break', 4), S('B2', 8), S('A2', 8), S('B2', 8), S('outro', 4)],
];
const DRIFT_FORMS: readonly (readonly SectionPlan[])[] = [
  [S('intro', 8), S('A', 8), S('B', 8), S('break', 8), S('A2', 8), S('outro', 8)],
  [S('intro', 4), S('A', 8), S('B', 8), S('A2', 8), S('outro', 8)],
  [S('intro', 8), S('A', 8), S('B', 8), S('A2', 8), S('outro', 8)],
  [S('intro', 4), S('A', 8), S('B', 8), S('break', 8), S('B2', 8), S('outro', 8)],
];

const TAIL = 1.6;

/** Cheap: tempo, key, form and instrumentation for a track (no notes). */
export function planTrack(stationSeed: number, style: StationStyle, index: number): TrackPlan {
  const seed = hash(stationSeed, index, 0x7ac4);
  const rng = new Rng(seed);
  const st = STYLES[style];
  const bpm = Math.round(rng.range(st.bpm[0], st.bpm[1]));
  const swing = rng.range(st.swing[0], st.swing[1]);
  const mode = rng.chance(st.minorProb) ? 'minor' : 'major';
  const tonic = rng.weighted(KEY_WEIGHTS);
  const key: Key = { tonic, mode };
  const twoBar = rng.chance(st.twoBarChords);
  const barDur = 240 / bpm;
  const target = rng.range(st.targetDur[0], st.targetDur[1]);
  const forms = st.drift ? DRIFT_FORMS : SONG_FORMS;
  const ranked = forms
    .map((f) => ({ f, err: Math.abs(f.reduce((a, s) => a + s.bars, 0) * barDur - target) }))
    .sort((a, b) => a.err - b.err);
  const form = rng.chance(0.7) ? ranked[0].f : ranked[Math.min(1, ranked.length - 1)].f;
  const sections = form.map((s) => ({ ...s }));
  const bars = sections.reduce((a, s) => a + s.bars, 0);
  const chordInst = rng.weighted(st.chordInst);
  const melodyInst = rng.weighted(st.melodyInst);
  const bell = rng.weighted(st.bells);
  const pad = chordInst === 'pad' || rng.chance(st.padProb);
  const drums = rng.weighted(st.drums);
  const bassStyle = rng.weighted(st.bass);
  let compPool = st.comp.filter(([c]) => (chordInst === 'guitar' ? c === 'arp' || c === 'strum' : c !== 'arp' && c !== 'strum'));
  if (compPool.length === 0) compPool = chordInst === 'guitar' ? [['arp', 1]] : [['sustain', 1]];
  const comp = rng.weighted(compPool);
  const ending: Ending = rng.chance(st.tapeStopProb) ? 'tapestop' : rng.chance(0.55) ? 'fade' : 'filter';
  const tex = {
    crackle: st.crackle * rng.range(0.7, 1.25),
    hiss: st.hiss * rng.range(0.8, 1.2),
    wow: st.wow * rng.range(0.75, 1.25),
  };
  return {
    stationSeed, index, seed, style, title: trackTitle(seed), bpm, swing, key, keyLabel: keyName(key), sections, bars, barDur,
    duration: bars * barDur + TAIL, twoBar, chordInst, melodyInst, bell, pad, wurli: rng.chance(st.wurliProb), drums, bassStyle, comp,
    ending, tex,
  };
}

// ------------------------------------------------------------------------------------------------

interface Layers {
  drums: 'full' | 'light' | 'none';
  bass: boolean;
  chords: boolean;
  pad: boolean;
  melody: 'main' | 'var' | 'sparse' | 'frag' | 'none';
  arp: boolean;
}

const SECTION_GAIN: Record<SectionName, number> = { intro: 0.86, A: 0.95, B: 1, break: 0.78, A2: 1, B2: 1.03, outro: 0.9 };

interface MelRange {
  lo: number;
  hi: number;
  center: number;
  vel: number;
}

function melodyRange(inst: InstId, bell: BellKind): MelRange {
  switch (inst) {
    case 'ep':
      return { lo: 67, hi: 81, center: 73, vel: 0.62 };
    case 'piano':
      return { lo: 67, hi: 84, center: 74, vel: 0.58 };
    case 'guitar':
      return { lo: 64, hi: 79, center: 71, vel: 0.62 };
    case 'lead':
      return { lo: 65, hi: 81, center: 72, vel: 0.58 };
    case 'bell':
      if (bell === 'kalimba') return { lo: 69, hi: 86, center: 76, vel: 0.55 };
      if (bell === 'glock') return { lo: 72, hi: 86, center: 79, vel: 0.45 };
      if (bell === 'marimba') return { lo: 64, hi: 81, center: 72, vel: 0.58 };
      return { lo: 67, hi: 84, center: 74, vel: 0.55 };
    default:
      return { lo: 67, hi: 81, center: 72, vel: 0.6 };
  }
}

interface Hit {
  at: number; // 16ths from span start (negative = anticipation)
  len: number; // 16ths, -1 = until the next hit
  vel: number;
  sub: 'full' | 'upper' | 'top';
  roll?: boolean;
  up?: boolean; // strum direction
}

function compHits(style: CompStyle, spanLen: number, rng: Rng, rollProb: number, first: boolean): Hit[] {
  const h: Hit[] = [];
  switch (style) {
    case 'sustain':
      h.push({ at: 0, len: -1, vel: 1, sub: 'full', roll: rng.chance(rollProb) });
      if (spanLen >= 32 && rng.chance(0.45)) h.push({ at: 16 + rng.pick([0, 6, 10]), len: -1, vel: 0.7, sub: 'upper' });
      else if (spanLen >= 16 && rng.chance(0.18)) h.push({ at: rng.pick([10, 14]), len: -1, vel: 0.62, sub: 'upper' });
      break;
    case 'push':
      h.push({ at: first ? 0 : -2, len: -1, vel: 1, sub: 'full', roll: rng.chance(rollProb * 0.5) });
      if (spanLen >= 16 && rng.chance(0.3)) h.push({ at: 10, len: -1, vel: 0.68, sub: 'upper' });
      break;
    case 'charleston':
      h.push({ at: 0, len: 5, vel: 1, sub: 'full' });
      if (spanLen >= 8) h.push({ at: 6, len: -1, vel: 0.78, sub: 'upper' });
      if (spanLen >= 32) h.push({ at: 16, len: 5, vel: 0.9, sub: 'full' }, { at: 22, len: -1, vel: 0.72, sub: 'upper' });
      break;
    case 'halves':
      h.push({ at: 0, len: 7, vel: 1, sub: 'full', roll: rng.chance(rollProb) });
      if (spanLen >= 16) h.push({ at: 8, len: -1, vel: 0.72, sub: 'upper' });
      break;
    case 'stabs': {
      const pats: readonly (readonly (readonly [number, number, number])[])[] = [
        [[0, 3, 1], [6, 2, 0.8], [10, 4, 0.9]],
        [[0, 3, 1], [3, 2, 0.7], [8, 3, 0.9], [14, 2, 0.75]],
        [[0, 6, 1], [7, 2, 0.75], [10, 4, 0.85]],
        [[0, 2, 1], [6, 3, 0.85], [11, 3, 0.8]],
        [[0, 4, 1], [10, 2, 0.8], [13, 3, 0.7]],
      ];
      const p = rng.pick(pats);
      for (const [at, len, vel] of p) if (at < spanLen) h.push({ at, len, vel, sub: vel < 0.8 ? 'upper' : 'full' });
      if (spanLen >= 32) for (const [at, len, vel] of rng.pick(pats)) h.push({ at: at + 16, len, vel, sub: vel < 0.8 ? 'upper' : 'full' });
      break;
    }
    case 'roll':
      h.push({ at: 0, len: -1, vel: 1, sub: 'full', roll: true });
      if (spanLen >= 32 && rng.chance(0.5)) h.push({ at: 16, len: -1, vel: 0.75, sub: 'full', roll: true });
      break;
    case 'offbeat':
      h.push({ at: 2, len: 4, vel: 0.85, sub: 'full' });
      if (spanLen >= 16) h.push({ at: 10, len: -1, vel: 0.8, sub: 'full' });
      break;
    case 'strum': {
      const pats: readonly (readonly (readonly [number, boolean, number])[])[] = [
        [[0, false, 1], [6, true, 0.6], [10, false, 0.8], [14, true, 0.55]],
        [[0, false, 1], [7, true, 0.55], [10, false, 0.75]],
        [[0, false, 1], [10, false, 0.75], [14, true, 0.55]],
      ];
      const p = rng.pick(pats);
      for (let rep = 0; rep * 16 < spanLen; rep++)
        for (const [at, up, vel] of p) if (at + rep * 16 < spanLen) h.push({ at: at + rep * 16, len: -1, vel, sub: up ? 'upper' : 'full', roll: true, up });
      break;
    }
    case 'arp':
      break; // handled separately
  }
  return h.filter((x) => x.at < spanLen);
}

/** Dominant colour for a turnaround chord into `target`. */
function turnDom(target: PChord, mode: 'major' | 'minor'): Quality {
  const fam = QUALITIES[target.q].family;
  if (fam === 'min' || fam === 'hdim') return mode === 'minor' ? '7b9' : '7b13';
  return '13';
}

export function composeTrack(plan: TrackPlan): Score {
  const rng = new Rng(hash(plan.seed, 0x5c0e));
  const st = STYLES[plan.style];
  const key = plan.key;
  const barScale = plan.twoBar ? 2 : 1;
  const tag = st.drift ? 'D' : 'A';
  const progA = pickProgression(rng, key.mode, tag);
  const progB = pickProgression(rng, key.mode, st.drift ? 'D' : 'B', progA.id);
  const loopA = parseProgression(progA, barScale);
  const loopB = parseProgression(progB, barScale);
  const notes: string[] = [];
  const s16 = plan.barDur / 16;
  const eighth = s16 * 2;
  const swing = plan.swing;
  const timeOf = (pos: number) => {
    const e = pos / 2;
    const e0 = Math.floor(e);
    const f = e - e0;
    const fs = f < 0.5 ? f * (swing / 0.5) : swing + (f - 0.5) * ((1 - swing) / 0.5);
    return (e0 + fs) * eighth;
  };
  const human = (sigma: number) => Math.max(-0.012, Math.min(0.012, rng.gauss() * sigma));

  // ---------------- harmony per section ----------------
  const secChords: PChord[][] = [];
  for (const sec of plan.sections) {
    const base = sec.name === 'B' || sec.name === 'B2' ? loopB : loopA;
    const out: PChord[] = [];
    const need = sec.bars * 4;
    let beats = 0;
    let pass = 0;
    while (beats < need) {
      let nsubs = 0;
      switch (sec.name) {
        case 'A':
        case 'B':
          nsubs = pass === 0 ? 0 : 1;
          break;
        case 'A2':
        case 'B2':
          nsubs = pass === 0 ? 1 : 2;
          break;
        case 'break':
          nsubs = 1;
          break;
        default:
          nsubs = 0;
      }
      const allowed = sec.name === 'break' ? (['ext', 'sus'] as const) : st.subs;
      const loop = nsubs > 0 ? evolveLoop(base, key, rng, nsubs, allowed).chords : base.map((c) => ({ ...c }));
      for (const c of loop) {
        if (beats >= need) break;
        const b = Math.min(c.beats, need - beats);
        out.push({ ...c, beats: b });
        beats += b;
      }
      pass++;
    }
    if (sec.name === 'outro') {
      // close on the tonic: the final bar (or two) becomes I / i
      const tonicQ: Quality = key.mode === 'major' ? rng.pick<Quality>(['maj9', '69']) : rng.pick<Quality>(['m9', 'm11']);
      const lastBeats = Math.min(need, 4 * barScale);
      let acc = 0;
      while (out.length && acc < lastBeats) {
        const c = out[out.length - 1];
        if (acc + c.beats <= lastBeats) {
          acc += c.beats;
          out.pop();
        } else {
          c.beats -= lastBeats - acc;
          acc = lastBeats;
        }
      }
      out.push({ deg: 0, q: tonicQ, beats: lastBeats });
    }
    secChords.push(out);
  }
  // turnarounds into the next section
  for (let i = 0; i < secChords.length - 1; i++) {
    if (st.drift || !rng.chance(0.3)) continue;
    const cur = secChords[i];
    const nextFirst = secChords[i + 1][0];
    const last = cur[cur.length - 1];
    if (!nextFirst || !last || last.beats < 4) continue;
    if (QUALITIES[nextFirst.q].family === 'dom') continue;
    const vDeg = mod12(nextFirst.deg + 7);
    if (last.deg === vDeg) continue;
    last.beats -= 2;
    cur.push({ deg: vDeg, q: turnDom(nextFirst, key.mode), beats: 2 });
  }

  // ---------------- layers ----------------
  const layers: Layers[] = plan.sections.map((sec) => {
    const L: Layers = { drums: 'full', bass: true, chords: true, pad: false, melody: 'none', arp: false };
    const drift = st.drift;
    switch (sec.name) {
      case 'intro':
        L.drums = drift ? 'none' : rng.weighted([['light', 0.5], ['none', 0.3], ['full', 0.2]] as const);
        L.bass = false;
        L.pad = drift;
        L.arp = drift && rng.chance(0.5);
        break;
      case 'A':
        L.drums = drift ? 'none' : 'full';
        L.pad = drift;
        L.melody = rng.chance(st.melodyInA) ? 'sparse' : 'none';
        L.arp = drift ? true : rng.chance(st.arpProb * 0.4);
        break;
      case 'B':
        L.drums = drift ? 'none' : 'full';
        L.pad = plan.pad;
        L.melody = 'main';
        L.arp = drift ? rng.chance(0.5) : false;
        break;
      case 'break':
        L.drums = drift ? 'none' : rng.chance(0.3) ? 'light' : 'none';
        L.bass = drift ? false : rng.chance(0.35);
        L.pad = plan.pad || rng.chance(0.5);
        L.melody = rng.chance(0.55) ? 'frag' : 'none';
        L.arp = rng.chance(st.arpProb);
        break;
      case 'A2':
        L.drums = drift ? 'none' : 'full';
        L.pad = drift || (plan.pad && rng.chance(0.5));
        L.melody = 'var';
        L.arp = drift;
        break;
      case 'B2':
        L.drums = drift ? 'none' : 'full';
        L.pad = plan.pad;
        L.melody = 'main';
        L.arp = drift ? rng.chance(0.5) : rng.chance(0.2);
        break;
      case 'outro':
        L.drums = drift ? 'none' : 'full';
        L.pad = plan.pad;
        L.melody = rng.chance(0.3) ? 'frag' : 'none';
        L.arp = drift;
        break;
    }
    if (drift) L.bass = sec.name !== 'intro' && sec.name !== 'break' && sec.name !== 'outro';
    if (plan.chordInst === 'pad') L.pad = false; // the pad already carries the chords
    return L;
  });

  // ---------------- chord timeline + voicings ----------------
  const mel = melodyRange(plan.melodyInst, plan.bell);
  const spans: ChordSpan[] = [];
  const sectionSpans: SectionSpan[] = [];
  let pos = 0;
  let prevV: number[] | null = null;
  let prevPad: number[] | null = null;
  const vCenterBase = rng.range(58, 61);
  plan.sections.forEach((sec, si) => {
    sectionSpans.push({ name: sec.name, startBar: pos / 16, bars: sec.bars, t: timeOf(pos) });
    const L = layers[si];
    const hasMel = L.melody !== 'none';
    const chordHi = hasMel ? Math.min(70, Math.max(63, mel.lo - 2)) : 70;
    const lift = sec.name === 'B' || sec.name === 'B2' ? 1.5 : sec.name === 'A2' ? 1 : 0;
    for (const pc of secChords[si]) {
      const chord = toAbsolute(pc, key);
      const len = pc.beats * 4;
      let voicing: number[];
      const slash = chord.bass !== undefined;
      if (plan.chordInst === 'guitar') {
        voicing = voiceChord(chord, prevV, { lo: 48, hi: Math.min(chordHi, 69), center: 58 + lift, maxSpan: 17, minNotes: 3, maxNotes: 5, rooted: !slash, rng, jitter: 1 });
      } else if (plan.chordInst === 'pad') {
        voicing = voiceChord(chord, prevV, { lo: 50, hi: 74, center: 61 + lift, maxSpan: 19, minNotes: 3, maxNotes: 4, rooted: !slash, rng, jitter: 1 });
      } else {
        voicing = voiceChord(chord, prevV, { lo: 50, hi: chordHi, center: vCenterBase + lift, maxSpan: 16, minNotes: 3, maxNotes: 4, rng, jitter: 1.2 });
      }
      prevV = voicing;
      let pad: number[] = [];
      if (L.pad || st.drift) {
        pad = voiceChord(chord, prevPad, { lo: 52, hi: 76, center: 63, maxSpan: 19, minNotes: 3, maxNotes: 4, rooted: !slash, rng, jitter: 0.8 });
        prevPad = pad;
      }
      spans.push({ start: pos, len, chord, section: sec.name, sectionIndex: si, voicing, pad });
      pos += len;
    }
  });
  const totalSteps = pos;

  const spanAt = (p: number): ChordSpan => {
    let lo = 0;
    let hi = spans.length - 1;
    if (p <= 0) return spans[0];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (spans[mid].start <= p + 1e-6) lo = mid;
      else hi = mid - 1;
    }
    return spans[lo];
  };

  const events: ScoreEv[] = [];
  const addNote = (inst: InstId, role: Role, p: number, len: number, m: number, v: number, extra = 0, slide?: number) => {
    const t = Math.max(0, timeOf(p) + extra);
    const tEnd = timeOf(p + len);
    const d = Math.max(0.05, tEnd - timeOf(p) - extra * 0.5);
    const ev: NoteEv = { k: 'n', t, p, inst, m, v: Math.max(0.05, Math.min(1, v)), d, role };
    if (slide) ev.slide = slide;
    events.push(ev);
  };

  // ---------------- drums ----------------
  const groove = plan.drums !== 'none' ? makeGroove(plan.drums, rng) : null;
  const kickSteps = new Map<number, number[]>(); // bar -> kick steps
  if (groove) {
    let bar = 0;
    plan.sections.forEach((sec, si) => {
      const L = layers[si];
      const nextL = layers[si + 1];
      for (let b = 0; b < sec.bars; b++, bar++) {
        let mode = L.drums;
        if (sec.name === 'outro' && b >= Math.ceil(sec.bars / 2)) mode = 'light';
        if (sec.name === 'intro' && L.drums === 'none' && b === sec.bars - 1 && rng.chance(0.4)) mode = 'light';
        if (mode === 'none') continue;
        const lastOfSection = b === sec.bars - 1;
        let fill: FillKind = 'none';
        if (mode === 'full') {
          if (lastOfSection && nextL) {
            fill = nextL.drums === 'none' ? rng.pick<FillKind>(['stop', 'roll', 'openhat']) : rng.pick<FillKind>(['roll', 'kickdouble', 'drop', 'openhat', 'flam']);
          } else if (b % 4 === 3) {
            fill = rng.chance(0.55) ? rng.pick<FillKind>(['openhat', 'flam', 'roll', 'none']) : 'none';
          }
        }
        const busy = (sec.name === 'B' || sec.name === 'B2' || sec.name === 'A2') && b >= sec.bars / 2;
        const hits = drumBar(groove, b, fill, mode === 'light', rng, busy);
        const gain = SECTION_GAIN[sec.name];
        const ks: number[] = [];
        for (const h of hits) {
          const p = bar * 16 + h.step;
          let off = human(0.005);
          if (h.drum === 'snare' || h.drum === 'rim' || h.drum === 'brush' || h.drum === 'snap') off += groove.laidBack;
          if (h.drum === 'hat' || h.drum === 'ohat') off += groove.hatFeel;
          if (h.drum === 'kick') {
            off = human(0.003);
            ks.push(h.step);
          }
          events.push({ k: 'd', t: Math.max(0, timeOf(p) + off), p, drum: h.drum, v: Math.min(1, h.vel * gain) });
        }
        if (mode === 'full') kickSteps.set(bar, ks.sort((a, b2) => a - b2));
      }
    });
  }

  // ---------------- bass ----------------
  let prevBass = 38;
  const bassPitch = (pc: number, voicingLow: number) => {
    let best = 40;
    let bc = Infinity;
    for (let m = 31; m <= 47; m++) {
      if (mod12(m) !== pc) continue;
      let c = Math.abs(m - prevBass) * 0.5 + Math.abs(m - 40) * 0.4;
      if (voicingLow - m < 9) c += 1;
      if (voicingLow - m < 7) c += 12;
      if (m < 33) c += 1.5;
      if (c < bc) {
        bc = c;
        best = m;
      }
    }
    return best;
  };
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const L = layers[sp.sectionIndex];
    if (!L.bass) continue;
    const next = spans[i + 1];
    const gain = SECTION_GAIN[sp.section];
    const rootPc = sp.chord.bass ?? sp.chord.root;
    const vLow = sp.voicing.length ? sp.voicing[0] : 48;
    const root = bassPitch(rootPc, vLow);
    const fifthPc = mod12(sp.chord.root + QUALITIES[sp.chord.q].fifth);
    const style = plan.bassStyle;
    // hit positions (relative to span start)
    let hits: number[] = [0];
    const barOf = (p: number) => Math.floor(p / 16);
    if (style === 'pluck') {
      hits = [];
      for (let p = sp.start; p < sp.start + sp.len; p += 16) {
        const ks = kickSteps.get(barOf(p));
        const inBar = ks ?? [0, 10];
        for (const k of inBar) {
          const ap = barOf(p) * 16 + k - sp.start;
          if (ap >= 0 && ap < sp.len) hits.push(ap);
        }
      }
      if (!hits.includes(0)) hits.unshift(0);
    } else if (style === 'walk') {
      hits = [];
      for (let o = 0; o < sp.len; o += 8) hits.push(o);
    } else if (style === 'long') {
      hits = [0];
      if (sp.len >= 16 && rng.chance(0.35)) hits.push(sp.len >= 32 ? 26 : 10);
    } else {
      hits = [0];
    }
    // a short diatonic walk into the next phrase (every few 4-bar boundaries)
    const spanEndBar = (sp.start + sp.len) / 16;
    const phraseEnd = next && next.sectionIndex === sp.sectionIndex && Number.isInteger(spanEndBar) && spanEndBar % 4 === 0 && sp.len >= 8;
    let run: { at: number; m: number }[] | null = null;
    if (phraseEnd && style !== 'pedal' && style !== 'long' && rng.chance(style === 'walk' ? 0.5 : 0.3)) {
      const target = bassPitch(next.chord.bass ?? next.chord.root, next.voicing[0] ?? 48);
      const scale = SCALES[key.mode].map((i) => mod12(key.tonic + i));
      const ceiling = Math.min(48, vLow - 7); // keep clear of the chord voicing
      const walk = (from: number) => {
        const notes: number[] = [];
        let m = target;
        for (let k = 0; k < 3; k++) {
          m += from;
          while (!scale.includes(mod12(m))) m += from;
          notes.unshift(m);
        }
        return notes;
      };
      let notes = walk(rng.chance(0.5) ? 1 : -1); // approach from above (1) or below (-1)
      if (notes.some((x) => x > ceiling)) notes = walk(-1);
      if (notes.every((x) => x >= 31 && x <= ceiling)) run = notes.map((mm, k) => ({ at: sp.len - 6 + k * 2, m: mm }));
    }
    // approach note into the next chord
    let approach: { at: number; m: number } | null = null;
    if (!run && next && next.sectionIndex === sp.sectionIndex && style !== 'pedal' && (next.chord.bass ?? next.chord.root) !== rootPc) {
      const prob = style === 'walk' ? 0.55 : style === 'long' ? 0.25 : 0.4;
      if (rng.chance(prob)) {
        const nextRoot = bassPitch(next.chord.bass ?? next.chord.root, next.voicing[0] ?? 48);
        let at = sp.len - rng.pick(style === 'walk' ? [2, 4] : [2, 1, 2]);
        // the approach sounds under the current chord: stay clear of both voicings
        const ceiling = Math.min(48, Math.min(next.voicing[0] ?? 50, vLow) - 7);
        const first = rng.weighted([['below', 2], ['above', 1.5], ['fifth', 1]] as const);
        const order = [first, ...(['below', 'above', 'fifth'] as const).filter((k) => k !== first)];
        let m = -1;
        for (const kind of order) {
          let c = kind === 'below' ? nextRoot - 1 : kind === 'above' ? nextRoot + 1 : nextRoot + 7;
          while (c > ceiling) c -= 12;
          if (c < 31) continue;
          m = c;
          break;
        }
        if (m < 0) at = -1;
        if (at > 0) {
          approach = { at, m };
          hits = hits.filter((h) => h < at - 1);
        }
      }
    }
    hits = Array.from(new Set(hits)).sort((a, b) => a - b);
    if (run) hits = hits.filter((h) => h < run![0].at - 1);
    hits.forEach((h, k) => {
      const nextHit = k + 1 < hits.length ? hits[k + 1] : approach ? approach.at : run ? run[0].at : sp.len;
      let m = root;
      if (k > 0) {
        const r = rng.next();
        const octOk = root + 12 <= Math.min(47, vLow - 7);
        if (style === 'walk') m = r < 0.5 ? bassPitch(fifthPc, vLow) : r < 0.75 ? root : octOk ? root + 12 : root;
        else if (r < 0.25 && octOk) m = root + 12;
        else if (r < 0.5) m = bassPitch(fifthPc, vLow);
        else m = root;
      }
      let len = Math.max(1, nextHit - h - (style === 'pluck' ? 0.4 : 0.25));
      if (style === 'pedal') len = sp.len - 0.5;
      const slide = k === 0 && rng.chance(0.12) && Math.abs(prevBass - m) <= 5 && Math.abs(prevBass - m) >= 2 ? prevBass - m : undefined;
      const vel = (k === 0 ? 0.86 : 0.7) * gain * (style === 'pedal' ? 0.6 : 1) * (1 + rng.gauss() * 0.05);
      addNote('bass', 'bass', sp.start + h, len, m, vel, human(0.004) + 0.003, slide);
      prevBass = m;
    });
    if (approach) {
      addNote('bass', 'bass', sp.start + approach.at, sp.len - approach.at - 0.3, approach.m, 0.62 * gain, human(0.004) + 0.004);
      prevBass = approach.m;
    }
    if (run) {
      run.forEach((r, k) => addNote('bass', 'bass', sp.start + r.at, 1.7, r.m, (0.6 + 0.05 * k) * gain, human(0.004) + 0.004));
      prevBass = run[run.length - 1].m;
    }
  }

  // ---------------- chords ----------------
  const chordVel = plan.chordInst === 'guitar' ? 0.6 : plan.chordInst === 'piano' ? 0.55 : plan.chordInst === 'pad' ? 0.5 : 0.58;
  const arpPatterns: readonly (readonly number[])[] = [
    [0, 2, 1, 3, 2, 1, 3, 2],
    [0, 1, 2, 3, 2, 1, 2, 3],
    [0, 2, 1, 2, 0, 3, 1, 2],
    [0, 3, 1, 2, 0, 3, 2, 1],
  ];
  const gtrArp = rng.pick(arpPatterns);
  // chord hits, generated span by span so anticipations can borrow time from the previous span
  interface PlacedHit {
    pos: number;
    len: number;
    vel: number;
    notes: number[];
    roll: boolean;
    up: boolean;
  }
  const placed: PlacedHit[] = [];
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const L = layers[sp.sectionIndex];
    if (!L.chords) continue;
    const sec = sp.section;
    const gain = SECTION_GAIN[sec] * chordVel;
    let style: CompStyle = plan.comp;
    if (plan.chordInst !== 'guitar' && (sec === 'intro' || sec === 'break' || sec === 'outro')) style = rng.chance(0.6) ? 'sustain' : 'roll';
    if (plan.chordInst === 'guitar' && sec === 'break') style = 'arp';
    if (plan.chordInst === 'pad') {
      for (const m of sp.voicing) addNote('pad', 'chord', sp.start, sp.len + 0.6, m, gain * (0.9 + rng.next() * 0.15), human(0.01));
      continue;
    }
    if (style === 'arp') {
      const v = sp.voicing;
      for (let o = 0; o < sp.len; o += 2) {
        const slot = (o / 2) % 8;
        const idx = Math.min(v.length - 1, gtrArp[slot] % Math.max(1, v.length));
        const ring = Math.min(sp.len - o, slot === 0 ? 8 : 5);
        const vel = (slot === 0 ? 1 : 0.78) * gain * (1 + rng.gauss() * 0.07);
        addNote('guitar', 'chord', sp.start + o, ring, v[idx], vel, human(0.007));
      }
      continue;
    }
    const firstOfSection = i === 0 || spans[i - 1].sectionIndex !== sp.sectionIndex;
    const hits = compHits(style, sp.len, rng, st.rollProb, firstOfSection);
    for (const h of hits) {
      const v = sp.voicing;
      let notes = v;
      if (h.sub === 'upper') notes = v.slice(Math.max(0, v.length - (v.length >= 4 ? 3 : 2)));
      if (h.sub === 'top') notes = v.slice(-1);
      placed.push({ pos: sp.start + h.at, len: h.len, vel: h.vel * gain, notes, roll: !!h.roll, up: !!h.up });
    }
  }
  placed.sort((a, b) => a.pos - b.pos);
  const chordInst: InstId = plan.chordInst === 'pad' ? 'pad' : plan.chordInst;
  for (let i = 0; i < placed.length; i++) {
    const h = placed[i];
    const nextPos = i + 1 < placed.length ? placed[i + 1].pos : totalSteps;
    let len = h.len < 0 ? nextPos - h.pos : Math.min(h.len, nextPos - h.pos);
    len = Math.max(0.5, len - 0.12);
    const n = h.notes.length;
    const gap = h.roll ? rng.range(0.015, 0.045) * (chordInst === 'guitar' ? 0.6 : 1) : 0;
    const base = human(0.006);
    h.notes.forEach((m, k) => {
      const order = h.up ? n - 1 - k : k;
      const top = k === n - 1 ? 0.06 : 0;
      const vel = h.vel * (1 + top + rng.gauss() * 0.05) * (h.roll ? 1 - order * 0.03 : 1);
      addNote(chordInst, 'chord', h.pos, len, m, vel, base + order * gap + human(0.003));
    });
  }

  // ---------------- pad layer ----------------
  for (const sp of spans) {
    const L = layers[sp.sectionIndex];
    if (!L.pad || sp.pad.length === 0) continue;
    const gain = SECTION_GAIN[sp.section] * 0.48;
    for (const m of sp.pad) addNote('pad', 'pad', sp.start, sp.len + 0.5, m, gain * (0.92 + rng.next() * 0.12), human(0.012));
  }

  // ---------------- melody ----------------
  const melodyMotif: Motif = makeMotif(rng, st.density);
  const answerMotif: Motif = makeAnswer(melodyMotif, rng, [Math.max(2, st.density[0] - 2), Math.max(3, st.density[1] - 2)]);
  const voicingAt = (p: number): number[] => {
    const sp = spanAt(p);
    const out: number[] = [];
    const add = (s: ChordSpan) => {
      const L = layers[s.sectionIndex];
      if (L.chords) out.push(...s.voicing);
      if (L.pad) out.push(...s.pad);
    };
    add(sp);
    // anticipated ("pushed") chords sound up to an 8th before their span
    const idx = spans.indexOf(sp);
    const nx = spans[idx + 1];
    if (nx && p >= nx.start - 2.01) add(nx);
    return out;
  };
  const coreVoicingAt = (p: number): number[] => {
    const sp = spanAt(p);
    const L = layers[sp.sectionIndex];
    return [...(L.chords ? sp.voicing : []), ...(L.pad ? sp.pad : [])];
  };
  const chordAt = (p: number): ChordSeg => {
    const sp = spanAt(p);
    return { chord: sp.chord, start: sp.start, end: sp.start + sp.len };
  };
  let prevMel: number | null = null;
  const melodyNotes: { n: MelNote; inst: InstId }[] = [];
  let secStart = 0;
  plan.sections.forEach((sec, si) => {
    const L = layers[si];
    const start = secStart;
    secStart += sec.bars * 16;
    if (L.melody === 'none') return;
    let inst: InstId = plan.melodyInst;
    if (L.melody === 'frag' && rng.chance(0.5)) inst = plan.melodyInst === 'bell' ? 'piano' : 'bell';
    const range = melodyRange(inst, plan.bell);
    const ctx: MelodyCtx = {
      key, lo: range.lo, hi: range.hi, center: range.center, chordAt, voicingAt, coreVoicingAt,
      vel: range.vel * SECTION_GAIN[sec.name], rng,
    };
    const slots = Math.floor(sec.bars / 2);
    const doubled = sec.name === 'B2' && inst !== 'bell' && L.melody === 'main' && rng.chance(0.5);
    let plan2: readonly Slot[];
    if (L.melody === 'sparse') plan2 = rng.pick<readonly Slot[]>([['-', 'M', '-', 'A'], ['-', '-', 'M', '-'], ['-', 'A', '-', 'M']]);
    else if (L.melody === 'frag') plan2 = rng.pick<readonly Slot[]>([['-', 'V', '-', '-'], ['-', '-', 'V', '-'], ['V', '-', '-', '-']]);
    else plan2 = rng.pick(PHRASE_PLANS);
    // a second voice answers in the rests of the main melody (call and response between instruments)
    const counterInst: InstId = inst === 'bell' ? (plan.chordInst === 'piano' ? 'ep' : 'piano') : 'bell';
    const counterProb = sec.name === 'B2' ? 0.7 : sec.name === 'A2' || sec.name === 'B' ? 0.45 : 0;
    for (let k = 0; k < slots; k++) {
      const slot = plan2[k % plan2.length];
      if (slot === '-') {
        if ((L.melody === 'main' || L.melody === 'var') && k > 0 && rng.chance(counterProb)) {
          const cr = melodyRange(counterInst, plan.bell);
          // the answer must also sit well against main-melody notes still ringing
          const melAt = (p: number) => melodyNotes.filter(({ n }) => n.pos <= p && n.pos + n.len > p).map(({ n }) => n.midi);
          const cctx: MelodyCtx = {
            ...ctx, lo: cr.lo, hi: cr.hi, center: cr.center + 2, vel: cr.vel * 0.72 * SECTION_GAIN[sec.name],
            voicingAt: (p) => [...voicingAt(p), ...melAt(p)],
            coreVoicingAt: (p) => [...coreVoicingAt(p), ...melAt(p)],
          };
          const ans = makeMotif(rng, [2, 4], true, 32);
          const slotEnd = start + (k + 1) * 32;
          const r = realiseMotif(ans, start + k * 32 + 4, cctx, null, { resolve: true, graceProb: 0 });
          for (const n of r.notes) {
            if (n.pos >= slotEnd - 2) continue;
            melodyNotes.push({ n: { ...n, len: Math.min(n.len, slotEnd - n.pos - 0.5) }, inst: counterInst });
          }
        }
        continue;
      }
      const slotPos = start + k * 32;
      let motif: Motif;
      let resolve = false;
      let lift = 0;
      switch (slot) {
        case 'M':
          motif = L.melody === 'var' ? varyMotif(melodyMotif, rng) : melodyMotif;
          if (L.melody === 'var' && k === 2) lift = 3;
          break;
        case 'V':
          motif = varyMotif(melodyMotif, rng, L.melody === 'frag' ? 'truncate' : undefined);
          break;
        case 'A':
          motif = answerMotif;
          break;
        default:
          motif = varyMotif(answerMotif, rng, 'tail');
          resolve = true;
      }
      const r = realiseMotif(motif, slotPos, ctx, prevMel, { resolve, lift, graceProb: inst === 'ep' || inst === 'piano' || inst === 'guitar' ? 0.08 : 0.03 });
      for (const n of r.notes) melodyNotes.push({ n, inst });
      if (doubled) {
        // soft mallet doubling (an octave up when there is room) for lift in the last melodic section
        for (const n of r.notes) {
          if (n.grace) continue;
          const up = n.midi + 12 <= 88 ? 12 : 0;
          melodyNotes.push({ n: { ...n, midi: n.midi + up, vel: n.vel * 0.5 }, inst: 'bell' });
        }
      }
      if (r.last !== null) prevMel = r.last;
    }
  });
  const melStart = events.length;
  for (const { n, inst } of melodyNotes) {
    const extra = (n.grace ? -n.grace : 0) + human(0.008);
    addNote(inst, 'melody', n.pos, n.len, n.midi, n.vel, extra);
  }
  // final safety pass against what actually sounds (anticipations, rolls, pads): no minor 2nds / 9ths
  {
    const harmony = events.filter((e): e is NoteEv => e.k === 'n' && (e.role === 'chord' || e.role === 'pad'));
    const sounding = (t0: number, t1: number) => harmony.filter((h) => h.t < t1 && h.t + h.d > t0);
    const drop = new Set<ScoreEv>();
    for (let i = melStart; i < events.length; i++) {
      const e = events[i] as NoteEv;
      const hs = sounding(e.t + 0.03, e.t + e.d - 0.03).filter((h) => clashes(e.m, [h.m]));
      if (!hs.length) continue;
      // 1) an anticipated chord arrives during the note: end the note just before it
      const later = Math.min(...hs.map((h) => h.t));
      if (later > e.t + 0.12) {
        e.d = later - e.t - 0.02;
        continue;
      }
      // 2) move to the nearest chord-scale tone that sits well with everything sounding
      const sp = spanAt(e.p);
      const allowedPcs = melodyAllowed(sp.chord, key, false);
      const all = sounding(e.t + 0.03, e.t + e.d - 0.03).map((h) => h.m);
      let fixed = false;
      for (let r = 1; r <= 7 && !fixed; r++) {
        for (const c of [e.m + r, e.m - r]) {
          if (allowedPcs.includes(mod12(c)) && !clashes(c, all)) {
            e.m = c;
            fixed = true;
            break;
          }
        }
      }
      // 3) otherwise a short note is simply left out
      if (!fixed) drop.add(e);
    }
    if (drop.size) for (let i = events.length - 1; i >= melStart; i--) if (drop.has(events[i])) events.splice(i, 1);
  }

  // ---------------- arpeggios (bells / piano) ----------------
  const arpInst: InstId = st.drift ? (plan.melodyInst === 'bell' ? 'piano' : 'bell') : 'bell';
  const arpPat = rng.pick<readonly number[]>([[0, 1, 2, 3], [0, 1, 2, 3, 2, 1], [0, 2, 1, 3], [3, 2, 1, 0, 1, 2]]);
  // Drift breathes: quarter notes or dotted eighths, with more gaps
  const arpRate = st.drift ? rng.weighted([[4, 2], [3, 1.5], [2, 0.6]] as const) : 2;
  const arpSkip = st.drift ? 0.24 : 0.14;
  let prevArp: number[] | null = null;
  for (const sp of spans) {
    const L = layers[sp.sectionIndex];
    if (!L.arp) continue;
    const hasMelHere = L.melody === 'main' || L.melody === 'var';
    const lo = hasMelHere ? 55 : 62;
    const hi = hasMelHere ? 70 : 84;
    const v = voiceChord(sp.chord, prevArp, { lo, hi, center: (lo + hi) / 2, maxSpan: 16, minNotes: 4, maxNotes: 4, rooted: sp.chord.bass === undefined, rng, jitter: 0.6 });
    prevArp = v;
    const gain = SECTION_GAIN[sp.section] * (arpInst === 'bell' ? 0.42 : 0.4) * (hasMelHere ? 0.75 : 1);
    let k = 0;
    for (let o = 0; o < sp.len; o += arpRate, k++) {
      if (rng.chance(arpSkip) && k > 0) continue;
      const m = v[arpPat[k % arpPat.length] % v.length];
      addNote(arpInst, 'arp', sp.start + o, Math.min(sp.len - o, arpRate * 3), m, gain * (k % arpPat.length === 0 ? 1.1 : 1) * (1 + rng.gauss() * 0.08), human(0.006));
    }
  }

  // ---------------- arrangement FX ----------------
  const fx = (p: number, kind: FxKind, to: number, dur: number) => events.push({ k: 'fx', t: timeOf(p), p, fx: kind, to, dur });
  const OPEN = 20000;
  let barPos = 0;
  plan.sections.forEach((sec, si) => {
    const start = barPos * 16;
    const end = (barPos + sec.bars) * 16;
    const barSec = plan.barDur;
    if (sec.name === 'intro') {
      const closed = st.drift ? rng.range(1500, 2600) : rng.range(650, 1100);
      fx(0, 'filter', closed, 0.01);
      fx(end - 16, 'filter', OPEN, barSec * 0.95);
    }
    if (sec.name === 'break') {
      fx(start, 'filter', st.drift ? 3500 : rng.range(1800, 3200), barSec * 0.5);
      fx(end - 16, 'filter', OPEN, barSec * 0.9);
    }
    const next = plan.sections[si + 1];
    if (next && (next.name === 'B' || next.name === 'B2' || (sec.name === 'break' && !st.drift)) && rng.chance(st.drift ? 0.2 : 0.55)) {
      fx(end - 16, 'riser', st.drift ? 0.5 : 0.8, barSec);
    }
    if (sec.name === 'outro') {
      const tEnd = timeOf(end);
      if (plan.ending === 'filter') {
        fx(start, 'filter', 420, barSec * sec.bars);
        fx(end - 16, 'fade', 0, barSec * 1.2);
      } else if (plan.ending === 'fade') {
        fx(start + 16, 'filter', 2600, barSec * (sec.bars - 1));
        fx(end - 32, 'fade', 0, barSec * 2.4);
      } else {
        // tape stop a beat and a half into the last bar
        const p = end - 16 + 6;
        fx(p, 'tapestop', 0, Math.min(1.1, tEnd - timeOf(p) + 0.6));
      }
    }
    barPos += sec.bars;
  });

  events.sort((a, b) => a.t - b.t);
  // nothing may start after the end of the form
  const formEnd = timeOf(totalSteps);
  const evs = events.filter((e) => e.t < formEnd + 0.05);
  const progressions = [progA.id, progB.id];
  return { plan, events: evs, chords: spans, sections: sectionSpans, duration: plan.duration, progressions, notes };
}
