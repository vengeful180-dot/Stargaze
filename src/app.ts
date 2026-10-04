// Game shell: boot, universe, selection, flight, warp, render loop.
import * as THREE from 'three';
import { Renderer } from './render/renderer';
import { CubeBaker } from './render/cubeBaker';
import { QUALITY, guessQuality, loadSettings, type QualityLevel, type QualityPreset, type Settings } from './core/settings';
import { Input } from './core/input';
import { hashString } from './core/rng';
import { damp, smoothstep } from './core/math';
import { Galaxy, LY, nameOf, type SystemRef } from './space/galaxy';
import { GAME_AU, TYPE_LABEL, generateSystem, type Body, type PlanetBody, type StarSystem } from './space/system';
import { SkyGenerator, nebulaeNear } from './space/sky';
import { StarField } from './space/starfield';
import { SystemView } from './space/systemView';
import { SpeedDust } from './space/dust';
import { Ship } from './ship/ship';
import { CameraRig, PILOT_SPOT } from './ship/cameraRig';
import { Flight } from './ship/flight';
import { makePlaceholderCabin } from './cabin/placeholder';
import { Hud, type TargetInfo } from './ui/hud';
import { GalaxyMap } from './ui/galaxyMap';

const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const NO_INPUT = { keys: new Set<string>(), axis: () => 0 } as unknown as Input;

type Selection = { kind: 'body'; body: Body } | { kind: 'star'; ref: SystemRef; dist: number } | null;

