#!/usr/bin/env node
// Render radio stations offline in headless Chromium (same code path as the game) and write WAV/MP3.
//
// Single render:
//   node tools/audio/render.mjs --style dusty-keys --seed 1234 --seconds 90 --out out/dusty [--character 0.7]
//        [--track 0] [--offset 0] [--no-textures] [--ambience] [--mp3] [--sr 48000]
//        [--second night-drive:77] [--actions '[{"at":40,"action":"nextStation"}]']
// Batch (one browser for many renders):
//   node tools/audio/render.mjs --jobs jobs.json
//   jobs.json = [{ "name": "out/dusty", "opts": { ...OfflineOptions }, "mp3": true, "write": ["radio", "mix"] }]
//
// Each render writes <name>-radio.wav (what the listener hears in the cabin) and <name>-mix.wav (the
// broadcast before the radio), 32-bit float, plus <name>.json with node/voice stats and an info log.
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

function wavFloat32(channels, sampleRate) {
  const n = channels[0].length;
  const nc = channels.length;
  const dataBytes = n * nc * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * nc * 4, 28);
  buf.writeUInt16LE(nc * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  const inter = new Float32Array(n * nc);
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) inter[i * nc + c] = channels[c][i];
  Buffer.from(inter.buffer).copy(buf, 44);
  return buf;
}

function buildJobs() {
  const jf = opt('jobs', false);
  if (jf) return JSON.parse(fs.readFileSync(jf, 'utf8'));
  const o = {
    style: opt('style', 'dusty-keys'),
    seed: Number(opt('seed', 1234)),
    seconds: Number(opt('seconds', 60)),
    sampleRate: Number(opt('sr', 48000)),
    character: Number(opt('character', 0.7)),
    trackIndex: Number(opt('track', 0)),
    offset: Number(opt('offset', 0)),
    textures: !opt('no-textures', false),
    ambience: !!opt('ambience', false),
  };
  const second = opt('second', false);
  if (second) {
    const [style, seed] = String(second).split(':');
    o.second = { style, seed: Number(seed) };
  }
  const actions = opt('actions', false);
  if (actions) o.actions = JSON.parse(actions);
  return [{ name: opt('out', 'out/render'), opts: o, mp3: !!opt('mp3', false) }];
}

const jobs = buildJobs();
const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text());
  });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  await page.goto(`http://127.0.0.1:${port}/audio-lab.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__audioLab, null, { timeout: 60000 });
  for (const job of jobs) {
    const t0 = Date.now();
    const meta = await page.evaluate((o) => window.__audioLab.render(o), job.opts);
    const { length, sampleRate } = meta;
    const CH = 48000 * 8;
    const write = job.write ?? ['radio', 'mix'];
    const need = new Set([...(write.includes('radio') ? [0, 1] : []), ...(write.includes('mix') ? [2, 3] : [])]);
    const chans = [];
    for (let c = 0; c < meta.channels; c++) {
      if (!need.has(c)) {
        chans.push(null);
        continue;
      }
      const data = new Float32Array(length);
      for (let s = 0; s < length; s += CH) {
        const n = Math.min(CH, length - s);
        const b64 = await page.evaluate(([cc, ss, nn]) => window.__audioLab.chunk(cc, ss, nn), [c, s, n]);
        const raw = Buffer.from(b64, 'base64');
        data.set(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), s);
      }
      chans.push(data);
    }
    fs.mkdirSync(path.dirname(path.resolve(job.name)), { recursive: true });
    const files = [];
    if (write.includes('radio')) {
      const f = `${job.name}-radio.wav`;
      fs.writeFileSync(f, wavFloat32([chans[0], chans[1]], sampleRate));
      files.push(f);
    }
    if (write.includes('mix')) {
      const f = `${job.name}-mix.wav`;
      fs.writeFileSync(f, wavFloat32([chans[2], chans[3]], sampleRate));
      files.push(f);
    }
    fs.writeFileSync(`${job.name}.json`, JSON.stringify({ opts: job.opts, stats: meta.stats, renderMs: meta.renderMs, log: meta.log }, null, 1));
    if (job.mp3) {
      for (const f of files.filter((x) => (job.mp3Which ?? ['radio']).some((w) => x.endsWith(`-${w}.wav`)))) {
        const mp3 = f.replace(/\.wav$/, '.mp3').replace(/-radio\.mp3$/, '.mp3');
        const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', f, '-codec:a', 'libmp3lame', '-b:a', '192k', mp3]);
        if (r.status !== 0) console.log('ffmpeg failed', r.stderr?.toString());
        else files.push(mp3);
      }
    }
    const st = meta.stats;
    console.log(
      `${job.name}: ${(length / sampleRate).toFixed(1)}s rendered in ${(meta.renderMs / 1000).toFixed(1)}s (total ${((Date.now() - t0) / 1000).toFixed(1)}s) ` +
        `nodes live ${st.nodesLive} max ${st.nodesMax} · voices max ${st.voicesMax} stolen ${st.voicesStolen} · bands ${st.bandsLive}`,
    );
    console.log('  ' + files.join('\n  '));
  }
} finally {
  await browser.close();
  await server.close();
}
