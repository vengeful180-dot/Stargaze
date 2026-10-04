// Asteroid fields: rocks streamed in from a 3D cell grid around the ship (deterministic per cell), drawn as
// instanced meshes; plus a sparse cloud of glints tracing each belt from afar.
import * as THREE from 'three';
import { Rng, hash } from '../core/rng';
import type { QualityPreset } from '../core/settings';
import noiseGlsl from '../glsl/noise.glsl?raw';
import { makeRockGeometry, makeRockMaterial } from './rocks';
import type { BeltDef, PlanetBody, StarSystem } from './system';

const SHAPES = 6;

export interface Field {
  id: string;
  kind: 'belt' | 'ring';
  centreId: string; // body the field is centred on
  normal: THREE.Vector3; // plane normal (system frame)
  radius: number; // m, centre of the field
  width: number; // m (radial half-width scale)
  thickness: number; // m (vertical scale)
  cell: number; // m
  perCell: number; // expected rocks per cell at peak density
  size: [number, number]; // rock radius range, m
  seed: number;
  icy: boolean;
}

interface Rock {
  pos: THREE.Vector3; // relative to the field centre (so a planet's ring rocks travel with it)
  field: string;
  key: number; // squared distance to the ship at rebuild time
  radius: number;
  axis: THREE.Vector3;
  spin: number;
  q0: THREE.Quaternion;
  shape: number;
  tint: THREE.Color;
}

export function fieldsFor(system: StarSystem): Field[] {
  const out: Field[] = [];
  const n = new THREE.Vector3(...system.ecliptic);
  for (const b of system.belts as BeltDef[]) {
    out.push({
      id: b.id, kind: 'belt', centreId: b.parent.id, normal: n.clone(), radius: b.radius, width: b.width,
      thickness: b.thickness, cell: 6000, perCell: 2.2 * b.density, size: [6, 420], seed: b.seed, icy: false,
    });
  }
  for (const p of system.planets as PlanetBody[]) {
    if (!p.rings || !p.ringRocks) continue;
    out.push({
      id: `${p.id}:ringrocks`, kind: 'ring', centreId: p.id, normal: n.clone(), // replaced by the planet's axis at runtime
      radius: ((p.rings.inner + p.rings.outer) / 2) * p.radius, width: ((p.rings.outer - p.rings.inner) / 2) * p.radius,
      thickness: 900, cell: 700, perCell: 3.0, size: [0.6, 45], seed: p.rings.seed, icy: true,
    });
  }
  return out;
}

export class AsteroidField {
  readonly root = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private icyMeshes: THREE.InstancedMesh[] = [];
  private rocks: Rock[] = [];
  private cellKey = '';
  private maxPerShape: number;
  private glints: THREE.Points[] = [];
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  /** Nearest rock to the ship after the last update (for flight avoidance). */
  nearest: { dist: number; pos: THREE.Vector3; radius: number } | null = null;
  /** 0..1 how deep we are inside any field (for dust, music, autopilot caution). */
  inField = 0;

  constructor(
    readonly fields: Field[],
    quality: QualityPreset,
    private centreOf: (id: string) => { pos: THREE.Vector3; axis?: THREE.Vector3 },
  ) {
    this.maxPerShape = Math.max(20, Math.floor(quality.rocks / SHAPES));
    const rockMat = makeRockMaterial(noiseGlsl, false);
    const iceMat = makeRockMaterial(noiseGlsl, true);
    for (let i = 0; i < SHAPES; i++) {
      const g = makeRockGeometry(0x0c0ffee + i * 7919, quality.rocks > 900 ? 4 : 3, false);
      const m = new THREE.InstancedMesh(g, rockMat, this.maxPerShape);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      this.meshes.push(m);
      this.root.add(m);
      const gi = makeRockGeometry(0x1ce + i * 104729, 3, true);
      const mi = new THREE.InstancedMesh(gi, iceMat, this.maxPerShape);
      mi.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mi.count = 0;
      mi.frustumCulled = false;
      this.icyMeshes.push(mi);
      this.root.add(mi);
    }
    for (const f of fields) this.glints.push(this.makeGlints(f));
  }

