// Flight model. Speed is limited by the distance to the nearest surface, so the ship crosses a system in
// seconds yet creeps politely past rocks and settles gently into a parking orbit. No damage, ever.
import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { Input } from '../core/input';
import type { Body, PlanetBody } from '../space/system';
import type { SystemView } from '../space/systemView';
import type { Ship } from './ship';

export type FlightMode = 'parked' | 'manual' | 'autopilot' | 'warp';
export type AutoPhase = 'align' | 'cruise';

const K_MANUAL = 0.55; // 1/s: speed per metre of clearance
const K_AUTO = 0.45;
const V_MAX = 3e9;
const V_MIN = 2;

export function standoff(b: Body): number {
  if (b.kind === 'star') return b.radius * 12;
  const p = b as PlanetBody;
  if (p.rings) return p.radius * p.rings.outer * 1.55;
  return p.radius * (p.kind === 'moon' ? 3.4 : 3.1);
}

export class Flight {
  mode: FlightMode = 'parked';
  phase: AutoPhase = 'align';
  target: Body | null = null;
  throttle = 0;
  speed = 0;
  /** Seconds until arrival (autopilot), Infinity otherwise. */
  eta = Infinity;
  distToTarget = 0;
  park: { body: Body; offset: THREE.Vector3; rate: number; axis: THREE.Vector3 } | null = null;
  onArrive: ((b: Body) => void) | null = null;
  onBump: (() => void) | null = null;
  private angVel = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private lookM = new THREE.Matrix4();
  private bumpCooldown = 0;

  /** Speed allowed at a point: proportional to the clearance to the nearest surface or rock. */
  speedLimit(p: THREE.Vector3, sv: SystemView, k: number): number {
    const surf = sv.nearestSurface(p).dist;
    const rock = sv.asteroids.nearest;
    const clearance = Math.min(surf, rock ? rock.dist * 3 + 40 : Infinity);
    return clamp(k * Math.max(clearance, 1), V_MIN, V_MAX);
  }

  engage(b: Body) {
    this.target = b;
    this.mode = 'autopilot';
    this.phase = 'align';
    this.park = null;
  }

  parkAt(b: Body, ship: Ship, sv: SystemView) {
    const bp = sv.bodyPos(b.id);
    if (!bp) return;
    const axis = new THREE.Vector3(...sv.system.ecliptic);
    this.park = { body: b, offset: ship.pos.clone().sub(bp), rate: 0.00045, axis };
    this.mode = 'parked';
    this.target = b;
  }

  stop() {
    this.throttle = 0;
    if (this.mode === 'autopilot') this.mode = 'manual';
  }

  /** Rotate the ship toward a world direction at a capped rate. Returns the remaining angle. */
  private turnToward(ship: Ship, dir: THREE.Vector3, up: THREE.Vector3, maxRate: number, dt: number): number {
    this.lookM.lookAt(this.tmp2.set(0, 0, 0), dir, up);
    this.tmpQ.setFromRotationMatrix(this.lookM);
    const angle = ship.quat.angleTo(this.tmpQ);
    if (angle > 1e-5) ship.quat.rotateTowards(this.tmpQ, maxRate * dt * Math.min(1, 0.25 + angle));
    return angle;
  }

  update(dt: number, ship: Ship, input: Input, sv: SystemView) {
    this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);
    // any helm input takes manual control
    const yaw = input.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    const pitch = input.axis(['KeyF', 'ArrowDown'], ['KeyR', 'ArrowUp']);
    const roll = input.axis(['KeyE'], ['KeyQ']);
    const thr = input.axis(['KeyS'], ['KeyW']);
    if ((yaw || pitch || roll || thr) && this.mode !== 'warp') {
      if (this.mode !== 'manual') {
        this.mode = 'manual';
        this.throttle = this.mode === 'manual' && this.speed > 0 ? this.throttle : 0;
        this.park = null;
      }
    }
    if (input.keys.has('Space') && this.mode === 'manual') this.throttle = 0;

