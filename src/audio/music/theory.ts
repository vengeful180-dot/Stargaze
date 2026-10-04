// Music theory helpers: keys, chord qualities, voicing search with voice leading, melody pitch sets.
// Pure functions (no Web Audio) so the composer can run anywhere, including Node for score dumps.
import type { Rng } from '../../core/rng';

export type Mode = 'major' | 'minor';
export interface Key {
  tonic: number; // pitch class 0..11
  mode: Mode;
}

export const SCALES: Record<Mode, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};
export const PENTATONIC: Record<Mode, readonly number[]> = {
  major: [0, 2, 4, 7, 9],
  minor: [0, 3, 5, 7, 10],
};

export type Quality =
  | 'maj7' | 'maj9' | '69' | 'maj7#11'
  | 'm7' | 'm9' | 'm11' | 'm6'
  | '7' | '9' | '13' | '9sus' | '13sus' | '7b9' | '7b13'
  | 'm7b5' | 'dim7';

export type Family = 'maj' | 'min' | 'dom' | 'hdim' | 'dim';

export interface QualityDef {
  symbol: string;
  family: Family;
  /** chord tones including the colour tones this quality implies (intervals mod 12) */
  tones: readonly number[];
  /** rootless voicing pitch-class sets */
  sets: readonly (readonly number[])[];
  /** voicings that include the root (pads, guitar) */
  rootSets: readonly (readonly number[])[];
  /** melody notes that may land on strong beats / long notes */
  stable: readonly number[];
  /** melody notes allowed on weak positions (no avoid notes) */
  allowed: readonly number[];
  third: number | null;
  fifth: number;
}

