// PLATEAU CityGML (松江市 2024) → ゲーム用データ変換
//   bldg (LOD1 Solid) → public/data/buildings.json
//   tran (LOD1 道路面) → public/data/roads.json
//   dem  (LOD1 TIN)   → public/data/terrain.json + terrain.bin (Int16, 単位dm, 水面 = -32768)
import { readFileSync, writeFileSync, createReadStream, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const course = JSON.parse(readFileSync('data/course.json', 'utf8'));
const lat0 = course.origin.lat, lon0 = course.origin.lon;
const mPerLat = 110950;
const mPerLon = 111320 * Math.cos(lat0 * Math.PI / 180);

// 出力範囲 (コース + 余白)。北端は塩見縄手の先、西端は松江しんじ湖温泉の先まで。
const BB = { latMin: 35.4470, latMax: 35.4860, lonMin: 133.0330, lonMax: 133.0715 };

// LOD2 (実写テクスチャ) で描画する建物は LOD1 では出さない
let lod2Skip = new Set();
try {
  const l2 = JSON.parse(readFileSync('public/data/lod2.json', 'utf8'));
  lod2Skip = new Set(l2.skipIds ?? []);
  console.log(`LOD2 で描画する ${lod2Skip.size} 棟を LOD1 から除外`);
} catch { console.log('lod2.json が無いため LOD1 のみで出力'); }
const toXZ = (lat, lon) => [(lon - lon0) * mPerLon, -(lat - lat0) * mPerLat];
const inBB = (lat, lon) => lat >= BB.latMin && lat <= BB.latMax && lon >= BB.lonMin && lon <= BB.lonMax;
const r1 = v => Math.round(v * 10) / 10;

// ランドマークは専用の詳細モデルを置くため、PLATEAU 側の同じ建物は除外する
const landmarks = JSON.parse(readFileSync('data/rail.json', 'utf8')).landmarks;
const LANDMARK_ZONES = Object.values(landmarks).map(l => {
  const [x, z] = toXZ(l.lat, l.lon);
  return { name: l.name, x, z, r: l.excludeRadius ?? 25 };
});
let domeSkipped = 0;

const DIR = 'data/citygml';
const files = readdirSync(DIR);
const POSLIST = /<gml:posList>([^<]*)<\/gml:posList>/g;

// ---------- 建築物 ----------
function parseBuildings(text) {
  const out = [];
  let idx = 0;
  while (true) {
    const s = text.indexOf('<bldg:Building ', idx);
    if (s < 0) break;
    const e = text.indexOf('</bldg:Building>', s);
    if (e < 0) break;
    idx = e + 16;
    const blk = text.slice(s, e);
    const gid = /gml:id="([^"]+)"/.exec(blk);
    if (gid && lod2Skip.has(gid[1])) continue;
    const mh = /<bldg:measuredHeight[^>]*>([\d.]+)</.exec(blk);
    const us = /<bldg:usage[^>]*>(\d+)</.exec(blk);
    const ls = blk.indexOf('<bldg:lod1Solid>');
    if (ls < 0) continue;
    const le = blk.indexOf('</bldg:lod1Solid>', ls);
    const solid = blk.slice(ls, le);
    const re = new RegExp(POSLIST.source, 'g');
    let m, zMin = Infinity, zMax = -Infinity, base = null, baseZ = Infinity;
    while ((m = re.exec(solid))) {
      const v = m[1].trim().split(/\s+/).map(Number);
      let pzMin = Infinity, pzMax = -Infinity;
      for (let i = 2; i < v.length; i += 3) { if (v[i] < pzMin) pzMin = v[i]; if (v[i] > pzMax) pzMax = v[i]; }
      if (pzMin < zMin) zMin = pzMin;
      if (pzMax > zMax) zMax = pzMax;
      // 水平な面 (底面 or 天井面) のうち最も低いものを底面とみなす
      if (Math.abs(pzMax - pzMin) < 1e-6 && pzMin < baseZ) { baseZ = pzMin; base = v; }
    }
    if (!base) continue;
    let h = zMax - zMin;
    if (!(h > 0.5) && mh) h = parseFloat(mh[1]);
    if (!(h > 0.5)) h = 3;
    // 重心で範囲判定
    let cla = 0, clo = 0;
    const n = base.length / 3 - 1;
    for (let i = 0; i < n; i++) { cla += base[i * 3]; clo += base[i * 3 + 1]; }
    cla /= n; clo /= n;
    if (!inBB(cla, clo)) continue;
    {
      const [bx, bz] = toXZ(cla, clo);
      let inLandmark = false;
      for (const L of LANDMARK_ZONES) if (Math.hypot(bx - L.x, bz - L.z) < L.r) { inLandmark = true; break; }
      if (inLandmark) { domeSkipped++; continue; }
    }
    const ring = [];
    for (let i = 0; i < n; i++) { const [x, z] = toXZ(base[i * 3], base[i * 3 + 1]); ring.push(r1(x), r1(z)); }
    if (ring.length < 6) continue;
    out.push([r1(h), r1(baseZ), us ? parseInt(us[1]) : 0, ...ring]);
  }
  return out;
}

