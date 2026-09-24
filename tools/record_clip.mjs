// ゲーム画面の動画クリップを撮る (プロモ動画の素材用)
//   PORT=5182 node tools/record_clip.mjs <out.mp4> "<query>" [秒数=4] [助走秒=0]
//   例: node tools/record_clip.mjs clips/start.mp4 "debug=1&wp=0&cam=0&ai=1" 4 1
//
// ?rec=1 で実時間に依存せず 1/30 秒ずつ進め、1 コマごとにスクリーンショットを撮って
// ffmpeg で 30fps の MP4 にする。描画が遅くてもコマ落ちしない。
// GPU (D3D11) で描画する。HUD と FPS 表示は消す。
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [out, query, secArg, warmArg] = process.argv.slice(2);
if (!out || !query) { console.error('usage: record_clip.mjs <out.mp4> "<query>" [sec] [warmupSec]'); process.exit(1); }
const FPS = 30;
const frames = Math.round(Number(secArg ?? 4) * FPS);
const warmup = Math.round(Number(warmArg ?? 0) * FPS);
const W = Number(process.env.W ?? 1920), H = Number(process.env.H ?? 1080);
const BASE = `http://localhost:${process.env.PORT ?? 5182}/`;
const tmp = path.join(path.dirname(out), `.frames-${path.basename(out, '.mp4')}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));
await page.goto(`${BASE}?${query}&rec=1&nohud=1&nofps=1&q=high`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__recStep && window.__debug, null, { timeout: 300000 });
// テクスチャの読み込みと影の安定を待つ
await page.waitForTimeout(3000);
if (warmup) await page.evaluate(n => window.__recStep(n), warmup);
for (let f = 0; f < frames; f++) {
  await page.evaluate(() => window.__recStep(1));
  await page.screenshot({ path: path.join(tmp, `f${String(f).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 });
}
await browser.close();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(tmp, 'f%04d.jpg'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'medium', out], { stdio: 'inherit' });
rmSync(tmp, { recursive: true, force: true });
console.log(`${out} (${frames} コマ, ${frames / FPS}s)`);
