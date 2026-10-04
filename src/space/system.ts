// One star system, generated from its catalogue entry: the star, planets with moons and rings,
// asteroid belts and the odd comet. Distances in metres. Orbits are compressed relative to reality
// (GAME_AU) so neighbouring worlds show as discs rather than dots, which reads better from a cabin window.
import { Rng, hash } from '../core/rng';
import { hslLinear, mixRgb } from '../core/color';
import { SOLAR_RADIUS, nameOf, type SystemRef } from './galaxy';
import { makeWord, moonName, planetName } from './names';

export const GAME_AU = 3.0e10;
const EARTH_RADIUS = 6.371e6;

export type PlanetType =
  | 'terran' | 'ocean' | 'desert' | 'arid' | 'ice' | 'lava' | 'barren' | 'toxic' | 'gas' | 'icegiant' | 'exotic';

export const TYPE_LABEL: Record<PlanetType, string> = {
  terran: 'Temperate world', ocean: 'Ocean world', desert: 'Desert world', arid: 'Rust world', ice: 'Ice world',
  lava: 'Molten world', barren: 'Barren rock', toxic: 'Shrouded world', gas: 'Gas giant', icegiant: 'Ice giant',
  exotic: 'Exotic world',
};

export type Rgb = [number, number, number];

export interface Orbit {
  radius: number; // m
  period: number; // s (game time)
  phase: number; // rad at t = 0
  inclination: number; // rad, about the system's node line
  node: number; // rad
}

export interface RingDef {
  inner: number; // planet radii
  outer: number;
  seed: number;
  color: Rgb;
  color2: Rgb;
  opacity: number;
  tilt: number; // extra tilt of the ring plane vs equator (usually 0)
}

export interface AtmosphereDef {
  color: Rgb; // Rayleigh-like scattering tint
  density: number; // 0..1
  height: number; // shell thickness, planet radii
  mie: number; // forward-scatter haze strength
}

export interface SurfaceParams {
  seed: number;
  palette: Rgb[]; // 5 colours from low to high ground (or band colours for giants)
  ocean: Rgb; // deep water
  shallow: Rgb;
  seaLevel: number; // -1..1 in noise units; < -1 means no ocean
  roughness: number; // terrain contrast
  continentScale: number;
  mountains: number;
  craters: number; // density 0..1
  iceCap: number; // latitude (sin) where caps start; > 1 none
  cityLights: number; // 0..1
  lava: number; // 0..1 glowing cracks
  bands: number; // giants: band count
  turbulence: number; // giants
  storms: number; // giants: storm count
  clouds: number; // cloud cover 0..1 (0 = none)
  cloudColor: Rgb;
}

export interface Body {
  id: string;
  name: string;
  kind: 'star' | 'planet' | 'moon';
  radius: number; // m
  orbit: Orbit | null;
  parent: Body | null;
  spinPeriod: number; // s
  axialTilt: number; // rad
  seed: number;
}

export interface StarBody extends Body {
  kind: 'star';
  temperature: number;
  color: Rgb;
  luminosity: number;
}

export interface PlanetBody extends Body {
  kind: 'planet' | 'moon';
  type: PlanetType;
  surface: SurfaceParams;
  atmosphere: AtmosphereDef | null;
  rings: RingDef | null;
  moons: PlanetBody[];
  mass: number; // earth masses (flavour text)
  gravity: number; // g
  temperatureC: number; // mean surface temperature (flavour)
  ringRocks: boolean; // fly-through ring debris
  special: boolean;
}

export interface BeltDef {
  id: string;
  name: string;
  radius: number; // m (centre of the belt)
  width: number; // m
  thickness: number; // m
  density: number; // relative rock density
  seed: number;
  color: Rgb;
  parent: Body; // star or planet
}

export interface StarSystem {
  ref: SystemRef;
  seed: number;
  star: StarBody;
  planets: PlanetBody[];
  belts: BeltDef[];
  ecliptic: [number, number, number]; // orbital plane normal in the galactic frame
  bodies: Body[]; // every body, for lookups
}

const TWO_PI = Math.PI * 2;

