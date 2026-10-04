// Temporary cabin used until the Blender cabin lands: just enough frame to judge window framing.
import * as THREE from 'three';

export function makePlaceholderCabin(): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15100c, roughness: 0.8 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xb08a4a, roughness: 0.35, metalness: 1 });
  // console
  const console_ = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 0.08, 48, 1, false, -Math.PI * 0.35, Math.PI * 0.7), wood);
  console_.rotation.y = Math.PI;
  console_.position.set(0, 0.78, 0.15);
  console_.scale.set(1, 1, 0.85);
  g.add(console_);
  const front = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.82, 0.2), dark);
  front.position.set(0, 0.4, -1.25);
  g.add(front);
  // canopy ribs: arcs over the head
  for (const x of [-1.05, -0.35, 0.35, 1.05]) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.035, 8, 48, Math.PI * 0.62), brass);
    rib.rotation.set(0, Math.PI / 2, 0);
    rib.rotation.z = Math.PI * 0.02;
    rib.position.set(x, 0.85, -0.05);
    rib.rotation.x = 0;
    g.add(rib);
  }
  const sill = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.05, 8, 64, Math.PI * 0.8), dark);
  sill.rotation.set(Math.PI / 2, 0, Math.PI * 1.1);
  sill.position.set(0, 0.88, 0.2);
  g.add(sill);
  const lamp = new THREE.PointLight(0xffb36b, 2.2, 6, 2);
  lamp.position.set(-0.6, 1.4, -0.4);
  g.add(lamp);
  const fill = new THREE.HemisphereLight(0x8090b0, 0x302018, 0.15);
  g.add(fill);
  return g;
}
