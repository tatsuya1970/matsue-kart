// トップ画面の「対戦待ち」表示と、待っている人の部屋へ入って 2 人でカウントダウンが
// 始まるかの確認 (開発用)
//   PORT=5181 node tools/presencetest.mjs
// ブラウザを 2 つ立ち上げ、A はトップ画面に残し、B が対戦PLAY を押す。
//   1. A のトップ画面に「いま 1 人が対戦待ち（ゲスト）対戦相手を待っています」が出るか
//   2. B のロビーは締切なしで「対戦相手を待っています」になっているか
//   3. A が対戦PLAY を押すと B と同じ部屋に数秒以内に席が決まり、両方でカウントダウンが始まるか
//      (presence で接続が共有済みなので、リレー経由の 8〜19 秒を待たずに済むはず)
//   4. B に「対戦相手が来ました」の一言が出るか。そのまま発走して 2 人の席が食い違っていないか
import { chromium } from 'playwright';

const BASE = `http://localhost:${process.env.PORT ?? 5182}/`;
const QUERY = `?ai=1&nofps=1&q=low&nolod2=1&steps=${process.env.STEPS ?? '20'}`;
const OUT = process.env.OUT ?? 'data/shots';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function open(label, name) {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.on('pageerror', e => console.log(`[${label} pageerror] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') console.log(`[${label} error] ${m.text()}`); });
  await page.goto(BASE + QUERY, { waitUntil: 'load' });
  await page.waitForFunction(() => { const b = document.getElementById('startBtn'); return b && !b.disabled; }, null, { timeout: 300000 });
  await page.fill('#playerName', name);
  console.log(`${label}: 読み込み完了`);
  return page;
}
const text = (p, sel) => p.evaluate(s => document.querySelector(s)?.textContent ?? '', sel);
const visible = (p, sel) => p.evaluate(s => { const e = document.querySelector(s); return !!e && e.style.display !== 'none'; }, sel);
const t0 = Date.now();
const since = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';

const [a, b] = await Promise.all([open('A', 'みるひと'), open('B', 'ゲスト')]);

// 1. presence でつながるのを待つ (相手が見えるまで)
const okPresence = await a.waitForFunction(() => window.__presence && window.__presence().others >= 1, null, { timeout: 120000 })
  .then(() => true).catch(() => false);
console.log(`[${since()}] A から相手が${okPresence ? '見えました' : '見えません'}: ${await text(a, '#presenceMain')} / ${await text(a, '#presenceSub')}`);

// 2. B が対戦PLAY を押して 1 人で待つ
await b.click('#openBtn');
const bRoom = await b.evaluate(() => window.__net().code);
const clickedB = Date.now();
console.log(`[${since()}] B が対戦PLAY (部屋 ${bRoom})`);
const okLive = await a.waitForFunction(() => document.getElementById('presence')?.classList.contains('live'), null, { timeout: 15000 })
  .then(() => true).catch(() => false);
console.log(`[${since()}] A に対戦待ちが${okLive ? '出ました' : '出ません'} (B が押してから ${((Date.now() - clickedB) / 1000).toFixed(1)} 秒): ${await text(a, '#presenceMain')} / ${await text(a, '#presenceSub')}`);
await b.waitForTimeout(1500);
console.log(`[${since()}] B のロビー: ${await text(b, '#countLabel')} (数字の表示 ${await visible(b, '#countNum')}) / ${await text(b, '#netNote2')} / ${await text(b, '#presence2')}`);
await a.screenshot({ path: `${OUT}/presence_a.png` });
await b.screenshot({ path: `${OUT}/presence_b_waiting.png` });

// 3. A が押すと B と同じ部屋に入り、2 人でカウントダウンが始まるか
await a.waitForTimeout(3000);
await a.click('#openBtn');
const clickedA = Date.now();
const aRoom = await a.evaluate(() => window.__net().code);
console.log(`[${since()}] A が対戦PLAY (部屋 ${aRoom}) ${aRoom === bRoom ? '= B と同じ部屋' : '≠ B と違う部屋!'}`);
for (const [p, label] of [[a, 'A'], [b, 'B']]) {
  const ok = await p.waitForFunction(() => window.__net && window.__net().order.length >= 2 && window.__net().deadline > 0, null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  const s = await p.evaluate(() => window.__net());
  console.log(`[${since()}] ${label}: 席 ${s.order.length} 人 ${ok ? '' : '(カウントダウンが始まりませんでした)'} A が押してから ${((Date.now() - clickedA) / 1000).toFixed(1)} 秒 / ${await text(p, '#countLabel')} ${await text(p, '#countNum')} / 一言「${await text(p, '#lobbyToast')}」(表示 ${await visible(p, '#lobbyToast')})`);
}
await a.screenshot({ path: `${OUT}/presence_a_lobby.png` });
await b.screenshot({ path: `${OUT}/presence_b_lobby.png` });

// 4. 発走して席が食い違っていないか
for (const [p, label] of [[a, 'A'], [b, 'B']]) {
  await p.waitForFunction(() => window.__net && window.__net().started, null, { timeout: 60000 }).catch(() => console.log(`${label}: 発走しませんでした`));
}
await a.waitForTimeout(3000);
for (const [p, label] of [[a, 'A'], [b, 'B']]) {
  const s = await p.evaluate(() => window.__net());
  console.log(`[${since()}] ${label}: 部屋 ${s.code} / 自分の枠 ${s.slot} / ホスト ${s.host} / 開始 ${s.started} / 席 ${s.order.length} 人`);
}
console.log(`[${since()}] A から見た状況: ${JSON.stringify(await a.evaluate(() => window.__presence()))}`);
await browser.close();