function palette(rng: Rng, type: PlanetType): { pal: Rgb[]; ocean: Rgb; shallow: Rgb } {
  const H = (h: number, s: number, l: number) => hslLinear(((h % 1) + 1) % 1, s, l);
  const j = (x: number, amt = 0.03) => x + rng.range(-amt, amt);
  switch (type) {
    case 'terran': {
      const g = rng.range(0.2, 0.36); // green hue range shifts per world (teal-green to olive)
      return {
        pal: [H(j(0.11), 0.35, 0.36), H(g, 0.45, j(0.28)), H(g + 0.06, 0.4, 0.3), H(j(0.08), 0.25, 0.42), H(0.6, 0.06, 0.88)],
        ocean: H(j(0.6), 0.65, 0.16), shallow: H(j(0.52), 0.55, 0.36),
      };
    }
    case 'ocean':
      return {
        pal: [H(j(0.12), 0.4, 0.62), H(j(0.3), 0.4, 0.34), H(j(0.33), 0.3, 0.3), H(0.08, 0.2, 0.45), H(0.6, 0.05, 0.9)],
        ocean: H(j(0.58, 0.05), 0.7, 0.18), shallow: H(j(0.5), 0.6, 0.42),
      };
    case 'desert': {
      const h = rng.range(0.06, 0.12);
      return {
        pal: [H(h, 0.45, 0.42), H(h + 0.02, 0.5, 0.55), H(h + 0.03, 0.42, 0.66), H(h - 0.02, 0.35, 0.48), H(h, 0.2, 0.76)],
        ocean: H(0.55, 0.5, 0.2), shallow: H(0.48, 0.45, 0.4),
      };
    }
    case 'arid': {
      const h = rng.range(0.01, 0.06);
      return {
        pal: [H(h, 0.55, 0.26), H(h + 0.02, 0.6, 0.38), H(h + 0.03, 0.5, 0.48), H(h - 0.01, 0.35, 0.33), H(h + 0.05, 0.2, 0.72)],
        ocean: H(0.55, 0.4, 0.15), shallow: H(0.5, 0.35, 0.3),
      };
    }
    case 'ice': {
      const h = rng.range(0.5, 0.6);
      return {
        pal: [H(h, 0.25, 0.62), H(h, 0.2, 0.74), H(h - 0.02, 0.12, 0.84), H(h + 0.03, 0.3, 0.55), H(h, 0.05, 0.94)],
        ocean: H(h + 0.02, 0.6, 0.22), shallow: H(h, 0.45, 0.45),
      };
    }
    case 'lava':
      return {
        pal: [H(0.02, 0.2, 0.06), H(0.03, 0.15, 0.1), H(0.05, 0.1, 0.16), H(0.0, 0.15, 0.08), H(0.06, 0.08, 0.24)],
        ocean: H(0.04, 0.9, 0.35), shallow: H(0.08, 1.0, 0.5),
      };
    case 'barren': {
      const h = rng.range(0.04, 0.12);
      const s = rng.range(0.03, 0.15);
      return {
        pal: [H(h, s, 0.28), H(h, s, 0.38), H(h, s * 0.8, 0.48), H(h, s, 0.22), H(h, s * 0.5, 0.6)],
        ocean: H(0, 0, 0.1), shallow: H(0, 0, 0.2),
      };
    }
    case 'toxic': {
      const h = rng.range(0.1, 0.18);
      return {
        pal: [H(h, 0.35, 0.4), H(h + 0.02, 0.45, 0.55), H(h - 0.03, 0.3, 0.32), H(h + 0.04, 0.5, 0.62), H(h, 0.2, 0.75)],
        ocean: H(h, 0.4, 0.2), shallow: H(h, 0.4, 0.3),
      };
    }
    case 'exotic': {
      const h = rng.next();
      return {
        pal: [H(h, 0.45, 0.3), H(h + 0.08, 0.5, 0.45), H(h + 0.15, 0.4, 0.58), H(h - 0.06, 0.4, 0.35), H(h + 0.3, 0.2, 0.8)],
        ocean: H(h + 0.5, 0.55, 0.2), shallow: H(h + 0.45, 0.5, 0.4),
      };
    }
    case 'gas': {
      // classic cream / tan / rust banding, occasionally teal or violet giants
      const style = rng.next();
      const base = style < 0.6 ? rng.range(0.05, 0.11) : style < 0.8 ? rng.range(0.5, 0.58) : rng.range(0.72, 0.85);
      const pal: Rgb[] = [
        H(base, 0.45, 0.72), H(base + 0.02, 0.55, 0.55), H(base - 0.02, 0.5, 0.4),
        H(base + 0.04, 0.3, 0.82), H(base - 0.04, 0.6, 0.33),
      ];
      return { pal, ocean: H(base, 0.6, 0.45), shallow: H(base, 0.4, 0.7) };
    }
    case 'icegiant': {
      const h = rng.range(0.5, 0.62);
      return {
        pal: [H(h, 0.5, 0.55), H(h + 0.02, 0.55, 0.48), H(h - 0.02, 0.45, 0.62), H(h + 0.03, 0.35, 0.7), H(h, 0.6, 0.42)],
        ocean: H(h, 0.6, 0.4), shallow: H(h, 0.4, 0.6),
      };
    }
  }
}