const buildings = [];
const ONLY_TERRAIN = !!process.env.ONLY_TERRAIN; // 地形だけ作り直す
for (const f of ONLY_TERRAIN ? [] : files.filter(f => f.endsWith('_bldg.gml'))) {
  const t = readFileSync(path.join(DIR, f), 'utf8');
  const b = parseBuildings(t);
  buildings.push(...b);
  console.log('bldg ' + f + ': ' + b.length);
}
if (!ONLY_TERRAIN) writeFileSync('public/data/buildings.json', JSON.stringify({ origin: course.origin, count: buildings.length, items: buildings }));
console.log('buildings total', buildings.length, `(ランドマーク位置で除外 ${domeSkipped} 棟)`);

// ---------- 道路 ----------
const roads = [];
for (const f of ONLY_TERRAIN ? [] : files.filter(f => f.endsWith('_tran.gml'))) {
  const t = readFileSync(path.join(DIR, f), 'utf8');
  let idx = 0, c = 0;
  while (true) {
    const s = t.indexOf('<tran:Road ', idx); if (s < 0) break;
    const e = t.indexOf('</tran:Road>', s); if (e < 0) break;
    idx = e + 12;
    const blk = t.slice(s, e);
    const fn = /<tran:function[^>]*>(\d+)</.exec(blk);
    const ls = blk.indexOf('<tran:lod1MultiSurface>'); if (ls < 0) continue;
    const solid = blk.slice(ls, blk.indexOf('</tran:lod1MultiSurface>', ls));
    const re = new RegExp(POSLIST.source, 'g');
    let m;
    while ((m = re.exec(solid))) {
      const v = m[1].trim().split(/\s+/).map(Number);
      const n = v.length / 3 - 1;
      let cla = 0, clo = 0;
      for (let i = 0; i < n; i++) { cla += v[i * 3]; clo += v[i * 3 + 1]; }
      cla /= n; clo /= n;
      if (!inBB(cla, clo)) continue;
      const ring = [];
      for (let i = 0; i < n; i++) { const [x, z] = toXZ(v[i * 3], v[i * 3 + 1]); ring.push(r1(x), r1(z)); }
      roads.push([fn ? parseInt(fn[1]) : 0, ...ring]);
      c++;
    }
  }
  console.log('tran ' + f + ': ' + c);
}
if (!ONLY_TERRAIN) writeFileSync('public/data/roads.json', JSON.stringify({ items: roads }));
console.log('roads total', roads.length);

// ---------- 地形 (DEM) ----------
const CELL = 5;
const [xMin, zMax] = toXZ(BB.latMin, BB.lonMin);
const [xMax, zMin] = toXZ(BB.latMax, BB.lonMax);
const W = Math.ceil((xMax - xMin) / CELL) + 1, H = Math.ceil((zMax - zMin) / CELL) + 1;
const hsum = new Float32Array(W * H), hcnt = new Uint16Array(W * H);
console.log('terrain grid', W, H);

