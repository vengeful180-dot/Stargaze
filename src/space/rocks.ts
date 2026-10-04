// Procedural rock meshes: noisy, cratered, slightly elongated potatoes with baked cavity darkening.
import * as THREE from 'three';
import { Noise3 } from '../core/noise';
import { Rng } from '../core/rng';

function icosphere(detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  // IcosahedronGeometry is non-indexed; merge vertices so displacement keeps the surface closed
  const pos = g.getAttribute('position');
  const map = new Map<string, number>();
  const verts: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      verts.push(x, y, z);
      map.set(key, id);
    }
    index.push(id);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  out.setIndex(index);
  g.dispose();
  return out;
}

export function makeRockGeometry(seed: number, detail = 4, icy = false): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const noise = new Noise3(seed);
  const g = icosphere(detail);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const craters: { c: THREE.Vector3; r: number; d: number }[] = [];
  const nc = rng.int(4, 14);
  for (let i = 0; i < nc; i++) {
    const v = rng.unitVector();
    craters.push({ c: new THREE.Vector3(v.x, v.y, v.z), r: rng.range(0.15, 0.55), d: rng.range(0.04, 0.14) });
  }
  const stretch = new THREE.Vector3(rng.range(0.75, 1.35), rng.range(0.6, 1.0), rng.range(0.8, 1.2));
  const lumpy = rng.range(0.18, 0.38);
  const colors = new Float32Array(pos.count * 3);
  const radii = new Float32Array(pos.count);
  const v = new THREE.Vector3();
  let mean = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let r = 1 + lumpy * noise.fbm(v.x * 1.3, v.y * 1.3, v.z * 1.3, 4);
    r += 0.08 * (noise.ridged(v.x * 3 + 5, v.y * 3, v.z * 3, 4) - 0.5);
    r += 0.03 * noise.fbm(v.x * 9, v.y * 9, v.z * 9, 3);
    for (const c of craters) {
      const d = v.distanceTo(c.c) / c.r;
      if (d < 1.3) r += d < 1 ? -c.d * (1 - d * d) : c.d * 0.35 * Math.exp(-(((d - 1) * 6) ** 2));
    }
    radii[i] = r;
    mean += r;
    pos.setXYZ(i, v.x * r * stretch.x, v.y * r * stretch.y, v.z * r * stretch.z);
  }
  mean /= pos.count;
  // cavities darker, ridges lighter; a little mineral mottling
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const cav = THREE.MathUtils.clamp((radii[i] - mean) * 3.5 + 0.75, 0.35, 1.1);
    const mott = 0.85 + 0.3 * (noise.fbm(v.x * 4 + 11, v.y * 4, v.z * 4, 3) * 0.5 + 0.5);
    const base = icy ? [0.78, 0.84, 0.9] : [0.55, 0.5, 0.46];
    colors[i * 3] = base[0] * cav * mott;
    colors[i * 3 + 1] = base[1] * cav * mott;
    colors[i * 3 + 2] = base[2] * cav * mott;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Standard material plus fine triplanar-free bump from 3D noise in object space. */
export function makeRockMaterial(noiseGlsl: string, icy = false): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: icy ? 0.55 : 0.92,
    metalness: 0,
    color: 0xffffff,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockPos;\nvarying vec3 vRockAx;\nvarying vec3 vRockAy;\nvarying vec3 vRockAz;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vRockPos = position;
        mat4 rockMV = modelViewMatrix;
        #ifdef USE_INSTANCING
        rockMV = modelViewMatrix * instanceMatrix;
        #endif
        vRockAx = normalize((rockMV * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
        vRockAy = normalize((rockMV * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        vRockAz = normalize((rockMV * vec4(0.0, 0.0, 1.0, 0.0)).xyz);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockPos;\nvarying vec3 vRockAx;\nvarying vec3 vRockAy;\nvarying vec3 vRockAz;\n' + noiseGlsl)
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec4 nd = gnoised(vRockPos * 7.0);
          vec4 nd2 = gnoised(vRockPos * 23.0 + 4.0);
          vec3 g = nd.yzw * 0.6 + nd2.yzw * 0.35;
          vec3 gv = g.x * vRockAx + g.y * vRockAy + g.z * vRockAz;
          normal = normalize(normal - 0.18 * (gv - dot(gv, normal) * normal));
          diffuseColor.rgb *= 0.88 + 0.2 * nd2.x;
        }`,
      );
  };
  return m;
}