function atmosphereFor(rng: Rng, type: PlanetType): AtmosphereDef | null {
  const H = (h: number, s: number, l: number) => hslLinear(((h % 1) + 1) % 1, s, l);
  switch (type) {
    case 'terran':
    case 'ocean':
      return { color: H(rng.range(0.55, 0.62), 0.75, 0.6), density: rng.range(0.7, 1), height: 0.035, mie: 0.35 };
    case 'desert':
      return { color: H(rng.range(0.06, 0.12), 0.55, 0.65), density: rng.range(0.35, 0.6), height: 0.03, mie: 0.6 };
    case 'arid':
      return rng.chance(0.6) ? { color: H(0.05, 0.6, 0.62), density: rng.range(0.2, 0.45), height: 0.025, mie: 0.7 } : null;
    case 'ice':
      return rng.chance(0.6) ? { color: H(rng.range(0.52, 0.6), 0.5, 0.75), density: rng.range(0.25, 0.55), height: 0.03, mie: 0.3 } : null;
    case 'toxic':
      return { color: H(rng.range(0.1, 0.16), 0.6, 0.62), density: 1, height: 0.05, mie: 0.9 };
    case 'exotic':
      return { color: H(rng.next(), 0.6, 0.65), density: rng.range(0.5, 1), height: 0.04, mie: 0.4 };
    case 'gas':
      return { color: H(rng.range(0.55, 0.62), 0.4, 0.7), density: 0.7, height: 0.02, mie: 0.5 };
    case 'icegiant':
      return { color: H(rng.range(0.52, 0.58), 0.6, 0.7), density: 0.9, height: 0.025, mie: 0.3 };
    case 'lava':
      return rng.chance(0.5) ? { color: H(0.04, 0.7, 0.5), density: 0.4, height: 0.03, mie: 0.8 } : null;
    case 'barren':
      return null;
  }
}

function makeSurface(rng: Rng, type: PlanetType): SurfaceParams {
  const { pal, ocean, shallow } = palette(rng, type);
  const giant = type === 'gas' || type === 'icegiant';
  const sea: Record<PlanetType, number> = {
    terran: rng.range(-0.05, 0.12), ocean: rng.range(0.22, 0.4), desert: rng.chance(0.3) ? rng.range(-0.35, -0.2) : -2,
    arid: rng.chance(0.2) ? -0.3 : -2, ice: rng.chance(0.35) ? rng.range(-0.25, -0.05) : -2, lava: rng.range(-0.38, -0.2),
    barren: -2, toxic: -2, exotic: rng.chance(0.6) ? rng.range(-0.15, 0.1) : -2, gas: -2, icegiant: -2,
  };
  const clouds: Record<PlanetType, number> = {
    terran: rng.range(0.35, 0.6), ocean: rng.range(0.45, 0.7), desert: rng.range(0, 0.15), arid: rng.range(0, 0.1),
    ice: rng.range(0.1, 0.35), lava: rng.range(0, 0.25), barren: 0, toxic: rng.range(0.8, 1), exotic: rng.range(0.1, 0.5),
    gas: 0, icegiant: 0,
  };
  const cloudColor: Rgb = type === 'toxic' ? mixRgb(pal[3], [0.9, 0.85, 0.6], 0.5) : type === 'lava' ? [0.25, 0.22, 0.2] : [0.92, 0.93, 0.95];
  return {
    seed: rng.uint(),
    palette: pal,
    ocean,
    shallow,
    seaLevel: sea[type],
    roughness: rng.range(0.6, 1.2),
    continentScale: rng.range(0.8, 1.6),
    mountains: type === 'ocean' ? rng.range(0.2, 0.5) : rng.range(0.4, 1),
    craters: type === 'barren' ? rng.range(0.4, 0.9) : type === 'arid' ? rng.range(0, 0.35) : type === 'ice' ? rng.range(0, 0.2) : 0,
    iceCap: type === 'terran' || type === 'ocean' ? rng.range(0.72, 0.9) : type === 'arid' ? rng.range(0.8, 0.95) : type === 'desert' ? rng.range(0.9, 1.1) : 2,
    cityLights: (type === 'terran' || type === 'ocean') && rng.chance(0.18) ? rng.range(0.4, 1) : 0,
    lava: type === 'lava' ? rng.range(0.6, 1) : 0,
    bands: giant ? rng.range(6, 16) : 0,
    turbulence: giant ? rng.range(0.4, 1.2) : 0,
    storms: giant ? rng.int(0, 4) : 0,
    clouds: clouds[type],
    cloudColor,
  };
}

