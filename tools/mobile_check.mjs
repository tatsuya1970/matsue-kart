// スマホ表示の確認 (開発用)。iPhone 相当の横持ち / 縦持ちでタイトルとレース画面を撮り、
// タッチ操作 (自動アクセル・ハンドル・指の滑り・ブレーキ) が効くか、ボタンや HUD が
// 重なっていないかを調べる。
//   node tools/mobile_check.mjs [outdir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'data/shots/mobile';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:' + (process.env.PORT ?? '5182') + '/';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'OK ' : 'NG '} ${msg}`); if (!ok) failed++; };

async function open(width, height, query) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, userAgent: UA });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(BASE + query, { waitUntil: 'load' });
  return { ctx, page };
}

/** 要素の中心座標 */
const center = (page, sel) => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
/** 見えている要素どうしで重なっているものを列挙する */
const overlaps = (page, sels) => page.evaluate(sels => {
  const rs = sels.map(s => { const el = document.querySelector(s); const r = el.getBoundingClientRect(); return { s, r, vis: getComputedStyle(el).display !== 'none' && r.width > 0 }; }).filter(x => x.vis);
  const out = [];
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i].r, b = rs[j].r;
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) out.push(`${rs[i].s} x ${rs[j].s}`);
  }
  return out;
}, sels);
const PADS = ['#tLeft', '#tRight', '#tBrake', '#tDrift', '#tItem'];
const HUD = ['#lap', '#timer', '#fps', '#pos', '#item', '#speed', '#coins'];

// ---- 横持ち: タイトル ----
{
  const { ctx, page } = await open(852, 393, '');
  await page.waitForFunction(() => { const b = document.getElementById('startBtn'); return b && !b.disabled; }, null, { timeout: 180000 });
  check(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'pointer: coarse が有効 (タッチ端末として扱われている)');
  check(await page.$eval('#touch', el => getComputedStyle(el).display === 'block'), 'タッチボタンが表示される');
  check(await page.$eval('.keys.touchKeys', el => getComputedStyle(el).display !== 'none'), 'タッチ操作の説明が出る');
  check(await page.$eval('#rotateHint', el => getComputedStyle(el).display === 'none'), '横持ちでは回転の案内が出ない');
  await page.screenshot({ path: `${OUT}/01_title_landscape.png` });
  await ctx.close();
}

// ---- 横持ち: レース (debug=1 でカウントダウン無し) ----
{
  const { ctx, page } = await open(852, 393, '?debug=1&nofps=0');
  await page.waitForFunction(() => window.__debug, null, { timeout: 180000 });
  const state = () => page.evaluate(() => { const k = window.__debug.karts[0]; return { speed: k.speed, heading: k.heading, drifting: k.drifting }; });
  const on = sel => page.$eval(sel, el => el.classList.contains('on'));
  // SwiftShader は fps が低く物理時間の進みが遅いので、速度の絶対値ではなく増えているかを見る
  await page.waitForTimeout(1500);
  const sA = await state();
  await page.waitForTimeout(1500);
  const s0 = await state();
  check(s0.speed > sA.speed && s0.speed > 0.5, `触らなくても走り出す (自動アクセル): ${sA.speed.toFixed(1)} → ${s0.speed.toFixed(1)} m/s`);
  check((await overlaps(page, [...PADS, ...HUD])).length === 0, '横持ちでボタンと HUD が重ならない: ' + JSON.stringify(await overlaps(page, [...PADS, ...HUD])));

  const cdp = await ctx.newCDPSession(page);
  const left = await center(page, '#tLeft'), right = await center(page, '#tRight'), brake = await center(page, '#tBrake'), drift = await center(page, '#tDrift');
  // ◀ を押さえる
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: left.x, y: left.y, id: 1 }] });
  await page.waitForTimeout(150);
  check(await on('#tLeft'), '◀ に触れると光る');
  await page.waitForTimeout(700);
  const s1 = await state();
  check(Math.abs(s1.heading - s0.heading) > 0.05, `◀ で向きが変わる: ${(s1.heading - s0.heading).toFixed(2)} rad`);
  // 右の親指で D を押さえたままにする (2 本指)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: left.x, y: left.y, id: 1 }, { x: drift.x, y: drift.y, id: 2 }] });
  await page.waitForTimeout(400);
  check(await on('#tDrift') && await on('#tLeft'), '2 本指で ◀ と D を同時に押せる');
  await page.screenshot({ path: `${OUT}/02_race_landscape.png` });
  // ◀ の指を ▶ へ滑らせる
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: right.x, y: right.y, id: 1 }, { x: drift.x, y: drift.y, id: 2 }] });
  await page.waitForTimeout(150);
  check(await on('#tRight') && !(await on('#tLeft')), '指を滑らせると ◀ が離れて ▶ が押される');
  // 全部離す
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
  check(!(await on('#tRight')) && !(await on('#tDrift')), '離すと全部消える');
  // ブレーキ
  const s2 = await state();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: brake.x, y: brake.y, id: 3 }] });
  await page.waitForTimeout(1500);
  const s3 = await state();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check(s3.speed < s2.speed - 3, `▼ で減速する: ${s2.speed.toFixed(1)} → ${s3.speed.toFixed(1)} m/s`);
  await ctx.close();
}

// ---- 縦持ち: タイトルとレース ----
{
  const { ctx, page } = await open(393, 852, '');
  await page.waitForFunction(() => { const b = document.getElementById('startBtn'); return b && !b.disabled; }, null, { timeout: 180000 });
  check(await page.$eval('#rotateHint', el => getComputedStyle(el).display !== 'none'), '縦持ちでは回転の案内が出る');
  await page.$eval('#mainButtons', el => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${OUT}/03_title_portrait.png` });
  await ctx.close();
}
{
  const { ctx, page } = await open(393, 852, '?debug=1');
  await page.waitForFunction(() => window.__debug, null, { timeout: 180000 });
  await page.waitForTimeout(2000);
  const ov = await overlaps(page, [...PADS, ...HUD]);
  check(ov.length === 0, '縦持ちでボタンと HUD が重ならない: ' + JSON.stringify(ov));
  await page.screenshot({ path: `${OUT}/04_race_portrait.png` });
  await ctx.close();
}

await browser.close();
console.log(failed ? `${failed} 件 NG` : 'すべて OK');
process.exit(failed ? 1 : 0);
