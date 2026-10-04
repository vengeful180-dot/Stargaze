// Score dumps and automated music checks (used by tools/audio/score.mjs and the audio lab).
import { type Score, type NoteEv, type DrumEv, composeTrack, planTrack } from './compose';
import { chordSymbol, degreeLabel, keyScalePcs, keyUsesFlats, melodyAllowed, mod12, noteName, voiceMovement } from './theory';
import { clashes } from './melody';
import type { StationStyle } from '../types';

export interface ScoreReport {
  title: string;
  style: string;
  bpm: number;
  key: string;
  bars: number;
  duration: number;
  melodyNotes: number;
  melodyOffScale: number;
  melodyClashes: number;
  strongOnStable: number;
  outOfKey: number;
  avgVoiceMove: number;
  maxTopLeap: number;
  lowMud: number;
  bassRange: [number, number];
  chordRange: [number, number];
  melodyRange: [number, number];
  maxRepeatRun: number;
  distinctBars: number;
  maxPoly: number;
  maxPolyAt: number;
  events: number;
  issues: string[];
}

const SEC_ABBR: Record<string, string> = { intro: 'In', A: 'A', B: 'B', break: 'Br', A2: "A'", B2: "B'", outro: 'Out' };

/** Notes of the given roles that are held through [t + 0.06, t + 0.18] (ignores tails already releasing). */
function sounding(notes: NoteEv[], t: number, roles: string[]): number[] {
  const out: number[] = [];
  for (const n of notes) {
    if (!roles.includes(n.role)) continue;
    if (n.t <= t + 0.06 && n.t + n.d > t + 0.18) out.push(n.m);
  }
  return out;
}

