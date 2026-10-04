// Boom-bap / brush / half-time drum patterns on a 16-step grid, with per-bar variation and fills.
import type { Rng } from '../../core/rng';
import type { DrumStyle } from './styles';

export type DrumId = 'kick' | 'snare' | 'rim' | 'hat' | 'ohat' | 'shaker' | 'brush' | 'snap';

export interface DrumHit {
  step: number; // 0..15 (may be fractional for flams)
  drum: DrumId;
  vel: number;
}

export interface DrumGroove {
  style: DrumStyle;
  kickA: number[];
  kickB: number[];
  snare: number[];
  snareDrum: DrumId;
  ghosts: number[];
  hats: number[]; // 16 velocities
  /** a busier hat pattern for the second half of melodic sections */
  hatsB: number[];
  hatDrum: DrumId;
  shaker: boolean;
  /** extra lateness of the backbeat in seconds */
  laidBack: number;
  /** hats rush/drag in seconds */
  hatFeel: number;
  kickVel: number;
  snareVel: number;
  hatVel: number;
}

const KICKS: readonly (readonly number[])[] = [
  [0, 10], [0, 7, 10], [0, 6, 10], [0, 10, 13], [0, 3, 10], [0, 7, 9], [0, 10, 11], [0, 2, 10], [0, 9],
];
const KICK_VARIANTS: readonly (readonly number[])[] = [
  [0, 10, 15], [0, 7, 10], [0, 6, 9], [0, 3, 10, 13], [0, 10, 14], [0, 7, 11],
];
const HALF_KICKS: readonly (readonly number[])[] = [[0, 11], [0, 7, 11], [0, 10], [0, 3, 11], [0, 14]];

const H8 = [0.62, 0, 0.4, 0, 0.58, 0, 0.38, 0, 0.62, 0, 0.4, 0, 0.58, 0, 0.4, 0];
const H8P = [0.62, 0, 0.4, 0, 0.58, 0, 0.38, 0.2, 0.62, 0, 0.4, 0, 0.58, 0, 0.4, 0.22];
const H16 = [0.6, 0.2, 0.42, 0.24, 0.55, 0.2, 0.4, 0.27, 0.6, 0.2, 0.42, 0.24, 0.55, 0.2, 0.4, 0.3];
const HQ = [0.5, 0, 0.32, 0, 0.45, 0, 0.3, 0, 0.5, 0, 0.32, 0, 0.45, 0, 0.3, 0];
const HOFF = [0, 0, 0.48, 0, 0, 0, 0.45, 0, 0, 0, 0.48, 0, 0, 0, 0.45, 0];
const SH16 = [0.34, 0.16, 0.26, 0.18, 0.32, 0.16, 0.26, 0.2, 0.34, 0.16, 0.26, 0.18, 0.32, 0.16, 0.26, 0.2];

export function makeGroove(style: DrumStyle, rng: Rng): DrumGroove {
  const g: DrumGroove = {
    style,
    kickA: [...rng.pick(KICKS)],
    kickB: [],
    snare: [4, 12],
    snareDrum: 'snare',
    ghosts: [],
    hats: rng.pick([H8, H8, H8P, H16]),
    hatsB: [],
    hatDrum: 'hat',
    shaker: false,
    laidBack: rng.range(0.006, 0.016),
    hatFeel: rng.range(-0.004, 0.006),
    kickVel: 0.9,
    snareVel: 0.82,
    hatVel: 1,
  };
  g.kickB = rng.chance(0.55) ? [...rng.pick(KICK_VARIANTS)] : [...g.kickA];
  const ghostSets = [[7, 9], [7, 15], [3, 11], [9, 15], [14], [7, 9, 15], []];
  g.ghosts = [...rng.pick(ghostSets)];
  switch (style) {
    case 'crisp':
      g.hats = rng.pick([H16, H8P, H16]);
      g.snareVel = 0.92;
      g.kickVel = 0.95;
      g.laidBack = rng.range(0.004, 0.012);
      g.ghosts = [...rng.pick([[7, 9], [7, 15], [3, 9, 15], [9, 14]])];
      break;
    case 'brush':
      g.snareDrum = rng.chance(0.6) ? 'brush' : 'rim';
      g.hats = rng.pick([HQ, H8]);
      g.shaker = true;
      g.kickVel = 0.75;
      g.snareVel = 0.7;
      g.hatVel = 0.7;
      g.kickA = [...rng.pick([[0, 10], [0, 7, 10], [0, 9]])];
      g.kickB = rng.chance(0.5) ? [0, 10, 15] : [...g.kickA];
      break;
    case 'halftime':
      g.snare = [8];
      g.snareDrum = rng.chance(0.5) ? 'rim' : 'snap';
      g.kickA = [...rng.pick(HALF_KICKS)];
      g.kickB = rng.chance(0.5) ? [...rng.pick(HALF_KICKS)] : [...g.kickA];
      g.hats = rng.pick([HOFF, H8, HQ]);
      g.shaker = rng.chance(0.6);
      g.ghosts = [...rng.pick([[14], [6, 14], [], [3]])];
      g.kickVel = 0.8;
      g.snareVel = 0.72;
      g.hatVel = 0.8;
      break;
    default:
      break;
  }
  const busier = new Map<number[], number[]>([[H8, H8P], [H8P, H16], [HQ, H8], [HOFF, H8], [H16, H16]]);
  g.hatsB = busier.get(g.hats) ?? g.hats;
  return g;
}

