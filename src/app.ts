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
import { Cabin } from './cabin/cabin';
import { Screen, drawDial, drawNav, drawRadio, drawShip, type ScreenData } from './cabin/screens';
import { AudioSystem, makeStations, type RadioBand, type RadioInfo, type SfxName } from './audio';
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
  cabinModel = new Cabin();
  screens = new Map<string, Screen>();
  private screenTimer = 0;
  /** the cabin radio, ambience and sound effects (no AudioContext until the player boards) */
  audio = AudioSystem.create();
  private radioInfo: RadioInfo | null = null;
  private spectrum = new Uint8Array(64);
  private shipInv = new THREE.Matrix4();
  private camLocal = new THREE.Matrix4();
  /** props that move when clicked: rest pose, current and target angle about their pivot axis */
  private movers = new Map<string, { node: THREE.Object3D; rest: THREE.Quaternion; axis: THREE.Vector3; angle: number; target: number }>();
  private tapeInput: HTMLInputElement | null = null;
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
  private dustLight = new THREE.Vector3();
  private fovBoost = 0;
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
    if (!params.has('nocabin')) {
      if (params.has('placeholder')) this.ship.group.add(this.cabin);
      else {
        await this.cabinModel.load(params.get('cabin') ?? 'assets/cabin', this.renderer.gl);
        this.cabinModel.applyEnv();
        this.ship.group.add(this.cabinModel.root);
        for (const [name, draw, w, h] of [['Screen_L', drawShip, 640, 320], ['Screen_C', drawNav, 640, 320],
          ['Screen_R', drawRadio, 640, 320], ['Radio_Dial', drawDial, 256, 110]] as const) {
          const mesh = this.cabinModel.screens.get(name);
          if (!mesh) continue;
          const sc = new Screen(name, draw, w, h);
          mesh.material = sc.material;
          this.screens.set(name, sc);
        }
        for (const [name, ax] of Object.entries(this.cabinModel.manifest?.pivots ?? {})) {
          const node = this.cabinModel.nodes.get(name);
          if (node) this.movers.set(name, { node, rest: node.quaternion.clone(), axis: ax === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), angle: 0, target: 0 });
        }
      }
    }
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

    // the music comes from the radio on the desk (ship-local metres: +Y up, forward -Z)
    const rp = this.cabinModel.manifest?.radio;
    this.audio.radio.setPosition(rp?.pos ?? [0.72, 0.84, -0.35], rp?.facing ?? [-0.9, 0, 0.44]);
    this.audio.setVolumes({ master: this.settings.master, music: this.settings.music, ambience: this.settings.ambience, sfx: this.settings.sfx });
    this.audio.radio.setCharacter(this.settings.radioCharacter);
    this.audio.radio.onInfo((i) => {
      this.radioInfo = i;
    });

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
    if (params.has('speed')) {
      this.flight.mode = 'manual';
      this.flight.throttle = 1;
      this.ship.forward(this.ship.vel).multiplyScalar(Number(params.get('speed')));
    }
    if (params.has('nosys')) this.systemView!.root.visible = false;
    if (params.has('map')) this.map.show();
    if (params.has('yaw') || params.has('pitch')) this.rig.setView(Number(params.get('yaw') ?? 0), Number(params.get('pitch') ?? -4));

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
    this.audio.unlock().then(
      () => this.sfx('seat'),
      () => this.hud.toast('No sound: this browser has no Web Audio'),
    );
  }

  sfx(name: SfxName, node?: string) {
    const o = node ? this.cabinModel.nodes.get(node) : undefined;
    let pos: [number, number, number] | undefined;
    if (o) {
      const v = o.getWorldPosition(new THREE.Vector3()).applyMatrix4(this.shipInv.copy(this.ship.group.matrixWorld).invert());
      pos = [v.x, v.y, v.z];
    }
    this.audio.sfx.play(name, pos);
  }

  enterSystem(ref: SystemRef) {
    this.systemRef = ref;
    this.visited.add(ref.id);
    this.system = generateSystem(ref);
    this.systemView?.dispose();
    this.systemView = new SystemView(this.system, this.baker, this.quality);
    this.scene.add(this.systemView.root);
    this.stars.build(this.galaxy, ref.pos, ref, this.quality.stars);
    // every system has its own handful of stations; arriving retunes through static
    this.audio.radio.setStations(makeStations(((this.galaxy.seed * 31) ^ ref.id) >>> 0));
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
    // cabin first: screens and props; a click on the cabin never selects a planet behind it
    if (this.cabinModel.loaded) {
      const hits = ray.intersectObject(this.cabinModel.root, true);
      const h = hits.find((h) => (h.object as THREE.Mesh).isMesh && !this.cabinModel.glass.includes(h.object as THREE.Mesh));
      if (h) {
        const sc = this.screens.get(h.object.name);
        if (sc && h.uv) {
          const id = sc.hit(h.uv.x, h.uv.y);
          if (id) {
            this.sfx('button', h.object.name);
            this.onScreenButton(id);
          }
        } else this.onProp(h.object.name);
        return;
      }
    }
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

  onScreenButton(id: string) {
    const lv = this.cabinModel.levels;
    const step = 0.15;
    switch (id) {
      case 'lamps-': this.cabinModel.setLevels({ lamps: Math.max(0, lv.lamps - step) }); break;
      case 'lamps+': this.cabinModel.setLevels({ lamps: Math.min(1.5, lv.lamps + step) }); break;
      case 'glow-': this.cabinModel.setLevels({ console: Math.max(0, lv.console - step) }); break;
      case 'glow+': this.cabinModel.setLevels({ console: Math.min(1.5, lv.console + step) }); break;
      case 'night': this.cabinModel.setLevels({ lamps: 0.2, console: 0.6 }); break;
      case 'cozy': this.cabinModel.setLevels({ lamps: 1, console: 1 }); break;
      case 'bright': this.cabinModel.setLevels({ lamps: 1.4, console: 1.2 }); break;
      case 'map': this.toggleMap(); break;
      case 'go': this.engageSelection(); break;
      case 'stop': this.flight.stop(); break;
      case 'power': this.audio.radio.setPower(!(this.radioInfo?.on ?? this.audio.radio.on)); break;
      case 'next': this.audio.radio.nextStation(); break;
      case 'prev': this.audio.radio.prevStation(); break;
      case 'band': this.cycleBand(); break;
    }
    this.screenTimer = 0;
  }

  /** stations -> your own files (tape) -> a stream link -> stations */
  private cycleBand() {
    const r = this.audio.radio;
    const next: RadioBand = r.band === 'stations' ? 'tape' : r.band === 'tape' ? 'link' : 'stations';
    if (next === 'tape' && (this.radioInfo?.tapeCount ?? 0) === 0) {
      if (!this.tapeInput) {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'audio/*';
        inp.multiple = true;
        inp.style.display = 'none';
        inp.addEventListener('change', () => {
          const files = [...(inp.files ?? [])];
          if (files.length) {
            r.loadTape(files);
            r.setBand('tape');
            this.hud.toast(`Tape: ${files.length} track${files.length > 1 ? 's' : ''}`);
          }
          inp.value = '';
        });
        document.body.appendChild(inp);
        this.tapeInput = inp;
      }
      this.tapeInput.click();
      return;
    }
    if (next === 'link') {
      const url = window.prompt('Play a stream or audio file link on the radio (https://...):', '');
      if (url) {
        r.setBand('link');
        r.playLink(url).then((res) => {
          if (res === 'no-cors') this.hud.toast('Playing (the site blocks the radio effect, so it sounds clean)');
          else if (res === 'error') this.hud.toast('Could not play that link');
        });
        return;
      }
      r.setBand('stations');
      return;
    }
    r.setBand(next);
  }

  /** clicks on the cabin's props: radio knobs, toggle switches */
  private onProp(name: string) {
    const turn = (id: string, by: number, abs = false) => {
      const m = this.movers.get(id);
      if (m) m.target = abs ? by : m.target + by;
    };
    if (name === 'Radio_Knob_Tune') {
      this.audio.radio.nextStation();
      turn(name, 0.9);
      this.sfx('knob', name);
    } else if (name === 'Radio_Knob_Volume') {
      const on = !(this.radioInfo?.on ?? this.audio.radio.on);
      this.audio.radio.setPower(on);
      turn(name, on ? 2.2 : 0, true);
      this.sfx('knob', name);
    } else if (/^Switch_[1-4]$/.test(name)) {
      const m = this.movers.get(name);
      const up = !m || m.target <= 0;
      turn(name, up ? 0.45 : -0.45, true);
      this.sfx('switch', name);
      const lv = this.cabinModel.levels;
      if (name === 'Switch_1') this.cabinModel.setLevels({ lamps: up ? 0.15 : 1 });
      else if (name === 'Switch_2') this.cabinModel.setLevels({ console: up ? 0.25 : 1 });
      else if (name === 'Switch_3') this.cabinModel.setLevels({ lamps: Math.min(1.5, lv.lamps + (up ? 0.35 : -0.35)) });
      else this.audio.radio.setPower(!(this.radioInfo?.on ?? this.audio.radio.on));
    }
  }

  private screenData(): ScreenData {
    const sv = this.systemView!;
    const t = this.targetInfo();
    const star = this.system.star;
    const n = new THREE.Vector3(...this.system.ecliptic);
    const ref = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const ax = new THREE.Vector3().crossVectors(n, ref).normalize();
    const ay = new THREE.Vector3().crossVectors(n, ax);
    const sel = this.selection?.kind === 'body' ? this.selection.body.id : this.flight.target?.id;
    const near = this.flight.park?.body.id;
    const planets = this.system.planets.map((p) => {
      const pos = sv.bodyPos(p.id)!;
      return { name: p.name, orbit: p.orbit!.radius, angle: Math.atan2(pos.dot(ay), pos.dot(ax)), ringed: !!p.rings,
        selected: sel === p.id || p.moons.some((m) => m.id === sel), here: near === p.id || p.moons.some((m) => m.id === near) };
    });
    const ri = this.radioInfo ?? this.audio.radio.getInfo();
    this.audio.radio.getSpectrum(this.spectrum);
    const levels = new Array(24).fill(0).map((_, i) => {
      const k = Math.floor(2 + Math.pow(i / 24, 1.6) * 44);
      return this.spectrum[k] / 255;
    });
    const station = ri.band === 'tape' ? 'Your tape' : ri.band === 'link' ? (ri.station ?? 'Link') : (ri.station ?? (ri.status === 'static' ? '· · · static · · ·' : '—'));
    return {
      system: star.name, starClass: this.systemRef.cls === 'RG' ? 'RED GIANT' : this.systemRef.cls === 'D' ? 'WHITE DWARF' : `${this.systemRef.cls}-TYPE`,
      target: t?.name ?? null, targetKind: t?.kind ?? '', distance: t?.distance ?? 0, eta: t?.eta ?? Infinity,
      speed: this.flight.speed, mode: this.warp ? 'warp' : this.flight.mode, planets,
      lamps: this.cabinModel.levels.lamps, console: this.cabinModel.levels.console,
      radio: {
        on: ri.on, band: ri.band, station, freq: ri.band === 'stations' ? `${ri.freq.toFixed(1)} MHz` : ri.band.toUpperCase(),
        freqMHz: ri.freq, title: ri.title ?? (ri.status === 'loading' ? 'loading…' : ''), levels, signal: ri.signal, status: ri.status,
      },
      catalogued: this.visited.size, clock: new Date(),
    };
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
        if (w.t === dt) this.sfx('warp-spool');
        fx.amount = 0.3 * smoothstep(0, 2.6, w.t);
        if (w.t > 2.6) {
          w.phase = 'jump';
          w.t = 0;
          this.sfx('warp-jump');
          this.arriveIn(w.target, w.dir);
        }
        break;
      case 'jump':
        fx.amount = damp(fx.amount, 1, 2.2, dt);
        if (w.t > 4 && w.skyReady && !this.baker.busy) {
          w.phase = 'exit';
          w.t = 0;
          this.sfx('warp-exit');
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
    this.dustLight.copy(this.sunRad).clampScalar(0, 2.5);
    this.dust.update(this.ship.vel, sv.asteroids.inField, this.dustLight, dt);
    // speed widens the view a touch (warp sets its own field of view)
    if (!this.warp) {
      const sp01 = smoothstep(2.5, 9, Math.log10(1 + this.flight.speed));
      this.fovBoost = damp(this.fovBoost, sp01 * 7, 1.5, dt);
      this.rig.setFov(this.settings.fov + this.fovBoost);
    }

    // the listener is the camera, in the ship's own frame (the radio and the cabin's sounds live there)
    this.camera.updateMatrixWorld();
    this.camLocal.multiplyMatrices(this.shipInv.copy(this.ship.group.matrixWorld).invert(), this.camera.matrixWorld);
    const e = this.camLocal.elements;
    this.audio.setListener([e[12], e[13], e[14]], [-e[8], -e[9], -e[10]], [e[4], e[5], e[6]]);
    this.audio.ambience.setShipState({
      throttle: this.flight.throttle,
      speed: Math.min(1, Math.log10(1 + this.flight.speed) / 9.5),
      warp: this.renderer.warp.amount,
    });
    for (const m of this.movers.values()) {
      if (Math.abs(m.target - m.angle) < 1e-4) continue;
      m.angle = damp(m.angle, m.target, 14, dt);
      m.node.quaternion.copy(m.rest).multiply(new THREE.Quaternion().setFromAxisAngle(m.axis, m.angle));
    }

    this.hud.update(dt);
    this.hud.setTarget(this.hud.boarded && !this.warp ? this.targetInfo() : null);
    const mode = this.warp ? 'warp' : this.flight.mode === 'autopilot' ? 'autopilot' : this.flight.mode === 'parked' ? 'orbiting' : this.flight.speed > 0.5 ? 'manual' : 'drifting';
    this.hud.setSpeed(this.flight.speed, mode);

    if (this.screens.size) {
      this.screenTimer -= dt;
      if (this.screenTimer <= 0) {
        this.screenTimer = 0.1;
        const d = this.screenData();
        for (const sc of this.screens.values()) sc.render(d);
      }
      for (const sc of this.screens.values()) sc.material.uniforms.uTime.value = this.time;
    }
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
