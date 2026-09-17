// 松江城天守 (PLATEAU 建築物 LOD3, テクスチャ付き) → ゲーム用データ
//   入力: data/citygml/53331074_bldg.gml の「松江城」
//   出力: public/data/castle.bin   頂点座標 (Float32 x3) + UV (Float32 x2) + 色 (Float32 x3)
//         public/data/castle.json  描画グループ (テクスチャごと + 単色)
//         public/data/castle/*.jpg テクスチャ (PLATEAU の appearance をそのまま)
//
// LOD3 は壁・屋根・破風・窓・扉を面ごとに持つ (約 4.3 万面)。テクスチャは部位ごとの
// 6 枚で、それ以外の面は X3DMaterial の単色。単色の面は頂点色にまとめて 1 回で描く。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { triangulate } from './triangulate.mjs';

const SRC = 'data/citygml/53331074_bldg.gml';
const TEX_BASE = 'https://assets.cms.plateau.reearth.io/assets/7c/606e42-b9e0-410b-8c0b-b64731336e05/32201_matsue-shi_city_2024_citygml_1_op/udx/bldg';

const course = JSON.parse(readFileSync('data/course.json', 'utf8'));
const lat0 = course.origin.lat, lon0 = course.origin.lon;
const mPerLat = 110950, mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const toXZ = (lat, lon) => [(lon - lon0) * mPerLon, -(lat - lat0) * mPerLat];

const text = readFileSync(SRC, 'utf8');
const nameAt = text.indexOf('<gml:name>松江城</gml:name>');
if (nameAt < 0) throw new Error('松江城が見つかりません');
const bStart = text.lastIndexOf('<bldg:Building ', nameAt);
const bEnd = text.indexOf('</bldg:Building>', nameAt);
const blk = text.slice(bStart, bEnd);
console.log(`松江城: ${(blk.length / 1e6).toFixed(1)}MB`);

// ---- LOD3 の面 ----
const polys = new Map(); // id -> [[x,y,z]...]
for (const m of blk.matchAll(/<bldg:lod3(?:MultiSurface|Geometry)>([\s\S]*?)<\/bldg:lod3(?:MultiSurface|Geometry)>/g)) {
  for (const p of m[1].matchAll(/<gml:Polygon gml:id="([^"]+)">[\s\S]*?<gml:posList>([^<]*)<\/gml:posList>/g)) {
    const v = p[2].trim().split(/\s+/).map(Number);
    const pos = [];
    for (let k = 0; k + 2 < v.length; k += 3) { const [x, z] = toXZ(v[k], v[k + 1]); pos.push([x, v[k + 2], z]); }
    const f = pos[0], l = pos[pos.length - 1];
    if (pos.length > 1 && f[0] === l[0] && f[1] === l[1] && f[2] === l[2]) pos.pop();
    polys.set(p[1], pos);
  }
}
console.log(`LOD3 の面 ${polys.size}`);