export function analyseScore(sc: Score): ScoreReport {
  const plan = sc.plan;
  const key = plan.key;
  const flats = keyUsesFlats(key);
  const notes = sc.events.filter((e): e is NoteEv => e.k === 'n');
  const issues: string[] = [];
  const scale = new Set(keyScalePcs(key));
  const spanAt = (p: number) => {
    let s = sc.chords[0];
    for (const c of sc.chords) if (c.start <= p + 1e-6) s = c;
    return s;
  };
  // melody checks
  const mel = notes.filter((n) => n.role === 'melody');
  let off = 0;
  let clash = 0;
  let strong = 0;
  let strongStable = 0;
  for (const n of mel) {
    const sp = spanAt(n.p);
    const allowed = melodyAllowed(sp.chord, key, false);
    if (!allowed.includes(mod12(n.m)) && n.d > 0.12) {
      off++;
      if (off <= 6) issues.push(`melody ${noteName(n.m, flats, true)} over ${chordSymbol(sp.chord, true)} at bar ${Math.floor(n.p / 16) + 1} is outside the chord scale`);
    }
    const snd = sounding(notes, n.t, ['chord', 'pad']);
    if (clashes(n.m, snd) && n.d > 0.1) {
      clash++;
      if (clash <= 6) issues.push(`melody ${noteName(n.m, flats, true)} clashes with ${snd.map((m) => noteName(m, flats, true)).join(' ')} at bar ${Math.floor(n.p / 16) + 1}`);
    }
    const isStrong = Math.abs(n.p - Math.round(n.p)) < 1e-6 && Math.round(n.p) % 8 === 0;
    if (isStrong) {
      strong++;
      if (melodyAllowed(sp.chord, key, true).includes(mod12(n.m))) strongStable++;
    }
  }
  // out-of-key: notes neither in key nor chord tones of the chord sounding
  let outOfKey = 0;
  for (const n of notes) {
    if (n.role === 'chord' || n.role === 'pad' || n.role === 'bass') continue;
    const sp = spanAt(n.p);
    const tones = new Set<number>();
    for (const m of sp.voicing) tones.add(mod12(m));
    for (const m of sp.pad) tones.add(mod12(m));
    tones.add(sp.chord.root);
    if (!scale.has(mod12(n.m)) && !tones.has(mod12(n.m)) && !melodyAllowed(sp.chord, key, false).includes(mod12(n.m))) outOfKey++;
  }
  // voice leading
  let moveSum = 0;
  let moveN = 0;
  let maxTop = 0;
  for (let i = 1; i < sc.chords.length; i++) {
    const a = sc.chords[i - 1].voicing;
    const b = sc.chords[i].voicing;
    moveSum += voiceMovement(a, b);
    moveN++;
    maxTop = Math.max(maxTop, Math.abs(a[a.length - 1] - b[b.length - 1]));
  }
  // low mud: chord notes below C3, or bass too close to the lowest chord note in the low register
  let mud = 0;
  for (const n of notes) if (n.role === 'chord' && n.inst !== 'guitar' && n.m < 48) mud++;
  for (const n of notes.filter((x) => x.role === 'bass')) {
    const snd = sounding(notes, n.t, ['chord']);
    if (snd.length) {
      const low = Math.min(...snd);
      if (low < 55 && low - n.m < 7 && low - n.m >= 0) mud++;
    }
  }
  const range = (arr: number[]): [number, number] => (arr.length ? [Math.min(...arr), Math.max(...arr)] : [0, 0]);
  const bassR = range(notes.filter((n) => n.role === 'bass').map((n) => n.m));
  const chordR = range(notes.filter((n) => n.role === 'chord').map((n) => n.m));
  const melR = range(mel.map((n) => n.m));
  if (bassR[0] && (bassR[0] < 28 || bassR[1] > 52)) issues.push(`bass range ${bassR.join('-')} is outside E1-E3`);
  // repetition: per-bar fingerprints
  const bars = plan.bars;
  const fp: string[] = [];
  for (let b = 0; b < bars; b++) {
    const inBar = notes.filter((n) => n.p >= b * 16 && n.p < (b + 1) * 16);
    fp.push(inBar.map((n) => `${n.inst}${n.m}@${n.p - b * 16}`).sort().join(','));
  }
  let run = 1;
  let maxRun = 1;
  for (let b = 1; b < bars; b++) {
    if (fp[b] && fp[b] === fp[b - 1]) {
      run++;
      maxRun = Math.max(maxRun, run);
    } else run = 1;
  }
  const distinct = new Set(fp.filter((x) => x)).size;
  // polyphony
  const edges: [number, number][] = [];
  for (const n of notes) {
    const rel = n.inst === 'pad' ? 1.2 : n.inst === 'bell' ? 1.5 : n.inst === 'guitar' ? 0.3 : 0.25;
    edges.push([n.t, 1], [n.t + n.d + rel, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let maxPoly = 0;
  let maxAt = 0;
  for (const [t, d] of edges) {
    cur += d;
    if (cur > maxPoly) {
      maxPoly = cur;
      maxAt = t;
    }
  }
  if (clash > 0) issues.push(`${clash} melody clashes`);
  if (maxRun > 2) issues.push(`a bar repeats verbatim ${maxRun} times in a row`);
  return {
    title: plan.title,
    style: plan.style,
    bpm: plan.bpm,
    key: plan.keyLabel,
    bars,
    duration: sc.duration,
    melodyNotes: mel.length,
    melodyOffScale: off,
    melodyClashes: clash,
    strongOnStable: strong ? strongStable / strong : 1,
    outOfKey,
    avgVoiceMove: moveN ? moveSum / moveN : 0,
    maxTopLeap: maxTop,
    lowMud: mud,
    bassRange: bassR,
    chordRange: chordR,
    melodyRange: melR,
    maxRepeatRun: maxRun,
    distinctBars: distinct,
    maxPoly,
    maxPolyAt: maxAt,
    events: sc.events.length,
    issues,
  };
}

/** Human-readable score: one line per bar with chords, voicings, bass, melody (with degrees) and a drum grid. */
export function scoreText(sc: Score, opts: { drums?: boolean; maxBars?: number } = {}): string {
  const plan = sc.plan;
  const key = plan.key;
  const flats = keyUsesFlats(key);
  const nn = (m: number) => noteName(m, flats, true);
  const lines: string[] = [];
  const mm = Math.floor(plan.duration / 60);
  const ss = Math.round(plan.duration % 60).toString().padStart(2, '0');
  lines.push(`== "${plan.title}"  ${plan.style}  ${plan.bpm} BPM  swing ${(plan.swing * 100).toFixed(0)}%  ${plan.keyLabel.replace('♭', 'b').replace('♯', '#')}  ${plan.bars} bars (${mm}:${ss}) ==`);
  lines.push(`form: ${plan.sections.map((s) => SEC_ABBR[s.name] + s.bars).join(' ')}   progressions: ${sc.progressions.join(' / ')}   ending: ${plan.ending}`);
  lines.push(`inst: chords=${plan.chordInst}${plan.wurli ? '(wurli)' : ''} comp=${plan.comp} melody=${plan.melodyInst}${plan.melodyInst === 'bell' ? '(' + plan.bell + ')' : ''} pad=${plan.pad} drums=${plan.drums} bass=${plan.bassStyle} twoBar=${plan.twoBar}`);
  const notes = sc.events.filter((e): e is NoteEv => e.k === 'n');
  const drums = sc.events.filter((e): e is DrumEv => e.k === 'd');
  const spanAt = (p: number) => {
    let s = sc.chords[0];
    for (const c of sc.chords) if (c.start <= p + 1e-6) s = c;
    return s;
  };
  const maxBars = opts.maxBars ?? plan.bars;
  let lastSec = '';
  for (let b = 0; b < Math.min(plan.bars, maxBars); b++) {
    const p0 = b * 16;
    const p1 = p0 + 16;
    const sp = spanAt(p0);
    if (sp.section !== lastSec) {
      lastSec = sp.section;
      lines.push(`-- [${SEC_ABBR[sp.section]}] --`);
    }
    const chordsInBar = sc.chords.filter((c) => c.start >= p0 && c.start < p1);
    const chordStr = (chordsInBar.length ? chordsInBar : [sp])
      .map((c) => `${chordSymbol(c.chord, true)}${c.start > p0 ? '@' + ((c.start - p0) / 4 + 1) : ''}[${c.voicing.map(nn).join(' ')}]`)
      .join(' ');
    const bass = notes.filter((n) => n.role === 'bass' && n.p >= p0 && n.p < p1).map((n) => `${nn(n.m)}${n.slide ? '~' : ''}@${fmtPos(n.p - p0)}`);
    const melN = notes.filter((n) => (n.role === 'melody' || n.role === 'arp') && n.p >= p0 && n.p < p1);
    const melS = melN.map((n) => {
      const c = spanAt(n.p).chord;
      const tag = degreeLabel(c, n.m);
      return `${n.role === 'arp' ? 'a:' : ''}${nn(n.m)}(${tag})@${fmtPos(n.p - p0)}`;
    });
    lines.push(`${String(b + 1).padStart(3)} | ${chordStr.padEnd(46)} | B: ${bass.join(' ').padEnd(26)} | M: ${melS.join(' ')}`);
    if (opts.drums) {
      const row = (ids: string[], ch: string) => {
        const cells = new Array(16).fill('.');
        for (const d of drums) {
          if (!ids.includes(d.drum) || d.p < p0 || d.p >= p1) continue;
          const s = Math.round(d.p - p0);
          cells[Math.min(15, s)] = d.v > 0.5 ? ch.toUpperCase() : ch;
        }
        return cells.join('');
      };
      const k = row(['kick'], 'k');
      const sn = row(['snare', 'rim', 'brush', 'snap'], 's');
      const h = row(['hat', 'ohat'], 'h');
      if (k.replace(/\./g, '') || sn.replace(/\./g, '') || h.replace(/\./g, '')) lines.push(`      K ${k}  S ${sn}  H ${h}`);
    }
  }
  return lines.join('\n');
}

function fmtPos(p: number): string {
  const beat = Math.floor(p / 4) + 1;
  const sub = p - (beat - 1) * 4;
  return sub === 0 ? `${beat}` : `${beat}.${Number.isInteger(sub) ? sub : sub.toFixed(1)}`;
}

/** Convenience for tools: compose a station track and return text + report. */
export function inspectTrack(stationSeed: number, style: StationStyle, index: number, drumsGrid = false) {
  const plan = planTrack(stationSeed, style, index);
  const sc = composeTrack(plan);
  return { text: scoreText(sc, { drums: drumsGrid }), report: analyseScore(sc), score: sc };
}
