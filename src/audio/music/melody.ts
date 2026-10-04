// Motif-based melodies: a short rhythmic/contour idea, repeated and varied over the changes.
// Pitches are realised against each chord (chord tones on strong positions, chord-scale tones elsewhere)
// and checked against the sounding voicing so the melody never forms a minor 2nd / minor 9th with it.
import type { Rng } from '../../core/rng';
import { type Chord, type Key, QUALITIES, melodyAllowed, mod12, nearestInSet, stepInSet } from './theory';

export interface MotifNote {
  pos: number; // 16ths from the slot start
  len: number; // 16ths
  step: number; // scale steps from the previous note
  acc: number; // accent 0..1
}

export type StartRole = 'root' | 'third' | 'fifth' | 'ninth' | 'seventh';

export interface Motif {
  notes: MotifNote[];
  length: number; // 16ths (usually 32 = two bars)
  startRole: StartRole;
}

export interface MelNote {
  pos: number; // absolute 16th position (fractional allowed)
  len: number;
  midi: number;
  vel: number;
  /** grace note: seconds before `pos` */
  grace?: number;
}

export interface ChordSeg {
  chord: Chord;
  start: number; // 16ths
  end: number;
}

export interface MelodyCtx {
  key: Key;
  lo: number;
  hi: number;
  center: number;
  chordAt(pos: number): ChordSeg;
  /** chord-instrument notes sounding at a position (including an anticipated next chord) */
  voicingAt(pos: number): readonly number[];
  /** only the chord whose span contains the position */
  coreVoicingAt(pos: number): readonly number[];
  vel: number;
  rng: Rng;
}

export function makeMotif(rng: Rng, n: readonly [number, number], answer = false, length = 32): Motif {
  // A motif is built from 1-3 "groups": a few short notes moving mostly by step in one direction that
  // land on a longer note, separated by short rests. Successive groups usually turn around (contour arch),
  // and a group may start with a small leap against its direction (a turn), which keeps lines singable.
  const target = rng.int(n[0], n[1]);
  const notes: MotifNote[] = [];
  let pos = answer ? rng.pick([2, 4, 6]) : rng.weighted([[0, 3], [2, 2], [4, 1], [3, 0.6]] as const);
  let dir = rng.sign();
  let cum = 0;
  while (notes.length < target && pos < length - 6) {
    const left = target - notes.length;
    const size = Math.min(left, rng.weighted([[1, 0.8], [2, 3], [3, 3], [4, 1.2]] as const));
    for (let g = 0; g < size; g++) {
      const end = g === size - 1;
      const ioi = end ? rng.weighted([[4, 2], [6, 2], [8, 1.2], [3, 0.8]] as const) : rng.weighted([[2, 4], [3, 1.4], [4, 1], [1, 0.5]] as const);
      let step = 0;
      if (notes.length > 0) {
        if (g === 0) step = -dir * rng.weighted([[1, 1.5], [2, 2], [3, 1]] as const);
        else step = dir * rng.weighted([[1, 4], [2, 1.5], [0, 0.35]] as const);
        // keep the line within a comfortable span around its start
        if (cum + step > 5 || cum + step < -5) step = -step;
      }
      cum += step;
      notes.push({ pos, len: Math.max(1, ioi - (ioi > 2 && rng.chance(0.3) ? 1 : 0)), step, acc: end ? 0.5 : g === 0 ? 0.3 : 0 });
      pos += ioi;
      if (pos >= length - 5) break;
    }
    dir = rng.chance(0.75) ? -dir : dir;
    pos += rng.weighted([[0, 1.2], [2, 2], [4, 1.5], [6, 0.5]] as const);
  }
  // break up immediate back-and-forth trills (x y x y)
  for (let i = 3; i < notes.length; i++) {
    const a = notes[i - 2].step;
    const b = notes[i - 1].step;
    const c = notes[i].step;
    if (Math.abs(a) === 1 && b === -a && c === a) notes[i].step = a * 2;
  }
  const last = notes[notes.length - 1];
  last.len = Math.max(last.len, Math.min(12, length - last.pos - rng.int(1, 3)));
  last.acc = Math.max(last.acc, 0.4);
  if (notes.length) notes[0].acc = Math.max(notes[0].acc, 0.4);
  const startRole = rng.weighted<StartRole>(
    answer
      ? [['third', 2], ['fifth', 2], ['root', 1]]
      : [['third', 3], ['fifth', 2.5], ['ninth', 1.5], ['seventh', 1], ['root', 0.6]],
  );
  return { notes, length, startRole };
}

