#!/usr/bin/env node
// Dump generated lofi scores as text and run the automated music checks.
//
//   node tools/audio/score.mjs --style dusty-keys --seed 1234 --track 0 [--drums] [--bars 16]
//   node tools/audio/score.mjs --survey 40        # check 40 tracks of every style, print a summary table
//
// Loads the TypeScript composer through Vite's SSR module loader (no build step needed).
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const mod = await server.ssrLoadModule('/src/audio/music/inspect.ts');
  const STYLES = ['dusty-keys', 'sunday-tape', 'night-drive', 'drift', 'cafe-boom-bap'];
  const survey = opt('survey', false);
  if (survey) {
    const n = Number(survey === true ? 20 : survey);
    const styles = opt('style', false) ? [opt('style')] : STYLES;
    const rows = [];
    for (const style of styles) {
      const agg = { n: 0, clash: 0, off: 0, ook: 0, mud: 0, move: 0, topLeap: 0, stable: 0, run: 0, poly: 0, dur: 0, issues: 0, distinct: 0, minDur: 1e9, maxDur: 0 };
      for (let i = 0; i < n; i++) {
        const seed = 1000 + i * 7919;
        const { report } = mod.inspectTrack(seed, style, i % 5);
        agg.n++;
        agg.clash += report.melodyClashes;
        agg.off += report.melodyOffScale;
        agg.ook += report.outOfKey;
        agg.mud += report.lowMud;
        agg.move += report.avgVoiceMove;
        agg.topLeap = Math.max(agg.topLeap, report.maxTopLeap);
        agg.stable += report.strongOnStable;
        agg.run = Math.max(agg.run, report.maxRepeatRun);
        agg.poly = Math.max(agg.poly, report.maxPoly);
        agg.dur += report.duration;
        agg.minDur = Math.min(agg.minDur, report.duration);
        agg.maxDur = Math.max(agg.maxDur, report.duration);
        agg.distinct += report.distinctBars / report.bars;
        agg.issues += report.issues.length;
        if (opt('verbose', false) && report.issues.length) console.log(style, seed, report.issues.join(' | '));
      }
      rows.push({
        style,
        tracks: agg.n,
        clashes: agg.clash,
        offScale: agg.off,
        outOfKey: agg.ook,
        lowMud: agg.mud,
        avgMove: +(agg.move / agg.n).toFixed(2),
        maxTopLeap: agg.topLeap,
        strongStable: +(agg.stable / agg.n).toFixed(2),
        maxRepeatRun: agg.run,
        distinctBars: +(agg.distinct / agg.n).toFixed(2),
        maxPoly: agg.poly,
        dur: `${Math.round(agg.minDur)}-${Math.round(agg.maxDur)}s`,
      });
    }
    console.table(rows);
  } else {
    const style = opt('style', 'dusty-keys');
    const seed = Number(opt('seed', 1234));
    const track = Number(opt('track', 0));
    const { text, report } = mod.inspectTrack(seed, style, track, !!opt('drums', false));
    const bars = opt('bars', false);
    const lines = text.split('\n');
    console.log(bars ? lines.slice(0, Number(bars) + 12).join('\n') : text);
    const { issues, ...rest } = report;
    console.log('\nreport:', JSON.stringify(rest));
    if (issues.length) console.log('issues:\n  ' + issues.join('\n  '));
  }
} finally {
  await server.close();
}
