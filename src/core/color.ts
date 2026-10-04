// Physically based star colours: Planck's law integrated against the CIE 1931 observer
// (multi-lobe analytic fit by Wyman, Sloan and Shirley 2013), converted to linear sRGB.

function lobe(l: number, mu: number, s1: number, s2: number): number {
  const t = (l - mu) / (l < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

function cie(l: number): [number, number, number] {
  const x = 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2);
  const y = 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1);
  const z = 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}

const cache = new Map<number, [number, number, number]>();

/** Linear sRGB colour of a black body at temperature K, normalised so the largest channel is 1. */
export function blackbody(kelvin: number): [number, number, number] {
  const key = Math.round(kelvin / 25) * 25;
  const hit = cache.get(key);
  if (hit) return hit;
  const h = 6.62607015e-34, c = 2.99792458e8, k = 1.380649e-23;
  let X = 0, Y = 0, Z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const l = nm * 1e-9;
    const b = 1 / (Math.pow(l, 5) * (Math.exp((h * c) / (l * k * key)) - 1));
    const [x, y, z] = cie(nm);
    X += b * x;
    Y += b * y;
    Z += b * z;
  }
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let bl = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  r = Math.max(0, r);
  g = Math.max(0, g);
  bl = Math.max(0, bl);
  const m = Math.max(r, g, bl) || 1;
  const out: [number, number, number] = [r / m, g / m, bl / m];
  cache.set(key, out);
  return out;
}

/** HSL (h in turns, s, l in 0..1) to linear sRGB. Handy for palette generation. */
export function hslLinear(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    // sRGB -> linear
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [f(0), f(8), f(4)];
}

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Hex sRGB (#rrggbb) to linear triple. */
export function hexLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

export function mixRgb(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
