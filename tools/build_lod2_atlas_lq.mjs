// 既存の 4096px アトラスから低画質版 (既定 2048px) を作る。
//
// UV はアトラス内の正規化座標 (0..1) なので、画像を縮小しても lod2.bin 側は
// 変更不要。PLATEAU の元データ (data/citygml, data/lod2tex) も要らない。
//
//   node tools/build_lod2_atlas_lq.mjs [--size 2048] [--quality 0.82]
//
// 出力: public/data/lod2_atlas_N_2k.jpg
//
// build_lod2_atlas.mjs と同じく Playwright の Chromium を canvas として使う。
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : def;
};
const SIZE = arg('size', 2048);
const QUALITY = arg('quality', 0.82);

const DATA = path.resolve('public/data');
const meta = JSON.parse(readFileSync(path.join(DATA, 'lod2.json'), 'utf8'));
if (meta.atlasSize <= SIZE) {
  console.error(`元アトラスが ${meta.atlasSize}px なので ${SIZE}px への縮小は不要です`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });
await page.setContent('<canvas id="c"></canvas>');

let totalIn = 0, totalOut = 0;
for (const name of meta.atlases) {
  const src = path.join(DATA, name);
  if (!existsSync(src)) { console.error(`見つかりません: ${src}`); process.exit(1); }
  const out = path.join(DATA, name.replace(/\.jpg$/, `_${SIZE / 1024}k.jpg`));

  const b64 = readFileSync(src).toString('base64');
  const dataUrl = await page.evaluate(async ({ b64, SIZE, QUALITY }) => {
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('decode failed'));
      i.src = `data:image/jpeg;base64,${b64}`;
    });
    const cv = document.createElement('canvas');
    cv.width = SIZE; cv.height = SIZE;
    const ctx = cv.getContext('2d');
    // 高品質な縮小 (タイル境界の滲みを抑える)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, 0, 0, SIZE, SIZE);
    return cv.toDataURL('image/jpeg', QUALITY);
  }, { b64, SIZE, QUALITY });

  writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  const inSz = statSync(src).size, outSz = statSync(out).size;
  totalIn += inSz; totalOut += outSz;
  const mb = n => (n / 1048576).toFixed(2);
  console.log(`${name} ${mb(inSz)}MB -> ${path.basename(out)} ${mb(outSz)}MB`);
}

await browser.close();

const mb = n => (n / 1048576).toFixed(1);
const vram = s => (meta.atlases.length * s * s * 4 * 1.33 / 1048576).toFixed(0);
console.log(`\n転送量 ${mb(totalIn)}MB -> ${mb(totalOut)}MB`);
console.log(`VRAM (ミップ込み概算) ${vram(meta.atlasSize)}MB -> ${vram(SIZE)}MB`);
