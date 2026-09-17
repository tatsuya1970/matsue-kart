// 画面上の点が LOD2 アトラスのどこを参照しているかを調べる (開発用)
//   node tools/probe_uv.mjs "debug=1&wp=7&cam=0" -0.55,0.32 -0.15,0.33
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const query = process.argv[2] ?? 'debug=1&wp=7&cam=0';
const pts = process.argv.slice(3).map(s => s.split(',').map(Number));
const plan = JSON.parse(readFileSync('data/lod2_images.json', 'utf8'));

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5182/?' + query, { waitUntil: 'load' });
await page.waitForFunction(() => (window).__debug, null, { timeout: 240000 });
await page.waitForTimeout(2500);

const out = await page.evaluate((pts) => {
  const d = (window).__debug;
  const T = d.THREE;
  const rc = new T.Raycaster();
  const res = [];
  for (const [px, py] of pts) {
    rc.setFromCamera(new T.Vector2(px, py), d.camera);
    const hits = rc.intersectObjects(d.scene.children, true);
    const h = hits[0];
    if (!h) { res.push({ px, py, none: true }); continue; }
    const mat = h.object.material;
    const src = mat && mat.map && mat.map.image ? (mat.map.image.currentSrc || mat.map.image.src || '') : '';
    let sample = null;
    if (mat && mat.map && mat.map.image && h.uv) {
      const im = mat.map.image;
      const w = im.naturalWidth || im.width, ht = im.naturalHeight || im.height;
      const cv = document.createElement('canvas');
      cv.width = 8; cv.height = 8;
      const c = cv.getContext('2d');
      const sx = Math.min(w - 8, Math.max(0, Math.round(h.uv.x * w) - 4));
      const sy = Math.min(ht - 8, Math.max(0, Math.round(h.uv.y * ht) - 4));
      c.drawImage(im, sx, sy, 8, 8, 0, 0, 8, 8);
      const p = c.getImageData(0, 0, 8, 8).data;
      sample = { rgb: [p[0], p[1], p[2]], sx, sy, w, ht };
    }
    res.push({
      px, py, dist: +h.distance.toFixed(1), point: [h.point.x, h.point.y, h.point.z].map(v => +v.toFixed(1)),
      uv: h.uv ? [+h.uv.x.toFixed(5), +h.uv.y.toFixed(5)] : null,
      matType: mat?.type, src: src.split('/').pop(), sample,
    });
  }
  return res;
}, pts.length ? pts : [[-0.55, 0.32], [-0.15, 0.33]]);

const { atlasSize: S, cell: CELL } = plan;
for (const r of out) {
  if (r.none) { console.log(`screen(${r.px},${r.py}) hit nothing`); continue; }
  let tile = '';
  if (r.uv) {
    const tx = Math.floor(r.uv[0] * S / CELL) * CELL, ty = Math.floor(r.uv[1] * S / CELL) * CELL;
    const m = plan.images.find(e => e.px === tx && e.py === ty && `lod2_atlas_${e.atlas}.jpg` === r.src);
    tile = ` tile=(${tx},${ty}) img=${m ? m.img.split('/').pop() : '(該当なし)'}`;
  }
  console.log(`screen(${r.px},${r.py}) d=${r.dist} ${r.matType} src=${r.src} uv=${JSON.stringify(r.uv)} rgb=${r.sample ? r.sample.rgb.join(',') : '-'} atlasPx=${r.sample ? r.sample.sx + ',' + r.sample.sy : '-'}${tile}`);
}
await browser.close();
