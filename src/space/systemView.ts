// Everything visible in the current star system, kept in scene coordinates around the ship (floating origin).
import * as THREE from 'three';
import type { CubeBaker } from '../render/cubeBaker';
import type { QualityPreset } from '../core/settings';
import { GAME_AU, orbitOffset, type Body, type PlanetBody, type StarSystem } from './system';
import { PlanetView, StarView, type BodyFrame } from './bodies';
import { AsteroidField, fieldsFor } from './asteroids';

const pointsVert = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = 0.5 * gl_Position.w;
  gl_PointSize = aSize;
}
`;
const pointsFrag = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor * exp(-r2 * 4.0), 1.0);
}
`;

export interface BodyState {
  body: Body;
  pos: THREE.Vector3; // system frame, metres (doubles)
  orbitAngle: number;
}

export class SystemView {
  readonly root = new THREE.Group();
  readonly star: StarView;
  readonly views: PlanetView[] = [];
  readonly states = new Map<string, BodyState>();
  private points: THREE.Points;
  private pointPos: Float32Array;
  private pointCol: Float32Array;
  private pointSize: Float32Array;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private sunRad = new THREE.Vector3();
  nearest: PlanetView | null = null;
  readonly asteroids: AsteroidField;
  readonly byId = new Map<string, PlanetView>();

