// Caches rendered buffers per AudioContext: drums, multisampled piano/guitar (one root every 3 semitones,
// transposed by at most a semitone), textures and noise loops. Instrument notes render lazily; a small
// queue lets the scheduler pre-render the notes of an upcoming track in short time slices.
import type { F32 } from '../dsp';
import type { DrumId } from '../music/drums';
import {
  renderChatter, renderCrackle, renderDrum, renderGuitar, renderHiss, renderNoise, renderPiano,
} from './samples';

export type SampledInst = 'piano' | 'guitar' | 'nylon';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class SampleBank {
  readonly instRate: number;
  private drums = new Map<string, AudioBuffer>();
  private notes = new Map<string, AudioBuffer>();
  private misc = new Map<string, AudioBuffer>();
  private queue: { inst: SampledInst; root: number; hard: boolean }[] = [];

  constructor(readonly ctx: BaseAudioContext) {
    this.instRate = Math.min(ctx.sampleRate, 32000);
  }

  private buf(chans: F32[], rate: number): AudioBuffer {
    const b = this.ctx.createBuffer(chans.length, chans[0].length, rate);
    chans.forEach((c, i) => b.copyToChannel(c, i));
    return b;
  }

  static readonly DRUM_VARIANTS = 3;

  drum(id: DrumId, variant: number, crisp: boolean): AudioBuffer {
    const v = ((variant % SampleBank.DRUM_VARIANTS) + SampleBank.DRUM_VARIANTS) % SampleBank.DRUM_VARIANTS;
    const key = `${id}:${v}:${crisp && id === 'snare' ? 1 : 0}`;
    let b = this.drums.get(key);
    if (!b) {
      b = this.buf([renderDrum(id, this.ctx.sampleRate, v, crisp)], this.ctx.sampleRate);
      this.drums.set(key, b);
    }
    return b;
  }

  /** Root note used for a MIDI pitch (multisample spacing of 3 semitones). */
  static rootFor(midi: number) {
    return 3 * Math.round(midi / 3);
  }

  private noteKey(inst: SampledInst, root: number, hard: boolean) {
    return `${inst}:${root}:${hard ? 1 : 0}`;
  }

  private renderNote(inst: SampledInst, root: number, hard: boolean): AudioBuffer {
    const seed = 0x51a7 + root * 31 + (hard ? 7 : 0) + inst.length * 1009;
    const data =
      inst === 'piano' ? renderPiano(this.instRate, root, hard, seed) : renderGuitar(this.instRate, root, inst === 'nylon', seed);
    return this.buf([data], this.instRate);
  }

  /** Buffer + playback rate for a sampled note (renders synchronously if not cached yet). */
  note(inst: SampledInst, midi: number, vel: number): { buffer: AudioBuffer; rate: number } {
    const root = SampleBank.rootFor(midi);
    const hard = inst === 'piano' ? vel > 0.62 : false;
    const key = this.noteKey(inst, root, hard);
    let b = this.notes.get(key);
    if (!b) {
      b = this.renderNote(inst, root, hard);
      this.notes.set(key, b);
    }
    return { buffer: b, rate: Math.pow(2, (midi - root) / 12) };
  }

  has(inst: SampledInst, midi: number, vel: number) {
    const hard = inst === 'piano' ? vel > 0.62 : false;
    return this.notes.has(this.noteKey(inst, SampleBank.rootFor(midi), hard));
  }

  /** Queue notes for background rendering (deduplicated). */
  prefetch(inst: SampledInst, notes: readonly { m: number; v: number }[]) {
    const seen = new Set(this.queue.map((q) => this.noteKey(q.inst, q.root, q.hard)));
    for (const n of notes) {
      const root = SampleBank.rootFor(n.m);
      const hard = inst === 'piano' ? n.v > 0.62 : false;
      const key = this.noteKey(inst, root, hard);
      if (this.notes.has(key) || seen.has(key)) continue;
      seen.add(key);
      this.queue.push({ inst, root, hard });
    }
  }

  /** Render queued notes for up to `budgetMs` milliseconds. Returns the remaining queue length. */
  work(budgetMs: number): number {
    const t0 = now();
    while (this.queue.length && now() - t0 < budgetMs) {
      const q = this.queue.shift()!;
      const key = this.noteKey(q.inst, q.root, q.hard);
      if (!this.notes.has(key)) this.notes.set(key, this.renderNote(q.inst, q.root, q.hard));
    }
    return this.queue.length;
  }

  /** Render everything queued (offline rendering). */
  flush() {
    this.work(Infinity);
  }

  private cached(key: string, make: () => AudioBuffer): AudioBuffer {
    let b = this.misc.get(key);
    if (!b) {
      b = make();
      this.misc.set(key, b);
    }
    return b;
  }

  crackle(): AudioBuffer {
    return this.cached('crackle', () => {
      const [l, r] = renderCrackle(this.ctx.sampleRate, 11.3, 0xc4ac, 1);
      return this.buf([l, r], this.ctx.sampleRate);
    });
  }

  /** Harsher crackle used by the tuning static. */
  staticCrackle(): AudioBuffer {
    return this.cached('scrackle', () => {
      const [l] = renderCrackle(this.ctx.sampleRate, 7.7, 0x57a7, 3.5);
      return this.buf([l], this.ctx.sampleRate);
    });
  }

  hiss(): AudioBuffer {
    return this.cached('hiss', () => this.buf([renderHiss(this.ctx.sampleRate, 5.1, 0x4155)], this.ctx.sampleRate));
  }

  chatter(): AudioBuffer {
    return this.cached('chatter', () => this.buf([renderChatter(this.ctx.sampleRate, 9.7, 0xc4a7)], this.ctx.sampleRate));
  }

  noise(kind: 'white' | 'pink' | 'brown'): AudioBuffer {
    return this.cached('noise:' + kind, () =>
      this.buf([renderNoise(kind, this.ctx.sampleRate, kind === 'brown' ? 6.3 : 3.7, kind === 'white' ? 0x1111 : kind === 'pink' ? 0x2222 : 0x3333)], this.ctx.sampleRate),
    );
  }

  /** Stereo white noise (decorrelated channels) for risers and the room. */
  noiseStereo(): AudioBuffer {
    return this.cached('noise:st', () =>
      this.buf([renderNoise('white', this.ctx.sampleRate, 3.1, 0x5151), renderNoise('white', this.ctx.sampleRate, 3.1, 0x6161)], this.ctx.sampleRate),
    );
  }
}