/** An answer phrase: either the call's rhythm with its contour turned over, or a short fresh idea. */
export function makeAnswer(call: Motif, rng: Rng, n: readonly [number, number]): Motif {
  if (rng.chance(0.5) && call.notes.length >= 3) {
    const v = varyMotif(call, rng, 'invert');
    const keep = Math.max(2, Math.min(v.notes.length, rng.int(2, 4)));
    v.notes.length = keep;
    const last = v.notes[keep - 1];
    last.len = Math.max(last.len, Math.min(12, v.length - last.pos - 2));
    v.startRole = rng.pick<StartRole>(['third', 'fifth']);
    return v;
  }
  return makeMotif(rng, n, true);
}

export type VariationKind = 'tail' | 'rhythm' | 'invert' | 'truncate' | 'ornament' | 'displace';

export function varyMotif(m: Motif, rng: Rng, kind?: VariationKind): Motif {
  const k = kind ?? rng.pick<VariationKind>(['tail', 'rhythm', 'invert', 'truncate', 'ornament', 'displace']);
  const notes = m.notes.map((n) => ({ ...n }));
  const out: Motif = { notes, length: m.length, startRole: m.startRole };
  if (notes.length < 2) return out;
  switch (k) {
    case 'tail': {
      const from = Math.max(1, notes.length - 2);
      for (let i = from; i < notes.length; i++) notes[i].step = rng.weighted([[1, 2], [-1, 2], [2, 1], [-2, 1.2]] as const);
      break;
    }
    case 'rhythm': {
      const i = rng.int(1, notes.length - 1);
      const prevEnd = notes[i - 1].pos + 1;
      const nextStart = i + 1 < notes.length ? notes[i + 1].pos - 1 : m.length - 4;
      const np = Math.max(prevEnd, Math.min(nextStart, notes[i].pos + rng.pick([-2, -1, 1, 2])));
      const delta = np - notes[i].pos;
      notes[i].pos = np;
      notes[i].len = Math.max(1, notes[i].len - delta);
      notes[i - 1].len = Math.max(1, Math.min(notes[i - 1].len, np - notes[i - 1].pos));
      break;
    }
    case 'invert': {
      const half = Math.floor(notes.length / 2);
      for (let i = half; i < notes.length; i++) notes[i].step = -notes[i].step;
      break;
    }
    case 'truncate': {
      const keep = Math.max(2, Math.ceil(notes.length / 2));
      notes.length = keep;
      const lastN = notes[keep - 1];
      lastN.len = Math.max(lastN.len, Math.min(12, m.length - lastN.pos - 2));
      break;
    }
    case 'ornament': {
      // split a leap into two steps with a passing note
      for (let i = 1; i < notes.length; i++) {
        const n = notes[i - 1];
        if (Math.abs(notes[i].step) >= 2 && n.len >= 2) {
          const half = Math.floor(n.len / 2);
          const pass: MotifNote = { pos: n.pos + half, len: n.len - half, step: Math.sign(notes[i].step), acc: 0 };
          n.len = half;
          notes[i].step -= Math.sign(notes[i].step);
          notes.splice(i, 0, pass);
          break;
        }
      }
      break;
    }
    case 'displace': {
      const lastN = notes[notes.length - 1];
      if (lastN.pos + 2 + 4 <= m.length) for (const n of notes) n.pos += 2;
      lastN.len = Math.min(lastN.len, m.length - lastN.pos - 1);
      break;
    }
  }
  return out;
}

function roleInterval(role: StartRole, c: Chord): number {
  const d = QUALITIES[c.q];
  switch (role) {
    case 'root':
      return 0;
    case 'third':
      return d.third ?? 5;
    case 'fifth':
      return d.fifth;
    case 'ninth':
      return d.family === 'dim' || d.family === 'hdim' || c.q === '7b9' ? d.third ?? 3 : 2;
    case 'seventh':
      return d.tones.includes(11) ? 11 : d.tones.includes(10) ? 10 : 9;
  }
}

/** True when melody note p forms a minor 2nd / minor 9th against a voicing note. */
export function clashes(p: number, voicing: readonly number[]): boolean {
  for (const v of voicing) {
    const d = p - v;
    if (d > 0 && d % 12 === 1) return true;
    if (d === -1) return true;
  }
  return false;
}

function resolveClash(p: number, voicing: readonly number[], pcs: readonly number[], lo: number, hi: number, dir = 0, avoid?: number): number {
  if (!clashes(p, voicing) && pcs.includes(mod12(p))) return p;
  // prefer continuing in the direction the line was moving, and not landing back on the previous note
  for (let r = 1; r <= 12; r++) {
    const order = dir < 0 ? [p - r, p + r] : [p + r, p - r];
    for (const cand of order) {
      if (cand === avoid && r < 4) continue;
      if (cand < lo || cand > hi) continue;
      if (pcs.includes(mod12(cand)) && !clashes(cand, voicing)) return cand;
    }
  }
  return p;
}

