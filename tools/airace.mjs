// 全カート AI でレースを高速シミュレーションし、進行状況を確認する (開発用)
//   node tools/airace.mjs [seconds] [steps]
import { chromium } from 'playwright';

const secs = Number(process.argv[2] ?? 90), steps = Number(process.argv[3] ?? 12);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const logs = [];
page.on('console', m => { if (m.type() !== 'debug') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:${process.env.PORT ?? 5182}/?debug=1&ai=1&steps=${steps}&cam=1`, { waitUntil: 'load' });
await page.waitForFunction(() => (window).__debug, null, { timeout: 180000 });
const t0 = Date.now();
while (Date.now() - t0 < secs * 1000) {
  await page.waitForTimeout(10000);
  const s = await page.evaluate(() => {
    const d = (window).__debug;
    return d.karts.map(k => `${k.def.name}: lap${k.lap} s=${Math.round(k.s)} v=${Math.round(k.speed * 3.6)}km/h lat=${k.lateral.toFixed(1)} rank${k.rank} spin=${k.spinTimer > 0 ? 1 : 0} item=${k.item ?? '-'} coins=${k.coins}${k.finished ? ' FIN' : ''}`).join('\n');
  });
  const t = await page.evaluate(() => document.getElementById('timer')?.textContent);
  console.log(`--- wall ${Math.round((Date.now() - t0) / 1000)}s race ${t}`);
  console.log(s);
}
await page.screenshot({ path: 'data/shots/airace_end.png' });
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
