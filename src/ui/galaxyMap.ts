// Star map: the neighbourhood around the current system, with drop lines to the galactic plane,
// hover labels and a warp button. Rendered over the cabin view with its own little scene.
import * as THREE from 'three';
import { Galaxy, nameOf, type NearSystem, type SystemRef } from '../space/galaxy';
import { generateSystem } from '../space/system';
import { TAU } from '../core/math';

const RADIUS_LY = 85;

const starVert = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aState; // 0 normal, 1 current, 2 visited
uniform float uPixelRatio;
uniform float uHover;
uniform float uSelected;
attribute float aIndex;
varying vec3 vColor;
varying float vState;
varying float vHi;
void main() {
  vColor = aColor;
  vState = aState;
  float hi = (abs(aIndex - uHover) < 0.5 ? 0.6 : 0.0) + (abs(aIndex - uSelected) < 0.5 ? 1.0 : 0.0);
  vHi = hi;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (aSize * (1.0 + hi * 0.5) + (aState == 1.0 ? 10.0 : 0.0)) * uPixelRatio * clamp(60.0 / -mv.z, 0.55, 1.6);
}
`;
const starFrag = /* glsl */ `
varying vec3 vColor;
varying float vState;
varying float vHi;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  float core = exp(-r * r * 14.0);
  float halo = exp(-r * r * 3.5) * 0.35;
  vec3 col = vColor * (core * 1.6 + halo);
  if (vState == 1.0) col += vec3(1.0, 0.78, 0.45) * smoothstep(0.08, 0.0, abs(r - 0.82)) * 1.4;
  if (vState == 2.0) col += vec3(0.5, 0.85, 0.8) * smoothstep(0.08, 0.0, abs(r - 0.7)) * 0.6;
  col += vec3(1.0, 0.85, 0.6) * smoothstep(0.07, 0.0, abs(r - 0.9)) * vHi;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class GalaxyMap {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  open = false;
  private stars: THREE.Points | null = null;
  private drops: THREE.LineSegments | null = null;
  private grid: THREE.Group;
  private dim: THREE.Mesh;
  private list: NearSystem[] = [];
  private centre: SystemRef | null = null;
  private yaw = 0.6;
  private pitch = 0.75;
  private dist = 140;
  private hover = -1;
  private selected = -1;
  private panel: HTMLDivElement;
  private labels: HTMLDivElement;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private overlay: HTMLDivElement;
  visited = new Set<number>();
  onWarp: ((ref: SystemRef) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(
    private galaxy: Galaxy,
    parent: HTMLElement,
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'map-overlay';
    this.overlay.innerHTML = `<div class="map-head"><div class="map-title">Star map</div><div class="map-sub">Drag to turn &middot; scroll to zoom &middot; click a star</div></div><button class="map-close" type="button" aria-label="Close map">&times;</button>`;
    this.labels = document.createElement('div');
    this.labels.className = 'map-labels';
    this.panel = document.createElement('div');
    this.panel.className = 'map-panel';
    this.overlay.append(this.labels, this.panel);
    parent.appendChild(this.overlay);
    this.overlay.querySelector('.map-close')!.addEventListener('click', () => this.close());
    this.overlay.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = THREE.MathUtils.clamp(this.dist * Math.exp(Math.sign(e.deltaY) * 0.12), 25, 320);
    }, { passive: false });

    this.dim = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'void main(){ gl_FragColor = vec4(0.012, 0.01, 0.018, 0.78); }',
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.dim.frustumCulled = false;
    this.dim.renderOrder = -10;
    this.scene.add(this.dim);

    this.grid = new THREE.Group();
    const ringMat = new THREE.LineBasicMaterial({ color: 0xf4c27a, transparent: true, opacity: 0.12, depthWrite: false });
    for (let r = 20; r <= RADIUS_LY; r += 20) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 96; i++) pts.push(new THREE.Vector3(Math.cos((i / 96) * TAU) * r, 0, Math.sin((i / 96) * TAU) * r));
      this.grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
    }
    const spokes: THREE.Vector3[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      spokes.push(new THREE.Vector3(Math.cos(a) * 20, 0, Math.sin(a) * 20), new THREE.Vector3(Math.cos(a) * RADIUS_LY, 0, Math.sin(a) * RADIUS_LY));
    }
    this.grid.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), ringMat));
    this.scene.add(this.grid);
  }

  build(current: SystemRef) {
    this.centre = current;
    this.list = this.galaxy.systemsNear(current.pos, RADIUS_LY);
    const n = this.list.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const state = new Float32Array(n);
    const index = new Float32Array(n);
    const drops: number[] = [];
    this.list.forEach((s, i) => {
      const x = s.ref.pos[0] - current.pos[0], y = s.ref.pos[1] - current.pos[1], z = s.ref.pos[2] - current.pos[2];
      pos.set([x, y, z], i * 3);
      col.set(s.ref.color, i * 3);
      size[i] = 5 + Math.min(9, Math.log10(1 + s.ref.luminosity * 10) * 3.2);
      state[i] = s.ref.id === current.id ? 1 : this.visited.has(s.ref.id) ? 2 : 0;
      index[i] = i;
      drops.push(x, y, z, x, 0, z);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aState', new THREE.BufferAttribute(state, 1));
    g.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));
    if (this.stars) {
      this.stars.geometry.dispose();
      this.stars.geometry = g;
    } else {
      this.stars = new THREE.Points(
        g,
        new THREE.ShaderMaterial({
          vertexShader: starVert,
          fragmentShader: starFrag,
          uniforms: { uPixelRatio: { value: 1 }, uHover: { value: -1 }, uSelected: { value: -1 } },
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
        }),
      );
      this.scene.add(this.stars);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute(drops, 3));
    if (this.drops) {
      this.drops.geometry.dispose();
      this.drops.geometry = dg;
    } else {
      this.drops = new THREE.LineSegments(dg, new THREE.LineBasicMaterial({ color: 0x9fb4d8, transparent: true, opacity: 0.16, depthWrite: false }));
      this.scene.add(this.drops);
    }
    this.selected = -1;
    this.renderPanel();
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    this.open = true;
    this.overlay.classList.add('show');
  }

  close() {
    this.open = false;
    this.overlay.classList.remove('show');
    this.labels.innerHTML = '';
    this.onClose?.();
  }

  private onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, .map-panel')) return;
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.moved = 0;
  };

  private onMove = (e: PointerEvent) => {
    if (!this.open) return;
    if (this.dragging) {
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.yaw -= dx * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.005, 0.08, 1.45);
    }
    this.hover = this.pickAt(e.clientX, e.clientY);
  };

  private onUp = (e: PointerEvent) => {
    if (!this.open || !this.dragging) return;
    this.dragging = false;
    if (this.moved < 6) {
      const i = this.pickAt(e.clientX, e.clientY);
      if (i >= 0) {
        this.selected = i;
        this.renderPanel();
      }
    }
  };

  private project(i: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.stars!.geometry.getAttribute('position') as THREE.BufferAttribute;
    return out.fromBufferAttribute(p, i).project(this.camera);
  }

  private pickAt(x: number, y: number): number {
    if (!this.stars) return -1;
    let best = -1;
    let bestD = 16;
    const v = new THREE.Vector3();
    for (let i = 0; i < this.list.length; i++) {
      this.project(i, v);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private renderPanel() {
    const s = this.list[this.selected];
    if (!s || !this.centre) {
      this.panel.classList.remove('show');
      return;
    }
    const sys = generateSystem(s.ref);
    const moons = sys.planets.reduce((n, p) => n + p.moons.length, 0);
    const ringed = sys.planets.filter((p) => p.rings).length;
    const here = s.ref.id === this.centre.id;
    const cls = s.ref.cls === 'D' ? 'white dwarf' : s.ref.cls === 'RG' ? 'red giant' : `${s.ref.cls}-type star`;
    this.panel.innerHTML = `
      <div class="target-kind">${cls} &middot; ${Math.round(s.ref.temperature).toLocaleString('en-US')} K</div>
      <div class="target-name">${nameOf(s.ref)}</div>
      <div class="target-detail">${sys.planets.length} worlds${moons ? `, ${moons} moons` : ''}${ringed ? `, ${ringed} ringed` : ''}${sys.belts.length ? ', an asteroid belt' : ''}${this.visited.has(s.ref.id) ? ' &middot; visited' : ''}</div>
      <div class="target-row"><span class="mono">${here ? 'you are here' : `${s.dist.toFixed(1)} ly away`}</span></div>
      ${here ? '' : '<button class="fly warp" type="button">Warp there</button>'}`;
    this.panel.querySelector('.warp')?.addEventListener('click', () => {
      this.onWarp?.(s.ref);
      this.close();
    });
    this.panel.classList.add('show');
  }

  update(width: number, height: number, pixelRatio: number) {
    if (!this.open || !this.stars) return;
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    const cp = Math.cos(this.pitch);
    this.camera.position.set(Math.sin(this.yaw) * cp * this.dist, Math.sin(this.pitch) * this.dist, Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    const u = (this.stars.material as THREE.ShaderMaterial).uniforms;
    u.uPixelRatio.value = pixelRatio;
    u.uHover.value = this.hover;
    u.uSelected.value = this.selected;
    // labels: hovered, selected and the brightest few nearby
    const show = new Set<number>([this.hover, this.selected]);
    for (let i = 0; i < Math.min(this.list.length, 10); i++) show.add(i);
    let html = '';
    const v = new THREE.Vector3();
    for (const i of show) {
      if (i < 0 || !this.list[i]) continue;
      this.project(i, v);
      if (v.z > 1) continue;
      const x = (v.x * 0.5 + 0.5) * width, y = (-v.y * 0.5 + 0.5) * height;
      const strong = i === this.hover || i === this.selected || this.list[i].ref.id === this.centre?.id;
      html += `<div class="map-label${strong ? ' strong' : ''}" style="transform:translate(${x + 10}px,${y - 8}px)">${nameOf(this.list[i].ref)}</div>`;
    }
    this.labels.innerHTML = html;
  }
}