export const QUALITIES: Record<Quality, QualityDef> = {
  maj7: {
    symbol: 'maj7', family: 'maj', tones: [0, 4, 7, 11],
    sets: [[4, 7, 11]], rootSets: [[0, 4, 7, 11], [0, 4, 11]],
    stable: [0, 4, 7, 11], allowed: [0, 2, 4, 7, 9, 11], third: 4, fifth: 7,
  },
  maj9: {
    symbol: 'maj9', family: 'maj', tones: [0, 4, 7, 11, 2],
    sets: [[4, 7, 11, 2], [4, 11, 2]], rootSets: [[0, 4, 11, 2], [0, 4, 7, 11, 2], [0, 7, 11, 4]],
    stable: [0, 2, 4, 7, 11], allowed: [0, 2, 4, 7, 9, 11], third: 4, fifth: 7,
  },
  '69': {
    symbol: '6/9', family: 'maj', tones: [0, 4, 7, 9, 2],
    sets: [[4, 7, 9, 2], [4, 9, 2]], rootSets: [[0, 4, 9, 2], [0, 7, 9, 2, 4]],
    stable: [0, 2, 4, 7, 9], allowed: [0, 2, 4, 7, 9], third: 4, fifth: 7,
  },
  'maj7#11': {
    symbol: 'maj7♯11', family: 'maj', tones: [0, 4, 7, 11, 2, 6],
    sets: [[4, 11, 2, 6], [4, 7, 11, 6]], rootSets: [[0, 4, 11, 6], [0, 7, 11, 2, 6]],
    stable: [0, 2, 4, 6, 7, 11], allowed: [0, 2, 4, 6, 7, 9, 11], third: 4, fifth: 7,
  },
  m7: {
    symbol: 'm7', family: 'min', tones: [0, 3, 7, 10],
    sets: [[3, 7, 10]], rootSets: [[0, 3, 7, 10], [0, 3, 10]],
    stable: [0, 3, 7, 10], allowed: [0, 2, 3, 5, 7, 10], third: 3, fifth: 7,
  },
  m9: {
    symbol: 'm9', family: 'min', tones: [0, 3, 7, 10, 2],
    sets: [[3, 7, 10, 2], [3, 10, 2]], rootSets: [[0, 3, 10, 2], [0, 3, 7, 10, 2], [0, 7, 10, 3]],
    stable: [0, 2, 3, 7, 10], allowed: [0, 2, 3, 5, 7, 10], third: 3, fifth: 7,
  },
  m11: {
    symbol: 'm11', family: 'min', tones: [0, 3, 7, 10, 2, 5],
    sets: [[3, 10, 2, 5], [5, 10, 3, 7], [10, 3, 5]], rootSets: [[0, 5, 10, 3], [0, 3, 10, 2, 5], [0, 7, 10, 3, 5]],
    stable: [0, 2, 3, 5, 7, 10], allowed: [0, 2, 3, 5, 7, 10], third: 3, fifth: 7,
  },
  m6: {
    symbol: 'm6', family: 'min', tones: [0, 3, 7, 9],
    sets: [[3, 7, 9], [3, 9, 2, 7]], rootSets: [[0, 3, 9, 7], [0, 7, 9, 3]],
    stable: [0, 3, 7, 9], allowed: [0, 2, 3, 5, 7, 9], third: 3, fifth: 7,
  },
  '7': {
    symbol: '7', family: 'dom', tones: [0, 4, 7, 10],
    sets: [[4, 7, 10]], rootSets: [[0, 4, 10, 7], [0, 4, 10]],
    stable: [0, 4, 7, 10], allowed: [0, 2, 4, 7, 9, 10], third: 4, fifth: 7,
  },
  '9': {
    symbol: '9', family: 'dom', tones: [0, 4, 7, 10, 2],
    sets: [[4, 7, 10, 2], [4, 10, 2]], rootSets: [[0, 4, 10, 2], [0, 7, 10, 4]],
    stable: [0, 2, 4, 7, 10], allowed: [0, 2, 4, 7, 9, 10], third: 4, fifth: 7,
  },
  '13': {
    symbol: '13', family: 'dom', tones: [0, 4, 10, 2, 9],
    sets: [[4, 9, 10, 2], [4, 10, 9]], rootSets: [[0, 4, 10, 9], [0, 10, 4, 9, 2]],
    stable: [0, 2, 4, 9, 10], allowed: [0, 2, 4, 7, 9, 10], third: 4, fifth: 7,
  },
  '9sus': {
    symbol: '9sus4', family: 'dom', tones: [0, 5, 7, 10, 2],
    sets: [[5, 10, 2], [5, 7, 10, 2]], rootSets: [[0, 5, 10, 2], [0, 7, 10, 2, 5]],
    stable: [0, 2, 5, 7, 10], allowed: [0, 2, 5, 7, 9, 10], third: null, fifth: 7,
  },
  '13sus': {
    symbol: '13sus4', family: 'dom', tones: [0, 5, 10, 2, 9],
    sets: [[10, 2, 5, 9], [5, 10, 2]], rootSets: [[0, 10, 2, 5, 9], [0, 5, 10, 2]],
    stable: [0, 2, 5, 9, 10], allowed: [0, 2, 5, 7, 9, 10], third: null, fifth: 7,
  },
  '7b9': {
    symbol: '7♭9', family: 'dom', tones: [0, 4, 7, 10, 1],
    sets: [[4, 7, 10, 1], [4, 10, 1]], rootSets: [[0, 4, 10, 1], [0, 4, 7, 10]],
    stable: [0, 1, 4, 7, 10], allowed: [0, 1, 4, 7, 8, 10], third: 4, fifth: 7,
  },
  '7b13': {
    symbol: '9♭13', family: 'dom', tones: [0, 4, 10, 2, 8],
    sets: [[4, 8, 10], [10, 2, 4, 8]], rootSets: [[0, 4, 10, 8], [0, 10, 4, 8]],
    stable: [0, 2, 4, 8, 10], allowed: [0, 2, 4, 8, 10], third: 4, fifth: 8,
  },
  m7b5: {
    symbol: 'm7♭5', family: 'hdim', tones: [0, 3, 6, 10],
    sets: [[3, 6, 10], [3, 6, 10, 5]], rootSets: [[0, 3, 6, 10], [0, 6, 10, 3]],
    stable: [0, 3, 6, 10], allowed: [0, 3, 5, 6, 8, 10], third: 3, fifth: 6,
  },
  dim7: {
    symbol: '°7', family: 'dim', tones: [0, 3, 6, 9],
    sets: [[0, 3, 6, 9]], rootSets: [[0, 3, 6, 9]],
    stable: [0, 3, 6, 9], allowed: [0, 2, 3, 5, 6, 8, 9, 11], third: 3, fifth: 6,
  },
};

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

