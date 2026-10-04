// Audio lab: a small manual test bench for the audio system (audio-lab.html), plus hooks used by
// tools/audio/render.mjs to render stations offline and pull the result out of the browser.
import { AudioSystem, SFX_NAMES, makeStations } from './index';
import type { RadioBand, RadioInfo, Vec3 } from './types';
import { type OfflineOptions, type OfflineResult, renderOffline } from './offline';
import { inspectTrack } from './music/inspect';
import { composeTrack, planTrack } from './music/compose';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const audio = AudioSystem.create();
audio.radio.setStations(makeStations(1));
const RADIO_POS: Vec3 = [0.55, 0.85, -0.75];
audio.radio.setPosition(RADIO_POS, [-0.55, 0.2, 0.8]);

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

let lastInfo: RadioInfo | null = null;
audio.radio.onInfo((i) => {
  lastInfo = i;
  const lines = [
    `band     ${i.band}   power ${i.on ? 'on' : 'off'}   status ${i.status}`,
    `dial     ${i.freq.toFixed(1)} MHz   signal ${(i.signal * 100).toFixed(0)}%`,
    `station  ${i.station ?? '—'}${i.stationFreq ? `  (${i.stationFreq.toFixed(1)})` : ''}`,
    `style    ${i.styleLabel ?? '—'}`,
    `track    ${i.title ?? '—'}  #${i.trackIndex}`,
    `music    ${i.bpm ? i.bpm + ' BPM' : '—'}   ${i.key ?? ''}`,
    `time     ${fmtTime(i.elapsed)}${i.duration ? ' / ' + fmtTime(i.duration) : ''}`,
  ];
  $('info').textContent = lines.join('\n');
  const dial = $<HTMLInputElement>('dial');
  if (document.activeElement !== dial) dial.value = String(i.freq);
  $('dialv').textContent = i.freq.toFixed(1);
});

function bindSlider(id: string, fn: (v: number) => void, fmt = (v: number) => v.toFixed(2)) {
  const el = $<HTMLInputElement>(id);
  const out = el.parentElement?.querySelector('output');
  const upd = () => {
    const v = parseFloat(el.value);
    if (out) out.textContent = fmt(v);
    fn(v);
  };
  el.addEventListener('input', upd);
  upd();
}

let yaw = 0;
let lx = 0;
let lz = 0;
function pushListener() {
  const r = (yaw * Math.PI) / 180;
  const fwd: Vec3 = [-Math.sin(r), 0, -Math.cos(r)];
  audio.setListener([lx, 1.15, lz], fwd, [0, 1, 0]);
}

$('unlock').addEventListener('click', async () => {
  await audio.unlock();
  pushListener();
  $('state').textContent = `AudioContext: ${audio.ctx?.state} @ ${audio.ctx?.sampleRate} Hz`;
  audio.sfx.play('switch', RADIO_POS);
});
$('power').addEventListener('click', () => {
  audio.radio.setPower(!audio.radio.on);
  audio.sfx.play('switch', RADIO_POS);
});
$('prev').addEventListener('click', () => {
  audio.radio.prevStation();
  audio.sfx.play('knob', RADIO_POS);
});
$('next').addEventListener('click', () => {
  audio.radio.nextStation();
  audio.sfx.play('knob', RADIO_POS);
});
$('track').addEventListener('click', () => {
  audio.radio.nextTrack();
  audio.sfx.play('button', RADIO_POS);
});
$<HTMLSelectElement>('band').addEventListener('change', (e) => {
  audio.radio.setBand((e.target as HTMLSelectElement).value as RadioBand);
  audio.sfx.play('switch', RADIO_POS);
});
$('newsys').addEventListener('click', () => {
  const seed = parseInt($<HTMLInputElement>('sysseed').value, 10) || 1;
  audio.radio.setStations(makeStations(seed));
});
$<HTMLInputElement>('dial').addEventListener('input', (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  audio.radio.tune(v);
  $('dialv').textContent = v.toFixed(1);
});
bindSlider('vol', (v) => audio.radio.setVolume(v));
bindSlider('char', (v) => audio.radio.setCharacter(v));
bindSlider('yaw', (v) => {
  yaw = v;
  pushListener();
}, (v) => `${v.toFixed(0)}°`);
bindSlider('lx', (v) => {
  lx = v;
  pushListener();
});
bindSlider('lz', (v) => {
  lz = v;
  pushListener();
});
bindSlider('vmaster', (v) => audio.setVolumes({ master: v }));
bindSlider('vmusic', (v) => audio.setVolumes({ music: v }));
bindSlider('vamb', (v) => audio.setVolumes({ ambience: v }));
bindSlider('vsfx', (v) => audio.setVolumes({ sfx: v }));
const ship = { throttle: 0, speed: 0, warp: 0 };
bindSlider('throttle', (v) => audio.ambience.setShipState({ ...ship, throttle: (ship.throttle = v) }));
bindSlider('speed', (v) => audio.ambience.setShipState({ ...ship, speed: (ship.speed = v) }));
bindSlider('warp', (v) => audio.ambience.setShipState({ ...ship, warp: (ship.warp = v) }));
$<HTMLInputElement>('files').addEventListener('change', (e) => {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  audio.radio.loadTape(files);
  audio.radio.setBand('tape');
  $<HTMLSelectElement>('band').value = 'tape';
});
$('link').addEventListener('click', async () => {
  const url = $<HTMLInputElement>('url').value.trim();
  if (!url) return;
  audio.radio.setBand('link');
  $<HTMLSelectElement>('band').value = 'link';
  $('linkres').textContent = 'loading…';
  const r = await audio.radio.playLink(url);
  $('linkres').textContent = r === 'ok' ? 'playing through the radio' : r === 'no-cors' ? 'playing directly (the server does not allow CORS, so no radio effects)' : 'could not play that URL';
});
const sfxRow = $('sfx');
for (const name of SFX_NAMES) {
  const b = document.createElement('button');
  b.textContent = name;
  b.addEventListener('click', () => audio.sfx.play(name, name.startsWith('warp') ? undefined : [0.3, 0.9, -0.5]));
  sfxRow.appendChild(b);
}
$('score').addEventListener('click', () => {
  const i = lastInfo;
  const st = audio.radio.stationList.find((s) => s.name === i?.station);
  if (!st || !i) {
    $('scoretext').textContent = 'Tune to a station first.';
    return;
  }
  $('scoretext').textContent = inspectTrack(st.seed, st.style, i.trackIndex, true).text;
});

