// Ship state in the system frame (doubles). Flight model and autopilot live in flight.ts.
import * as THREE from 'three';

export class Ship {
  readonly pos = new THREE.Vector3(); // system frame, metres
  readonly vel = new THREE.Vector3(); // m/s, system frame
  readonly quat = new THREE.Quaternion(); // ship -> world
  readonly angVel = new THREE.Vector3(); // rad/s, ship-local
  readonly group = new THREE.Group(); // scene node at the origin, carries cabin + camera

  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quat);
  }

  up(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 1, 0).applyQuaternion(this.quat);
  }

  /** Orient so -Z looks at target (system frame) with the given up. */
  lookAt(target: THREE.Vector3, up: THREE.Vector3) {
    const m = new THREE.Matrix4().lookAt(this.pos, target, up);
    this.quat.setFromRotationMatrix(m);
  }

  syncGroup() {
    this.group.position.set(0, 0, 0);
    this.group.quaternion.copy(this.quat);
    this.group.updateMatrixWorld(true);
  }
}