export interface RealiseOpts {
  /** force the final note onto the root or third (phrase answer / cadence) */
  resolve?: boolean;
  /** move the anchor up by this many semitones (development) */
  lift?: number;
  graceProb?: number;
}

/** Realise a motif over the changes starting at absolute 16th position `slot`. */
export function realiseMotif(m: Motif, slot: number, ctx: MelodyCtx, prevPitch: number | null, o: RealiseOpts = {}): { notes: MelNote[]; last: number | null } {
  const out: MelNote[] = [];
  const { key, lo, hi, rng } = ctx;
  let pitch: number | null = null;
  const n = m.notes.length;
  for (let i = 0; i < n; i++) {
    const mn = m.notes[i];
    const pos = slot + mn.pos;
    const seg = ctx.chordAt(pos);
    const isLast = i === n - 1;
    const strong = pos % 8 === 0 || mn.len >= 6 || isLast;
    const allowed = melodyAllowed(seg.chord, key, false);
    const stable = melodyAllowed(seg.chord, key, true);
    let p: number;
    if (pitch === null) {
      const pc = mod12(seg.chord.root + roleInterval(m.startRole, seg.chord));
      const pcs = stable.includes(pc) ? [pc] : stable;
      const anchor = (prevPitch === null ? ctx.center : prevPitch * 0.4 + ctx.center * 0.6) + (o.lift ?? 0);
      p = nearestInSet(anchor, pcs, lo, hi);
    } else {
      p = stepInSet(pitch, mn.step, allowed, lo, hi);
      if (p > hi) p = stepInSet(pitch, -Math.max(1, Math.abs(mn.step)), allowed, lo, hi);
      if (p < lo) p = stepInSet(pitch, Math.max(1, Math.abs(mn.step)), allowed, lo, hi);
      if (strong) p = nearestInSet(p, stable, lo, hi, Math.sign(mn.step));
    }
    if (isLast && o.resolve) {
      const d = QUALITIES[seg.chord.q];
      const pcs = [mod12(seg.chord.root), mod12(seg.chord.root + (d.third ?? 7))];
      p = nearestInSet(p, pcs, lo, hi);
    }
    const pcsHere = strong ? stable : allowed;
    const avoidPrev = mn.step !== 0 ? pitch ?? undefined : undefined;
    let q = resolveClash(p, ctx.voicingAt(pos), pcsHere, lo, hi, Math.sign(mn.step), avoidPrev);
    // still clashing: accept any chord-scale tone, then (last resort) only respect the current chord
    if (clashes(q, ctx.voicingAt(pos))) q = resolveClash(p, ctx.voicingAt(pos), allowed, lo, hi, Math.sign(mn.step), avoidPrev);
    if (clashes(q, ctx.voicingAt(pos))) q = resolveClash(p, ctx.coreVoicingAt(pos), pcsHere, lo, hi, Math.sign(mn.step), avoidPrev);
    p = q;
    // a note that sustains over a chord change must still fit the new chord
    let len = mn.len;
    if (pos + len > seg.end + 0.01) {
      const nx = ctx.chordAt(seg.end);
      const okNext = melodyAllowed(nx.chord, key, true).includes(mod12(p)) && !clashes(p, ctx.voicingAt(seg.end));
      if (!okNext) len = Math.max(1, seg.end - pos);
    }
    const arc = n > 2 ? Math.sin((Math.PI * (i + 0.5)) / n) * 0.06 : 0;
    const vel = Math.max(0.15, Math.min(1, ctx.vel + mn.acc * 0.1 + arc - (isLast ? 0.04 : 0) + rng.gauss() * 0.035));
    const prevEnd = out.length ? out[out.length - 1].pos + out[out.length - 1].len : -99;
    if (i > 0 && len >= 3 && pos - prevEnd >= 1 && rng.chance(o.graceProb ?? 0.07)) {
      const g = stepInSet(p, -1, allowed, lo - 2, hi);
      if (g !== p && !clashes(g, ctx.voicingAt(pos))) out.push({ pos, len: 0.5, midi: g, vel: vel * 0.6, grace: 0.06 });
    }
    out.push({ pos, len, midi: p, vel });
    pitch = p;
  }
  return { notes: out, last: pitch };
}

export type Slot = 'M' | 'V' | 'A' | 'R' | '-';

export const PHRASE_PLANS: readonly (readonly Slot[])[] = [
  ['M', 'A', 'M', 'R'],
  ['M', '-', 'V', 'R'],
  ['M', 'V', '-', 'R'],
  ['-', 'M', '-', 'R'],
  ['M', 'A', 'V', 'R'],
  ['M', '-', 'M', 'A'],
];