export const mod12 = (x: number) => ((x % 12) + 12) % 12;

/** Whether a key is conventionally written with flats. */
export function keyUsesFlats(k: Key): boolean {
  const majorTonic = k.mode === 'major' ? k.tonic : mod12(k.tonic + 3);
  return [0, 5, 10, 3, 8, 1, 6].includes(majorTonic);
}

export function pcName(pc: number, flats: boolean): string {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)];
}

export function keyName(k: Key): string {
  return `${pcName(k.tonic, keyUsesFlats(k))} ${k.mode}`;
}

/** Note name with octave, e.g. "E♭4" (ASCII variant for dumps when ascii=true). */
export function noteName(m: number, flats = true, ascii = false): string {
  let n = pcName(m, flats) + (Math.floor(m / 12) - 1);
  if (ascii) n = n.replace('♯', '#').replace('♭', 'b');
  return n;
}

export interface Chord {
  root: number; // absolute pitch class
  q: Quality;
  /** slash-bass pitch class (defaults to root) */
  bass?: number;
  flats: boolean;
}

export function chordSymbol(c: Chord, ascii = false): string {
  let s = pcName(c.root, c.flats) + QUALITIES[c.q].symbol;
  if (c.bass !== undefined && c.bass !== c.root) s += '/' + pcName(c.bass, c.flats);
  if (ascii) s = s.replace(/♯/g, '#').replace(/♭/g, 'b').replace('°', 'dim');
  return s;
}

export function chordTonePcs(c: Chord): number[] {
  return QUALITIES[c.q].tones.map((i) => mod12(c.root + i));
}

export function keyScalePcs(k: Key): number[] {
  return SCALES[k.mode].map((i) => mod12(k.tonic + i));
}

/** Melody pitch classes allowed over a chord: the chord-scale minus avoid notes, kept in key unless a chord tone. */
export function melodyAllowed(c: Chord, k: Key, stableOnly: boolean): number[] {
  const d = QUALITIES[c.q];
  const tones = new Set(chordTonePcs(c));
  const scale = new Set(keyScalePcs(k));
  const rel = stableOnly ? d.stable : d.allowed;
  const out: number[] = [];
  for (const i of rel) {
    const pc = mod12(c.root + i);
    if (scale.has(pc) || tones.has(pc)) out.push(pc);
  }
  // never empty: fall back to chord tones
  return out.length >= 3 ? out : Array.from(tones);
}

/** Interval name of a pitch class relative to a chord root (for score dumps). */
export function degreeLabel(c: Chord, pc: number): string {
  const i = mod12(pc - c.root);
  const d = QUALITIES[c.q];
  const isTone = d.tones.includes(i);
  const labels: Record<number, string> = {
    0: 'R', 1: 'b9', 2: '9', 3: d.family === 'dom' ? '#9' : 'b3', 4: '3', 5: d.third === null ? '4' : '11', 6: d.family === 'hdim' || d.family === 'dim' ? 'b5' : '#11',
    7: '5', 8: d.family === 'dom' ? 'b13' : '#5', 9: d.family === 'dim' ? 'bb7' : '13', 10: 'b7', 11: '7',
  };
  return (labels[i] ?? '?') + (isTone ? '' : '*');
}