// VU needle + spectrum
const canvas = $<HTMLCanvasElement>('vu');
const g2 = canvas.getContext('2d')!;
const spec = new Uint8Array(256);
let vu = 0;
function draw() {
  const lv = audio.radio.getLevels();
  audio.radio.getSpectrum(spec);
  vu += (Math.min(1, lv.rms * 4) - vu) * 0.2;
  const w = canvas.width;
  const h = canvas.height;
  g2.fillStyle = '#0f0c0a';
  g2.fillRect(0, 0, w, h);
  g2.fillStyle = '#5a4532';
  const bw = w / 96;
  for (let k = 0; k < 96; k++) {
    const v = spec[Math.floor(Math.pow(k / 96, 1.8) * 200)] / 255;
    g2.fillRect(k * bw, h - v * h * 0.9, bw - 1, v * h * 0.9);
  }
  g2.strokeStyle = '#f4c27a';
  g2.lineWidth = 3;
  g2.beginPath();
  const a = Math.PI * (1.15 + 0.7 * vu);
  g2.moveTo(w / 2, h + 20);
  g2.lineTo(w / 2 + Math.cos(a) * (h + 5), h + 20 + Math.sin(a) * (h + 5));
  g2.stroke();
  const st = audio.stats();
  if (st) $('stats').textContent = `nodes ${st.nodesLive} (max ${st.nodesMax}) · voices ${st.voicesLive} (max ${st.voicesMax}, stolen ${st.voicesStolen}) · bands ${st.bandsLive}`;
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ------------------------------------------------------------------------------------------------
// Hooks for tools/audio/render.mjs

let lastRender: OfflineResult | null = null;

function b64(f: Float32Array): string {
  const u8 = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(s);
}

(window as unknown as { __audioLab: unknown }).__audioLab = {
  audio,
  async render(opts: OfflineOptions) {
    lastRender = null;
    const r = await renderOffline(opts);
    lastRender = r;
    return {
      length: r.buffer.length,
      channels: r.buffer.numberOfChannels,
      sampleRate: r.buffer.sampleRate,
      stats: r.stats,
      log: r.log,
      renderMs: r.renderMs,
    };
  },
  /** base64 of float32 samples [start, start+len) of a channel of the last render */
  chunk(ch: number, start: number, len: number): string {
    if (!lastRender) throw new Error('nothing rendered');
    const d = lastRender.buffer.getChannelData(ch).subarray(start, start + len);
    return b64(new Float32Array(d));
  },
  score(seed: number, style: string, index: number) {
    return inspectTrack(seed, style as never, index, true);
  },
  plan(seed: number, style: string, index: number) {
    return planTrack(seed, style as never, index);
  },
  compose(seed: number, style: string, index: number) {
    return composeTrack(planTrack(seed, style as never, index));
  },
};
