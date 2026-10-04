// Catalogue stars as points: every bright point in the sky is a real system you can warp to.
import * as THREE from 'three';
import { Rng, hash } from '../core/rng';
import { blackbody } from '../core/color';
import type { Galaxy, NearSystem, SystemRef } from './galaxy';

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
void main() {
  vec4 mv = modelViewMatrix * vec4(position * 1.0e10, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = 0.5 * gl_Position.w; // depth test is off; keep it inside the clip volume
  float b = aBright * uScale;
  // faint stars keep a minimum footprint and lose intensity instead, so they do not shimmer
  float size = clamp(1.6 + 2.6 * log2(1.0 + b * 4.0), 1.6, 9.0);
  float tw = 1.0 + 0.06 * sin(uTime * (1.3 + aPhase * 2.0) + aPhase * 40.0);
  float hl = (abs(aIndex - uHighlightId) < 0.5) ? uHighlight : 0.0;
  gl_PointSize = (size + hl * 10.0) * uPixelRatio;
  vColor = aColor;
  vI = min(b, 6.0) * tw + hl * 2.0;
}
`;

const frag = /* glsl */ `
varying vec3 vColor;
varying float vI;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 10.0);
  float halo = exp(-r2 * 3.0) * 0.22;
  gl_FragColor = vec4(vColor * vI * (core + halo), 1.0);
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
      // power law: most are faint
      bright[i] = 0.05 + Math.pow(rng.next(), 9) * 1.1;
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
      // map flux to a perceptual intensity; reference: a sun-like star at 10 ly ~ 0.6
      bright[i] = Math.pow(flux(s) / 0.01, 0.45) * 0.6;
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