interface WarpState {
  target: SystemRef;
  phase: 'align' | 'spool' | 'jump' | 'exit';
  t: number;
  dir: THREE.Vector3;
  skyReady: boolean;
}

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
  flight = new Flight();
  dust = new SpeedDust();
  cabin: THREE.Group;
  hud!: Hud;
  map!: GalaxyMap;
  sun = new THREE.DirectionalLight(0xffffff, 3);
  ambient = new THREE.HemisphereLight(0x223044, 0x0c0a08, 0.04);
  selection: Selection = null;
  warp: WarpState | null = null;
  visited = new Set<number>();
  time = 0;
  private last = 0;
  private skyTarget: THREE.WebGLCubeRenderTarget | null = null;
  private tmp = new THREE.Vector3();
  private sunRad = new THREE.Vector3();
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
    this.rig.reduceMotion = this.settings.reduceMotion;
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
    this.scene.add(this.dust.lines);
    this.scene.add(this.sun, this.sun.target, this.ambient);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.quality.shadowMap, this.quality.shadowMap);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -3.2;
    sc.right = sc.top = 3.2;
    sc.near = 0.5;
    sc.far = 14;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;

    this.hud = new Hud(this.ui);
    this.hud.onBoard = () => this.board();
    this.hud.onFly = () => this.engageSelection();
    this.hud.onStop = () => {
      this.flight.stop();
      this.hud.toast('Holding position');
    };

    const seedParam = params.get('seed');
    const universeSeed = seedParam ? (/^\d+$/.test(seedParam) ? Number(seedParam) : hashString(seedParam)) : 0x5747a2e;
    this.galaxy = new Galaxy(universeSeed);
    this.sky = new SkyGenerator(this.baker, universeSeed);
    this.map = new GalaxyMap(this.galaxy, this.ui);
    this.map.visited = this.visited;
    this.map.onWarp = (ref) => this.startWarp(ref);
    this.hud.onMap = () => this.toggleMap();
    this.time = TEST ? 1000 : Date.now() / 1000;

    const sysParam = params.get('system');
    let ref = sysParam ? this.galaxy.getSystem(Number(sysParam)) : undefined;
    let prefer: PlanetBody | undefined;
    const ptype = params.get('ptype');
    if (ptype) {
      // test helper: find a nearby system with a world of this type (optionally ringed)
      for (const n of this.galaxy.systemsNear(this.galaxy.startSystem().pos, 160)) {
        const sys = generateSystem(n.ref);
        const hit = sys.planets.flatMap((p) => [p, ...p.moons]).find((p) => p.type === ptype && (!params.has('rings') || p.rings));
        if (hit) {
          ref = n.ref;
          prefer = hit;
          break;
        }
      }
    }
    this.enterSystem(ref ?? this.galaxy.startSystem());
    const preferNow = prefer ? this.system.planets.flatMap((p) => [p, ...p.moons]).find((p) => p.id === prefer!.id) : undefined;
    const parked = this.placeAtShowcase(preferNow);
    if (parked) this.flight.parkAt(parked, this.ship, this.systemView!);
    const look = params.get('look');
    if (look) {
      const dir = look === 'gc' ? new THREE.Vector3(...this.systemRef.pos).negate().normalize() : new THREE.Vector3(...look.split(',').map(Number)).normalize();
      this.ship.lookAt(this.ship.pos.clone().addScaledVector(dir, 1e12), new THREE.Vector3(0, 1, 0));
      this.flight.mode = 'manual';
    }
    if (params.has('nosys')) this.systemView!.root.visible = false;
    if (params.has('map')) this.map.show();

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.input.onClick = (e) => this.onClick(e.x, e.y);
    this.input.onKey = (code) => this.onKey(code);

    if (TEST) {
      this.hud.skipTitle();
      // finish GPU generation before the first frame so screenshots are deterministic
      for (let i = 0; i < 3; i++) {
        this.ship.syncGroup();
        this.scene.updateMatrixWorld();
        this.systemView!.update(this.time, this.ship.pos, this.camera, this.renderer.drawingSize);
        this.baker.flush();
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this.last = performance.now();
    this.renderer.gl.setAnimationLoop(() => this.frame());
  }

  board() {
    this.hud.toast(`${nameOf(this.systemRef)} system`);
  }

  enterSystem(ref: SystemRef) {
    this.systemRef = ref;
    this.visited.add(ref.id);
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
      if (this.skyTarget !== job.target) return;
      this.scene.background = job.target.texture;
      old?.dispose();
      if (this.warp) this.warp.skyReady = true;
    });
    const cls = ref.cls === 'D' ? 'White dwarf' : ref.cls === 'RG' ? 'Red giant' : `${ref.cls}-type star`;
    this.hud?.setStatus(nameOf(ref), `${cls} · ${this.system.planets.length} worlds`);
    this.map?.build(ref);
    this.selection = null;
  }

  /** Park the ship somewhere pretty: near the most photogenic world, star off to the side. */
  placeAtShowcase(prefer?: PlanetBody): Body | null {
    const sv = this.systemView!;
    sv.computeStates(this.time);
    const planets = this.system.planets;
    const score = (p: PlanetBody) =>
      (p.rings ? 3 : 0) + (p.type === 'terran' || p.type === 'ocean' ? 2.5 : 0) + (p.type === 'gas' ? 1.5 : 0) + p.moons.length * 0.4 + (p.atmosphere ? 0.5 : 0);
    const target = prefer ?? [...planets].sort((a, b) => score(b) - score(a))[0];
    if (!target) {
      this.ship.pos.set(0, 0, this.system.star.radius * 40);
      this.ship.lookAt(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
      return null;
    }
    const P = sv.states.get(target.id)!.pos.clone();
    const n = new THREE.Vector3(...this.system.ecliptic);
    const toStar = P.clone().negate().normalize();
    const perp = new THREE.Vector3().crossVectors(toStar, n).normalize();
    const phase = THREE.MathUtils.degToRad(Number(params.get('phase') ?? 62));
    const u = toStar.clone().multiplyScalar(Math.cos(phase)).addScaledVector(perp, Math.sin(phase)).addScaledVector(n, 0.32).normalize();
    const dist = target.radius * Number(params.get('dist') ?? (target.rings ? 5.2 : 3.4));
    this.ship.pos.copy(P).addScaledVector(u, dist);
    const lookAt = P.clone().addScaledVector(perp, -target.radius * 0.55).addScaledVector(n, -target.radius * 0.25);
    this.ship.lookAt(lookAt, n);
    return target;
  }

  resize() {
    this.renderer.resize(window.innerWidth, window.innerHeight);
  }

  toggleMap() {
    this.map.toggle();
    this.hud.noteInteraction();
  }

  onKey(code: string) {
    if (!this.hud.boarded) {
      if (code === 'Enter' || code === 'Space') this.hud.board();
      return;
    }
    this.hud.noteInteraction();
    if (code === 'KeyM') this.toggleMap();
    else if (code === 'Escape') {
      if (this.map.open) this.map.close();
      else if (this.selection) this.select(null);
    } else if (code === 'Enter' || code === 'KeyG') this.engageSelection();
  }

  onClick(x: number, y: number) {
    if (!this.hud.boarded || this.map.open || this.warp) return;
    this.hud.noteInteraction();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const body = this.systemView?.pick(ray.ray.origin, ray.ray.direction, this.ship.pos, 0.014);
    let next: Selection = null;
    if (body) next = { kind: 'body', body };
    else {
      const i = this.stars.pick(ray.ray.direction, 0.02);
      if (i >= 0) {
        const s = this.stars.systems[i];
        next = { kind: 'star', ref: s.ref, dist: s.dist };
      }
    }
    // clicking the selected thing again goes there
    if (next && this.selection && this.sameSelection(next, this.selection)) {
      this.engageSelection();
      return;
    }
    this.select(next);
  }

  private sameSelection(a: Selection, b: Selection): boolean {
    if (!a || !b || a.kind !== b.kind) return false;
    return a.kind === 'body' ? a.body.id === (b as { body: Body }).body.id : a.ref.id === (b as { ref: SystemRef }).ref.id;
  }

  select(s: Selection) {
    this.selection = s;
    if (s?.kind === 'star') {
      const idx = this.stars.systems.findIndex((x) => x.ref.id === s.ref.id);
      this.stars.setHighlight(idx, 1);
    } else this.stars.setHighlight(-1, 0);
  }

  engageSelection() {
    const s = this.selection;
    if (!s || this.warp) return;
    if (s.kind === 'body') {
      this.flight.engage(s.body);
      this.hud.toast(`Setting course for ${s.body.name}`);
    } else this.startWarp(s.ref);
  }

  startWarp(ref: SystemRef) {
    if (this.warp || ref.id === this.systemRef.id) return;
    const dir = new THREE.Vector3(ref.pos[0] - this.systemRef.pos[0], ref.pos[1] - this.systemRef.pos[1], ref.pos[2] - this.systemRef.pos[2]).normalize();
    this.warp = { target: ref, phase: 'align', t: 0, dir, skyReady: false };
    this.flight.mode = 'warp';
    this.ship.vel.set(0, 0, 0);
    this.select(null);
    this.hud.toast(`Warping to ${nameOf(ref)}`);
  }

  private updateWarp(dt: number) {
    const w = this.warp!;
    const fx = this.renderer.warp;
    w.t += dt;
    switch (w.phase) {
      case 'align': {
        const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), w.dir, new THREE.Vector3(0, 1, 0));
        const q = new THREE.Quaternion().setFromRotationMatrix(m);
        const ang = this.ship.quat.angleTo(q);
        this.ship.quat.rotateTowards(q, dt * 0.7 * Math.min(1, 0.3 + ang));
        if (ang < 0.03 || w.t > 6) {
          w.phase = 'spool';
          w.t = 0;
        }
        break;
      }
      case 'spool':
        fx.amount = 0.3 * smoothstep(0, 2.6, w.t);
        if (w.t > 2.6) {
          w.phase = 'jump';
          w.t = 0;
          this.arriveIn(w.target, w.dir);
        }
        break;
      case 'jump':
        fx.amount = damp(fx.amount, 1, 2.2, dt);
        if (w.t > 4 && w.skyReady && !this.baker.busy) {
          w.phase = 'exit';
          w.t = 0;
        }
        break;
      case 'exit':
        fx.amount = 1 - smoothstep(0, 2.4, w.t);
        if (w.t > 2.4) {
          fx.amount = 0;
          this.warp = null;
          this.flight.mode = 'manual';
          this.flight.throttle = 0;
          this.hud.toast(`Welcome to ${nameOf(this.systemRef)}`, 4200);
        }
        break;
    }
    this.rig.setFov(this.settings.fov + fx.amount * 22);
  }

  /** Swap systems mid-jump: new sky and worlds bake while the tunnel hides them. */
  private arriveIn(ref: SystemRef, dir: THREE.Vector3) {
    this.enterSystem(ref);
    const s = this.system.star;
    const hz = Math.sqrt(Math.max(0.01, s.luminosity)) * GAME_AU;
    const d = Math.max(s.radius * 40, hz * 1.1);
    this.ship.pos.copy(dir).multiplyScalar(-d);
    // the star a little off-centre so it does not sit right behind a canopy frame
    const up = new THREE.Vector3(...this.system.ecliptic);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const look = new THREE.Vector3().addScaledVector(side, d * 0.25);
    this.ship.lookAt(look, up);
    this.ship.vel.set(0, 0, 0);
  }

  private targetInfo(): TargetInfo | null {
    const auto = this.flight.mode === 'autopilot' || this.flight.mode === 'parked';
    const s: Selection = this.selection ?? (auto && this.flight.target ? { kind: 'body', body: this.flight.target } : null);
    if (!s) return null;
    if (s.kind === 'star') {
      const cls = s.ref.cls === 'D' ? 'White dwarf' : s.ref.cls === 'RG' ? 'Red giant' : `${s.ref.cls}-type star`;
      return {
        name: nameOf(s.ref), kind: 'Distant star', detail: `${cls} · ${Math.round(s.ref.temperature).toLocaleString('en-US')} K · warp to visit`,
        distance: s.dist * LY, eta: Infinity, flying: false, parked: false,
      };
    }
    const b = s.body;
    const pos = this.systemView!.bodyPos(b.id)!;
    const dist = Math.max(0, pos.distanceTo(this.ship.pos) - b.radius);
    const flyingHere = this.flight.mode === 'autopilot' && this.flight.target?.id === b.id;
    const parkedHere = this.flight.mode === 'parked' && this.flight.park?.body.id === b.id;
    let kind = 'Star';
    let detail: string;
    if (b.kind === 'star') {
      detail = `${Math.round(this.system.star.temperature).toLocaleString('en-US')} K · ${this.system.planets.length} worlds`;
    } else {
      const p = b as PlanetBody;
      kind = p.kind === 'moon' ? `${TYPE_LABEL[p.type]} moon` : TYPE_LABEL[p.type];
      const bits = [`${p.gravity.toFixed(1)} g`, `${p.temperatureC} °C`];
      if (p.moons.length) bits.push(`${p.moons.length} moon${p.moons.length > 1 ? 's' : ''}`);
      if (p.rings) bits.push('rings');
      if (p.atmosphere) bits.push('air');
      if (p.surface.cityLights > 0) bits.push('lights on the night side');
      detail = bits.join(' · ');
    }
    return { name: b.name, kind, detail, distance: dist, eta: flyingHere ? this.flight.eta : Infinity, flying: flyingHere, parked: parkedHere };
  }

  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!TEST) this.time += dt;
    const sv = this.systemView!;

    const [dx, dy] = this.input.consumeLook();
    const z = this.input.consumeZoom();
    if (!this.map.open && this.hud.boarded) {
      if (dx || dy) {
        this.rig.look(dx, dy, this.settings.lookSensitivity, this.settings.invertY);
        this.hud.noteInteraction();
      }
      if (z) this.rig.zoom(z);
    }
    this.rig.update(dt);

    // body positions first (flight reads them), then fly, then place everything around the ship
    sv.computeStates(this.time);
    if (this.warp) this.updateWarp(dt);
    else this.flight.update(dt, this.ship, this.hud.boarded && !this.map.open ? this.input : NO_INPUT, sv);
    this.ship.syncGroup();
    this.scene.updateMatrixWorld();

    const vp = this.renderer.drawingSize;
    sv.update(this.time, this.ship.pos, this.camera, vp);
    this.stars.update(this.time, this.renderer.gl.getPixelRatio());

    // sunlight on the cabin and rocks
    const starPos = sv.bodyPos(this.system.star.id)!;
    const toStar = this.tmp.copy(starPos).sub(this.ship.pos);
    const dStar = toStar.length();
    toStar.divideScalar(dStar);
    sv.starIrradiance(dStar, this.sunRad);
    const sunI = this.sunRad.length();
    this.sun.color.setRGB(this.sunRad.x / sunI, this.sunRad.y / sunI, this.sunRad.z / sunI);
    this.sun.intensity = sunI * Math.PI * 0.55;
    this.sun.position.copy(toStar).multiplyScalar(8);
    this.sun.target.position.set(0, 0, 0);
    this.dust.update(this.ship.pos, this.ship.vel, sv.asteroids.inField, this.sunRad);

    this.hud.update(dt);
    this.hud.setTarget(this.hud.boarded && !this.warp ? this.targetInfo() : null);
    const mode = this.warp ? 'warp' : this.flight.mode === 'autopilot' ? 'autopilot' : this.flight.mode === 'parked' ? 'orbiting' : this.flight.speed > 0.5 ? 'manual' : 'drifting';
    this.hud.setSpeed(this.flight.speed, mode);

    if (params.has('warpfx')) this.renderer.warp.amount = Number(params.get('warpfx'));
    this.baker.update(TEST ? 1e9 : this.warp?.phase === 'jump' ? 12 : 3);
    this.renderer.render(dt);
    if (this.map.open) {
      this.map.update(window.innerWidth, window.innerHeight, this.renderer.gl.getPixelRatio());
      const gl = this.renderer.gl;
      gl.clearDepth();
      gl.render(this.map.scene, this.map.camera);
    }
    if (!this.ready && !this.baker.busy) {
      this.ready = true;
      (window as unknown as { __stargazeReady: boolean }).__stargazeReady = true;
    }
  }
}
