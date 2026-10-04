// Jazz / neo-soul progression library (roman numerals) and loop-evolution substitutions.
import type { Rng } from '../../core/rng';
import { type Key, type Mode, type Quality, QUALITIES, SCALES, mod12, keyUsesFlats } from './theory';
import type { Chord } from './theory';

/** One chord of a progression, relative to the key. */
export interface PChord {
  deg: number; // semitones above the tonic
  q: Quality;
  beats: number;
  /** bass note as interval above the chord root (slash chords) */
  bassInt?: number;
  /** spelling hint from the numeral (b / #) */
  acc?: -1 | 1;
}

export interface Progression {
  id: string;
  mode: Mode;
  /** one string per bar; tokens like "ii:m9", "bVII:9", "#I:dim7", "I:maj9/3"; 2 tokens split the bar */
  bars: readonly string[];
  weight: number;
  /** where it fits: A = home loop, B = contrast loop, D = drift/slow (2 bars per chord) */
  tags: string;
}

const NUMERALS: Record<string, number> = { I: 0, II: 2, III: 4, IV: 5, V: 7, VI: 9, VII: 11 };

export function parseToken(tok: string, beats: number): PChord {
  const m = /^([b#]?)([ivIV]+):([^/]+)(?:\/(b?\d+))?$/.exec(tok);
  if (!m) throw new Error('bad chord token ' + tok);
  const acc = m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0;
  const base = NUMERALS[m[2].toUpperCase()];
  if (base === undefined) throw new Error('bad numeral ' + tok);
  const q = m[3] as Quality;
  if (!QUALITIES[q]) throw new Error('bad quality ' + tok);
  let bassInt: number | undefined;
  if (m[4]) {
    const map: Record<string, number> = { '3': QUALITIES[q].third ?? 4, '5': 7, b7: 10, '7': 11, '9': 2 };
    bassInt = map[m[4]];
  }
  return { deg: mod12(base + acc), q, beats, bassInt, acc: acc === 0 ? undefined : (acc as -1 | 1) };
}

export function parseProgression(p: Progression, barScale = 1): PChord[] {
  const out: PChord[] = [];
  for (const bar of p.bars) {
    const toks = bar.trim().split(/\s+/);
    const beats = (4 * barScale) / toks.length;
    for (const t of toks) out.push(parseToken(t, beats));
  }
  return out;
}

export const PROGRESSIONS: readonly Progression[] = [
  // ---- major ----
  { id: 'ii-V-I-vi', mode: 'major', bars: ['ii:m9', 'V:13', 'I:maj9', 'vi:m9'], weight: 3, tags: 'A' },
  { id: 'I-vi-ii-V', mode: 'major', bars: ['I:maj9', 'vi:m9', 'ii:m9', 'V:13'], weight: 3, tags: 'A' },
  { id: 'I-IV-iii-vi', mode: 'major', bars: ['I:maj7', 'IV:maj9', 'iii:m7', 'vi:m9'], weight: 3, tags: 'AD' },
  { id: 'IV-iv-I', mode: 'major', bars: ['IV:maj9', 'iv:m6', 'I:maj9', 'I:69'], weight: 2, tags: 'BD' },
  { id: 'backdoor', mode: 'major', bars: ['IV:maj7', 'bVII:9', 'I:maj9', 'vi:m9'], weight: 2, tags: 'AB' },
  { id: 'I-VI7-ii-V', mode: 'major', bars: ['I:maj9', 'VI:7b13', 'ii:m9', 'V:13'], weight: 2, tags: 'A' },
  { id: 'iii-VI-ii-V', mode: 'major', bars: ['iii:m7', 'VI:7b13', 'ii:m9', 'V:9sus V:13'], weight: 2, tags: 'B' },
  { id: 'I-#idim-ii-V', mode: 'major', bars: ['I:maj7', '#I:dim7', 'ii:m9', 'V:13'], weight: 1.5, tags: 'A' },
  { id: 'IV-iii-ii-I', mode: 'major', bars: ['IV:maj9', 'iii:m7', 'ii:m9', 'I:maj9'], weight: 3, tags: 'BD' },
  { id: 'two-of-us', mode: 'major', bars: ['IV:maj7', 'III:7b9', 'vi:m9', 'v:m7 I:9'], weight: 2.5, tags: 'AB' },
  { id: 'tritone', mode: 'major', bars: ['ii:m9', 'bII:9', 'I:maj9', 'vi:m9'], weight: 1.5, tags: 'A' },
  { id: 'I-iii-IV-iv', mode: 'major', bars: ['I:maj9', 'iii:m7', 'IV:maj9', 'iv:m6'], weight: 2, tags: 'AD' },
  { id: 'lydian-float', mode: 'major', bars: ['I:maj9', 'IV:maj7#11', 'vi:m9', 'IV:maj9'], weight: 2, tags: 'D' },
  { id: 'ii-iii-IV-V', mode: 'major', bars: ['ii:m9', 'iii:m7', 'IV:maj9', 'V:13sus'], weight: 2, tags: 'BD' },
  { id: 'IV-V-iii-vi', mode: 'major', bars: ['IV:maj9', 'V:13sus', 'iii:m7', 'vi:m9'], weight: 2.5, tags: 'BD' },
  { id: 'I-ii-iii-ii', mode: 'major', bars: ['I:maj9', 'ii:m9', 'iii:m7', 'ii:m11'], weight: 1.5, tags: 'D' },
  { id: 'vi-ii-V-I', mode: 'major', bars: ['vi:m9', 'ii:m9', 'V:13', 'I:maj9'], weight: 2, tags: 'B' },
  { id: 'I-V/vi', mode: 'major', bars: ['I:maj9', 'III:7b9', 'vi:m9', 'IV:maj9 iv:m6'], weight: 2, tags: 'AB' },
  // ---- minor ----
  { id: 'i-iv-bVI-V', mode: 'minor', bars: ['i:m9', 'iv:m9', 'bVI:maj7', 'V:7b9'], weight: 3, tags: 'A' },
  { id: 'dorian-vamp', mode: 'minor', bars: ['i:m9', 'IV:9', 'i:m11', 'IV:13'], weight: 2, tags: 'AD' },
  { id: 'two-of-us-min', mode: 'minor', bars: ['bVI:maj7', 'V:7b9', 'i:m9', 'bvii:m7 bIII:9'], weight: 3, tags: 'AB' },
  { id: 'i-bVI-bIII-bVII', mode: 'minor', bars: ['i:m9', 'bVI:maj9', 'bIII:maj9', 'bVII:13sus'], weight: 3, tags: 'AD' },
  { id: 'minor-ii-V-i', mode: 'minor', bars: ['ii:m7b5', 'V:7b9', 'i:m9', 'iv:m9'], weight: 2, tags: 'B' },
  { id: 'aeolian-fall', mode: 'minor', bars: ['i:m9', 'bVII:9sus', 'bVI:maj9', 'V:7b9'], weight: 2, tags: 'A' },
  { id: 'minor-circle', mode: 'minor', bars: ['iv:m9', 'bVII:13', 'bIII:maj9', 'bVI:maj7'], weight: 2.5, tags: 'BD' },
  { id: 'i-v-bVI-bVII', mode: 'minor', bars: ['i:m9', 'v:m7', 'bVI:maj7', 'bVII:9sus'], weight: 2, tags: 'AD' },
  { id: 'i-iv-vamp', mode: 'minor', bars: ['i:m9', 'iv:m9', 'i:m11', 'iv:m9'], weight: 1.5, tags: 'AD' },
  { id: 'i-bIII-iv-V', mode: 'minor', bars: ['i:m9', 'bIII:maj7', 'iv:m9', 'V:7b9'], weight: 2, tags: 'A' },
  { id: 'bVI-bVII-i', mode: 'minor', bars: ['bVI:maj9', 'bVII:13sus', 'i:m9', 'i:m11'], weight: 2, tags: 'BD' },
  { id: 'iv-v-bVI-V', mode: 'minor', bars: ['iv:m9', 'v:m7', 'bVI:maj7', 'ii:m7b5 V:7b9'], weight: 2, tags: 'B' },
];

export function progressionsFor(mode: Mode, tag: string): Progression[] {
  return PROGRESSIONS.filter((p) => p.mode === mode && p.tags.includes(tag));
}

export function pickProgression(rng: Rng, mode: Mode, tag: string, avoid?: string): Progression {
  let pool = progressionsFor(mode, tag).filter((p) => p.id !== avoid);
  if (pool.length === 0) pool = PROGRESSIONS.filter((p) => p.mode === mode && p.id !== avoid);
  return rng.weighted(pool.map((p) => [p, p.weight] as const));
}

// ------------------------------------------------------------------------------------------------
// Substitutions: small, safe re-harmonisations so repeated loops evolve instead of looping verbatim.

const isDom = (q: Quality) => QUALITIES[q].family === 'dom';
const isMin = (q: Quality) => QUALITIES[q].family === 'min';
const isMaj = (q: Quality) => QUALITIES[q].family === 'maj';

/** Count chord tones outside the key scale (lower is more diatonic). */
function chromaticism(deg: number, q: Quality, mode: Mode): number {
  const scale = SCALES[mode];
  let n = 0;
  for (const i of QUALITIES[q].tones) if (!scale.includes(mod12(deg + i))) n++;
  return n;
}

/** Best dominant colour for a chord resolving to `target`. */
function domFor(deg: number, target: PChord, mode: Mode, rng: Rng): Quality {
  const opts: Quality[] = isMin(target.q) || QUALITIES[target.q].family === 'hdim' ? ['7b13', '7b9'] : ['13', '9', '7b9'];
  let best = opts[0];
  let bestScore = Infinity;
  for (const q of opts) {
    const s = chromaticism(deg, q, mode) + rng.next() * 0.6;
    if (s < bestScore) {
      bestScore = s;
      best = q;
    }
  }
  return best;
}

const EXT_SWAPS: Partial<Record<Quality, Quality[]>> = {
  maj7: ['maj9', '69'],
  maj9: ['69', 'maj7'],
  '69': ['maj9'],
  m7: ['m9', 'm11'],
  m9: ['m11', 'm7'],
  m11: ['m9'],
  '9': ['13'],
  '13': ['9', '13sus'],
  '9sus': ['13sus'],
  '13sus': ['9sus'],
  m6: ['m9'],
};

export type SubKind = 'ext' | 'secdom' | 'tritone' | 'iiV' | 'modalIV' | 'passdim' | 'sus' | 'slip' | 'inversion';

export interface SubResult {
  chords: PChord[];
  applied: SubKind[];
}

/** Apply `count` random substitutions to a loop (returns a new array). The first chord is kept as the anchor. */
export function evolveLoop(loop: readonly PChord[], key: Key, rng: Rng, count: number, allowed: readonly SubKind[]): SubResult {
  let chords = loop.map((c) => ({ ...c }));
  const applied: SubKind[] = [];
  let guard = 0;
  while (applied.length < count && guard++ < 40) {
    const kind = rng.pick(allowed);
    const i = rng.int(0, chords.length - 1);
    const c = chords[i];
    const next = chords[(i + 1) % chords.length];
    let done = false;
    switch (kind) {
      case 'ext': {
        const sw = EXT_SWAPS[c.q];
        if (sw) {
          c.q = rng.pick(sw);
          done = true;
        }
        break;
      }
      case 'secdom': {
        // a minor chord a fifth above the next chord becomes its secondary dominant (vi -> VI7 before ii)
        if (i > 0 && isMin(c.q) && mod12(c.deg - next.deg) === 7) {
          c.q = domFor(c.deg, next, key.mode, rng);
          done = true;
        }
        break;
      }
      case 'tritone': {
        if (i > 0 && isDom(c.q) && mod12(c.deg - next.deg) === 7 && c.q !== '9sus' && c.q !== '13sus') {
          c.deg = mod12(c.deg + 6);
          c.q = '9';
          c.acc = -1;
          done = true;
        }
        break;
      }
      case 'iiV': {
        // split a non-tonic 4-beat chord into ii-V of the next chord
        const nf = QUALITIES[next.q].family;
        if (i > 0 && c.beats >= 4 && c.deg !== 0 && next.deg !== c.deg && (nf === 'maj' || nf === 'min')) {
          const half = c.beats / 2;
          const targetMinor = isMin(next.q);
          const v: PChord = { deg: mod12(next.deg + 7), q: domFor(mod12(next.deg + 7), next, key.mode, rng), beats: half };
          const ii: PChord = { deg: mod12(next.deg + 2), q: targetMinor ? 'm7b5' : 'm9', beats: half };
          chords.splice(i, 1, ii, v);
          done = true;
        }
        break;
      }
      case 'modalIV': {
        if (key.mode === 'major' && c.deg === 5 && isMaj(c.q)) {
          c.q = rng.chance(0.6) ? 'm6' : 'm9';
          done = true;
        }
        break;
      }
      case 'passdim': {
        if (c.deg === 0 && isMaj(c.q) && next.deg === 2 && c.beats >= 4) {
          const half = c.beats / 2;
          chords.splice(i, 1, { ...c, beats: half }, { deg: 1, q: 'dim7', beats: half, acc: 1 });
          done = true;
        }
        break;
      }
      case 'sus': {
        if (isDom(c.q) && c.beats >= 4 && c.q !== '9sus' && c.q !== '13sus') {
          const half = c.beats / 2;
          chords.splice(i, 1, { ...c, q: '9sus', beats: half }, { ...c, beats: half });
          done = true;
        }
        break;
      }
      case 'slip': {
        // chromatic side-slip from a semitone above into the next chord
        if (i > 0 && c.beats >= 4 && !isDom(next.q) && next.deg !== c.deg) {
          const half = c.beats / 2;
          chords.splice(i, 1, { ...c, beats: half }, { deg: mod12(next.deg + 1), q: next.q, beats: half, acc: -1 });
          done = true;
        }
        break;
      }
      case 'inversion': {
        // first-inversion passing chord when the bass can walk up by step into the next root
        const third = QUALITIES[c.q].third;
        if (third !== null && isMaj(c.q) && c.bassInt === undefined) {
          const bass = mod12(c.deg + third);
          const up = mod12(next.deg - bass);
          if (up === 1 || up === 2) {
            c.bassInt = third;
            done = true;
          }
        }
        break;
      }
    }
    if (done) applied.push(kind);
  }
  chords = chords.filter((c) => c.beats > 0);
  return { chords, applied };
}

/** Resolve key-relative chords to absolute chords. */
export function toAbsolute(c: PChord, key: Key): Chord {
  const root = mod12(key.tonic + c.deg);
  const flats = c.acc === -1 ? true : c.acc === 1 ? false : keyUsesFlats(key);
  return { root, q: c.q, flats, bass: c.bassInt !== undefined ? mod12(root + c.bassInt) : undefined };
}
