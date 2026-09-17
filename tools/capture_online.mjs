// SNS 用の素材収録 — オンライン対戦を 2 画面ぶん録る (開発用)
//   PORT=5181 OUT=<dir> node tools/capture_online.mjs
//
// ヘッドレス Chrome でも実 GPU が使えるので (ANGLE/D3D11)、60fps で録れる。
// タイトル → 公開ロビー (カウントダウン) → レースまでを両方の画面で録画し、
// 切り出し用の経過秒を marks.json に書き出す。
//
// 公開ロビーは 2 人そろってから 30 秒のカウントダウンが始まる。2 つ同時に押すと
// それぞれ部屋を作ることがあるが、1 人で待つ側が相手の部屋へ移って合流する。
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = process.env.OUT ?? 'data/shots/capture';
const RACE_SECONDS = Number(process.env.RACE_SECONDS ?? 90);
const BASE = `http://localhost:${process.env.PORT ?? 5182}/`;
const LANG = process.env.LANG_UI ?? 'ja';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'],
});

async function open(label, name) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: path.join(OUT, label), size: { width: 1280, height: 720 } },
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log(`[${label} pageerror] ${e.message}`));
  await page.goto(BASE + `?ai=1&nofps=1&q=high&lang=${LANG}`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('startBtn');
    return b && !b.disabled;
  }, null, { timeout: 300000 });
  await page.fill('#playerName', name);
  const start = Date.now();
  console.log(`${label}: 読み込み完了`);
  return { ctx, page, label, start };
}

// 2 つ同時に読み込む (順番に開くと押す時刻がずれて別の部屋になる)
const [A, B] = await Promise.all([open('host', LANG === 'ja' ? 'ヒロシマ' : 'Hiroshima'), open('guest', LANG === 'ja' ? 'カープ' : 'Carp')]);

const marks = {};
// タイトル画面を見せる時間
marks.titleHost = (Date.now() - A.start) / 1000;
await A.page.waitForTimeout(3500);

await Promise.all([A.page.click('#openBtn'), B.page.click('#openBtn')]);
console.log('公開ロビーに入りました');

for (const p of [A, B]) {
  await p.page.waitForFunction(() => document.querySelectorAll('#playerList li').length >= 2, null, { timeout: 60000 })
    .catch(() => console.log(`${p.label}: ロビーに 2 人そろいませんでした`));
}
// ロビーの中身はタイトル画面の下の方にあり、720px の窓では参加者リストが
// 見切れる。素材として使えるよう、オーバーレイをスクロールして見せる。
for (const p of [A, B]) {
  await p.page.evaluate(() => {
    const o = document.getElementById('overlay');
    if (o) o.scrollTop = o.scrollHeight;
  });
}
await A.page.waitForTimeout(600);
marks.lobbyHost = (Date.now() - A.start) / 1000;
marks.lobbyGuest = (Date.now() - B.start) / 1000;
const left = await A.page.evaluate(() => document.getElementById('countNum')?.textContent);
console.log(`ロビーに 2 人そろいました (発走まで ${left} 秒)`);

// カウントダウンで自動発走するのを待つ
await A.page.waitForFunction(() => window.__net && window.__net().started, null, { timeout: 60000 });
const started = Date.now();
marks.goHost = (started - A.start) / 1000;
marks.goGuest = (started - B.start) / 1000;
console.log('発走');
await A.page.waitForTimeout(RACE_SECONDS * 1000);

marks.raceSeconds = RACE_SECONDS;
marks.room = await A.page.evaluate(() => window.__net?.().code);
writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify(marks, null, 2));
console.log(JSON.stringify(marks));

for (const p of [A, B]) {
  const v = p.page.video();
  await p.ctx.close();
  console.log(`${p.label}: ${await v.path()}`);
}
await browser.close();
