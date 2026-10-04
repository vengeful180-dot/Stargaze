// Headless screenshots of the game for visual checks (SwiftShader WebGL2 in Chromium; slow but faithful).
// Usage: node tools/shots.mjs [name:query ...]   e.g. node tools/shots.mjs planet:"q=low&nocabin"
// Each shot opens /?test=1&<query>, waits for window.__stargazeReady, then saves shots/<name>.png.
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const outDir = resolve(root, 'shots');
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const width = Number(process.env.SHOT_W ?? 1280);
const height = Number(process.env.SHOT_H ?? 720);
const shots = args.length
  ? args.map((a) => {
      const i = a.indexOf(':');
      return i < 0 ? { name: a, query: '' } : { name: a.slice(0, i), query: a.slice(i + 1) };
    })
  : [{ name: 'default', query: 'q=low' }];

const server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } });
await server.listen();
const port = server.httpServer.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

let failed = 0;
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const log = [];
  page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
  const url = `http://127.0.0.1:${port}/?test=1&${shot.query}`;
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__stargazeReady === true, null, { timeout: Number(process.env.SHOT_TIMEOUT ?? 600000), polling: 500 });
    // a couple more frames so temporal effects settle
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
    const file = resolve(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file });
    console.log(`${shot.name}: ${((Date.now() - t0) / 1000).toFixed(1)} s -> shots/${shot.name}.png`);
  } catch (e) {
    failed++;
    console.log(`${shot.name}: FAILED ${e.message.split('\n')[0]}`);
  }
  const errors = log.filter((l) => /error|warn/i.test(l));
  writeFileSync(resolve(outDir, `${shot.name}.log`), log.join('\n'));
  if (errors.length) console.log(errors.slice(0, 20).join('\n'));
  await page.close();
}

await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