export type FillKind = 'none' | 'roll' | 'kickdouble' | 'drop' | 'openhat' | 'flam' | 'stop';

/** One bar of drums. `barInPhrase` counts from 0; fills happen on phrase ends. */
export function drumBar(g: DrumGroove, barInPhrase: number, fill: FillKind, light: boolean, rng: Rng, busy = false): DrumHit[] {
  const hits: DrumHit[] = [];
  const v = (base: number, spread = 0.07) => Math.max(0.05, Math.min(1, base * (1 + rng.gauss() * spread)));
  const kicks = barInPhrase % 2 === 1 ? g.kickB : g.kickA;
  const cutFrom = fill === 'drop' ? rng.pick([8, 12]) : fill === 'stop' ? 14 : 99;
  if (!light) {
    for (const s of kicks) if (s < cutFrom) hits.push({ step: s, drum: 'kick', vel: v(s === 0 ? g.kickVel : g.kickVel * 0.82) });
    for (const s of g.snare) if (s < cutFrom) hits.push({ step: s, drum: g.snareDrum, vel: v(g.snareVel) });
    for (const s of g.ghosts) if (s < cutFrom && rng.chance(0.65)) hits.push({ step: s, drum: g.snareDrum === 'snap' ? 'rim' : g.snareDrum, vel: v(0.2, 0.25) });
    // occasional extra ghost kick leading into the next bar
    if (rng.chance(0.12) && !kicks.includes(15) && cutFrom > 15) hits.push({ step: 15, drum: 'kick', vel: v(0.45) });
  }
  const hats = busy ? g.hatsB : g.hats;
  for (let s = 0; s < 16; s++) {
    if (s >= cutFrom) break;
    const hv = hats[s];
    if (hv <= 0) continue;
    if (rng.chance(0.05) && s % 4 !== 0) continue; // humans skip a hat now and then
    let drum: DrumId = g.hatDrum;
    if (fill === 'openhat' && s === 14) drum = 'ohat';
    hits.push({ step: s, drum, vel: v(hv * g.hatVel * (light ? 0.8 : 1), 0.12) });
  }
  if (g.shaker && !light) for (let s = 0; s < 16 && s < cutFrom; s++) hits.push({ step: s, drum: 'shaker', vel: v(SH16[s], 0.15) });
  switch (fill) {
    case 'roll':
      for (const [s, vv] of [[13, 0.22], [14, 0.32], [15, 0.46]] as const) hits.push({ step: s, drum: g.snareDrum === 'snap' ? 'rim' : g.snareDrum, vel: v(vv, 0.1) });
      break;
    case 'kickdouble':
      hits.push({ step: 14, drum: 'kick', vel: v(0.7) }, { step: 15, drum: 'kick', vel: v(0.6) });
      break;
    case 'flam':
      hits.push({ step: 15, drum: g.snareDrum === 'snap' ? 'rim' : g.snareDrum, vel: v(0.4) });
      break;
    default:
      break;
  }
  return hits;
}

/** Light pattern used in intros/outros: hats (and maybe a soft kick on one). */
export function introBar(g: DrumGroove, rng: Rng, withKick: boolean): DrumHit[] {
  const hits = drumBar(g, 0, 'none', true, rng);
  if (withKick) hits.push({ step: 0, drum: 'kick', vel: 0.55 });
  return hits;
}