function pickType(rng: Rng, tempC: number, giant: boolean): PlanetType {
  if (giant) return tempC < -150 && rng.chance(0.55) ? 'icegiant' : 'gas';
  if (tempC > 600) return rng.weighted([['lava', 4], ['barren', 1], ['toxic', 1]] as const);
  if (tempC > 120) return rng.weighted([['toxic', 3], ['desert', 2], ['barren', 2], ['lava', 1], ['exotic', 1]] as const);
  if (tempC > 40) return rng.weighted([['desert', 4], ['arid', 2], ['terran', 1], ['exotic', 1], ['barren', 1]] as const);
  if (tempC > -30) return rng.weighted([['terran', 5], ['ocean', 4], ['desert', 1], ['exotic', 1], ['arid', 1]] as const);
  if (tempC > -110) return rng.weighted([['arid', 3], ['ice', 3], ['barren', 2], ['exotic', 1], ['ocean', 1]] as const);
  return rng.weighted([['ice', 4], ['barren', 3], ['exotic', 1]] as const);
}

function makeOrbit(rng: Rng, radius: number, centralMassFactor: number, tilt: number): Orbit {
  // Kepler-ish period, then sped up a lot so motion is perceptible over a long session.
  const period = 2400 * Math.pow(radius / GAME_AU, 1.5) / Math.sqrt(centralMassFactor) * 60; // ~40 h at 1 AU for the sun
  return { radius, period: Math.max(600, period), phase: rng.range(0, TWO_PI), inclination: tilt, node: rng.range(0, TWO_PI) };
}

function moonOrbit(rng: Rng, radius: number, planetRadius: number): Orbit {
  // Moons get short, watchable periods: 15 min close in, up to 2 h far out.
  const period = Math.min(7200, Math.max(900, 900 * Math.pow(radius / (4 * planetRadius), 1.5)));
  return { radius, period, phase: rng.range(0, TWO_PI), inclination: rng.range(-0.08, 0.08), node: rng.range(0, TWO_PI) };
}

