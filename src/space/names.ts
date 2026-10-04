// Pronounceable procedural names. Tuned for soft, warm sounds rather than harsh consonant pile-ups.
import { Rng } from '../core/rng';

const ONSETS: readonly (readonly [string, number])[] = [
  ['', 3], ['b', 2], ['c', 1], ['d', 3], ['f', 1], ['g', 1], ['h', 2], ['j', 1], ['k', 3], ['l', 4], ['m', 4],
  ['n', 4], ['p', 1], ['r', 3], ['s', 4], ['t', 3], ['v', 3], ['y', 1], ['z', 1], ['th', 1], ['sh', 1], ['br', 1],
  ['dr', 1], ['tr', 1], ['st', 1], ['kh', 1], ['ar', 1], ['el', 1],
];
const VOWELS: readonly (readonly [string, number])[] = [
  ['a', 6], ['e', 5], ['i', 4], ['o', 4], ['u', 2], ['ae', 1], ['ia', 1], ['io', 1], ['ei', 1], ['ou', 1], ['y', 1],
];
const CODAS: readonly (readonly [string, number])[] = [
  ['', 10], ['n', 3], ['r', 3], ['s', 2], ['l', 2], ['th', 1], ['x', 1], ['m', 1], ['nd', 1], ['rn', 1], ['sk', 0.5],
];
const ENDINGS = ['a', 'ia', 'is', 'on', 'ar', 'el', 'un', 'os', 'ea', 'ix', 'or', 'ine', 'ara', 'ey'];
const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Omega'];
const SUFFIX = ['Prime', 'Minor', 'Major', 'Reach', 'Drift', 'Hollow', 'Gate', 'Rest', 'Light', 'Haven'];

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function makeWord(rng: Rng, minSyl = 2, maxSyl = 3): string {
  const n = rng.int(minSyl, maxSyl);
  let w = '';
  for (let i = 0; i < n; i++) {
    let on = rng.weighted(ONSETS);
    // avoid vowel-vowel glue that reads badly ("aeia")
    if (i > 0 && on === '' && /[aeiouy]$/.test(w)) on = rng.pick(['l', 'n', 'r', 'v', 's']);
    w += on + rng.weighted(VOWELS);
    if (i < n - 1 || rng.chance(0.5)) w += rng.weighted(CODAS);
  }
  if (rng.chance(0.35)) w = w.replace(/[aeiouy]+$/, '') + rng.pick(ENDINGS);
  w = w.replace(/(.)\1\1+/g, '$1$1').replace(/^(.)\1/, '$1');
  if (w.length < 3) w += rng.pick(ENDINGS);
  if (w.length > 10) w = w.slice(0, 9).replace(/[^aeiou]$/, '') + rng.pick(['a', 'is', 'on']);
  return cap(w);
}

export function systemName(seed: number): string {
  const rng = new Rng(seed);
  const style = rng.next();
  if (style < 0.62) return makeWord(rng);
  if (style < 0.78) return `${makeWord(rng, 2, 2)} ${rng.pick(GREEK)}`;
  if (style < 0.9) return `${makeWord(rng, 1, 2)} ${rng.pick(SUFFIX)}`;
  const letters = 'BCDGHKLNRSTVX';
  return `${letters[rng.int(0, letters.length - 1)]}${letters[rng.int(0, letters.length - 1)]}-${rng.int(100, 9999)}`;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

export function planetName(rng: Rng, systemName: string, index: number, special: boolean): string {
  if (special) return makeWord(rng, 2, 3);
  return `${systemName} ${ROMAN[index] ?? index + 1}`;
}

export function moonName(rng: Rng, planet: string, index: number, special: boolean): string {
  if (special) return makeWord(rng, 1, 2);
  return `${planet}${'abcdefgh'[index]}`;
}

const TITLE_A = ['Slow', 'Quiet', 'Warm', 'Soft', 'Late', 'Blue', 'Amber', 'Velvet', 'Dusty', 'Sleepy', 'Golden', 'Distant', 'Little', 'Paper', 'Hazy'];
const TITLE_B = ['Orbit', 'Comet', 'Nebula', 'Hull', 'Lantern', 'Tea', 'Window', 'Static', 'Signal', 'Moon', 'Drift', 'Satellite', 'Light-year', 'Engine', 'Stardust', 'Cabin', 'Rain'];

/** Track titles for the radio. */
export function trackTitle(seed: number): string {
  const rng = new Rng(seed);
  const s = rng.next();
  if (s < 0.5) return `${rng.pick(TITLE_A)} ${rng.pick(TITLE_B)}`;
  if (s < 0.75) return `${rng.pick(TITLE_B)} ${rng.pick(['at Dusk', 'for Two', 'in the Kettle', 'Lullaby', 'Waltz', 'Again', 'No. ' + rng.int(2, 9)])}`;
  return `${rng.pick(TITLE_A)} ${rng.pick(TITLE_B)}s`;
}
