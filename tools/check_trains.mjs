// 路面電車・JR・新幹線・アストラムラインが実際に動いているかを確認する (開発用)
import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${process.env.PORT ?? 5182}/?debug=1&wp=7&cam=3&steps=6`, { waitUntil: 'load' });
await page.waitForFunction(() => (window).__debug, null, { timeout: 240000 });

const snap = () => page.evaluate(() => {
  const r = (window).__debug.rail;
  const out = {};
  for (const [name, line] of Object.entries(r.lines)) {
    out[name] = { length: Math.round(line.length), pts: line.pts.length };
  }
  // group 内の車両位置 (Train.group は複数の車体 Group を持つ)
  const trains = [];
  for (const c of r.group.children) {
    if (c.type !== 'Group' || c.children.length < 2) continue;
    const first = c.children[0];
    if (!first || first.type !== 'Group') continue;
    trains.push([+first.position.x.toFixed(1), +first.position.y.toFixed(1), +first.position.z.toFixed(1)]);
  }
  return { lines: out, trains };
});

const a = await snap();
console.log('路線:', JSON.stringify(a.lines));
console.log('車両数:', a.trains.length);
await page.waitForTimeout(6000);
const b = await snap();
let moved = 0, total = 0;
for (let i = 0; i < Math.min(a.trains.length, b.trains.length); i++) {
  const d = Math.hypot(b.trains[i][0] - a.trains[i][0], b.trains[i][2] - a.trains[i][2]);
  total++;
  if (d > 1) moved++;
  console.log(`車両${i}: (${a.trains[i]}) -> (${b.trains[i]}) 移動 ${d.toFixed(1)}m`);
}
console.log(`動いた車両 ${moved}/${total}`);
await browser.close();