// DEM は 2 次メッシュを 4 分割したファイルに分かれている (00 / 05 / 50 / 55)。
// 合計 3GB あって読むのに数分かかるので、格子に落とした結果を data/dem_grid.bin に残し、
// 範囲が同じなら次回からはそれを使う (水面判定だけ調整し直すとき用)。
const demFiles = files.filter(f => /_dem_\d\d\.gml$/.test(f)).map(f => path.join(DIR, f));
const CACHE = 'data/dem_grid.bin';
const cacheKey = `${W}x${H}@${xMin.toFixed(2)},${zMin.toFixed(2)}`;
let cached = false;
if (existsSync(CACHE) && existsSync(CACHE + '.key') && readFileSync(CACHE + '.key', 'utf8') === cacheKey) {
  const b = readFileSync(CACHE);
  hsum.set(new Float32Array(b.buffer, b.byteOffset, W * H));
  hcnt.set(new Uint16Array(b.buffer.slice(b.byteOffset + W * H * 4, b.byteOffset + W * H * 6)));
  cached = true;
  console.log('DEM はキャッシュを使います', CACHE);
}
let tri = 0;
for (const demFile of cached ? [] : demFiles) {
console.log('dem', demFile);
let rest = '';
await new Promise((res, rej) => {
  const s = createReadStream(demFile, { encoding: 'utf8', highWaterMark: 1 << 22 });
  s.on('data', chunk => {
    let buf = rest + chunk;
    const last = buf.lastIndexOf('</gml:posList>');
    if (last < 0) { rest = buf; return; }
    rest = buf.slice(last + 14); buf = buf.slice(0, last + 14);
    const re = new RegExp(POSLIST.source, 'g');
    let m;
    while ((m = re.exec(buf))) {
      const v = m[1].trim().split(/\s+/).map(Number);
      if (v.length < 9) continue;
      const [ax, az] = toXZ(v[0], v[1]), [bx, bz] = toXZ(v[3], v[4]), [cx, cz] = toXZ(v[6], v[7]);
      const ay = v[2], by = v[5], cy = v[8];
      const txMin = Math.min(ax, bx, cx), txMax = Math.max(ax, bx, cx);
      const tzMin = Math.min(az, bz, cz), tzMax = Math.max(az, bz, cz);
      if (txMax < xMin || txMin > xMax || tzMax < zMin || tzMin > zMax) continue;
      tri++;
      const i0 = Math.max(0, Math.floor((txMin - xMin) / CELL)), i1 = Math.min(W - 1, Math.ceil((txMax - xMin) / CELL));
      const j0 = Math.max(0, Math.floor((tzMin - zMin) / CELL)), j1 = Math.min(H - 1, Math.ceil((tzMax - zMin) / CELL));
      const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      if (Math.abs(det) < 1e-9) continue;
      for (let j = j0; j <= j1; j++) {
        const pz = zMin + j * CELL;
        for (let i = i0; i <= i1; i++) {
          const px = xMin + i * CELL;
          const l1 = ((bx - px) * (cz - pz) - (cx - px) * (bz - pz)) / det;
          const l2 = ((cx - px) * (az - pz) - (ax - px) * (cz - pz)) / det;
          const l3 = 1 - l1 - l2;
          const eps = -0.02;
          if (l1 < eps || l2 < eps || l3 < eps) continue;
          hsum[j * W + i] += l1 * ay + l2 * by + l3 * cy;
          hcnt[j * W + i]++;
        }
      }
    }
  });
  s.on('end', res);
  s.on('error', rej);
});
}
if (!cached) {
  writeFileSync(CACHE, Buffer.concat([Buffer.from(hsum.buffer), Buffer.from(hcnt.buffer)]));
  writeFileSync(CACHE + '.key', cacheKey);
  console.log('dem triangles used', tri);
}

