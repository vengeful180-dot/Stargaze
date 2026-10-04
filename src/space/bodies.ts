// Scene objects for one star and its planets / moons: ray-traced sphere impostors, atmospheres, rings,
// surface cube maps baked on the GPU (re-baked at higher resolution for the world you approach).
import * as THREE from 'three';
import { CubeBaker, FACE_DIR_GLSL, FULLSCREEN_VERT } from '../render/cubeBaker';
import { Rng } from '../core/rng';
import { valueNoise1D } from '../core/noise';
import noiseGlsl from '../glsl/noise.glsl?raw';
import impostorGlsl from '../glsl/impostor.glsl?raw';
import impostorVert from '../glsl/impostor.vert.glsl?raw';
import planetFrag from '../glsl/planet.frag.glsl?raw';
import bakeFrag from '../glsl/planetBake.frag.glsl?raw';
import atmoFrag from '../glsl/atmosphere.frag.glsl?raw';
import ringsGlsl from '../glsl/rings.glsl?raw';
import starFrag from '../glsl/star.frag.glsl?raw';
import glowGlsl from '../glsl/glow.glsl?raw';
import type { PlanetBody, PlanetType, RingDef, StarBody } from './system';

const KIND: Record<PlanetType, number> = {
  terran: 0, ocean: 1, desert: 2, arid: 3, ice: 4, lava: 5, barren: 6, toxic: 7, exotic: 8, gas: 9, icegiant: 10,
};

export function splitGlsl(src: string): { vertex: string; fragment: string } {
  const [, v, f] = src.split(/\/\/--VERTEX|\/\/--FRAGMENT/);
  return { vertex: v, fragment: f };
}

const unitBox = new THREE.BoxGeometry(2, 2, 2);

function seedVec(rng: Rng): THREE.Vector3 {
  return new THREE.Vector3(rng.range(-80, 80), rng.range(-80, 80), rng.range(-80, 80));
}

/** One bake material per planet, created on demand and kept so re-bakes at other sizes are cheap to set up. */
function makeBakeMaterial(body: PlanetBody, clouds: boolean): THREE.ShaderMaterial {
  const s = body.surface;
  const rng = new Rng(s.seed);
  const storms: THREE.Vector4[] = [];
  for (let i = 0; i < 4; i++) {
    const lat = rng.range(-0.6, 0.6);
    const lon = rng.range(0, Math.PI * 2);
    const c = Math.cos(lat);
    storms.push(new THREE.Vector4(c * Math.cos(lon), Math.sin(lat), c * Math.sin(lon), rng.range(0.05, 0.16)));
  }
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: (clouds ? '#define BAKE_CLOUDS\n' : '') + noiseGlsl + FACE_DIR_GLSL + bakeFrag,
    uniforms: {
      uFace: { value: 0 },
      uSize: { value: 256 },
      uKind: { value: KIND[body.type] },
      uSeed: { value: seedVec(rng) },
      uPal: { value: s.palette.map((c) => new THREE.Vector3(...c)) },
      uOcean: { value: new THREE.Vector3(...s.ocean) },
      uShallow: { value: new THREE.Vector3(...s.shallow) },
      uSea: { value: s.seaLevel },
      uRough: { value: s.roughness },
      uCont: { value: s.continentScale },
      uMount: { value: s.mountains },
      uCraters: { value: s.craters },
      uIceCap: { value: s.iceCap },
      uBands: { value: s.bands },
      uTurb: { value: s.turbulence },
      uStorms: { value: s.storms },
      uStorm: { value: storms },
      uCover: { value: s.clouds },
      uOct: { value: 6 },
    },
    depthTest: false,
    depthWrite: false,
  });
}

