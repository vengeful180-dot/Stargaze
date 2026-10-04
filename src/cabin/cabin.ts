// The cabin: loads the GLB + baked textures exported by blender/bake_cabin.py and builds the runtime materials:
//   - atlas surfaces: albedo / ORM / normal + two baked lightmaps (lamp group A, console group B) with dimmers,
//     reflections from a probe rendered at the pilot's eye, and the live star as a real-time shadowing light;
//   - glass that mostly lets space through but catches the lamps' reflections;
//   - emitters (bulbs, strips) whose brightness follows their light group.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { markCabin } from './materials';

export interface Manifest {
  glb: string;
  textures: Record<'albedo' | 'orm' | 'normal' | 'lm_a' | 'lm_b' | 'probe', string>;
  lightmap: { scale: number };
  emissive: Record<string, { color: [number, number, number]; strength: number; group: 'A' | 'B' }>;
  /** per emitter node: its zone's colour and strength (bulbs, strips, the orrery's sun) */
  emitters?: Record<string, { color: [number, number, number]; strength: number; group: 'A' | 'B'; zone: string }>;
  /** nodes the game turns, and the local axis they turn about */
  pivots?: Record<string, 'x' | 'y'>;
  /** where the music comes from: glTF / ship-local metres, and the way the speaker faces */
  radio?: { pos: [number, number, number]; facing: [number, number, number] };
}

export interface LightLevels {
  lamps: number; // group A, 0..1.5
  console: number; // group B, 0..1.5
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`failed to load ${url}`));
    im.src = url;
  });

