// Offline rendering through the exact same engine/radio/composer code, for tests and listening samples.
// The scheduler is driven by OfflineAudioContext.suspend() points instead of the worker clock.
// Output: 4 channels = [radio L, radio R, broadcast mix L, broadcast mix R].
import { Ambience } from './ambience';
import { Engine } from './engine';
import { TRACK_GAP, planTrack } from './music/compose';
import { Radio } from './radio';
import { makeStations } from './stations';
import { BAND_DEBUG, MIX } from './synth/band';
import { TUNER_LEVEL } from './tuner';
import type { RadioInfo, StationDef, StationStyle } from './types';

export type OfflineAction =
  | { at: number; action: 'nextStation' | 'prevStation' | 'nextTrack' }
  | { at: number; action: 'tune'; value: number }
  | { at: number; action: 'character'; value: number }
  | { at: number; action: 'power'; value: boolean }
  | { at: number; action: 'listener'; value: { pos: number[]; fwd: number[]; up?: number[] } }
  | { at: number; action: 'ship'; value: { throttle?: number; speed?: number; warp?: number } }
  | { at: number; action: 'band'; value: 'stations' | 'tape' | 'link' }
  | { at: number; action: 'volume'; value: number }
  | { at: number; action: 'stations'; value: number };

export interface OfflineOptions {
  style: StationStyle;
  seed: number;
  seconds: number;
  sampleRate?: number;
  /** speaker character (default 0.7) */
  character?: number;
  /** radio volume knob (default 0.75) */
  volume?: number;
  /** start at this track of the station's programme */
  trackIndex?: number;
  /** seconds into that track when the render starts (joins mid-track) */
  offset?: number;
  /** a second station 6.8 MHz up the dial (for tuning transitions) */
  second?: { style: StationStyle; seed: number; trackIndex?: number; offset?: number };
  actions?: OfflineAction[];
  ambience?: boolean;
  /** vinyl crackle / tape hiss / radio floor (default true) */
  textures?: boolean;
  listener?: { pos: number[]; fwd: number[]; up?: number[] };
  /** scheduler step in seconds */
  step?: number;
  /** temporary instrument level overrides (e.g. solo an instrument by zeroing the others) */
  mix?: Partial<Record<keyof typeof MIX, number>>;
  /** keep only these MIX keys (others set to 0) */
  solo?: (keyof typeof MIX)[];
  /** capture the broadcast before the glue compressor (stem measurements) */
  rawMix?: boolean;
  quality?: 'high' | 'low';
  /** profiling: only keep these event streams (instrument ids, 'drums', 'fx') */
  only?: string[];
  /** broadcast plate reverb (default on) */
  plate?: boolean;
}

export interface OfflineLogEntry {
  t: number;
  info: RadioInfo;
  nodes: number;
  voices: number;
  bands: number;
}

export interface OfflineResult {
  buffer: AudioBuffer;
  stats: ReturnType<Engine['stats']['snapshot']>;
  log: OfflineLogEntry[];
  renderMs: number;
}

function epochFor(def: StationDef, trackIndex: number, offset: number, start: number) {
  let t = start - offset;
  for (let i = 0; i < trackIndex; i++) t -= planTrack(def.seed, def.style, i).duration + TRACK_GAP;
  return t;
}

