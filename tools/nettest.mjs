// オンライン対戦の疎通確認 (開発用)
//   PORT=5181 node tools/nettest.mjs
// ブラウザを 2 つ立ち上げて公開ロビーに入り、2 人そろって始まる 30 秒のカウントダウンで
// 自動発走し、相手のカートが動いて見えるかを調べる。
//
// 2 つ同時に押すので、お互いの「対戦待ち」が届く前にそれぞれ部屋を作ることがある。
// その場合は 1 人で待っている側が相手の部屋へ移って合流する (maybeMergeLobby) ので、
// 合流までの秒数もここで分かる。
import { chromium } from 'playwright';

const BASE = `http://localhost:${process.env.PORT ?? 5182}/`;
const STEPS = process.env.STEPS ?? '20';
const QUERY = `?ai=1&nofps=1&q=low&nolod2=1&steps=${STEPS}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function open(label, name) {
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  // 通信の許可を済ませた状態で開く (src/main.ts の startNet)
  await page.addInitScript(k => localStorage.setItem(k, '1'), 'mk.netConsent');
  page.on('pageerror', e => console.log(`[${label} pageerror] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') console.log(`[${label} error] ${m.text()}`); });
  await page.goto(BASE + QUERY, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('startBtn');
    return b && !b.disabled;
  }, null, { timeout: 300000 });
  await page.fill('#playerName', name);
  console.log(`${label}: 読み込み完了`);
  return page;
}

// 2 つ同時に読み込む
const [a, b] = await Promise.all([open('A', 'ホスト'), open('B', 'ゲスト')]);

const clickedAt = Date.now();
await Promise.all([a.click('#openBtn'), b.click('#openBtn')]);
console.log('公開ロビーに入りました');

for (const [p, label] of [[a, 'A'], [b, 'B']]) {
  await p.waitForFunction(() => document.querySelectorAll('#playerList li').length >= 2, null, { timeout: 60000 })
    .catch(() => console.log(`${label}: ロビーに 2 人そろいませんでした`));
  const n = await p.evaluate(() => document.querySelectorAll('#playerList li').length);
  if (label === 'A') console.log('相手とつながるまで ' + ((Date.now() - clickedAt) / 1000).toFixed(1) + ' 秒');
  const left = await p.evaluate(() => document.getElementById('countNum')?.textContent);
  console.log(`${label}: ロビー ${n} 人 / 発走まで ${left} 秒`);
}

// カウントダウンが 0 になると自動で始まる
await a.waitForFunction(() => window.__net && window.__net().started, null, { timeout: 60000 });
console.log('カウントダウンで自動発走しました');

const snap = async () => {
  const out = {};
  for (const [p, label] of [[a, 'A'], [b, 'B']]) out[label] = await p.evaluate(() => (window.__net ? window.__net() : null));
  return out;
};
await a.waitForTimeout(30000);
const s1 = await snap();
await a.waitForTimeout(30000);
const s2 = await snap();
console.log('--- 30 秒間の移動量 ---');
for (const label of ['A', 'B']) {
  if (!s1[label] || !s2[label]) continue;
  console.log(label + ': ' + s2[label].karts.map((k, i) => k.name + ' ' + Math.round(Math.hypot(k.x - s1[label].karts[i].x, k.z - s1[label].karts[i].z)) + 'm').join(', '));
}
console.log('--- A と B が見ている位置の差 ---');
if (s2.A && s2.B) console.log(s2.A.karts.map((k, i) => k.name + ' ' + Math.round(Math.hypot(k.x - s2.B.karts[i].x, k.z - s2.B.karts[i].z)) + 'm').join(', '));

for (const [p, label] of [[a, 'A'], [b, 'B']]) {
  const s = await p.evaluate(() => (window.__net ? window.__net() : null));
  if (!s) { console.log(`${label}: __net が取れません`); continue; }
  console.log(`${label}: 部屋 ${s.code} / 自分の枠 ${s.slot} / ホスト ${s.host} / 開始 ${s.started} / 席 ${s.order.length} / 名前の吹き出し ${s.labels}`);
  for (const k of s.karts) console.log(`   ${k.i} ${k.name} (${k.x},${k.z}) lap${k.lap} ${k.fromNet ? '受信' : '自前'}`);
}
const OUT = process.env.OUT ?? 'data/shots';
await a.screenshot({ path: `${OUT}/net_a.png` });
await b.screenshot({ path: `${OUT}/net_b.png` });
await browser.close();