    switch (this.mode) {
      case 'manual':
        this.manual(dt, ship, sv, yaw, pitch, roll, thr, input.keys.has('ShiftLeft') || input.keys.has('ShiftRight'));
        break;
      case 'autopilot':
        this.autopilot(dt, ship, sv);
        break;
      case 'parked':
        this.parked(dt, ship, sv);
        break;
      case 'warp':
        break;
    }
    this.speed = ship.vel.length();
    this.avoid(dt, ship, sv);
  }

  private manual(dt: number, ship: Ship, sv: SystemView, yaw: number, pitch: number, roll: number, thr: number, boost: boolean) {
    this.throttle = clamp(this.throttle + thr * dt * (thr > 0 ? 0.45 : 0.8), 0, 1);
    const target = this.tmp.set(pitch * 0.42, yaw * 0.42, roll * 0.7);
    this.angVel.x = damp(this.angVel.x, target.x, 3, dt);
    this.angVel.y = damp(this.angVel.y, target.y, 3, dt);
    this.angVel.z = damp(this.angVel.z, target.z, 3, dt);
    const ang = this.angVel.length();
    if (ang > 1e-6) {
      this.tmpQ.setFromAxisAngle(this.tmp2.copy(this.angVel).divideScalar(ang), ang * dt);
      ship.quat.multiply(this.tmpQ).normalize();
    }
    const lim = this.speedLimit(ship.pos, sv, K_MANUAL * (boost ? 3 : 1));
    const want = ship.forward(this.tmp).multiplyScalar(this.throttle * this.throttle * lim);
    ship.vel.x = damp(ship.vel.x, want.x, 1.3, dt);
    ship.vel.y = damp(ship.vel.y, want.y, 1.3, dt);
    ship.vel.z = damp(ship.vel.z, want.z, 1.3, dt);
    // never faster than the clearance allows, even while coasting
    const sp = ship.vel.length();
    if (sp > lim) ship.vel.multiplyScalar(lim / sp);
    ship.pos.addScaledVector(ship.vel, dt);
    this.eta = Infinity;
  }

  private autopilot(dt: number, ship: Ship, sv: SystemView) {
    const t = this.target;
    const tp = t ? sv.bodyPos(t.id) : undefined;
    if (!t || !tp) {
      this.mode = 'manual';
      return;
    }
    const to = this.tmp.copy(tp).sub(ship.pos);
    const dist = to.length();
    const dir = to.divideScalar(dist);
    const stand = standoff(t);
    const remaining = dist - stand;
    this.distToTarget = Math.max(0, dist - t.radius);
    const up = new THREE.Vector3(...sv.system.ecliptic);
    const angle = this.turnToward(ship, dir, up, 0.8, dt);
    let want = 0;
    if (this.phase === 'align') {
      if (angle < 0.06 || remaining < stand * 0.2) this.phase = 'cruise';
    } else {
      want = Math.min(this.speedLimit(ship.pos, sv, K_AUTO * 1.6), K_AUTO * Math.max(remaining, 0));
    }
    const v = this.tmp2.copy(dir).multiplyScalar(want);
    ship.vel.x = damp(ship.vel.x, v.x, 2, dt);
    ship.vel.y = damp(ship.vel.y, v.y, 2, dt);
    ship.vel.z = damp(ship.vel.z, v.z, 2, dt);
    ship.pos.addScaledVector(ship.vel, dt);
    this.eta = remaining > 0 ? Math.log(Math.max(remaining, 1) / Math.max(stand * 0.03, 1)) / K_AUTO + angle / 0.8 : 0;
    if (this.phase === 'cruise' && remaining < Math.max(stand * 0.03, 30)) {
      ship.vel.set(0, 0, 0);
      this.parkAt(t, ship, sv);
      this.onArrive?.(t);
    }
  }

  private parked(dt: number, ship: Ship, sv: SystemView) {
    const p = this.park;
    if (!p) {
      ship.vel.multiplyScalar(Math.exp(-2 * dt));
      ship.pos.addScaledVector(ship.vel, dt);
      return;
    }
    const bp = sv.bodyPos(p.body.id);
    if (!bp) return;
    // slow drift around the body: the view changes over minutes, never abruptly
    p.offset.applyAxisAngle(p.axis, p.rate * dt);
    const before = this.tmp2.copy(ship.pos);
    ship.pos.copy(bp).add(p.offset);
    ship.vel.copy(ship.pos).sub(before).divideScalar(Math.max(dt, 1e-4)).multiplyScalar(0); // co-moving: no felt motion
    // keep the world in view, a little off-centre so the window frames it
    const dir = this.tmp.copy(bp).sub(ship.pos).normalize();
    const up = new THREE.Vector3(...sv.system.ecliptic);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    dir.addScaledVector(side, -0.2).addScaledVector(up, -0.07).normalize();
    this.turnToward(ship, dir, up, 0.05, dt);
    this.distToTarget = Math.max(0, ship.pos.distanceTo(bp) - p.body.radius);
    this.eta = Infinity;
  }

  /** Gentle push away from rocks; a soft bump if we touch one. */
  private avoid(dt: number, ship: Ship, sv: SystemView) {
    const n = sv.asteroids.nearest;
    if (!n) return;
    const margin = n.radius * 0.6 + 25;
    if (n.dist < margin) {
      const away = this.tmp.copy(ship.pos).sub(n.pos).normalize();
      const push = (margin - n.dist) * 2.5;
      ship.pos.addScaledVector(away, push * dt);
      const into = ship.vel.dot(away);
      if (into < 0) ship.vel.addScaledVector(away, -into * 0.9);
      if (n.dist < n.radius * 0.1 + 6 && this.bumpCooldown <= 0) {
        this.bumpCooldown = 2;
        this.onBump?.();
      }
    }
  }
}