// ---- 見た目 (appearance はファイル末尾にまとめて入っている) ----
const app = text.slice(text.indexOf('<app:Appearance'), text.indexOf('</app:Appearance>'));
const texOf = new Map();   // polyId -> { img, uv }
const colorOf = new Map(); // polyId -> [r,g,b]
for (const m of app.matchAll(/<app:ParameterizedTexture>([\s\S]*?)<\/app:ParameterizedTexture>/g)) {
  const img = /<app:imageURI>([^<]*)<\/app:imageURI>/.exec(m[1])?.[1].trim();
  if (!img) continue;
  for (const t of m[1].matchAll(/<app:target uri="#([^"]+)">([\s\S]*?)<\/app:target>/g)) {
    if (!polys.has(t[1])) continue;
    const tc = /<app:textureCoordinates[^>]*>([^<]*)</.exec(t[2]);
    if (!tc) continue;
    const v = tc[1].trim().split(/\s+/).map(Number);
    const uv = [];
    for (let k = 0; k + 1 < v.length; k += 2) uv.push([v[k], v[k + 1]]);
    texOf.set(t[1], { img, uv });
  }
}
for (const m of app.matchAll(/<app:X3DMaterial>([\s\S]*?)<\/app:X3DMaterial>/g)) {
  const dc = /<app:diffuseColor>([^<]*)</.exec(m[1]);
  if (!dc) continue;
  const rgb = dc[1].trim().split(/\s+/).map(Number);
  for (const t of m[1].matchAll(/<app:target>#([^<]+)<\/app:target>/g)) if (polys.has(t[1])) colorOf.set(t[1], rgb);
}
console.log(`テクスチャ面 ${texOf.size} / 単色面 ${colorOf.size}`);

// ---- 三角形 ----
const images = [...new Set([...texOf.values()].map(t => t.img))].sort();
const buckets = new Map(images.map(img => [img, { pos: [], uv: [], col: [] }]));
const flat = { pos: [], uv: [], col: [] };
let yMin = Infinity, yMax = -Infinity, cx = 0, cz = 0, cn = 0, untextured = 0;
for (const [id, pos] of polys) {
  const t = texOf.get(id);
  const rgb = colorOf.get(id);
  if (!t && !rgb) untextured++;
  const b = t ? buckets.get(t.img) : flat;
  const uv = t ? t.uv.slice(0, pos.length) : null;
  if (t && uv.length !== pos.length) continue;
  const c = rgb ?? [0.55, 0.55, 0.55];
  for (const [ia, ib, ic] of triangulate(pos)) {
    for (const i of [ia, ib, ic]) {
      const p = pos[i];
      b.pos.push(p[0], p[1], p[2]);
      // CityGML の v は画像下端が 0。テクスチャは flipY=false で読むので上下を反転する
      if (uv) b.uv.push(uv[i][0], 1 - uv[i][1]); else b.uv.push(0, 0);
      b.col.push(c[0], c[1], c[2]);
      yMin = Math.min(yMin, p[1]); yMax = Math.max(yMax, p[1]);
      cx += p[0]; cz += p[2]; cn++;
    }
  }
}
if (untextured) console.log(`見た目の指定が無い面 ${untextured} (灰色で描きます)`);

const groups = [];
const parts = [...images.map(img => ({ img, b: buckets.get(img) })), { img: null, b: flat }];
let offset = 0;
for (const { img, b } of parts) {
  const count = b.pos.length / 3;
  if (!count) continue;
  groups.push({ texture: img ? `castle/${img.split('/').pop()}` : null, start: offset, count });
  offset += count;
}
const pos = new Float32Array(offset * 3), uv = new Float32Array(offset * 2), col = new Float32Array(offset * 3);
{
  let o = 0;
  for (const { b } of parts) {
    pos.set(b.pos, o * 3); uv.set(b.uv, o * 2); col.set(b.col, o * 3);
    o += b.pos.length / 3;
  }
}
mkdirSync('public/data/castle', { recursive: true });
writeFileSync('public/data/castle.bin', Buffer.concat([Buffer.from(pos.buffer), Buffer.from(uv.buffer), Buffer.from(col.buffer)]));
writeFileSync('public/data/castle.json', JSON.stringify({
  vertexCount: offset,
  center: [cx / cn, cz / cn],
  yMin, yMax,
  groups,
}));
console.log(`三角形 ${offset / 3} / 標高 ${yMin.toFixed(1)}-${yMax.toFixed(1)}m / castle.bin ${((pos.byteLength + uv.byteLength + col.byteLength) / 1e6).toFixed(1)}MB`);

// ---- テクスチャ ----
for (const img of images) {
  const dest = `public/data/castle/${img.split('/').pop()}`;
  if (existsSync(dest)) continue;
  const res = await fetch(`${TEX_BASE}/${img}`);
  if (!res.ok) { console.log(`テクスチャを取得できません ${img} (${res.status})`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  console.log(`${dest} ${(buf.length / 1e6).toFixed(2)}MB`);
}

// ---- 大きいテクスチャの縮小 ----
// 屋根と壁は 4096px (計 8MB) ある。走りながら見るには 2048px で足りるので縮める。
// 元の画像は data/castle_tex_orig/ に退避しておく。
const MAX_TEX = 2048;
const { chromium } = await import('playwright');
const jpegSize = buf => {
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xc2) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return [0, 0];
};
let browser = null;
for (const img of images) {
  const dest = `public/data/castle/${img.split('/').pop()}`;
  if (!existsSync(dest)) continue;
  const buf = readFileSync(dest);
  const [w, h] = jpegSize(buf);
  if (Math.max(w, h) <= MAX_TEX) continue;
  mkdirSync('data/castle_tex_orig', { recursive: true });
  writeFileSync(`data/castle_tex_orig/${img.split('/').pop()}`, buf);
  browser ??= await chromium.launch();
  const page = await browser.newPage();
  const out = await page.evaluate(async ({ src, size }) => {
    const im = new Image();
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = src; });
    const s = size / Math.max(im.naturalWidth, im.naturalHeight);
    const cv = document.createElement('canvas');
    cv.width = Math.round(im.naturalWidth * s); cv.height = Math.round(im.naturalHeight * s);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.86);
  }, { src: `data:image/jpeg;base64,${buf.toString('base64')}`, size: MAX_TEX });
  await page.close();
  const small = Buffer.from(out.split(',')[1], 'base64');
  writeFileSync(dest, small);
  console.log(`${dest}: ${w}px → ${MAX_TEX}px (${(buf.length / 1e6).toFixed(2)} → ${(small.length / 1e6).toFixed(2)}MB)`);
}
await browser?.close();