  private makeGlints(f: Field): THREE.Points {
    const rng = new Rng(hash(f.seed, 0x611));
    const n = f.kind === 'belt' ? 6000 : 3000;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = f.radius + rng.gauss() * f.width * 0.6;
      const h = rng.gauss() * f.thickness * 0.5;
      // in the field's local frame: plane XZ, normal +Y (oriented at runtime)
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = h;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        uniform float uNear;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = length(mv.xyz);
          // near glints would jitter (float precision); the real rocks take over there
          vA = smoothstep(uNear, uNear * 4.0, d);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = 0.5 * gl_Position.w;
          gl_PointSize = 1.6;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vA;
        void main() { gl_FragColor = vec4(uColor * vA, 1.0); }`,
      uniforms: { uNear: { value: f.cell * 6 }, uColor: { value: new THREE.Color(f.icy ? 0x6a7078 : 0x4d4740).multiplyScalar(0.5) } },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    p.renderOrder = -40;
    this.root.add(p);
    return p;
  }

  /** Density 0..1 of a field at a system-frame point. */
  private density(f: Field, p: THREE.Vector3, centre: THREE.Vector3, normal: THREE.Vector3): number {
    const rel = this.tmpV.copy(p).sub(centre);
    const h = rel.dot(normal);
    const planar = Math.sqrt(Math.max(0, rel.lengthSq() - h * h));
    const dr = (planar - f.radius) / f.width;
    const dh = h / f.thickness;
    return Math.exp(-0.5 * (dr * dr + dh * dh));
  }

  update(time: number, shipPos: THREE.Vector3, sunDir: THREE.Vector3) {
    void sunDir;
    // field frames
    const frames = this.fields.map((f) => {
      const c = this.centreOf(f.centreId);
      return { f, centre: c.pos, normal: f.kind === 'ring' && c.axis ? c.axis : f.normal };
    });
    // glints follow their centre, oriented to the field plane
    frames.forEach((fr, i) => {
      const g = this.glints[i];
      g.position.copy(fr.centre).sub(shipPos);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), fr.normal);
    });

    let inField = 0;
    for (const fr of frames) inField = Math.max(inField, this.density(fr.f, shipPos, fr.centre, fr.normal));
    this.inField = inField;

    // rebuild the rock list when the ship enters a new cell (per field)
    const key = frames
      .map((fr) => {
        if (this.density(fr.f, shipPos, fr.centre, fr.normal) < 0.002) return '-';
        const c = fr.f.cell;
        // cells live in the field's centre frame so orbiting planets carry their ring rocks with them
        const rel = this.tmpV.copy(shipPos).sub(fr.centre);
        return `${Math.floor(rel.x / c)},${Math.floor(rel.y / c)},${Math.floor(rel.z / c)}`;
      })
      .join('|');
    if (key !== this.cellKey) {
      this.cellKey = key;
      this.rebuild(frames, shipPos);
    }

    // place instances (positions relative to the ship = floating origin)
    const counts = new Array(SHAPES).fill(0);
    const icounts = new Array(SHAPES).fill(0);
    let nearest = Infinity;
    let nearestRock: Rock | null = null;
    for (const r of this.rocks) {
      const icy = r.shape >= SHAPES;
      const s = r.shape % SHAPES;
      const list = icy ? this.icyMeshes : this.meshes;
      const cnt = icy ? icounts : counts;
      if (cnt[s] >= this.maxPerShape) continue;
      const fr = frames.find((x) => x.f.id === r.field);
      const world = this.tmpV.copy(r.pos);
      if (fr) world.add(fr.centre);
      const rel = world.sub(shipPos);
      const d = rel.length() - r.radius;
      if (d < nearest) {
        nearest = d;
        nearestRock = r;
      }
      this.tmpQ.setFromAxisAngle(r.axis, r.spin * time).multiply(r.q0);
      this.tmpS.setScalar(r.radius);
      this.tmpM.compose(rel, this.tmpQ, this.tmpS);
      list[s].setMatrixAt(cnt[s], this.tmpM);
      list[s].setColorAt(cnt[s], r.tint);
      cnt[s]++;
    }
    for (let i = 0; i < SHAPES; i++) {
      for (const [list, cnt] of [[this.meshes, counts], [this.icyMeshes, icounts]] as const) {
        const m = list[i];
        m.count = cnt[i];
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
    if (nearestRock) {
      const fr = frames.find((x) => x.f.id === nearestRock!.field);
      const p = nearestRock.pos.clone();
      if (fr) p.add(fr.centre);
      this.nearest = { dist: nearest, pos: p, radius: nearestRock.radius };
    } else this.nearest = null;
  }

  private rebuild(frames: { f: Field; centre: THREE.Vector3; normal: THREE.Vector3 }[], shipPos: THREE.Vector3) {
    this.rocks = [];
    for (const fr of frames) {
      const f = fr.f;
      if (this.density(f, shipPos, fr.centre, fr.normal) < 0.002) continue;
      const c = f.cell;
      const rel = new THREE.Vector3().copy(shipPos).sub(fr.centre);
      const cx = Math.floor(rel.x / c), cy = Math.floor(rel.y / c), cz = Math.floor(rel.z / c);
      const K = 3;
      for (let dx = -K; dx <= K; dx++)
        for (let dy = -K; dy <= K; dy++)
          for (let dz = -K; dz <= K; dz++) {
            const ix = cx + dx, iy = cy + dy, iz = cz + dz;
            const centre = new THREE.Vector3((ix + 0.5) * c, (iy + 0.5) * c, (iz + 0.5) * c).add(fr.centre);
            const dens = this.density(f, centre, fr.centre, fr.normal);
            if (dens < 0.01) continue;
            const rng = new Rng(hash(f.seed, ix, iy, iz));
            const lambda = f.perCell * dens;
            let n = 0;
            let p = Math.exp(-lambda);
            let acc = p;
            const u = rng.next();
            while (u > acc && n < 12) {
              n++;
              p *= lambda / n;
              acc += p;
            }
            for (let k = 0; k < n; k++) {
              const local = new THREE.Vector3((ix + rng.next()) * c, (iy + rng.next()) * c, (iz + rng.next()) * c);
              // size distribution: lots of small rocks, the odd big one
              const t = Math.pow(rng.next(), 3.2);
              const radius = f.size[0] + (f.size[1] - f.size[0]) * t;
              const v = rng.unitVector();
              const q0 = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(0, 6.3), rng.range(0, 6.3), rng.range(0, 6.3)));
              const shade = rng.range(0.55, 1.15);
              const warm = rng.range(-0.06, 0.08);
              const rock: Rock = {
                pos: local,
                key: this.tmpS.copy(local).add(fr.centre).distanceToSquared(shipPos),
                radius,
                axis: new THREE.Vector3(v.x, v.y, v.z),
                spin: rng.range(0.01, 0.12) * (radius > 100 ? 0.25 : 1) * rng.sign(),
                q0,
                shape: rng.int(0, SHAPES - 1) + (f.icy ? SHAPES : 0),
                tint: new THREE.Color(shade * (1 + warm), shade, shade * (1 - warm)),
                field: f.id,
              };
              this.rocks.push(rock);
            }
          }
    }
    // nearest first so the per-shape caps drop the far ones
    this.rocks.sort((a, b) => a.key - b.key);
  }

  dispose() {
    for (const m of [...this.meshes, ...this.icyMeshes]) {
      m.geometry.dispose();
      m.dispose();
    }
    for (const g of this.glints) {
      g.geometry.dispose();
      (g.material as THREE.Material).dispose();
    }
    this.root.removeFromParent();
  }
}