/** Radial profile of a ring system: rgb colour, alpha density. */
function makeRingTexture(def: RingDef): THREE.DataTexture {
  const N = 1024;
  const data = new Uint8Array(N * 4);
  const rng = new Rng(def.seed);
  const n1 = valueNoise1D(def.seed);
  const n2 = valueNoise1D(def.seed ^ 0x9e37);
  const bands: { a: number; b: number; d: number }[] = [];
  let x = 0;
  while (x < 1) {
    const w = rng.range(0.06, 0.3);
    bands.push({ a: x, b: Math.min(1, x + w), d: rng.range(0.2, 1) });
    x += w;
  }
  const gaps = [{ c: rng.range(0.45, 0.72), w: rng.range(0.015, 0.045) }];
  for (let i = 0; i < 3; i++) gaps.push({ c: rng.range(0.1, 0.95), w: rng.range(0.003, 0.01) });
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    let d = 0;
    for (const b of bands) {
      const e = 0.01;
      const inside = Math.min(1, Math.max(0, (u - b.a) / e + 0.5)) * Math.min(1, Math.max(0, (b.b - u) / e + 0.5));
      d = Math.max(d, inside * b.d);
    }
    d *= 0.65 + 0.35 * n1(u * 40);
    d *= 0.8 + 0.2 * n2(u * 330);
    for (const g of gaps) d *= Math.min(1, Math.abs(u - g.c) / g.w);
    d *= Math.min(1, u / 0.04) * Math.min(1, (1 - u) / 0.06);
    const t = n2(u * 12);
    const shade = 0.8 + 0.4 * n1(u * 140 + 7);
    for (let k = 0; k < 3; k++) {
      const c = (def.color[k] * (1 - t) + def.color2[k] * t) * shade;
      data[i * 4 + k] = Math.min(255, Math.round(Math.sqrt(Math.min(1, c)) * 255));
    }
    data[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, d)) * 255);
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

const RING_DECODE = /* glsl */ `
vec4 ringSample(sampler2D t, float u) { vec4 v = texture2D(t, vec2(u, 0.5)); return vec4(v.rgb * v.rgb, v.a); }
`;

export interface BodyFrame {
  time: number;
  viewport: THREE.Vector2;
  camWorld: THREE.Vector3; // camera position in scene coordinates (floating origin)
  starWorld: THREE.Vector3; // star centre in scene coordinates
}

export class PlanetView {
  readonly group = new THREE.Group();
  readonly surface: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  atmosphere: THREE.Mesh | null = null;
  rings: THREE.Mesh | null = null;
  private bakeMat: THREE.ShaderMaterial | null = null;
  private cloudMat: THREE.ShaderMaterial | null = null;
  private surfaceRT: THREE.WebGLCubeRenderTarget | null = null;
  private cloudRT: THREE.WebGLCubeRenderTarget | null = null;
  faceSize = 0;
  private pendingSize = 0;
  private ringTex: THREE.DataTexture | null = null;
  /** Projected radius in pixels, updated every frame. */
  radiusPx = 0;
  readonly avgColor = new THREE.Vector3();
  private axisQuat = new THREE.Quaternion();
  private spinPhase: number;
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();

  constructor(
    readonly body: PlanetBody,
    private baker: CubeBaker,
    ecliptic: readonly number[],
  ) {
    const s = body.surface;
    const rng = new Rng(body.seed ^ 0x51);
    this.spinPhase = rng.range(0, Math.PI * 2);
    // spin axis: the ecliptic normal tilted by the axial tilt about a random horizontal axis
    const n = new THREE.Vector3(ecliptic[0], ecliptic[1], ecliptic[2]).normalize();
    const side = new THREE.Vector3(1, 0, 0).cross(n);
    if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
    side.normalize().applyAxisAngle(n, rng.range(0, Math.PI * 2));
    const axis = n.clone().applyAxisAngle(side, body.axialTilt);
    this.axisQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);