  constructor(
    readonly system: StarSystem,
    baker: CubeBaker,
    private quality: QualityPreset,
  ) {
    this.star = new StarView(system.star);
    this.root.add(this.star.group);
    const all: PlanetBody[] = [];
    for (const p of system.planets) {
      all.push(p);
      all.push(...p.moons);
    }
    for (const b of all) {
      const v = new PlanetView(b, baker, system.ecliptic);
      this.views.push(v);
      this.byId.set(b.id, v);
      this.root.add(v.group);
      v.requestFace(b.kind === 'moon' ? Math.max(64, quality.planetFace / 2) : quality.planetFace, quality.cloudFace / 2, 5);
    }
    for (const b of system.bodies) this.states.set(b.id, { body: b, pos: new THREE.Vector3(), orbitAngle: 0 });

    const n = this.views.length;
    this.pointPos = new Float32Array(n * 3);
    this.pointCol = new Float32Array(n * 3);
    this.pointSize = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pointPos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.pointCol, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.pointSize, 1));
    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        vertexShader: pointsVert,
        fragmentShader: pointsFrag,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        transparent: false,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = -50;
    this.root.add(this.points);

    this.asteroids = new AsteroidField(fieldsFor(system), quality, (id) => ({
      pos: this.states.get(id)?.pos ?? new THREE.Vector3(),
      axis: this.byId.get(id)?.axis,
    }));
    this.root.add(this.asteroids.root);
  }

  /** Positions of every body at time t (system frame). */
  computeStates(t: number) {
    const sys = this.system;
    for (const st of this.states.values()) {
      const b = st.body;
      if (!b.orbit) {
        st.pos.set(0, 0, 0);
        continue;
      }
      const o = orbitOffset(b.orbit, sys.ecliptic, t, this.tmp);
      st.orbitAngle = b.orbit.phase + (Math.PI * 2 * t) / b.orbit.period;
      st.pos.set(o.x, o.y, o.z);
      if (b.parent && b.parent.orbit) {
        const parent = orbitOffset(b.parent.orbit, sys.ecliptic, t, this.tmp2);
        st.pos.x += parent.x;
        st.pos.y += parent.y;
        st.pos.z += parent.z;
      }
    }
  }

  /** Display irradiance of the star at a distance, compressed so outer worlds stay visible. */
  starIrradiance(dist: number, out: THREE.Vector3): THREE.Vector3 {
    const s = this.system.star;
    const e = s.luminosity / Math.max(1e-6, (dist / GAME_AU) ** 2);
    const i = Math.min(6, Math.max(0.3, 2.2 * Math.pow(e, 0.28)));
    return out.set(s.color[0] * i, s.color[1] * i, s.color[2] * i);
  }

  update(time: number, shipPos: THREE.Vector3, camera: THREE.PerspectiveCamera, viewport: THREE.Vector2) {
    this.computeStates(time);
    const camWorld = camera.getWorldPosition(this.tmp2).clone();
    const starCentre = new THREE.Vector3().copy(this.states.get(this.system.star.id)!.pos).sub(shipPos);
    const frame: BodyFrame = { time, viewport, camWorld, starWorld: starCentre };
    this.star.update(frame, starCentre);
    const proj = camera.projectionMatrix.elements[5];
    let best: PlanetView | null = null;
    let bestPx = 0;
    const centre = new THREE.Vector3();
    this.views.forEach((v, i) => {
      const st = this.states.get(v.body.id)!;
      centre.copy(st.pos).sub(shipPos);
      const distToStar = st.pos.length();
      this.starIrradiance(distToStar, this.sunRad);
      v.update(frame, centre, this.sunRad, st.orbitAngle);
      const dist = Math.max(1, centre.distanceTo(camWorld));
      const rPx = (v.body.radius / dist) * proj * 0.5 * viewport.y;
      v.radiusPx = rPx;
      v.group.visible = rPx > 0.9;
      if (rPx > bestPx) {
        bestPx = rPx;
        best = v;
      }
      // distant worlds as soft points, brightness by phase
      const toCam = this.tmp.copy(camWorld).sub(centre).normalize();
      const toSun = new THREE.Vector3().copy(starCentre).sub(centre).normalize();
      const phase = 0.5 + 0.5 * toCam.dot(toSun);
      const fade = THREE.MathUtils.clamp((2.2 - rPx) / 1.3, 0, 1);
      const dir = this.tmp.copy(centre).sub(camWorld).normalize().multiplyScalar(1e9).add(camWorld);
      this.pointPos.set([dir.x, dir.y, dir.z], i * 3);
      const k = fade * phase * Math.min(1, 0.25 + rPx) * 1.6;
      this.pointCol.set([v.avgColor.x * this.sunRad.x * k, v.avgColor.y * this.sunRad.y * k, v.avgColor.z * this.sunRad.z * k], i * 3);
      this.pointSize[i] = 3.2 * (window.devicePixelRatio || 1);
    });
    this.points.geometry.attributes.position.needsUpdate = true;
    (this.points.geometry.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;

    this.asteroids.update(time, shipPos, starCentre);

    // resolution management: the world filling the window gets the big cube map
    this.nearest = best;
    for (const v of this.views) {
      const q = this.quality;
      const isMoon = v.body.kind === 'moon';
      let want = isMoon ? Math.max(64, q.planetFace / 2) : q.planetFace;
      if (v === best && bestPx > 60) want = q.nearPlanetFace;
      else if (v.radiusPx > 40) want = Math.max(want, q.nearPlanetFace / 2);
      const oct = want >= 1024 ? 9 : want >= 512 ? 8 : want >= 256 ? 7 : 6;
      v.requestFace(want, Math.max(Math.min(q.cloudFace * 2, want), 64), oct);
    }
  }

  setQuality(q: QualityPreset) {
    this.quality = q;
  }

  /** Closest body hit by a ray (scene coordinates), with a minimum angular radius so tiny worlds are clickable. */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, shipPos: THREE.Vector3, minAngle: number): Body | null {
    let best: Body | null = null;
    let bestT = Infinity;
    for (const st of this.states.values()) {
      const c = this.tmp.copy(st.pos).sub(shipPos).sub(origin);
      const t = c.dot(dir);
      if (t <= 0) continue;
      const perp = Math.sqrt(Math.max(0, c.lengthSq() - t * t));
      const r = Math.max(st.body.radius * (st.body.kind === 'star' ? 1.5 : 1.05), t * Math.tan(minAngle));
      if (perp < r && t < bestT) {
        bestT = t;
        best = st.body;
      }
    }
    return best;
  }

  /** Distance from a system-frame point to the nearest body surface. */
  nearestSurface(p: THREE.Vector3): { body: Body; dist: number } {
    let best: Body = this.system.star;
    let bestD = Infinity;
    for (const st of this.states.values()) {
      const d = p.distanceTo(st.pos) - st.body.radius;
      if (d < bestD) {
        bestD = d;
        best = st.body;
      }
    }
    return { body: best, dist: bestD };
  }

  /** Position of a body in the system frame (last computed). */
  bodyPos(id: string): THREE.Vector3 | undefined {
    return this.states.get(id)?.pos;
  }

  dispose() {
    this.asteroids.dispose();
    this.star.dispose();
    for (const v of this.views) v.dispose();
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }
}