export function generateSystem(ref: SystemRef): StarSystem {
  const rng = new Rng(hash(ref.seed, 0x5157));
  const sysName = nameOf(ref);
  const starMass = Math.max(0.1, Math.pow(ref.luminosity, 1 / 3.5));
  const star: StarBody = {
    id: `${ref.id}:star`,
    name: sysName,
    kind: 'star',
    radius: ref.radius * SOLAR_RADIUS * (ref.cls === 'RG' ? 0.35 : 1), // giants trimmed so they fit the compressed orbits
    orbit: null,
    parent: null,
    spinPeriod: rng.range(3000, 9000),
    axialTilt: rng.range(0, 0.3),
    seed: rng.uint(),
    temperature: ref.temperature,
    color: ref.color,
    luminosity: ref.luminosity,
  };

  const e = rng.unitVector();
  // Most systems are tilted moderately against the galactic disc, so the Milky Way crosses the sky at an angle.
  const ecliptic: [number, number, number] = [e.x * 0.6, 0.75 + Math.abs(e.y) * 0.25, e.z * 0.6];
  const el = Math.hypot(...ecliptic);
  ecliptic[0] /= el;
  ecliptic[1] /= el;
  ecliptic[2] /= el;

  const planets: PlanetBody[] = [];
  const belts: BeltDef[] = [];
  const bodies: Body[] = [star];

  const nPlanets = ref.cls === 'D' ? rng.int(0, 2) : ref.cls === 'O' || ref.cls === 'B' ? rng.int(1, 4) : rng.int(2, 8);
  // Habitable band scales with sqrt(luminosity); orbits start a little outside it for hot stars.
  const hz = Math.sqrt(ref.luminosity); // in AU (real), mapped to GAME_AU below
  let a = Math.max(0.12 * hz, (star.radius * 6) / GAME_AU) * rng.range(0.9, 1.6);
  let beltPlaced = false;
  let specialLeft = rng.int(0, 2);

  for (let i = 0; i < nPlanets; i++) {
    const r = a * GAME_AU;
    // equilibrium temperature, then a nudge for greenhouse variety
    const tempK = 278 * Math.pow(ref.luminosity, 0.25) / Math.sqrt(a) + rng.range(-25, 35);
    const tempC = tempK - 273;
    const beyondSnow = a > 2.4 * hz;
    const giant = beyondSnow ? rng.chance(0.7) : rng.chance(0.1);
    const type = pickType(rng, tempC, giant);
    const isGiant = type === 'gas' || type === 'icegiant';
    const radius = isGiant
      ? (type === 'gas' ? rng.range(7, 12) : rng.range(3.4, 4.6)) * EARTH_RADIUS
      : rng.range(0.4, 1.6) * EARTH_RADIUS * (type === 'barren' ? 0.7 : 1);
    const special = specialLeft > 0 && rng.chance(0.4);
    if (special) specialLeft--;
    const prng = rng.fork(i + 1);
    const surface = makeSurface(prng, type);
    const atmosphere = atmosphereFor(prng, type);
    const hasRings = isGiant ? prng.chance(type === 'gas' ? 0.55 : 0.4) : prng.chance(0.06);
    const pal = surface.palette;
    const rings: RingDef | null = hasRings
      ? {
          inner: prng.range(1.25, 1.6),
          outer: prng.range(2.0, 2.8),
          seed: prng.uint(),
          color: mixRgb(pal[3] ?? pal[0], [0.85, 0.8, 0.72], 0.6),
          color2: mixRgb(pal[2] ?? pal[0], [0.5, 0.45, 0.4], 0.5),
          opacity: prng.range(0.55, 0.9),
          tilt: 0,
        }
      : null;
    const massE = isGiant ? (radius / EARTH_RADIUS) ** 2 * prng.range(1.5, 3) : (radius / EARTH_RADIUS) ** 3 * prng.range(0.7, 1.2);
    const planet: PlanetBody = {
      id: `${ref.id}:p${i}`,
      name: '',
      kind: 'planet',
      radius,
      orbit: makeOrbit(prng, r, starMass, prng.range(-0.04, 0.04)),
      parent: star,
      spinPeriod: prng.range(900, 3600) * (isGiant ? 0.6 : 1),
      // ringed worlds get a decent tilt so their rings catch the light
      axialTilt: hasRings ? prng.range(0.32, 0.55) : prng.range(0, 0.45),
      seed: prng.uint(),
      type,
      surface,
      atmosphere,
      rings,
      moons: [],
      mass: massE,
      gravity: massE / (radius / EARTH_RADIUS) ** 2,
      // temperate types report temperate numbers; others get a greenhouse nudge from their air
      temperatureC: Math.round(
        type === 'terran' || type === 'ocean' ? Math.min(32, Math.max(-12, tempC * 0.6 + 6)) : tempC + (atmosphere ? atmosphere.density * 30 : 0),
      ),
      ringRocks: !!rings && prng.chance(0.7),
      special,
    };
    planet.name = planetName(prng, sysName, i, special);

    // moons
    const nMoons = isGiant ? prng.int(1, 4) : prng.chance(0.55) ? prng.int(1, 2) : 0;
    let mr = (rings ? rings.outer * 1.6 : 4) * radius;
    for (let m = 0; m < nMoons; m++) {
      mr *= prng.range(1.5, 2.4);
      const mrng = prng.fork(100 + m);
      const mTempC = tempC - 10;
      const mType: PlanetType = mrng.weighted([
        ['barren', 5], ['ice', mTempC < -60 ? 4 : 0.5], ['arid', 1], ['lava', tempC > 200 ? 2 : 0.2], ['exotic', 0.6],
        ['terran', mTempC > -30 && mTempC < 40 ? 0.8 : 0], ['toxic', 0.3],
      ] as const);
      const mRadius = Math.min(radius * 0.4, mrng.range(0.12, 0.45) * EARTH_RADIUS * (isGiant ? 1.6 : 1));
      const mSurface = makeSurface(mrng, mType);
      if (mType === 'barren' || mType === 'ice') mSurface.craters = Math.max(mSurface.craters, mrng.range(0.35, 0.8));
      const moon: PlanetBody = {
        id: `${planet.id}m${m}`,
        name: moonName(mrng, planet.name, m, special && mrng.chance(0.5)),
        kind: 'moon',
        radius: mRadius,
        orbit: moonOrbit(mrng, mr, radius),
        parent: planet,
        spinPeriod: 1e9, // tidally locked: handled by renderer when spin is huge
        axialTilt: 0,
        seed: mrng.uint(),
        type: mType,
        surface: mSurface,
        atmosphere: mType === 'terran' || mType === 'toxic' ? atmosphereFor(mrng, mType) : null,
        rings: null,
        moons: [],
        mass: (mRadius / EARTH_RADIUS) ** 3,
        gravity: mRadius / EARTH_RADIUS,
        temperatureC: Math.round(mTempC),
        ringRocks: false,
        special: false,
      };
      planet.moons.push(moon);
      bodies.push(moon);
    }

    planets.push(planet);
    bodies.push(planet);

    // spacing; drop an asteroid belt into one wide gap, ideally near the snow line
    const step = rng.range(1.45, 2.1);
    const next = a * step;
    if (!beltPlaced && (a > 1.6 * hz || i === nPlanets - 2) && rng.chance(0.65)) {
      const br = Math.sqrt(a * next) * GAME_AU;
      belts.push({
        id: `${ref.id}:belt0`,
        name: `${makeWord(rng.fork('belt'), 2, 2)} Belt`,
        radius: br,
        width: br * rng.range(0.08, 0.16),
        thickness: br * rng.range(0.01, 0.025),
        density: rng.range(0.6, 1),
        seed: rng.uint(),
        color: rng.pick([[0.42, 0.38, 0.34], [0.36, 0.34, 0.33], [0.48, 0.4, 0.33]] as Rgb[]),
        parent: star,
      });
      beltPlaced = true;
      a = next * rng.range(1.2, 1.5);
    } else {
      a = next;
    }
  }

  return { ref, seed: ref.seed, star, planets, belts, ecliptic, bodies };
}

