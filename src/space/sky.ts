// Builds the background sky for a star system: a half-float cube map rendered by sky.frag.glsl.
import * as THREE from 'three';
import { CubeBaker, FACE_DIR_GLSL, FULLSCREEN_VERT } from '../render/cubeBaker';
import { Rng, hash } from '../core/rng';
import { hslLinear } from '../core/color';
import noiseGlsl from '../glsl/noise.glsl?raw';
import skyGlsl from '../glsl/sky.frag.glsl?raw';

export interface NebulaDef {
  centre: [number, number, number]; // ly
  radius: number; // ly
  seed: number;
  emissivity: number;
  dust: number;
  c1: [number, number, number];
  c2: [number, number, number];
}

const NEB_CELL = 420; // ly

const NEB_PALETTES: [number, number, number, number][] = [
  // hue1, hue2 (turns), saturation, lightness
  [0.96, 0.52, 0.75, 0.6], // rose + teal
  [0.78, 0.55, 0.65, 0.6], // violet + cyan
  [0.04, 0.9, 0.8, 0.55], // ember + magenta
  [0.6, 0.66, 0.7, 0.62], // blue reflection
  [0.08, 0.5, 0.75, 0.6], // amber + teal
  [0.92, 0.75, 0.6, 0.62], // pink + purple
];

/** Nebulae around a position: generated per 420 ly cell so neighbouring systems agree. */
export function nebulaeNear(universeSeed: number, posLy: readonly number[], max = 6): NebulaDef[] {
  const out: (NebulaDef & { score: number })[] = [];
  const k = 4;
  const c0 = posLy.map((v) => Math.floor(v / NEB_CELL));
  for (let dx = -k; dx <= k; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -k; dz <= k; dz++) {
        const cx = c0[0] + dx, cy = c0[1] + dy, cz = c0[2] + dz;
        const rng = new Rng(hash(universeSeed, cx, cy, cz, 0x7e5));
        if (!rng.chance(0.2)) continue;
        const centre: [number, number, number] = [
          (cx + rng.next()) * NEB_CELL,
          (cy + 0.5) * NEB_CELL * 0.35 + rng.range(-60, 60),
          (cz + rng.next()) * NEB_CELL,
        ];
        const radius = rng.range(35, 150);
        const dist = Math.hypot(centre[0] - posLy[0], centre[1] - posLy[1], centre[2] - posLy[2]);
        const angular = radius / Math.max(dist, radius * 0.5);
        if (angular < 0.035) continue;
        const [h1, h2, s, l] = rng.pick(NEB_PALETTES);
        out.push({
          centre,
          radius,
          seed: rng.range(0, 100),
          emissivity: rng.range(0.6, 1.4),
          dust: rng.range(0.4, 1.6),
          c1: hslLinear(h1 + rng.range(-0.03, 0.03), s, l),
          c2: hslLinear(h2 + rng.range(-0.03, 0.03), s * 0.9, l * 0.95),
          score: angular,
        });
      }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, max);
}

export class SkyGenerator {
  readonly material: THREE.ShaderMaterial;
  private galaxies: { dir: THREE.Vector3; size: number; ratio: number; rot: number; bright: number }[] = [];

  constructor(
    private baker: CubeBaker,
    readonly universeSeed: number,
  ) {
    const rng = new Rng(hash(universeSeed, 0x6a1));
    for (let i = 0; i < 8; i++) {
      const v = rng.unitVector();
      this.galaxies.push({
        dir: new THREE.Vector3(v.x, v.y, v.z),
        size: rng.range(0.004, 0.014),
        ratio: rng.range(0.25, 0.9),
        rot: rng.range(0, Math.PI),
        bright: rng.range(0.15, 0.5),
      });
    }
    const zero4 = () => Array.from({ length: 6 }, () => new THREE.Vector4());
    const zero3 = () => Array.from({ length: 6 }, () => new THREE.Vector3());
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: noiseGlsl + FACE_DIR_GLSL + skyGlsl,
      uniforms: {
        uFace: { value: 0 },
        uSize: { value: 512 },
        uPos: { value: new THREE.Vector3() },
        uSteps: { value: 48 },
        uBright: { value: Number(new URLSearchParams(location.search).get('mw') ?? 0.045) },
        uStarBright: { value: 0.03 },
        uSeedOff: { value: new THREE.Vector3(rng.range(0, 100), rng.range(0, 100), rng.range(0, 100)) },
        uNebCount: { value: 0 },
        uNebA: { value: zero4() },
        uNebB: { value: zero4() },
        uNebC1: { value: zero3() },
        uNebC2: { value: zero3() },
        uGal: { value: this.galaxies.map((g) => new THREE.Vector4(g.dir.x, g.dir.y, g.dir.z, g.size)) },
        uGalB: { value: this.galaxies.map((g) => new THREE.Vector4(g.ratio, g.rot, g.bright, 0)) },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  /** Start rendering the sky seen from posLy. Returns the target immediately; it fills in over a few frames. */
  generate(posLy: readonly number[], nebulae: NebulaDef[], face: number, steps: number, tiles = 4) {
    const override = Number(new URLSearchParams(location.search).get('skyface'));
    if (override) face = override;
    const rt = CubeBaker.makeTarget(face, THREE.HalfFloatType, false);
    const mat = this.material.clone();
    const u = mat.uniforms;
    u.uPos.value.set(posLy[0] / 1000, posLy[1] / 1000, posLy[2] / 1000);
    u.uSteps.value = steps;
    u.uNebCount.value = nebulae.length;
    nebulae.forEach((n, i) => {
      u.uNebA.value[i].set(n.centre[0] / 1000, n.centre[1] / 1000, n.centre[2] / 1000, n.radius / 1000);
      u.uNebB.value[i].set(n.seed, n.emissivity, n.dust, 0);
      u.uNebC1.value[i].set(...n.c1);
      u.uNebC2.value[i].set(...n.c2);
    });
    const job = this.baker.bake(rt, mat, tiles, false);
    job.promise.then(() => mat.dispose());
    return { target: rt, ...job };
  }
}
