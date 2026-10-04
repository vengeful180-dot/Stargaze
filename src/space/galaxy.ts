// The galaxy: an endless catalogue of star systems in a four-armed spiral disc, generated cell by cell
// from the universe seed. Positions are in light-years, in a galactic frame: disc in XZ, +Y galactic north.
import { blackbody } from '../core/color';
import { Rng, hash } from '../core/rng';
import { systemName } from './names';

export const LY = 9.4607e15; // metres
export const SOLAR_RADIUS = 6.957e8; // metres

export const CELL_LY = 60;
const DISC_SCALE = 12000;
const DISC_HEIGHT = 900;
const DISC_MAX = 52000;
const ARMS = 4;
const PITCH = (13 * Math.PI) / 180;
const ARM_WIDTH = 1500;
const LOCAL_DENSITY = 2.2e-5; // systems per ly^3 near the start, sets jump distances of ~20 ly
export const START_LY: readonly [number, number, number] = [-3100, 14, 26300];

export type StarClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'D' | 'RG';

export interface StarInfo {
  cls: StarClass;
  temperature: number; // K
  radius: number; // solar radii
  luminosity: number; // solar
  color: [number, number, number]; // linear rgb, max channel 1
}

export interface SystemRef extends StarInfo {
  id: number;
  cell: [number, number, number];
  index: number;
  pos: [number, number, number]; // ly
  seed: number;
}

export interface NearSystem {
  ref: SystemRef;
  dist: number; // ly
}

const nameCache = new Map<number, string>();

/** Names are generated lazily: the sky needs thousands of systems but only shows a few names. */
export function nameOf(ref: SystemRef): string {
  let n = nameCache.get(ref.id);
  if (!n) {
    n = systemName(ref.seed);
    if (nameCache.size > 20000) nameCache.clear();
    nameCache.set(ref.id, n);
  }
  return n;
}

const CLASS_TABLE: readonly (readonly [StarClass, number, [number, number], [number, number]])[] = [
  // class, weight, temperature range K, radius range (solar)
  ['O', 0.003, [30000, 42000], [6, 11]],
  ['B', 0.014, [11000, 26000], [2.5, 6]],
  ['A', 0.045, [7600, 9800], [1.5, 2.3]],
  ['F', 0.11, [6100, 7300], [1.1, 1.5]],
  ['G', 0.18, [5300, 6000], [0.85, 1.15]],
  ['K', 0.27, [3900, 5200], [0.62, 0.9]],
  ['M', 0.33, [2700, 3800], [0.2, 0.55]],
  ['D', 0.018, [7500, 18000], [0.012, 0.02]],
  ['RG', 0.03, [3300, 4600], [12, 45]],
];

export function rollStar(rng: Rng): StarInfo {
  const row = rng.weighted(CLASS_TABLE.map((r) => [r, r[1]] as const));
  const [cls, , tr, rr] = row;
  const u = rng.next();
  const temperature = tr[0] + (tr[1] - tr[0]) * u;
  // hotter within a class goes with larger, loosely like the main sequence
  const radius = rr[0] + (rr[1] - rr[0]) * Math.min(1, Math.max(0, u * 0.7 + rng.next() * 0.3));
  const luminosity = radius * radius * Math.pow(temperature / 5772, 4);
  return { cls, temperature, radius, luminosity, color: blackbody(temperature) };
}

/** Expected systems per cubic light-year at a galactic position. */
export function galaxyDensity(x: number, y: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r > DISC_MAX * 1.2) return 0;
  const theta = Math.atan2(z, x);
  const armTheta = Math.log(Math.max(r, 500) / 3000) / Math.tan(PITCH);
  const sector = (2 * Math.PI) / ARMS;
  let d = (((theta - armTheta) % sector) + sector) % sector;
  d = Math.min(d, sector - d);
  const perp = d * r * Math.sin(PITCH);
  const arm = 0.3 + 0.7 * Math.exp(-((perp / ARM_WIDTH) ** 2));
  const disc = Math.exp(-(r - 26000) / DISC_SCALE) * Math.exp(-Math.abs(y) / DISC_HEIGHT);
  const taper = r > DISC_MAX ? Math.exp(-(r - DISC_MAX) / 2000) : 1;
  const bulge = 8 * Math.exp(-(r * r + (y * 2.5) ** 2) / (2 * 4200 * 4200));
  return LOCAL_DENSITY * (disc * arm * taper + bulge);
}

