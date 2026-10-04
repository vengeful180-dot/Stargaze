// Station styles: tempo, harmony, instrumentation and texture palettes for the generative lofi.
import type { StationStyle } from '../types';
import type { SubKind } from './progressions';

export type InstId = 'ep' | 'piano' | 'guitar' | 'bass' | 'pad' | 'lead' | 'bell';
export type BellKind = 'vibes' | 'kalimba' | 'glock' | 'marimba';
export type DrumStyle = 'boombap' | 'crisp' | 'brush' | 'halftime' | 'none';
export type BassStyle = 'pluck' | 'walk' | 'long' | 'pedal';
export type CompStyle = 'sustain' | 'push' | 'charleston' | 'halves' | 'stabs' | 'roll' | 'offbeat' | 'arp' | 'strum';

type W<T> = readonly (readonly [T, number])[];

export interface StyleDef {
  bpm: readonly [number, number];
  swing: readonly [number, number];
  minorProb: number;
  /** probability that a chord lasts two bars (slow harmonic rhythm) */
  twoBarChords: number;
  chordInst: W<InstId>;
  melodyInst: W<InstId>;
  bells: W<BellKind>;
  /** pad layer under B / breakdown sections */
  padProb: number;
  drums: W<DrumStyle>;
  bass: W<BassStyle>;
  comp: W<CompStyle>;
  /** melody notes per two-bar motif */
  density: readonly [number, number];
  rollProb: number;
  /** melody also appears (sparsely) in A sections */
  melodyInA: number;
  arpProb: number;
  subs: readonly SubKind[];
  crackle: number;
  hiss: number;
  wow: number;
  tapeStopProb: number;
  targetDur: readonly [number, number];
  drift: boolean;
  /** EP flavour */
  wurliProb: number;
}

export const STYLES: Record<StationStyle, StyleDef> = {
  'dusty-keys': {
    bpm: [72, 86], swing: [0.56, 0.62], minorProb: 0.5, twoBarChords: 0.08,
    chordInst: [['ep', 0.85], ['piano', 0.15]],
    melodyInst: [['ep', 0.3], ['bell', 0.25], ['piano', 0.25], ['lead', 0.2]],
    bells: [['vibes', 3], ['kalimba', 1], ['marimba', 1]],
    padProb: 0.35,
    drums: [['boombap', 1]],
    bass: [['pluck', 1]],
    comp: [['sustain', 2], ['push', 2], ['charleston', 1.5], ['roll', 1.5], ['halves', 1]],
    density: [4, 6], rollProb: 0.3, melodyInA: 0.25, arpProb: 0.2,
    subs: ['ext', 'secdom', 'tritone', 'iiV', 'modalIV', 'sus', 'inversion', 'passdim'],
    crackle: 1.0, hiss: 1.0, wow: 1.0, tapeStopProb: 0.35, targetDur: [135, 195], drift: false, wurliProb: 0.2,
  },
  'sunday-tape': {
    bpm: [76, 90], swing: [0.58, 0.64], minorProb: 0.3, twoBarChords: 0.05,
    chordInst: [['guitar', 0.65], ['ep', 0.35]],
    melodyInst: [['guitar', 0.4], ['bell', 0.35], ['piano', 0.25]],
    bells: [['vibes', 3], ['marimba', 1.5], ['kalimba', 1]],
    padProb: 0.2,
    drums: [['brush', 1]],
    bass: [['walk', 2], ['pluck', 1]],
    comp: [['arp', 3], ['strum', 2]],
    density: [4, 7], rollProb: 0.5, melodyInA: 0.35, arpProb: 0.1,
    subs: ['ext', 'secdom', 'iiV', 'passdim', 'sus', 'inversion', 'slip'],
    crackle: 0.55, hiss: 1.2, wow: 1.25, tapeStopProb: 0.25, targetDur: [130, 190], drift: false, wurliProb: 0.1,
  },
  'night-drive': {
    bpm: [66, 76], swing: [0.53, 0.57], minorProb: 0.75, twoBarChords: 0.5,
    chordInst: [['ep', 0.75], ['piano', 0.25]],
    melodyInst: [['lead', 0.55], ['ep', 0.2], ['bell', 0.25]],
    bells: [['vibes', 2], ['glock', 1]],
    padProb: 0.85,
    drums: [['halftime', 2], ['boombap', 1]],
    bass: [['long', 2], ['pluck', 1]],
    comp: [['sustain', 3], ['roll', 2], ['push', 1]],
    density: [3, 5], rollProb: 0.35, melodyInA: 0.2, arpProb: 0.3,
    subs: ['ext', 'sus', 'tritone', 'secdom'],
    crackle: 0.45, hiss: 0.9, wow: 0.8, tapeStopProb: 0.15, targetDur: [140, 200], drift: false, wurliProb: 0,
  },
  drift: {
    bpm: [60, 70], swing: [0.5, 0.53], minorProb: 0.35, twoBarChords: 1,
    chordInst: [['pad', 0.55], ['piano', 0.25], ['ep', 0.2]],
    melodyInst: [['bell', 0.6], ['piano', 0.4]],
    bells: [['kalimba', 2], ['vibes', 2], ['glock', 1]],
    padProb: 1,
    drums: [['none', 1]],
    bass: [['pedal', 1]],
    comp: [['sustain', 2], ['roll', 2]],
    density: [3, 5], rollProb: 0.6, melodyInA: 0.5, arpProb: 0.8,
    subs: ['ext', 'sus', 'inversion'],
    crackle: 0.3, hiss: 0.7, wow: 0.6, tapeStopProb: 0, targetDur: [150, 205], drift: true, wurliProb: 0,
  },
  'cafe-boom-bap': {
    bpm: [82, 92], swing: [0.56, 0.6], minorProb: 0.55, twoBarChords: 0.05,
    chordInst: [['piano', 0.6], ['ep', 0.4]],
    melodyInst: [['piano', 0.35], ['bell', 0.25], ['ep', 0.2], ['lead', 0.2]],
    bells: [['vibes', 2], ['marimba', 2]],
    padProb: 0.2,
    drums: [['crisp', 1]],
    bass: [['pluck', 1]],
    comp: [['stabs', 3], ['charleston', 1.5], ['push', 1]],
    density: [4, 6], rollProb: 0.2, melodyInA: 0.3, arpProb: 0.1,
    subs: ['ext', 'secdom', 'tritone', 'iiV', 'slip', 'sus'],
    crackle: 0.8, hiss: 0.9, wow: 0.7, tapeStopProb: 0.45, targetDur: [125, 180], drift: false, wurliProb: 0.35,
  },
};
