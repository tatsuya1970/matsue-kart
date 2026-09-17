// ダウンロードした LOD2 テクスチャを 4096px のアトラスへ敷き詰める。
// Playwright の Chromium を canvas として使うので追加の画像ライブラリは不要。
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const plan = JSON.parse(readFileSync('data/lod2_images.json', 'utf8'));
const { atlasSize: S, cell: CELL, pad: PAD, img: IMG, perAtlas, perRow } = plan;
const TEXDIR = path.resolve('data/lod2tex');
const atlasCount = Math.ceil(plan.images.length / perAtlas);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 200 } });
page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });
await page.setContent('<canvas id="c"></canvas>');

for (let a = 0; a < atlasCount; a++) {
  const tiles = plan.images.filter(e => e.atlas === a).map(e => {
    const file = path.join(TEXDIR, e.img.replace(/[\/\\]/g, '__'));
    if (!existsSync(file)) return null;
    const b64 = readFileSync(file).toString('base64');
    return { px: e.px, py: e.py, data: `data:image/jpeg;base64,${b64}` };
  }).filter(Boolean);

  const res = await page.evaluate(async ({ S, CELL, PAD, IMG, tiles }) => {
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#8a8578';
    ctx.fillRect(0, 0, S, S);
    // タイル 1 枚を整える作業用キャンバス
    const scratch = document.createElement('canvas');
    scratch.width = IMG; scratch.height = IMG;
    const sctx = scratch.getContext('2d', { willReadFrequently: true });
    const load = src => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
    let patched = 0;

    for (const t of tiles) {
      const im = await load(t.data);
      if (!im) continue;
      sctx.clearRect(0, 0, IMG, IMG);
      sctx.drawImage(im, 0, 0, im.naturalWidth, im.naturalHeight, 0, 0, IMG, IMG);
      // PLATEAU の LOD2 テクスチャには、航空写真が届かなかった壁面が「単色のベタ塗り」で
      // 入っている (背景の灰色と、面ごとのほぼ黒の 2 種類がある)。写真には同一 RGB が
      // ここまで集中しないため、完全一致の色が広い面積を占めるものを合成壁面へ差し替える。
      const id = sctx.getImageData(0, 0, IMG, IMG);
      const px = id.data, total = IMG * IMG;
      const hist = new Map();
      for (let i = 0; i < px.length; i += 4) {
        const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
        hist.set(key, (hist.get(key) ?? 0) + 1);
      }
      const fills = [];
      for (const [k, c] of hist) {
        if (c < total * 0.006) continue;
        const r = (k >> 16) & 255, g = (k >> 8) & 255, b = k & 255;
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        if (lum < 190 && chroma < 45) fills.push({ r, g, b, lum });
      }
      let didPatch = false;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        let hit = null;
        for (const f of fills) {
          if (Math.abs(r - f.r) <= 9 && Math.abs(g - f.g) <= 9 && Math.abs(b - f.b) <= 9) { hit = f; break; }
        }
        if (hit) {
          const p = i / 4, ix = p % IMG, iy = (p / IMG) | 0;
          // 暗いベタ塗りは少し暗いコンクリートにして、面ごとの違いを残す
          let base = (hit.lum < 90 ? 118 : 140) + ((ix * 7 + iy * 13) % 11) - 5;
          if (iy % 14 === 0) base -= 15;   // 階の水平線
          if (iy % 14 === 1) base += 5;
          if (ix % 22 === 0) base -= 6;    // 縦の目地
          px[i] = base; px[i + 1] = base - 2; px[i + 2] = base - 8;
          didPatch = true;
        }
      }
      // 影の持ち上げ: 真っ黒に落ちた画素をなくし、暗部の階調を残す
      for (let i = 0; i < px.length; i += 4) {
        for (let k = 0; k < 3; k++) {
          const v = px[i + k] / 255;
          px[i + k] = Math.min(255, 46 + (255 - 46) * Math.pow(v, 0.88));
        }
      }
      sctx.putImageData(id, 0, 0);
      if (didPatch) patched++;
      const x = t.px + PAD, y = t.py + PAD;
      // 本体
      ctx.drawImage(scratch, 0, 0, IMG, IMG, x, y, IMG, IMG);
      // 縁を複製してミップマップのにじみを防ぐ
      ctx.drawImage(scratch, 0, 0, 1, IMG, x - PAD, y, PAD, IMG);
      ctx.drawImage(scratch, IMG - 1, 0, 1, IMG, x + IMG, y, PAD, IMG);
      ctx.drawImage(scratch, 0, 0, IMG, 1, x, y - PAD, IMG, PAD);
      ctx.drawImage(scratch, 0, IMG - 1, IMG, 1, x, y + IMG, IMG, PAD);
      ctx.drawImage(scratch, 0, 0, 1, 1, x - PAD, y - PAD, PAD, PAD);
      ctx.drawImage(scratch, IMG - 1, 0, 1, 1, x + IMG, y - PAD, PAD, PAD);
      ctx.drawImage(scratch, 0, IMG - 1, 1, 1, x - PAD, y + IMG, PAD, PAD);
      ctx.drawImage(scratch, IMG - 1, IMG - 1, 1, 1, x + IMG, y + IMG, PAD, PAD);
    }
    return { url: cv.toDataURL('image/jpeg', 0.88), patched };
  }, { S, CELL, PAD, IMG, tiles });
  const dataUrl = res.url;

  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  const out = `public/data/lod2_atlas_${a}.jpg`;
  writeFileSync(out, buf);
  console.log(`${out} tiles=${tiles.length} ベタ塗り補正=${res.patched} ${(buf.length / 1e6).toFixed(2)}MB`);
}
await browser.close();