export async function renderOffline(o: OfflineOptions): Promise<OfflineResult> {
  const sr = o.sampleRate ?? 48000;
  const length = Math.ceil(sr * o.seconds);
  const ctx = new OfflineAudioContext({ numberOfChannels: 4, length, sampleRate: sr });
  const savedMix = { ...MIX };
  const savedFloor = TUNER_LEVEL.floor;
  if (o.textures === false) {
    MIX.crackle = 0;
    MIX.hiss = 0;
    TUNER_LEVEL.floor = 0;
  }
  if (o.solo) {
    const keep = new Set<string>(['bandGain', 'nylonGain', 'padChord', ...o.solo]);
    for (const k of Object.keys(MIX) as (keyof typeof MIX)[]) if (!keep.has(k)) MIX[k] = 0;
    TUNER_LEVEL.floor = 0;
  }
  if (o.mix) Object.assign(MIX, o.mix);
  BAND_DEBUG.only = o.only ?? null;
  try {
    const eng = new Engine(ctx, { offline: true, quality: o.quality ?? 'high' });
    eng.lookahead = Math.max(0.25, (o.step ?? 0.05) + 0.15);
    // reroute the final output into a 4-channel capture
    eng.out.disconnect();
    const merger = ctx.createChannelMerger(4);
    merger.connect(ctx.destination);
    const s1 = ctx.createChannelSplitter(2);
    eng.out.connect(s1);
    s1.connect(merger, 0, 0);
    s1.connect(merger, 1, 1);
    if (o.listener) eng.setListener(o.listener.pos, o.listener.fwd, o.listener.up ?? [0, 1, 0]);

    const defs: StationDef[] = [{ seed: o.seed, freq: 94.3, name: 'Test FM', style: o.style }];
    if (o.second) defs.push({ seed: o.second.seed, freq: 101.1, name: 'Second FM', style: o.second.style });
    const radio = new Radio();
    radio.setStations(defs);
    radio.setCharacter(o.character ?? 0.7);
    radio.setVolume(o.volume ?? 0.75);
    radio.attach(eng);
    if (o.plate === false) eng.broadcastSend = null;
    const s2 = ctx.createChannelSplitter(2);
    if (o.rawMix) radio.debugRawMixTap().connect(s2);
    else radio.mixTap!.connect(s2);
    s2.connect(merger, 0, 2);
    s2.connect(merger, 1, 3);
    // align the programmes so the requested track/offset is playing when the radio comes on
    const start = 0.3;
    radio.debugSetEpoch(0, epochFor(defs[0], o.trackIndex ?? 0, o.offset ?? 0, start));
    if (o.second) radio.debugSetEpoch(1, epochFor(defs[1], o.second.trackIndex ?? 0, o.second.offset ?? 0, start));

    let amb: Ambience | null = null;
    if (o.ambience) {
      amb = new Ambience();
      amb.attach(eng);
    }

    const actions = [...(o.actions ?? [])].sort((a, b) => a.at - b.at);
    let ai = 0;
    const log: OfflineLogEntry[] = [];
    let lastLog = -1;
    const apply = (a: OfflineAction) => {
      switch (a.action) {
        case 'nextStation':
          radio.nextStation();
          break;
        case 'prevStation':
          radio.prevStation();
          break;
        case 'nextTrack':
          radio.nextTrack();
          break;
        case 'tune':
          radio.tune(a.value);
          break;
        case 'character':
          radio.setCharacter(a.value);
          break;
        case 'power':
          radio.setPower(a.value);
          break;
        case 'listener':
          eng.setListener(a.value.pos, a.value.fwd, a.value.up ?? [0, 1, 0]);
          break;
        case 'ship':
          amb?.setShipState(a.value);
          break;
        case 'band':
          radio.setBand(a.value);
          break;
        case 'volume':
          radio.setVolume(a.value);
          break;
        case 'stations':
          radio.setStations(makeStations(a.value));
          break;
      }
    };
    const onStep = (t: number) => {
      while (ai < actions.length && actions[ai].at <= t + 1e-9) apply(actions[ai++]);
      eng.tick();
      if (t - lastLog >= 0.5) {
        lastLog = t;
        const st = eng.stats.snapshot();
        log.push({ t, info: radio.getInfo(), nodes: st.nodesLive, voices: st.voicesLive, bands: st.bandsLive });
      }
    };
    const step = o.step ?? 0.05;
    const total = length / sr;
    const schedule = (t: number) => {
      ctx
        .suspend(t)
        .then(() => {
          onStep(t);
          const nt = Math.round((t + step) * 1e6) / 1e6;
          if (nt < total - step) schedule(nt);
          return ctx.resume();
        })
        .catch((e) => console.error('[offline] suspend failed', e));
    };
    onStep(0);
    schedule(step);
    const t0 = performance.now();
    const buffer = await ctx.startRendering();
    const renderMs = performance.now() - t0;
    return { buffer, stats: eng.stats.snapshot(), log, renderMs };
  } finally {
    BAND_DEBUG.only = null;
    Object.assign(MIX, savedMix);
    TUNER_LEVEL.floor = savedFloor;
  }
}