    const pal = s.palette;
    this.avgColor.set(
      (pal[0][0] + pal[1][0] + pal[2][0] + pal[3][0]) / 4,
      (pal[0][1] + pal[1][1] + pal[2][1] + pal[3][1]) / 4,
      (pal[0][2] + pal[1][2] + pal[2][2] + pal[3][2]) / 4,
    );
    if (s.seaLevel > 0.15) this.avgColor.lerp(new THREE.Vector3(...s.ocean), 0.6);
    if (s.clouds > 0.4) this.avgColor.lerp(new THREE.Vector3(...s.cloudColor), s.clouds * 0.6);

    const kind = KIND[body.type];
    const giant = kind >= 9;
    const placeholder = new THREE.CubeTexture();
    this.material = new THREE.ShaderMaterial({
      vertexShader: impostorVert,
      fragmentShader: noiseGlsl + impostorGlsl + planetFrag,
      uniforms: {
        uCamObj: { value: new THREE.Vector3(0, 0, 10) },
        uSunObj: { value: new THREE.Vector3(1, 0, 0) },
        uSunRad: { value: new THREE.Vector3(1, 1, 1) },
        uSurface: { value: placeholder },
        uClouds: { value: placeholder },
        uHasClouds: { value: 0 },
        uCloudRot: { value: 0 },
        uCloudColor: { value: new THREE.Vector3(...s.cloudColor) },
        uKind: { value: kind },
        uSea: { value: s.seaLevel },
        uHasOcean: { value: s.seaLevel > -1.5 && !giant ? 1 : 0 },
        uRelief: { value: body.type === 'barren' ? 0.05 : body.type === 'ocean' ? 0.025 : 0.035 },
        uFaceSize: { value: 64 },
        uAtmoColor: { value: new THREE.Vector3(...(body.atmosphere?.color ?? [0, 0, 0])) },
        uAtmoDensity: { value: body.atmosphere ? body.atmosphere.density : 0 },
        uCity: { value: s.cityLights },
        uSeedC: { value: seedVec(new Rng(s.seed ^ 0x77)) },
        uTime: { value: 0 },
        uFlowAmp: { value: 0.12 },
        uFlowPeriod: { value: 140 },
        uRing: { value: new THREE.Vector4(0, 0, 0, 0) },
        uRingTex: { value: null },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uMinPx: { value: 2.5 },
        uPlanetShine: { value: new THREE.Vector3() },
        uPlanetShineCol: { value: new THREE.Vector3() },
      },
      side: THREE.BackSide,
      alphaToCoverage: true,
    });
    this.surface = new THREE.Mesh(unitBox, this.material);
    this.surface.frustumCulled = false;
    this.group.add(this.surface);

    if (body.atmosphere) {
      const a = body.atmosphere;
      const ra = 1 + a.height;
      const H = a.height / 4.5;
      const tint = a.color;
      const m = Math.max(...tint);
      const beta = new THREE.Vector3(tint[0] / m, tint[1] / m, tint[2] / m).multiplyScalar((0.32 / H) * a.density);
      const mat = new THREE.ShaderMaterial({
        vertexShader: impostorVert,
        fragmentShader: impostorGlsl + atmoFrag,
        uniforms: {
          uCamObj: this.material.uniforms.uCamObj,
          uSunObj: this.material.uniforms.uSunObj,
          uSunRad: this.material.uniforms.uSunRad,
          uViewport: this.material.uniforms.uViewport,
          uMinPx: { value: 0 },
          uRa: { value: ra },
          uBetaR: { value: beta },
          uBetaM: { value: (0.08 / H) * a.mie * a.density },
          uH: { value: H },
          uIntensity: { value: 1.6 },
          uSteps: { value: 12 },
        },
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.atmosphere = new THREE.Mesh(new THREE.BoxGeometry(2 * ra, 2 * ra, 2 * ra), mat);
      this.atmosphere.frustumCulled = false;
      this.atmosphere.renderOrder = 2;
      this.group.add(this.atmosphere);
    }

    if (body.rings) {
      const r = body.rings;
      this.ringTex = makeRingTexture(r);
      const { vertex, fragment } = splitGlsl(ringsGlsl);
      const ringMat = new THREE.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment.replace('vec4 rt = texture2D(uRingTex, vec2(u, 0.5));', 'vec4 rt = ringSample(uRingTex, u);').replace('#include <logdepthbuf_pars_fragment>', '#include <logdepthbuf_pars_fragment>\n' + RING_DECODE),
        uniforms: {
          uRing: { value: new THREE.Vector4(r.inner, r.outer, r.opacity, 1) },
          uRingTex: { value: this.ringTex },
          uSunObj: this.material.uniforms.uSunObj,
          uSunRad: this.material.uniforms.uSunRad,
          uCamObj: this.material.uniforms.uCamObj,
        },
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
      });
      const g = new THREE.PlaneGeometry(2 * r.outer, 2 * r.outer, 1, 1);
      g.rotateX(-Math.PI / 2);
      this.rings = new THREE.Mesh(g, ringMat);
      this.rings.frustumCulled = false;
      this.rings.renderOrder = 1;
      this.group.add(this.rings);
      this.material.uniforms.uRing.value.set(r.inner, r.outer, r.opacity, 1);
      this.material.uniforms.uRingTex.value = this.ringTex;
    }

