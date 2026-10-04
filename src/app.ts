// Game shell: boot, universe, render loop. Flight, cabin, audio and UI plug in here.
import * as THREE from 'three';
import { Renderer } from './render/renderer';
import { CubeBaker } from './render/cubeBaker';
import { QUALITY, guessQuality, loadSettings, type QualityLevel, type QualityPreset, type Settings } from './core/settings';
import { Input } from './core/input';
import { hashString } from './core/rng';
import { Galaxy, type SystemRef } from './space/galaxy';
import { generateSystem, type StarSystem, type PlanetBody } from './space/system';
import { SkyGenerator, nebulaeNear } from './space/sky';
import { StarField } from './space/starfield';
import { SystemView } from './space/systemView';
import { Ship } from './ship/ship';
import { CameraRig, PILOT_SPOT } from './ship/cameraRig';
import { makePlaceholderCabin } from './cabin/placeholder';

const params = new URLSearchParams(location.search);
const TEST = params.has('test');

export class App {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(68, 1, 0.03, 1e14);
  renderer!: Renderer;
  baker!: CubeBaker;
  settings: Settings;
  quality: QualityPreset;
  qualityLevel: QualityLevel;
  input!: Input;
  galaxy!: Galaxy;
  sky!: SkyGenerator;
  stars = new StarField();
  systemRef!: SystemRef;
  system!: StarSystem;
  systemView: SystemView | null = null;
  ship = new Ship();
  rig: CameraRig;
  cabin: THREE.Group;
  time = 0; // game clock (s), follows real time so the universe keeps moving between visits
  private last = 0;
  private skyTarget: THREE.WebGLCubeRenderTarget | null = null;
  ready = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly ui: HTMLDivElement,
  ) {
    this.settings = loadSettings();
    const q = (params.get('q') as QualityLevel | null) ?? (this.settings.quality === 'auto' ? guessQuality() : this.settings.quality);
    this.qualityLevel = q in QUALITY ? q : 'medium';
    this.quality = QUALITY[this.qualityLevel];
    this.rig = new CameraRig(this.camera, PILOT_SPOT, this.settings.fov);
    this.cabin = makePlaceholderCabin();
  }

  async start() {
    this.renderer = new Renderer(this.canvas, this.quality, this.scene, this.camera);
    this.baker = new CubeBaker(this.renderer.gl);
    this.input = new Input(this.canvas);
    this.scene.add(this.ship.group);
    this.ship.group.add(this.rig.root);
    if (!params.has('nocabin')) this.ship.group.add(this.cabin);
    this.scene.add(this.stars.points);

    const seedParam = params.get('seed');
    const universeSeed = seedParam ? (/^\d+$/.test(seedParam) ? Number(seedParam) : hashString(seedParam)) : 0x5747a2e;
    this.galaxy = new Galaxy(universeSeed);
    this.sky = new SkyGenerator(this.baker, universeSeed);
    this.time = TEST ? 1000 : Date.now() / 1000;

    const sysParam = params.get('system');
    let ref = sysParam ? this.galaxy.getSystem(Number(sysParam)) : undefined;
    let prefer: PlanetBody | undefined;
    const ptype = params.get('ptype');
    if (ptype) {
      // test helper: find a nearby system with a world of this type (optionally ringed)
      for (const n of this.galaxy.systemsNear(this.galaxy.startSystem().pos, 160)) {
        const sys = generateSystem(n.ref);
        const all = sys.planets.flatMap((p) => [p, ...p.moons]);
        const hit = all.find((p) => p.type === ptype && (!params.has('rings') || p.rings));
        if (hit) {
          ref = n.ref;
          prefer = hit;
          break;
        }
      }
    }
    this.enterSystem(ref ?? this.galaxy.startSystem());
    this.placeAtShowcase(prefer ? (this.system.planets.flatMap((p) => [p, ...p.moons]).find((p) => p.id === prefer!.id)) : undefined);
    const look = params.get('look');
    if (look) {
      // test views: gc = toward the galactic centre, or an explicit direction "x,y,z"
      const dir = look === 'gc' ? new THREE.Vector3(...this.systemRef.pos).negate().normalize() : new THREE.Vector3(...look.split(',').map(Number)).normalize();
      this.ship.lookAt(this.ship.pos.clone().addScaledVector(dir, 1e12), new THREE.Vector3(0, 1, 0));
    }
    if (params.has('nosys')) this.systemView!.root.visible = false;

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.input.onClick = (e) => this.onClick(e.x, e.y);

    if (TEST) {
      // finish all GPU generation before the first frame so screenshots are deterministic
      this.systemView!.update(this.time, this.ship.pos, this.camera, this.renderer.drawingSize);
      this.baker.flush();
      await new Promise((r) => setTimeout(r, 0));
      this.systemView!.update(this.time, this.ship.pos, this.camera, this.renderer.drawingSize);
      this.baker.flush();
      await new Promise((r) => setTimeout(r, 0));
    }
    this.last = performance.now();
    this.renderer.gl.setAnimationLoop(() => this.frame());
  }

  enterSystem(ref: SystemRef) {
    this.systemRef = ref;
    this.system = generateSystem(ref);
    this.systemView?.dispose();
    this.systemView = new SystemView(this.system, this.baker, this.quality);
    this.scene.add(this.systemView.root);
    this.stars.build(this.galaxy, ref.pos, ref, this.quality.stars);
    this.stars.buildBackground(this.galaxy.seed, this.quality.stars * 3, ref.pos);
    const neb = nebulaeNear(this.galaxy.seed, ref.pos);
    const old = this.skyTarget;
    const job = this.sky.generate(ref.pos, neb, this.quality.skyFace, this.quality.skySteps, TEST ? 1 : 4);
    this.skyTarget = job.target;
    job.promise.then(() => {
      this.scene.background = job.target.texture;
      old?.dispose();
    });
  }

  /** Park the ship somewhere pretty: near the most photogenic world, star off to the side. */
  placeAtShowcase(prefer?: PlanetBody) {
    const sv = this.systemView!;
    sv.computeStates(this.time);
    const planets = this.system.planets;
    const score = (p: PlanetBody) =>
      (p.rings ? 3 : 0) + (p.type === 'terran' || p.type === 'ocean' ? 2.5 : 0) + (p.type === 'gas' ? 1.5 : 0) + p.moons.length * 0.4 + (p.atmosphere ? 0.5 : 0);
    const target = prefer ?? [...planets].sort((a, b) => score(b) - score(a))[0];
    if (!target) {
      this.ship.pos.set(0, 0, this.system.star.radius * 40);
      this.ship.lookAt(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
      return;
    }
    const P = sv.states.get(target.id)!.pos.clone();
    const n = new THREE.Vector3(...this.system.ecliptic);
    const toStar = P.clone().negate().normalize();
    const perp = new THREE.Vector3().crossVectors(toStar, n).normalize();
    const phase = THREE.MathUtils.degToRad(Number(params.get('phase') ?? 62));
    const u = toStar.clone().multiplyScalar(Math.cos(phase)).addScaledVector(perp, Math.sin(phase)).addScaledVector(n, 0.32).normalize();
    const dist = target.radius * Number(params.get('dist') ?? (target.rings ? 5.2 : 3.4));
    this.ship.pos.copy(P).addScaledVector(u, dist);
    // look slightly past the planet so it sits off-centre in the window
    const look = P.clone().addScaledVector(perp, -target.radius * 0.55).addScaledVector(n, -target.radius * 0.25);
    this.ship.lookAt(look, n);
  }

  resize() {
    this.renderer.resize(window.innerWidth, window.innerHeight);
  }

  onClick(x: number, y: number) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const body = this.systemView?.pick(ray.ray.origin, ray.ray.direction, this.ship.pos, 0.012);
    if (body) console.info('picked', body.name);
  }

  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!TEST) this.time += dt;

    const [dx, dy] = this.input.consumeLook();
    if (this.input.dragging || dx || dy) this.rig.look(dx, dy, this.settings.lookSensitivity, this.settings.invertY);
    const z = this.input.consumeZoom();
    if (z) this.rig.zoom(z);
    this.rig.update(dt);

    this.ship.syncGroup();
    this.scene.updateMatrixWorld();
    const vp = this.renderer.drawingSize;
    this.systemView?.update(this.time, this.ship.pos, this.camera, vp);
    this.stars.update(this.time, this.renderer.gl.getPixelRatio());
    this.baker.update(TEST ? 1e9 : 3);
    this.renderer.render(dt);
    if (!this.ready && !this.baker.busy) {
      this.ready = true;
      (window as unknown as { __stargazeReady: boolean }).__stargazeReady = true;
    }
  }
}
