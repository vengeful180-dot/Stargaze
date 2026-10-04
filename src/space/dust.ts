// Motes of dust drifting past the windows: the only thing that tells you how fast you're moving in a void.
import * as THREE from 'three';
import { Rng } from '../core/rng';

export class SpeedDust {
  readonly lines: THREE.LineSegments;
  private seeds: Float64Array;
  private pos: Float32Array;
  private col: Float32Array;
  private n: number;
  private L = 420;

  constructor(count = 700) {
    this.n = count;
    const rng = new Rng(0xd057);
    this.seeds = new Float64Array(count * 3);
    for (let i = 0; i < count * 3; i++) this.seeds[i] = rng.next() * this.L;
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

  /** density: 0..1 (more inside asteroid fields); light: sunlight colour scale. */
  update(shipPos: THREE.Vector3, vel: THREE.Vector3, density: number, light: THREE.Vector3) {
    const L = this.L;
    const sp = vel.length();
    // streaks need relative motion; above ~1.5 km/s the lattice would alias, so fade out
    const vis = Math.min(1, sp / 12) * (1 - Math.min(1, Math.max(0, (sp - 600) / 1200))) * (0.25 + 0.75 * density);
    const len = Math.min(35, sp * 0.035) + 0.15;
    const vx = sp > 1e-6 ? vel.x / sp : 0, vy = sp > 1e-6 ? vel.y / sp : 0, vz = sp > 1e-6 ? vel.z / sp : 0;
    for (let i = 0; i < this.n; i++) {
      const lx = ((((this.seeds[i * 3] - shipPos.x) % L) + L) % L) - L / 2;
      const ly = ((((this.seeds[i * 3 + 1] - shipPos.y) % L) + L) % L) - L / 2;
      const lz = ((((this.seeds[i * 3 + 2] - shipPos.z) % L) + L) % L) - L / 2;
      const d = Math.sqrt(lx * lx + ly * ly + lz * lz);
      // keep motes outside the hull and fade them toward the edge of the box
      const a = vis * Math.min(1, Math.max(0, (d - 6) / 10)) * Math.max(0, 1 - d / (L * 0.5));
      this.pos[i * 6] = lx;
      this.pos[i * 6 + 1] = ly;
      this.pos[i * 6 + 2] = lz;
      this.pos[i * 6 + 3] = lx - vx * len;
      this.pos[i * 6 + 4] = ly - vy * len;
      this.pos[i * 6 + 5] = lz - vz * len;
      const r = light.x * a * 0.06, g = light.y * a * 0.06, b = light.z * a * 0.07;
      this.col[i * 6] = r;
      this.col[i * 6 + 1] = g;
      this.col[i * 6 + 2] = b;
      this.col[i * 6 + 3] = r * 0.1;
      this.col[i * 6 + 4] = g * 0.1;
      this.col[i * 6 + 5] = b * 0.1;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }
}
