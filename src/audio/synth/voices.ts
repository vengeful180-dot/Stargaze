// Voice bookkeeping: bounded polyphony with voice stealing, and guaranteed cleanup of every node so long
// sessions never leak (sources are stopped, every node disconnected, modulation links removed).
import { type NodeStats, safeDisconnect, safeDisconnectParam, safeStop } from '../util';

export interface Voice {
  start: number;
  /** when its sources stop */
  end: number;
  /** when it has decayed enough to stop counting toward polyphony */
  audible: number;
  /** lower = stolen first */
  prio: number;
  /** counts toward the synth polyphony limit (drums do not) */
  counted: boolean;
  nodes: AudioNode[];
  srcs: AudioScheduledSourceNode[];
  /** envelope gains, ramped to zero when the voice is stolen */
  env: AudioParam[];
  /** params driven by a shared modulation bus (wow & flutter, vibrato) */
  mods: { from: AudioNode; param: AudioParam }[];
  done: boolean;
}

export const MAX_SYNTH_VOICES = 28;

export class VoicePool {
  private list: Voice[] = [];
  constructor(private stats: NodeStats) {}

  get size() {
    return this.list.length;
  }

  /** Register a voice whose sources are already scheduled. Cleanup runs when the last source ends. */
  add(v: Voice) {
    this.list.push(v);
    this.stats.addNodes(v.nodes.length);
    this.stats.addVoice();
    const last = v.srcs[v.srcs.length - 1];
    if (last) last.onended = () => this.release(v);
  }

  release(v: Voice) {
    if (v.done) return;
    v.done = true;
    for (const s of v.srcs) s.onended = null;
    for (const m of v.mods) safeDisconnectParam(m.from, m.param);
    for (const n of v.nodes) safeDisconnect(n);
    this.stats.removeNodes(v.nodes.length);
    this.stats.removeVoice();
  }

  activeAt(t: number): number {
    let n = 0;
    for (const v of this.list) if (v.counted && !v.done && v.start <= t + 1e-4 && v.audible > t) n++;
    return n;
  }

  /** Make room for one more counted voice at time t by stealing the least important old voice. */
  makeRoom(t: number, max = MAX_SYNTH_VOICES) {
    let guard = 0;
    let active = this.activeAt(t);
    if (active + 1 > this.stats.synthMax) this.stats.synthMax = Math.min(max, active + 1);
    while (active >= max && guard++ < 8) {
      let victim: Voice | null = null;
      for (const v of this.list) {
        if (!v.counted || v.done || v.start > t || v.audible <= t) continue;
        if (!victim || v.prio < victim.prio || (v.prio === victim.prio && v.start < victim.start)) victim = v;
      }
      if (!victim) break;
      this.steal(victim, t);
      active = this.activeAt(t);
    }
  }

  steal(v: Voice, t: number) {
    for (const p of v.env) {
      try {
        p.cancelScheduledValues(t);
        p.setTargetAtTime(0, t, 0.012);
      } catch {
        /* ignore */
      }
    }
    for (const s of v.srcs) safeStop(s, t + 0.09);
    v.end = Math.min(v.end, t + 0.09);
    v.audible = Math.min(v.audible, t);
    this.stats.voicesStolen++;
  }

  /** Drop finished voices from the list; force-clean anything whose end passed long ago (lost onended). */
  sweep(now: number) {
    const keep: Voice[] = [];
    for (const v of this.list) {
      if (!v.done && v.end < now - 3) this.release(v);
      if (!v.done) keep.push(v);
    }
    this.list = keep;
  }

  /** Stop everything (band disposal). */
  stopAll(at: number) {
    for (const v of this.list) {
      if (v.done) continue;
      for (const s of v.srcs) safeStop(s, at);
    }
  }

  releaseAll() {
    for (const v of this.list) this.release(v);
    this.list = [];
  }
}
