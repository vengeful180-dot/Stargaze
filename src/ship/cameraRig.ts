// Seated head: yaw / pitch with soft limits, smoothed, plus gentle breathing sway.
import * as THREE from 'three';
import { clamp, damp, DEG } from '../core/math';

export interface Spot {
  name: string;
  eye: THREE.Vector3; // ship-local
  yaw: number; // rad, 0 = looking forward (-Z)
  pitch: number;
  yawLimit: [number, number];
  pitchLimit: [number, number];
}

export class CameraRig {
  readonly root = new THREE.Group(); // eye position, ship-local
  readonly yawNode = new THREE.Group();
  readonly pitchNode = new THREE.Group();
  yaw = 0;
  pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  fov: number;
  private targetFov: number;
  spot: Spot;
  private moveFrom = new THREE.Vector3();
  private moveT = 1;
  private time = 0;
  reduceMotion = false;
  /** Extra pitch/yaw applied on top (seat recline, telescope) in radians. */
  lean = 0;

  constructor(readonly camera: THREE.PerspectiveCamera, spot: Spot, fov: number) {
    this.spot = spot;
    this.fov = this.targetFov = fov;
    this.root.position.copy(spot.eye);
    this.yaw = this.targetYaw = spot.yaw;
    this.pitch = this.targetPitch = spot.pitch;
    this.root.add(this.yawNode);
    this.yawNode.add(this.pitchNode);
    this.pitchNode.add(camera);
    camera.position.set(0, 0, 0);
    camera.rotation.set(0, 0, 0);
  }

  look(dxPx: number, dyPx: number, sensitivity: number, invertY: boolean) {
    const k = 0.0032 * sensitivity * (this.fov / 68);
    this.targetYaw -= dxPx * k;
    this.targetPitch -= dyPx * k * (invertY ? -1 : 1);
    this.clampTargets();
  }

  /** Jump straight to a view (degrees; yaw positive = turn left like three.js). Used by tests and spots. */
  setView(yawDeg: number, pitchDeg: number) {
    this.yaw = this.targetYaw = yawDeg * DEG;
    this.pitch = this.targetPitch = pitchDeg * DEG;
  }

  zoom(steps: number) {
    this.targetFov = clamp(this.targetFov + steps * 4, 22, 85);
  }

  setFov(f: number) {
    this.targetFov = f;
  }

  goTo(spot: Spot) {
    this.moveFrom.copy(this.root.position);
    this.moveT = 0;
    this.spot = spot;
    this.targetYaw = spot.yaw;
    this.targetPitch = spot.pitch;
  }

  /** Point the head at a ship-local direction (used by hotspots). */
  lookAtLocal(dir: THREE.Vector3) {
    this.targetYaw = Math.atan2(-dir.x, -dir.z);
    this.targetPitch = Math.asin(clamp(dir.y / dir.length(), -1, 1));
    this.clampTargets();
  }

  private clampTargets() {
    const s = this.spot;
    // soft limits: allow the wide seated range, stop at the limits
    this.targetYaw = clamp(this.targetYaw, s.yawLimit[0], s.yawLimit[1]);
    this.targetPitch = clamp(this.targetPitch, s.pitchLimit[0], s.pitchLimit[1]);
  }

  update(dt: number) {
    this.time += dt;
    this.yaw = damp(this.yaw, this.targetYaw, 14, dt);
    this.pitch = damp(this.pitch, this.targetPitch, 14, dt);
    this.fov = damp(this.fov, this.targetFov, 10, dt);
    if (this.moveT < 1) {
      this.moveT = Math.min(1, this.moveT + dt / 1.4);
      const e = this.moveT * this.moveT * (3 - 2 * this.moveT);
      this.root.position.lerpVectors(this.moveFrom, this.spot.eye, e);
    }
    const sway = this.reduceMotion ? 0 : 1;
    const breathe = Math.sin(this.time * 1.25) * 0.0035 * sway;
    this.yawNode.rotation.y = this.yaw + Math.sin(this.time * 0.37) * 0.0025 * sway;
    this.pitchNode.rotation.x = this.pitch + this.lean + breathe;
    this.camera.position.y = breathe * 0.6;
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

export const PILOT_SPOT: Spot = {
  name: 'Pilot seat',
  eye: new THREE.Vector3(0, 1.17, 0),
  yaw: 0,
  pitch: -4 * DEG,
  yawLimit: [-150 * DEG, 150 * DEG],
  pitchLimit: [-55 * DEG, 80 * DEG],
};
