// 任意地点のスクリーンショット (開発用)
//   node tools/shots.mjs <outdir> name=query [name=query ...]
//   例: node tools/shots.mjs data/shots bridge="debug=1&idx=120&cam=3" ground=GROUND
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const [outDir, ...specs] = process.argv.slice(2);
const BASE = 'http://localhost:' + (process.env.PORT ?? '5182') + '/';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', m => { if (m.type() !== 'debug') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
for (const spec of specs) {
  const eq = spec.indexOf('=');
  const name = spec.slice(0, eq), query = spec.slice(eq + 1);
  if (query === 'GROUND') {
    await page.goto(BASE + '?debug=1', { waitUntil: 'load' });
    await page.waitForFunction(() => (window).__groundCanvas, null, { timeout: 180000 });
    const data = await page.evaluate(() => (window).__groundCanvas.toDataURL('image/png'));
    writeFileSync(`${outDir}/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
    console.log('ground saved');
    continue;
  }
  await page.goto(BASE + '?' + query, { waitUntil: 'load' });
  await page.waitForFunction(() => (window).__debug, null, { timeout: 180000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  const info = await page.evaluate(() => { const d = (window).__debug; const p = d.karts[0]; return { n: d.track.n, length: Math.round(d.track.length), idx: p.trackIdx, x: Math.round(p.x), z: Math.round(p.z), y: p.y.toFixed(1), bridge: d.track.bridge[p.trackIdx] }; });
  console.log(name, JSON.stringify(info));
}
console.log(logs.join('\n'));
await browser.close();
