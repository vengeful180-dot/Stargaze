// Motes of dust streaking past the windows: the one thing that tells you how fast you are going in a void.
// The ship's real speed spans 10 m/s to 10 c; the dust moves at an *apparent* speed that grows with the log of it,
// so a crawl reads as a drift and 10 c as a rush, without the lattice aliasing (a fixed box can only show speeds
// up to a few hundred m/s). The old version streaked only between 12 and 1,800 m/s - at any travel speed you saw
// nothing at all.
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { smoothstep } from '../core/math';

/** apparent dust speed (m/s) for a true speed (m/s) */
export function apparentSpeed(speed: number): number {
  return Math.min(430, 58 * Math.log10(1 + speed / 12));
}

export class SpeedDust {
  readonly lines: THREE.LineSegments;
  private seeds: Float32Array;
  private pos: Float32Array;
  private col: Float32Array;
  private n: number;
  private L = 260;
  private offset = new THREE.Vector3();
  private dir = new THREE.Vector3(0, 0, -1);
  private vis = 0;

  constructor(count = 1400) {
    this.n = count;
    const rng = new Rng(0xd057);
    this.seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      this.seeds[i * 4] = rng.next() * this.L;
      this.seeds[i * 4 + 1] = rng.next() * this.L;
      this.seeds[i * 4 + 2] = rng.next() * this.L;
      this.seeds[i * 4 + 3] = 0.35 + 0.65 * rng.next() * rng.next(); // per-mote brightness: most faint
    }
    this.pos = new Float32Array(count * 6);
    this.col = new Float32Array(count * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.lines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
  }

  /**
   * vel: ship velocity (world, m/s); density: 0..1 (thicker inside asteroid fields); light: sunlight colour scale;
   * dt: frame time. Motes live in a box round the ship in world axes, so turning the ship sweeps them correctly.
   */
  update(vel: THREE.Vector3, density: number, light: THREE.Vector3, dt: number) {
    const L = this.L;
    const sp = vel.length();
    if (sp > 1e-3) this.dir.copy(vel).divideScalar(sp);
    const va = apparentSpeed(sp);
    this.offset.addScaledVector(this.dir, va * dt);
    this.offset.set(((this.offset.x % L) + L) % L, ((this.offset.y % L) + L) % L, ((this.offset.z % L) + L) % L);
    // fade in with motion; hold a trace of motes even when drifting so space never looks frozen
    const target = 0.12 + 0.88 * smoothstep(2, 60, sp);
    this.vis += (target - this.vis) * Math.min(1, dt * 3);
    const len = 0.15 + va * 0.055;
    const dens = 0.55 + 0.45 * density;
    // dust is lit by the star but always faintly visible (scattered starlight)
    const lr = 0.05 + light.x * 0.1, lg = 0.055 + light.y * 0.1, lb = 0.065 + light.z * 0.11;
    const { x: dx, y: dy, z: dz } = this.dir;
    for (let i = 0; i < this.n; i++) {
      const lx = ((((this.seeds[i * 4] - this.offset.x) % L) + L) % L) - L / 2;
      const ly = ((((this.seeds[i * 4 + 1] - this.offset.y) % L) + L) % L) - L / 2;
      const lz = ((((this.seeds[i * 4 + 2] - this.offset.z) % L) + L) % L) - L / 2;
      const d = Math.sqrt(lx * lx + ly * ly + lz * lz);
      // outside the hull, fading toward the edge of the box
      const a = this.vis * dens * this.seeds[i * 4 + 3] * smoothstep(5, 14, d) * Math.max(0, 1 - d / (L * 0.5));
      const o = i * 6;
      this.pos[o] = lx;
      this.pos[o + 1] = ly;
      this.pos[o + 2] = lz;
      this.pos[o + 3] = lx - dx * len;
      this.pos[o + 4] = ly - dy * len;
      this.pos[o + 5] = lz - dz * len;
      this.col[o] = lr * a;
      this.col[o + 1] = lg * a;
      this.col[o + 2] = lb * a;
      this.col[o + 3] = lr * a * 0.05;
      this.col[o + 4] = lg * a * 0.05;
      this.col[o + 5] = lb * a * 0.05;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }
}
