// SNS のカード画像 (OGP) を作る — 日本語 public/ogp.png / 英語 public/ogp-en.png
//   PORT=5182 node tools/make_ogp.mjs
//
// 1200x630 でゲームを開き、HUD を隠して松江城天守 (PLATEAU LOD3) を見下ろす画をつくり、
// その上にタイトル帯を重ねて撮る。文字はブラウザに描かせるので、
// 日本語も英語もフォントの心配がいらない。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:' + (process.env.PORT ?? '5182') + '/';
/** photo=緯度,経度,注視高さ,距離,方位角 — 松江城天守を南南東から */
const QUERY = process.env.QUERY ?? 'debug=1&wp=2&nofps=1&q=high&photo=35.4752,133.0506,14,110,165';
const OUT = process.env.OUT ?? 'public';
mkdirSync(OUT, { recursive: true });

const CARDS = [
  { file: 'ogp.png', title: 'MATSUE KART', sub: '松江グランプリ', lead: 'PLATEAU の3D都市モデルで走る、実在の松江の街', foot: 'ブラウザで、いますぐ　/　インストール不要　/　最大8人のオンライン対戦' },
  { file: 'ogp-en.png', title: 'MATSUE KART', sub: 'Matsue Grand Prix', lead: 'The real city of Matsue, from MLIT’s Project PLATEAU', foot: 'Play in your browser  /  no install  /  online multiplayer for up to 8' },
];

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log(`[pageerror] ${e.message}`));
await page.goto(BASE + '?' + QUERY, { waitUntil: 'load' });
await page.waitForFunction(() => window.__debug, null, { timeout: 300000 });
await page.waitForTimeout(3000);
// HUD は消す。カード画像は「街の絵 + タイトル」だけにする
await page.evaluate(() => { const h = document.getElementById('hud'); if (h) h.style.display = 'none'; const t = document.getElementById('touch'); if (t) t.style.display = 'none'; });

for (const c of CARDS) {
  await page.evaluate(card => {
    document.getElementById('ogp')?.remove();
    const el = document.createElement('div');
    el.id = 'ogp';
    el.innerHTML = `
      <style>
        #ogp { position: fixed; inset: 0; z-index: 99; pointer-events: none;
               font-family: "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; color: #fff; }
        #ogp .veil { position: absolute; left: 0; right: 0; bottom: 0; height: 74%;
               background: linear-gradient(to top, rgba(11,26,42,.97) 0%, rgba(11,26,42,.9) 34%, rgba(11,26,42,.5) 70%, rgba(11,26,42,0) 100%); }
        #ogp .box { position: absolute; left: 62px; right: 62px; bottom: 54px; }
        #ogp .t { font-size: 88px; font-weight: 900; font-style: italic; letter-spacing: .02em;
               color: #ffd83d; text-shadow: 0 5px 0 #b6201f, 0 10px 24px rgba(0,0,0,.6); line-height: 1; }
        #ogp .s { margin-top: 14px; font-size: 34px; font-weight: 800; letter-spacing: .04em; }
        #ogp .l { margin-top: 10px; font-size: 23px; font-weight: 500; opacity: .92; }
        #ogp .f { margin-top: 18px; font-size: 19px; font-weight: 600; color: #ffd83d;
               border-top: 2px solid rgba(255,216,61,.55); padding-top: 12px; display: inline-block; }
      </style>
      <div class="veil"></div>
      <div class="box">
        <div class="t"></div><div class="s"></div><div class="l"></div><div class="f"></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('.t').textContent = card.title;
    el.querySelector('.s').textContent = card.sub;
    el.querySelector('.l').textContent = card.lead;
    el.querySelector('.f').textContent = card.foot;
  }, c);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${c.file}`, timeout: 180000 });
  console.log(`${OUT}/${c.file}`);
}
await browser.close();