// 水面判定 (松江): 宍道湖は DEM が欠測、大橋川・堀川の水面は標高 0m 前後で入っている。
// 一方で湖の北岸の水田は 0.9-1.1m、市街地も 1.4m 程度と低いので、広島のように
// 「1m 未満で水面に連結していれば水面」とすると水田と街が水没する。
//   DEM 欠測 or 標高 0.3m 未満 → 水面
//   標高 0.3-0.6m → 水面から 2 セル (10m) 以内に限り水面 (護岸の縁)
const raw = new Float32Array(W * H);
const isWater = new Uint8Array(W * H); // 1 = 確定, 3 = 候補(縁)
for (let k = 0; k < W * H; k++) {
  if (hcnt[k] === 0) { isWater[k] = 1; raw[k] = 0; continue; }
  const h = hsum[k] / hcnt[k];
  raw[k] = h;
  if (h < 0.3) isWater[k] = 1; else if (h < 0.6) isWater[k] = 3;
}
const budget = new Uint8Array(W * H);
const stack = [];
for (let k = 0; k < W * H; k++) if (isWater[k] === 1) { budget[k] = 3; stack.push(k); }
while (stack.length) {
  const k = stack.pop();
  const i = k % W, j = (k - i) / W;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const ii = i + di, jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
    const kk = jj * W + ii;
    if (isWater[kk] === 3 && budget[k] > 1) { isWater[kk] = 1; budget[kk] = budget[k] - 1; stack.push(kk); }
  }
}
const heights = new Int16Array(W * H);
let water = 0;
for (let k = 0; k < W * H; k++) {
  if (isWater[k] === 1) { heights[k] = -32768; water++; continue; }
  heights[k] = Math.round(raw[k] * 10);
}
// 孤立した水セル/陸セルのノイズ除去 (3x3多数決)
const cleaned = new Int16Array(heights);
for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
  let w = 0, sum = 0, n = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const v = heights[(j + dj) * W + i + di];
    if (v === -32768) w++; else { sum += v; n++; }
  }
  const k = j * W + i;
  if (heights[k] === -32768 && w <= 2) cleaned[k] = Math.round(sum / n);
  else if (heights[k] !== -32768 && w >= 7) cleaned[k] = -32768;
}
// 宍道湖の中に残る浅瀬 (DEM に 0.3-1.5m の細長い帯として入っている) は水面へ戻す。
// 周囲をすべて水に囲まれた小さな陸のうち、最高点が 1.5m 未満のものが対象。
// 嫁ヶ島は松の生えた島で 1.5m より高いので残る。
{
  const seen = new Uint8Array(W * H);
  let removed = 0;
  for (let k0 = 0; k0 < W * H; k0++) {
    if (seen[k0] || cleaned[k0] === -32768) continue;
    const comp = [k0];
    seen[k0] = 1;
    let top = -Infinity, touchesEdge = false;
    for (let q = 0; q < comp.length; q++) {
      const k = comp[q], i = k % W, j = (k - i) / W;
      top = Math.max(top, cleaned[k]);
      if (i === 0 || j === 0 || i === W - 1 || j === H - 1) touchesEdge = true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
        const kk = jj * W + ii;
        if (seen[kk] || cleaned[kk] === -32768) continue;
        seen[kk] = 1;
        comp.push(kk);
      }
    }
    if (comp.length > 4000 || touchesEdge || top >= 15) continue;
    for (const k of comp) cleaned[k] = -32768;
    removed += comp.length;
  }
  console.log(`湖の浅瀬を水面に戻したセル ${removed}`);
}
writeFileSync('public/data/terrain.bin', Buffer.from(cleaned.buffer));
writeFileSync('public/data/terrain.json', JSON.stringify({ w: W, h: H, cell: CELL, x0: xMin, z0: zMin, water: -32768, scale: 0.1 }));
console.log('terrain written, water cells', water, 'of', W * H);