function poisson(rng: Rng, lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * rng.gauss()));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > L);
  return k - 1;
}

/** Pack a cell and index into an exact integer id (fits in 2^53). */
export function systemId(cx: number, cy: number, cz: number, i: number): number {
  return (((cx + 2048) * 4096 + (cz + 2048)) * 128 + (cy + 64)) * 64 + i;
}

export function unpackId(id: number): [number, number, number, number] {
  const i = id % 64;
  let rest = (id - i) / 64;
  const cy = (rest % 128) - 64;
  rest = (rest - (cy + 64)) / 128;
  const cz = (rest % 4096) - 2048;
  const cx = (rest - (cz + 2048)) / 4096 - 2048;
  return [cx, cy, cz, i];
}

export class Galaxy {
  private cells = new Map<string, SystemRef[]>();

  constructor(readonly seed: number) {}

  cellSystems(cx: number, cy: number, cz: number): SystemRef[] {
    const key = `${cx},${cy},${cz}`;
    const hit = this.cells.get(key);
    if (hit) return hit;
    const rng = new Rng(hash(this.seed, cx, cy, cz, 0x5ca1ab1e));
    const centre = [(cx + 0.5) * CELL_LY, (cy + 0.5) * CELL_LY, (cz + 0.5) * CELL_LY];
    const lambda = galaxyDensity(centre[0], centre[1], centre[2]) * CELL_LY ** 3;
    const n = Math.min(60, poisson(rng, lambda));
    const list: SystemRef[] = [];
    for (let i = 0; i < n; i++) {
      const pos: [number, number, number] = [
        cx * CELL_LY + rng.next() * CELL_LY,
        cy * CELL_LY + rng.next() * CELL_LY,
        cz * CELL_LY + rng.next() * CELL_LY,
      ];
      const seed = hash(this.seed, cx, cy, cz, i, 0x57a2);
      const star = rollStar(new Rng(seed));
      list.push({ ...star, id: systemId(cx, cy, cz, i), cell: [cx, cy, cz], index: i, pos, seed });
    }
    if (this.cells.size > 40000) this.cells.clear();
    this.cells.set(key, list);
    return list;
  }

  getSystem(id: number): SystemRef | undefined {
    const [cx, cy, cz, i] = unpackId(id);
    return this.cellSystems(cx, cy, cz)[i];
  }

  /** All systems within radius (ly) of p, nearest first. */
  systemsNear(p: readonly number[], radius: number): NearSystem[] {
    const c0 = p.map((v) => Math.floor(v / CELL_LY));
    const k = Math.ceil(radius / CELL_LY);
    const out: NearSystem[] = [];
    for (let dx = -k; dx <= k; dx++)
      for (let dy = -k; dy <= k; dy++)
        for (let dz = -k; dz <= k; dz++) {
          const cy = c0[1] + dy;
          if (cy < -60 || cy > 60) continue;
          for (const s of this.cellSystems(c0[0] + dx, cy, c0[2] + dz)) {
            const d = Math.hypot(s.pos[0] - p[0], s.pos[1] - p[1], s.pos[2] - p[2]);
            if (d <= radius) out.push({ ref: s, dist: d });
          }
        }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  /** A good place to begin: the nearest system to the start point with a sun-like star. */
  startSystem(): SystemRef {
    const near = this.systemsNear(START_LY, 90);
    const nice = near.find((s) => s.ref.cls === 'G' || s.ref.cls === 'K' || s.ref.cls === 'F');
    return (nice ?? near[0])?.ref ?? this.cellSystems(0, 0, 0)[0];
  }
}