    this.group.scale.setScalar(body.radius);
  }

  /** Ask for a surface resolution; bakes in the background and swaps when done. */
  requestFace(size: number, cloudSize: number, octaves: number) {
    if (size === this.faceSize || size === this.pendingSize) return;
    this.pendingSize = size;
    if (!this.bakeMat) this.bakeMat = makeBakeMaterial(this.body, false);
    this.bakeMat.uniforms.uOct.value = octaves;
    const rt = CubeBaker.makeTarget(size, THREE.HalfFloatType, true);
    const tiles = Math.max(1, Math.round(size / 256));
    const jobs: Promise<void>[] = [this.baker.bake(rt, this.bakeMat, tiles, true).promise];
    let crt: THREE.WebGLCubeRenderTarget | null = null;
    if (this.body.surface.clouds > 0.01 && this.body.type !== 'gas' && this.body.type !== 'icegiant') {
      if (!this.cloudMat) this.cloudMat = makeBakeMaterial(this.body, true);
      this.cloudMat.uniforms.uOct.value = Math.min(octaves, 7);
      crt = new THREE.WebGLCubeRenderTarget(cloudSize, {
        type: THREE.UnsignedByteType,
        format: THREE.RedFormat,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      });
      crt.texture.colorSpace = THREE.NoColorSpace;
      jobs.push(this.baker.bake(crt, this.cloudMat, Math.max(1, Math.round(cloudSize / 256)), true).promise);
    }
    Promise.all(jobs).then(() => {
      if (this.pendingSize !== size) {
        rt.dispose();
        crt?.dispose();
        return;
      }
      this.surfaceRT?.dispose();
      this.cloudRT?.dispose();
      this.surfaceRT = rt;
      this.cloudRT = crt;
      this.faceSize = size;
      this.pendingSize = 0;
      const u = this.material.uniforms;
      u.uSurface.value = rt.texture;
      u.uFaceSize.value = size;
      if (crt) {
        u.uClouds.value = crt.texture;
        u.uHasClouds.value = 1;
      }
    });
  }

  get ready(): boolean {
    return this.faceSize > 0;
  }

  /** Spin axis (ring plane normal) in the system frame. */
  get axis(): THREE.Vector3 {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.axisQuat);
  }

  /** Position (scene coordinates), orientation and lighting for this frame. */
  update(f: BodyFrame, centre: THREE.Vector3, sunRad: THREE.Vector3, orbitAngle: number) {
    const b = this.body;
    this.group.position.copy(centre);
    const spin = b.kind === 'moon' ? -orbitAngle + this.spinPhase : this.spinPhase + (Math.PI * 2 * f.time) / b.spinPeriod;
    this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin);
    this.group.quaternion.copy(this.axisQuat).multiply(this.tmpQ);
    this.group.updateMatrixWorld(true);
    // camera and sun in object space (planet radii), computed in doubles
    const inv = this.tmpM.copy(this.group.matrixWorld).invert();
    const u = this.material.uniforms;
    u.uCamObj.value.copy(f.camWorld).applyMatrix4(inv);
    this.tmpV.copy(f.starWorld).sub(centre).normalize();
    u.uSunObj.value.copy(this.tmpV).applyQuaternion(this.tmpQ.copy(this.group.quaternion).invert()).normalize();
    u.uSunRad.value.copy(sunRad);
    u.uTime.value = f.time;
    u.uViewport.value.copy(f.viewport);
    u.uCloudRot.value = (f.time / (b.spinPeriod * 6)) * Math.PI * 2;
    const dist = Math.max(1, centre.distanceTo(f.camWorld));
    this.radiusPx = (b.radius / dist) * f.viewport.y * 0.5 * 1.4; // refined by caller with the real projection
  }

  setPlanetShine(dirObj: THREE.Vector3, color: THREE.Vector3) {
    this.material.uniforms.uPlanetShine.value.copy(dirObj);
    this.material.uniforms.uPlanetShineCol.value.copy(color);
  }

  dispose() {
    this.surfaceRT?.dispose();
    this.cloudRT?.dispose();
    this.ringTex?.dispose();
    this.material.dispose();
    this.bakeMat?.dispose();
    this.cloudMat?.dispose();
    (this.atmosphere?.material as THREE.Material | undefined)?.dispose();
    this.atmosphere?.geometry.dispose();
    (this.rings?.material as THREE.Material | undefined)?.dispose();
    this.rings?.geometry.dispose();
  }
}