/** Position of a body relative to its parent at time t (s), in the system frame. */
export function orbitOffset(o: Orbit, ecliptic: readonly number[], t: number, out: { x: number; y: number; z: number }) {
  const ang = o.phase + (TWO_PI * t) / o.period;
  // orbit in a plane perpendicular to the ecliptic normal, then a small inclination about the node line
  const n = ecliptic;
  // basis u, v spanning the ecliptic plane
  let ux = n[1], uy = -n[0], uz = 0;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;
  const cn = Math.cos(o.node), sn = Math.sin(o.node);
  // node direction k = cos(node) u + sin(node) v, perpendicular p = -sin u + cos v
  const kx = cn * ux + sn * vx, ky = cn * uy + sn * vy, kz = cn * uz + sn * vz;
  const px = -sn * ux + cn * vx, py = -sn * uy + cn * vy, pz = -sn * uz + cn * vz;
  const ci = Math.cos(o.inclination), si = Math.sin(o.inclination);
  // tilt p toward the normal by the inclination
  const qx = px * ci + n[0] * si, qy = py * ci + n[1] * si, qz = pz * ci + n[2] * si;
  const c = Math.cos(ang) * o.radius, s = Math.sin(ang) * o.radius;
  out.x = kx * c + qx * s;
  out.y = ky * c + qy * s;
  out.z = kz * c + qz * s;
  return out;
}
