// Catalogue stars as points: every bright point in the sky is a real system you can warp to.
import * as THREE from 'three';
import { Rng, hash } from '../core/rng';
import { blackbody } from '../core/color';
import type { Galaxy, NearSystem, SystemRef } from './galaxy';

// Each star is a point-spread function, not a blob: a crisp core about one device pixel wide carries the light,
// and only bright stars grow a soft glow. (Faint stars drawn as 2-3 px grey discs read as gravel.)
const vert = /* glsl */ `
attribute vec3 aColor;
attribute float aBright;
attribute float aPhase;
uniform float uPixelRatio;
uniform float uTime;
uniform float uScale;
uniform float uHighlight;
uniform float uHighlightId;
attribute float aIndex;
varying vec3 vColor;
varying float vI;
varying float vGlow;
varying float vSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position * 1.0e10, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = 0.5 * gl_Position.w; // depth test is off; keep it inside the clip volume
  float b = aBright * uScale;
  float glow = clamp(log2(1.0 + b * 2.5), 0.0, 3.2);
  float tw = 1.0 + 0.05 * sin(uTime * (1.3 + aPhase * 2.0) + aPhase * 40.0);
  float hl = (abs(aIndex - uHighlightId) < 0.5) ? uHighlight : 0.0;
  float size = (3.0 + glow * 6.0 + hl * 12.0) * uPixelRatio;
  gl_PointSize = size;
  vSize = size;
  vGlow = glow + hl;
  vColor = aColor;
  vI = b * tw + hl * 1.5;
}
`;

const frag = /* glsl */ `
uniform float uPixelRatio;
varying vec3 vColor;
varying float vI;
varying float vGlow;
varying float vSize;
void main() {
  vec2 c = (gl_PointCoord - 0.5) * vSize;          // device pixels from the centre
  float r2 = dot(c, c);
  float s = 0.6 * uPixelRatio;
  float core = exp(-r2 / (2.0 * s * s));
  float r = sqrt(r2) / uPixelRatio;
  float halo = vGlow * 0.045 * exp(-r / (0.9 + vGlow * 1.1));
  float edge = 1.0 - smoothstep(0.42, 0.5, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(vColor * vI * (core + halo) * edge, 1.0);
}
`;

export class StarField {
  readonly points: THREE.Points;
  readonly background: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  readonly bgMaterial: THREE.ShaderMaterial;
  systems: NearSystem[] = [];

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uPixelRatio: { value: 1 },
        uTime: { value: 0 },
        uScale: { value: 1 },
        uHighlight: { value: 0 },
        uHighlightId: { value: -1 },
      },
      // not "transparent": opaque-pass objects draw in renderOrder, so stars go first and worlds cover them
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -100;
    this.bgMaterial = this.material.clone();
    this.bgMaterial.uniforms.uScale.value = 1;
    this.background = new THREE.Points(new THREE.BufferGeometry(), this.bgMaterial);
    this.background.frustumCulled = false;
    this.background.renderOrder = -101;
    this.points.add(this.background);
  }

  /**
   * Unnamed background stars: far beyond the catalogue, so the same for every system. Crowded toward the
   * galactic plane and the galactic centre direction like the real sky.
   */
  buildBackground(universeSeed: number, count: number, posLy: readonly number[]) {
    const rng = new Rng(hash(universeSeed, 0xb6));
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const bright = new Float32Array(count);
    const phase = new Float32Array(count);
    const index = new Float32Array(count).fill(-10);
    const gcLon = Math.atan2(-posLy[2], -posLy[0]);
    for (let i = 0; i < count; i++) {
      let x: number, y: number, z: number;
      if (rng.chance(0.6)) {
        // band star: latitude concentrated near the plane, longitude leaning toward the centre
        const lat = rng.gauss() * (rng.chance(0.5) ? 0.08 : 0.22);
        const lon = rng.chance(0.45) ? gcLon + rng.gauss() * 0.9 : rng.range(0, Math.PI * 2);
        x = Math.cos(lat) * Math.cos(lon);
        z = Math.cos(lat) * Math.sin(lon);
        y = Math.sin(lat);
      } else {
        const v = rng.unitVector();
        x = v.x;
        y = v.y;
        z = v.z;
      }
      pos.set([x, y, z], i * 3);
      const t = rng.weighted([[3400, 3], [4500, 4], [5600, 4], [7000, 2], [10000, 1.2], [18000, 0.6]] as const) * rng.range(0.9, 1.1);
      col.set(blackbody(t), i * 3);
      // magnitudes: counts grow ~2.5x per magnitude, so nearly all sit at the edge of visibility and a handful
      // shine (a flat 0.05 floor for every star made an even grey speckle)
      const m = Math.max(0.6, 6.6 + Math.log(Math.max(1e-9, rng.next())) / Math.log(2.5));
      bright[i] = 0.007 * Math.pow(10, 0.4 * (6.6 - m));
      phase[i] = rng.next();
    }
    const g = this.background.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
  }

  /** Rebuild from the catalogue around posLy, skipping the system we are in. */
  build(galaxy: Galaxy, posLy: readonly number[], current: SystemRef | null, maxStars: number, radiusLy = 650) {
    const near = galaxy.systemsNear(posLy, radiusLy).filter((s) => s.ref.id !== current?.id && s.dist > 0.01);
    // apparent flux ~ L / d^2; keep the brightest
    const flux = (s: NearSystem) => s.ref.luminosity / (s.dist * s.dist);
    near.sort((a, b) => flux(b) - flux(a));
    const list = near.slice(0, maxStars);
    this.systems = list;
    const n = list.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const bright = new Float32Array(n);
    const phase = new Float32Array(n);
    const index = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = list[i];
      const dx = s.ref.pos[0] - posLy[0], dy = s.ref.pos[1] - posLy[1], dz = s.ref.pos[2] - posLy[2];
      const l = Math.hypot(dx, dy, dz);
      pos[i * 3] = dx / l;
      pos[i * 3 + 1] = dy / l;
      pos[i * 3 + 2] = dz / l;
      col.set(s.ref.color, i * 3);
      // map flux to a perceptual intensity; reference: a sun-like star at 10 ly ~ 0.5
      bright[i] = Math.min(4, Math.pow(flux(s) / 0.01, 0.5) * 0.5);
      phase[i] = (s.ref.seed % 1000) / 1000;
      index[i] = i;
    }
    const g = this.points.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));
    g.computeBoundingSphere();
  }

  /** Index of the catalogue star closest to a world direction, within maxAngle radians. */
  pick(dir: THREE.Vector3, maxAngle: number): number {
    const p = this.points.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!p) return -1;
    let best = -1;
    let bestDot = Math.cos(maxAngle);
    const b = this.points.geometry.getAttribute('aBright') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const d = p.getX(i) * dir.x + p.getY(i) * dir.y + p.getZ(i) * dir.z;
      // brighter stars are easier to click
      const bonus = Math.min(0.5, b.getX(i)) * 0.002;
      if (d + bonus > bestDot) {
        bestDot = d + bonus;
        best = i;
      }
    }
    return best;
  }

  update(time: number, pixelRatio: number) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uPixelRatio.value = pixelRatio;
    this.bgMaterial.uniforms.uTime.value = time;
    this.bgMaterial.uniforms.uPixelRatio.value = pixelRatio;
  }

  setHighlight(index: number, amount: number) {
    this.material.uniforms.uHighlightId.value = index;
    this.material.uniforms.uHighlight.value = amount;
  }
}
