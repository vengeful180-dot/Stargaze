// Renders procedural shaders into cube maps, a few tiles per frame, so generating a sky or a planet surface
// never stalls a frame long enough to stutter (or trip a GPU watchdog on slow machines).
//
// Face convention (OpenGL / three.js render targets): for a fragment at st in [-1,1]^2 of face f,
//   +X ( 1, -t, -s)  -X (-1, -t,  s)  +Y ( s, 1,  t)  -Y ( s, -1, -t)  +Z ( s, -t, 1)  -Z (-s, -t, -1)
// Materials get uFace (int) and uSize (float) and compute their direction with faceDir() below.
import * as THREE from 'three';

export const FACE_DIR_GLSL = /* glsl */ `
uniform int uFace;
uniform float uSize;
vec3 faceDir(vec2 fragCoord) {
  vec2 st = fragCoord / uSize * 2.0 - 1.0;
  vec3 d;
  if (uFace == 0) d = vec3(1.0, -st.y, -st.x);
  else if (uFace == 1) d = vec3(-1.0, -st.y, st.x);
  else if (uFace == 2) d = vec3(st.x, 1.0, st.y);
  else if (uFace == 3) d = vec3(st.x, -1.0, -st.y);
  else if (uFace == 4) d = vec3(st.x, -st.y, 1.0);
  else d = vec3(-st.x, -st.y, -1.0);
  return normalize(d);
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

interface Job {
  rt: THREE.WebGLCubeRenderTarget;
  material: THREE.ShaderMaterial;
  tiles: number; // per side
  next: number;
  mips: boolean;
  resolve: () => void;
  cancelled: boolean;
}

export class CubeBaker {
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private queue: Job[] = [];

  constructor(private renderer: THREE.WebGLRenderer) {
    const geo = new THREE.BufferGeometry();
    // one oversized triangle covers the viewport
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(geo);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  static makeTarget(size: number, type: THREE.TextureDataType, mips: boolean): THREE.WebGLCubeRenderTarget {
    // generateMipmaps must be true when the target is first set up, or the immutable storage gets one level only.
    const rt = new THREE.WebGLCubeRenderTarget(size, {
      type,
      format: THREE.RGBAFormat,
      generateMipmaps: mips,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    rt.texture.colorSpace = THREE.NoColorSpace;
    return rt;
  }

  /** Queue a bake; resolves when every face is rendered (and mipmapped if asked). */
  bake(rt: THREE.WebGLCubeRenderTarget, material: THREE.ShaderMaterial, tilesPerSide = 1, mips = false): { promise: Promise<void>; cancel: () => void } {
    let job!: Job;
    if (mips) {
      rt.texture.generateMipmaps = true;
      this.renderer.initRenderTarget(rt);
    }
    const promise = new Promise<void>((resolve) => {
      job = { rt, material, tiles: Math.max(1, tilesPerSide), next: 0, mips, resolve, cancelled: false };
      this.queue.push(job);
    });
    return { promise, cancel: () => { job.cancelled = true; } };
  }

  /** Render everything queued right now (loading screens, tests). */
  flush() {
    while (this.queue.length) this.update(1e9);
  }

  get busy(): boolean {
    return this.queue.length > 0;
  }

  /** Process up to maxTiles tile draws. Call once per frame. */
  update(maxTiles: number) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevFace = r.getActiveCubeFace();
    const prevMip = r.getActiveMipmapLevel();
    let budget = maxTiles;
    while (budget > 0 && this.queue.length) {
      const job = this.queue[0];
      if (job.cancelled) {
        this.queue.shift();
        job.resolve();
        continue;
      }
      const size = job.rt.width;
      const n = job.tiles;
      const total = 6 * n * n;
      const idx = job.next++;
      const face = Math.floor(idx / (n * n));
      const t = idx % (n * n);
      const tx = t % n;
      const ty = Math.floor(t / n);
      const w = Math.ceil(size / n);
      job.material.uniforms.uFace.value = face;
      job.material.uniforms.uSize.value = size;
      this.quad.material = job.material;
      job.rt.scissorTest = n > 1;
      job.rt.scissor.set(tx * w, ty * w, w, w);
      job.rt.viewport.set(0, 0, size, size);
      // three regenerates mips after every render into a mip-filtered target; only let it on the last tile
      job.rt.texture.generateMipmaps = job.mips && job.next >= total;
      r.setRenderTarget(job.rt, face);
      r.render(this.scene, this.camera);
      budget--;
      if (job.next >= total) {
        job.rt.scissorTest = false;
        this.queue.shift();
        job.resolve();
      }
    }
    r.setRenderTarget(prevTarget, prevFace, prevMip);
  }
}