export interface VoiceOpts {
  lo: number;
  hi: number;
  center: number;
  maxSpan: number;
  minNotes?: number;
  maxNotes?: number;
  /** allow voicings that include the root at the bottom */
  rooted?: boolean;
  /** only root-position voicings */
  rootedOnly?: boolean;
  rng: Rng;
  /** random cost jitter to vary choices between near-equal voicings */
  jitter?: number;
  /** preferred top note */
  topTarget?: number;
}

/** Order-preserving minimal L1 matching between two sorted voicings (DP). */
export function voiceMovement(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  const n = s.length;
  const m = l.length;
  // dp[i][j]: min cost matching first i of s into first j of l
  const INF = 1e9;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(INF);
    for (let j = i; j <= m; j++) {
      cur[j] = Math.min(cur[j - 1], prev[j - 1] + Math.abs(s[i - 1] - l[j - 1]));
    }
    prev = cur;
  }
  let cost = prev[m];
  // unmatched voices of the larger set: count half their distance to the nearest note of the smaller one
  if (m > n) {
    let extra = 0;
    for (const x of l) {
      let best = INF;
      for (const y of s) best = Math.min(best, Math.abs(x - y));
      extra += best;
    }
    cost += (extra / m) * (m - n) * 0.5;
  }
  return cost;
}

function validVoicing(notes: number[]): boolean {
  for (let i = 1; i < notes.length; i++) {
    const d = notes[i] - notes[i - 1];
    const low = notes[i - 1];
    if (d < 1) return false;
    if (d === 1) return false; // no minor seconds in voicings
    if (d === 2 && low < 51) return false; // low interval limits
    if (d <= 3 && low < 46) return false;
    if (i >= 2 && notes[i] - notes[i - 2] <= 4) return false; // no 3-note clusters
  }
  for (let i = 0; i < notes.length; i++)
    for (let j = i + 1; j < notes.length; j++) if (notes[j] - notes[i] === 13) return false; // no minor ninths
  return true;
}

/** Choose a voicing for the chord that is playable, in register, and close to the previous one.
 * If the register is too tight for this chord, it widens a little at a time. */
export function voiceChord(c: Chord, prev: readonly number[] | null, o: VoiceOpts): number[] {
  // widen upwards first: a voicing pushed down into the bass register muddies the low end
  const steps: readonly (readonly [number, number])[] = [[0, 0], [0, 3], [1, 5], [2, 8], [3, 10], [6, 12]];
  for (const [dl, dh] of steps) {
    const v = voiceChordIn(c, prev, dl || dh ? { ...o, lo: o.lo - dl, hi: o.hi + dh, maxSpan: o.maxSpan + Math.max(dl, dh) / 2 } : o);
    if (v) return v;
  }
  const d = QUALITIES[c.q];
  const out: number[] = [];
  let m = o.lo;
  for (const i of d.sets[0]) {
    const pc = mod12(c.root + i);
    while (mod12(m) !== pc) m++;
    out.push(m);
    m += 3;
  }
  return out;
}