/** sqrt-encoded 8-bit PNG -> linear half-float texture (lightmaps, probe) */
async function loadEncoded(url: string, scale: number): Promise<THREE.DataTexture> {
  const im = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = im.width;
  c.height = im.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(im, 0, 0);
  const src = ctx.getImageData(0, 0, im.width, im.height).data;
  const n = im.width * im.height;
  const out = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = src[i * 4 + k] / 255;
      out[i * 4 + k] = THREE.DataUtils.toHalfFloat(v * v * scale);
    }
    out[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const t = new THREE.DataTexture(out, im.width, im.height, THREE.RGBAFormat, THREE.HalfFloatType);
  t.flipY = true; // match the image orientation of TextureLoader textures (glTF UVs expect flipY = false + top-left)
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export class Cabin {
  readonly root = new THREE.Group();
  readonly nodes = new Map<string, THREE.Object3D>();
  readonly levels: LightLevels = { lamps: 1, console: 1 };
  glass: THREE.Mesh[] = [];
  screens = new Map<string, THREE.Mesh>();
  loaded = false;
  manifest: Manifest | null = null;
  private atlasMats: THREE.MeshStandardMaterial[] = [];
  private uniforms = {
    lmA: { value: null as THREE.Texture | null },
    lmB: { value: null as THREE.Texture | null },
    uLampA: { value: new THREE.Color(1, 1, 1) },
    uLampB: { value: new THREE.Color(1, 1, 1) },
    uShadeGlow: { value: 0 },
    uSunScale: { value: 0.35 },
  };
  private emitters: { mat: THREE.MeshBasicMaterial; base: THREE.Color; group: 'A' | 'B' }[] = [];
  envMap: THREE.Texture | null = null;

  async load(base: string, renderer: THREE.WebGLRenderer): Promise<void> {
    const man = (await (await fetch(`${base}/cabin.json`)).json()) as Manifest;
    this.manifest = man;
    const tl = new THREE.TextureLoader();
    const tex = (name: keyof Manifest['textures'], srgb: boolean) =>
      tl.loadAsync(`${base}/${man.textures[name]}`).then((t) => {
        t.flipY = false; // glTF UV convention
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = 8;
        return t;
      });
    const [gltf, albedo, orm, normal, lmA, lmB, probe] = await Promise.all([
      new GLTFLoader().loadAsync(`${base}/${man.glb}`),
      tex('albedo', true),
      tex('orm', false),
      tex('normal', false),
      loadEncoded(`${base}/${man.textures.lm_a}`, man.lightmap.scale),
      loadEncoded(`${base}/${man.textures.lm_b}`, man.lightmap.scale),
      loadEncoded(`${base}/${man.textures.probe}`, man.lightmap.scale),
    ]);
    for (const t of [lmA, lmB]) t.flipY = false;
    this.uniforms.lmA.value = lmA;
    this.uniforms.lmB.value = lmB;

    // reflections: the cabin seen from the pilot's eye, prefiltered for roughness
    probe.mapping = THREE.EquirectangularReflectionMapping;
    probe.flipY = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromEquirectangular(probe).texture;
    pmrem.dispose();

    const atlas = this.atlasMaterial(albedo, orm, normal, false);
    const shade = this.atlasMaterial(albedo, orm, normal, true);
    const glass = this.glassMaterial();

    gltf.scene.traverse((o) => {
      this.nodes.set(o.name, o);
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const name = (m.material as THREE.Material).name;
      m.castShadow = true;
      m.receiveShadow = true;
      if (name === 'CabinAtlas') m.material = atlas;
      else if (name === 'Shade') m.material = shade;
      else if (name === 'Glass') {
        m.material = glass;
        m.castShadow = false;
        m.renderOrder = 10;
        this.glass.push(m);
      } else if (name === 'Emit_A' || name === 'Emit_B') {
        const g = name === 'Emit_A' ? 'A' : 'B';
        const z = man.emitters?.[m.name] ?? Object.values(man.emissive).find((e) => e.group === g)!;
        const baseCol = new THREE.Color(...z.color).multiplyScalar(z.strength * 0.08);
        const mat = markCabin(new THREE.MeshBasicMaterial({ color: baseCol.clone() }), 0);
        this.emitters.push({ mat, base: baseCol, group: g });
        m.material = mat;
        m.castShadow = false;
      } else if (name === 'Screen') {
        m.material = markCabin(new THREE.MeshBasicMaterial({ color: 0x110c08 }), 0);
        m.castShadow = false;
        this.screens.set(m.name, m);
      }
    });
    this.root.add(gltf.scene);
    this.setLevels(this.levels);
    this.loaded = true;
  }

  private atlasMaterial(albedo: THREE.Texture, orm: THREE.Texture, normal: THREE.Texture, glow: boolean) {
    const m = new THREE.MeshStandardMaterial({
      map: albedo,
      roughnessMap: orm,
      metalnessMap: orm,
      aoMap: orm,
      aoMapIntensity: 0.45,
      normalMap: normal,
      normalScale: new THREE.Vector2(1, 1),
      roughness: 1,
      metalness: 1,
      envMapIntensity: 1,
    });
    m.name = glow ? 'ShadeGlow' : 'CabinAtlas';
    const u = this.uniforms;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D lmA;
uniform sampler2D lmB;
uniform vec3 uLampA;
uniform vec3 uLampB;
uniform float uShadeGlow;
uniform float uSunScale;`,
        )
        .replace(
          '#include <lights_fragment_maps>',
          `// the star is the only direct light; inside the cabin it is softened so the lamps stay the mood
  reflectedLight.directDiffuse *= uSunScale;
  reflectedLight.directSpecular *= uSunScale;
#include <lights_fragment_maps>
{
  // baked irradiance of the two light groups (the lightmaps share the atlas UVs)
  vec3 eA = texture2D(lmA, vMapUv).rgb;
  vec3 eB = texture2D(lmB, vMapUv).rgb;
  irradiance += eA * uLampA + eB * uLampB;
}`,
        );
      if (glow) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  // a lit shade glows: warm bulb light passing through the fabric (tinted by the bulb, not white)
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.7, 0.4) * uLampA * uShadeGlow;`,
        );
      }
    };
    m.customProgramCacheKey = () => (glow ? 'cabin-shade' : 'cabin-atlas');
    markCabin(m, 0);
    this.atlasMats.push(m);
    return m;
  }

  private glassMaterial() {
    const m = new THREE.MeshStandardMaterial({
      color: 0x0a0c0e,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      opacity: 0.05,
      depthWrite: false,
      envMapIntensity: 1.6,
    });
    m.name = 'CabinGlass';
    // reflection strength follows Fresnel: barely there head-on, stronger at grazing angles
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), -normal) * -1.0, 0.0, 1.0), 4.0);
  diffuseColor.a = clamp(0.035 + fres * 0.5, 0.0, 0.6);
  #include <opaque_fragment>`,
      );
    };
    m.customProgramCacheKey = () => 'cabin-glass';
    // no markCabin: blending keeps the space behind the glass at alpha 1, so the warp mask still sees through it
    return m;
  }

  setLevels(l: Partial<LightLevels>) {
    Object.assign(this.levels, l);
    this.uniforms.uLampA.value.setScalar(this.levels.lamps);
    this.uniforms.uLampB.value.setScalar(this.levels.console);
    this.uniforms.uShadeGlow.value = 0.55;
    for (const e of this.emitters) e.mat.color.copy(e.base).multiplyScalar(e.group === 'A' ? this.levels.lamps : this.levels.console);
  }

  setSunScale(k: number) {
    this.uniforms.uSunScale.value = k;
  }

  /** Space reflections: the cabin probe for the interior; glass also sees it. */
  applyEnv() {
    if (!this.envMap) return;
    for (const m of this.atlasMats) m.envMap = this.envMap;
    for (const g of this.glass) (g.material as THREE.MeshStandardMaterial).envMap = this.envMap;
  }
}
