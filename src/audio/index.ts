// Stargaze audio: a vintage cabin radio playing generative lofi (or your own music), a quiet ship ambience
// and soft tactile sound effects, all synthesised with the Web Audio API and placed in the cabin.
//
//   const audio = AudioSystem.create();
//   audio.radio.setStations(makeStations(systemSeed));      // any time, also before unlock
//   button.onclick = () => audio.unlock();                    // from a user gesture
//   // every frame:
//   audio.setListener(camPos, camForward, camUp);            // ship-local cabin frame, metres
//   audio.ambience.setShipState({ throttle, speed, warp });
import { Ambience } from './ambience';
import { WorkerClock } from './clock';
import { type AudioQuality, Engine } from './engine';
import { Radio } from './radio';
import { Sfx } from './sfx';
import type { Vec3, Volumes } from './types';

export { Radio } from './radio';
export { Ambience } from './ambience';
export { Sfx } from './sfx';
export { makeStations } from './stations';
export type { StationDef, StationStyle, RadioInfo, RadioBand, SfxName, ShipState, Volumes, Vec3 } from './types';
export type { AudioQuality } from './engine';
export { STATION_STYLES, STYLE_LABELS, SFX_NAMES } from './types';

type AudioContextCtor = typeof AudioContext;

export class AudioSystem {
  readonly radio = new Radio();
  readonly ambience = new Ambience();
  readonly sfx = new Sfx();
  private _ctx: AudioContext | null = null;
  private eng: Engine | null = null;
  private clock: WorkerClock | null = null;
  private vols: Required<Volumes> = { master: 1, music: 1, ambience: 1, sfx: 1 };
  private listener: { pos: Vec3; fwd: Vec3; up: Vec3 } = { pos: [0, 1.15, 0], fwd: [0, 0, -1], up: [0, 1, 0] };
  private userSuspended = false;
  private unlocking: Promise<void> | null = null;
  private quality: AudioQuality;

  private constructor(quality: AudioQuality) {
    this.quality = quality;
  }

  /**
   * Creates the system without touching Web Audio (no AudioContext until unlock()).
   * quality: 'high' (HRTF, full room) or 'low' for phones; defaults to 'low' on touch devices.
   */
  static create(opts: { quality?: AudioQuality } = {}): AudioSystem {
    const touch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0 && typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    return new AudioSystem(opts.quality ?? (touch ? 'low' : 'high'));
  }

  get ctx(): AudioContext | null {
    return this._ctx;
  }

  /** Internal engine (for tools / the audio lab). */
  get engine(): Engine | null {
    return this.eng;
  }

  /**
   * Call from a user gesture (e.g. the "Board ship" click). Creates/resumes the AudioContext and starts
   * the ambience and the radio. Safe to call repeatedly (later calls just resume).
   */
  unlock(): Promise<void> {
    if (this._ctx) {
      this.userSuspended = false;
      return this._ctx.state === 'running' ? Promise.resolve() : this._ctx.resume().catch(() => undefined);
    }
    if (this.unlocking) return this.unlocking;
    const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('Web Audio is not supported in this browser'));
    // iOS: play through the silent switch like a media app
    try {
      const nav = navigator as unknown as { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'playback';
    } catch {
      /* ignore */
    }
    const ctx = new AC({ latencyHint: 'interactive' });
    this._ctx = ctx;
    // resume synchronously inside the gesture (Safari requires this)
    const resumed = ctx.resume().catch(() => undefined);
    const eng = new Engine(ctx, { quality: this.quality });
    this.eng = eng;
    eng.setVolumes(this.vols);
    eng.setListener(this.listener.pos, this.listener.fwd, this.listener.up);
    this.sfx.attach(eng);
    this.ambience.attach(eng);
    this.radio.attach(eng);
    this.clock = new WorkerClock(() => eng.tick(), 25);
    this.clock.start();
    // browsers may suspend/interrupt the context (iOS calls, tab policies): try to come back on the next gesture
    const retry = () => {
      if (!this.userSuspended && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => undefined);
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, retry, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) retry();
    });
    this.unlocking = resumed.then(() => undefined);
    return this.unlocking;
  }

  /** Listener = the camera, in the ship-local cabin frame: metres, +Y up, ship forward is -Z. Call every frame. */
  setListener(pos: [number, number, number], forward: [number, number, number], up: [number, number, number]) {
    this.listener = { pos: [pos[0], pos[1], pos[2]], fwd: [forward[0], forward[1], forward[2]], up: [up[0], up[1], up[2]] };
    this.eng?.setListener(pos, forward, up);
  }

  /** 0..1 each. */
  setVolumes(v: Volumes) {
    for (const k of ['master', 'music', 'ambience', 'sfx'] as const) {
      const x = v[k];
      if (typeof x === 'number' && Number.isFinite(x)) this.vols[k] = Math.max(0, Math.min(1, x));
    }
    this.eng?.setVolumes(this.vols);
    // direct (no-CORS) link playback bypasses the graph and follows the volumes itself
    this.radio.volumesChanged();
  }

  suspend() {
    this.userSuspended = true;
    this.clock?.stop();
    this._ctx?.suspend().catch(() => undefined);
  }

  resume() {
    this.userSuspended = false;
    this.clock?.start();
    this._ctx?.resume().catch(() => undefined);
  }

  /** Node / voice counters (leak checks, debugging). */
  stats() {
    return this.eng?.stats.snapshot() ?? null;
  }
}