function voiceChordIn(c: Chord, prev: readonly number[] | null, o: VoiceOpts): number[] | null {
  const d = QUALITIES[c.q];
  const minN = o.minNotes ?? 3;
  const maxN = o.maxNotes ?? 4;
  let sets: (readonly number[])[] = o.rootedOnly ? [...d.rootSets] : o.rooted ? [...d.rootSets, ...d.sets] : [...d.sets];
  sets = sets.filter((s) => s.length >= minN && s.length <= maxN);
  if (sets.length === 0) sets = [o.rootedOnly || o.rooted ? d.rootSets[0] : d.sets[0]].map((s) => s.slice(0, maxN));
  let best: number[] | null = null;
  let bestCost = Infinity;
  const jitter = o.jitter ?? 1.0;
  const prevTop = prev && prev.length ? prev[prev.length - 1] : null;
  for (const set of sets) {
    const rooted = set[0] === 0 && d.family !== 'dim';
    const pcs = set.map((i) => mod12(c.root + i));
    const opts: number[][] = pcs.map((pc) => {
      const arr: number[] = [];
      for (let m = o.lo; m <= o.hi; m++) if (mod12(m) === pc) arr.push(m);
      return arr;
    });
    if (opts.some((a) => a.length === 0)) continue;
    const idx = new Array(pcs.length).fill(0);
    for (;;) {
      const notes = idx.map((k, j) => opts[j][k]).sort((a, b) => a - b);
      const okRoot = !rooted || mod12(notes[0]) === mod12(c.root);
      const span = notes[notes.length - 1] - notes[0];
      if (okRoot && span <= o.maxSpan && validVoicing(notes)) {
        let cost = 0;
        const mean = notes.reduce((a, b) => a + b, 0) / notes.length;
        if (prev && prev.length) {
          cost += voiceMovement(prev, notes) * 1.0;
          const top = notes[notes.length - 1];
          const tm = Math.abs(top - (prevTop as number));
          cost += tm * 0.35 + (tm > 5 ? 2.5 : 0);
          cost += Math.abs(mean - o.center) * 0.45;
        } else {
          cost += Math.abs(mean - o.center) * 1.2;
        }
        const idealLo = notes.length >= 4 ? 9 : 7;
        const idealHi = notes.length >= 4 ? 15 : 12;
        if (span < idealLo) cost += (idealLo - span) * 0.6;
        if (span > idealHi) cost += (span - idealHi) * 0.5;
        cost += (maxN - notes.length) * 0.9;
        if (o.topTarget !== undefined) cost += Math.abs(notes[notes.length - 1] - o.topTarget) * 0.5;
        cost += o.rng.next() * jitter;
        if (cost < bestCost) {
          bestCost = cost;
          best = notes;
        }
      }
      // next combination
      let k = 0;
      while (k < idx.length) {
        idx[k]++;
        if (idx[k] < opts[k].length) break;
        idx[k] = 0;
        k++;
      }
      if (k === idx.length) break;
    }
  }
  return best;
}

/** Nearest MIDI note to `target` whose pitch class is in `pcs`, inside [lo, hi]. */
export function nearestInSet(target: number, pcs: readonly number[], lo: number, hi: number, dir = 0): number {
  let best = target;
  let bestD = Infinity;
  for (let m = lo; m <= hi; m++) {
    if (!pcs.includes(mod12(m))) continue;
    let dd = Math.abs(m - target);
    if (dir > 0 && m < target) dd += 0.5;
    if (dir < 0 && m > target) dd += 0.5;
    if (dd < bestD) {
      bestD = dd;
      best = m;
    }
  }
  return best;
}

/** Move `steps` scale steps from `from` within the pitch-class set (ordered by pitch). */
export function stepInSet(from: number, steps: number, pcs: readonly number[], lo: number, hi: number): number {
  const pool: number[] = [];
  for (let m = lo - 12; m <= hi + 12; m++) if (pcs.includes(mod12(m))) pool.push(m);
  if (pool.length === 0) return from;
  // index of nearest pool note at or around `from`
  let i = 0;
  let bd = Infinity;
  for (let k = 0; k < pool.length; k++) {
    const dd = Math.abs(pool[k] - from);
    if (dd < bd) {
      bd = dd;
      i = k;
    }
  }
  // if `from` is not in the pool, a step in a direction should land on the nearest in that direction first
  if (pool[i] !== from && steps !== 0) {
    if (steps > 0 && pool[i] < from) i++;
    if (steps < 0 && pool[i] > from) i--;
    steps -= Math.sign(steps);
  }
  const j = Math.max(0, Math.min(pool.length - 1, i + steps));
  return pool[j];
}