export class StarView {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  readonly glow: THREE.Mesh;
  readonly glowMat: THREE.ShaderMaterial;

  constructor(readonly body: StarBody) {
    const c = new THREE.Vector3(...body.color);
    this.material = new THREE.ShaderMaterial({
      vertexShader: impostorVert,
      fragmentShader: noiseGlsl + impostorGlsl + starFrag,
      uniforms: {
        uCamObj: { value: new THREE.Vector3(0, 0, 10) },
        uColor: { value: c },
        uIntensity: { value: 60 },
        uTime: { value: 0 },
        uSeedC: { value: seedVec(new Rng(body.seed)) },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uMinPx: { value: 2 },
      },
      side: THREE.BackSide,
      alphaToCoverage: true,
    });
    const mesh = new THREE.Mesh(unitBox, this.material);
    mesh.frustumCulled = false;
    this.group.add(mesh);

    const { vertex, fragment } = splitGlsl(glowGlsl);
    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uSize: { value: 7 * body.radius }, // view-space metres (the glow ignores the group scale)
        uMinPx: { value: 70 },
        uViewport: this.material.uniforms.uViewport,
        uColor: { value: c.clone() },
        uIntensity: { value: 6 },
        uTime: { value: 0 },
        uCore: { value: 1 / 7 },
        uRays: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const quad = new THREE.PlaneGeometry(2, 2);
    this.glow = new THREE.Mesh(quad, this.glowMat);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 3;
    this.group.add(this.glow);
    mesh.scale.setScalar(body.radius);
  }

  update(f: BodyFrame, centre: THREE.Vector3) {
    this.group.position.copy(centre);
    this.group.updateMatrixWorld(true);
    const u = this.material.uniforms;
    // the glow quad is not scaled: its size is in metres
    u.uCamObj.value.copy(f.camWorld).sub(centre).divideScalar(this.body.radius);
    u.uTime.value = f.time;
    u.uViewport.value.copy(f.viewport);
    this.glowMat.uniforms.uTime.value = f.time;
  }

  dispose() {
    this.material.dispose();
    this.glowMat.dispose();
    this.glow.geometry.dispose();
  }
}
