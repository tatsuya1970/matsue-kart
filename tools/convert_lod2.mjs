// PLATEAU 建築物 LOD2 (実写テクスチャ付き) → ゲーム用データ変換
//   入力: data/citygml/*_bldg.gml (app:Appearance に ParameterizedTexture を含むもの)
//   出力: public/data/lod2.bin   三角形の頂点座標 (Float32) + アトラスUV (Float32)
//         public/data/lod2.json  アトラス構成・描画グループ・LOD1で除外する建物ID
//         data/lod2_images.json  ダウンロードすべきテクスチャ画像とアトラス配置
//
// テクスチャは 1 棟 1 枚 (512x512 程度)。そのまま読むと数千枚になるため、
// ATLAS_SIZE のアトラスに CELL 間隔で敷き詰め、UV をアトラス座標へ変換する。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { triangulate } from './triangulate.mjs';

const course = JSON.parse(readFileSync('data/course.json', 'utf8'));
const lat0 = course.origin.lat, lon0 = course.origin.lon;
const mPerLat = 110950;
const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const toXZ = (lat, lon) => [(lon - lon0) * mPerLon, -(lat - lat0) * mPerLat];

// コース中心線からこの距離以内の LOD2 建物だけを採用する
const CORRIDOR = Number(process.env.LOD2_CORRIDOR ?? 150);
// アトラス設定
// 松江は小さな建物が多く枚数が広島の 4 倍あるので、1 タイルを 128px (実画像 112px) にする
const ATLAS = 4096, CELL = 128, PAD = 8, IMG = CELL - PAD * 2; // 112px
const PER_ROW = Math.floor(ATLAS / CELL), PER_ATLAS = PER_ROW * PER_ROW;

const DIR = 'data/citygml';
// LOD2 (実写テクスチャ) を含む松江市のメッシュ
const MESHES = ['53331043', '53331044', '53331053', '53331054', '53331055', '53331063', '53331064', '53331065', '53331073', '53331074'];

// ---------------- コース中心線 (道路上を通る探索済み経路) ----------------
const coursePath = JSON.parse(readFileSync('data/course_path.json', 'utf8'));
const centerline = coursePath.points.map((p, i) => [p[0], p[1], coursePath.elevated[i]]);

/** 折れ線を空間ハッシュに載せて最近傍距離を高速に判定する */
function makeIndex(points, cell = 100) {
  const grid = new Map();
  points.forEach(([x, z], i) => {
    const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(i);
  });
  return (x, z, limit) => {
    const r = Math.ceil(limit / cell);
    const ci = Math.floor(x / cell), cj = Math.floor(z / cell);
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = grid.get(`${ci + di},${cj + dj}`);
      if (!a) continue;
      for (const i of a) if (Math.hypot(points[i][0] - x, points[i][1] - z) <= limit) return true;
    }
    return false;
  };
}
// 建物を除去する判定には地上区間だけを使う (高架の下は残す)
const nearCourse = makeIndex(centerline.filter(p => !p[2]));
// 高架区間は桁に当たる高い建物だけ除去する
const nearElevated = makeIndex(centerline.filter(p => p[2]));
const DECK_TOP = 15.5; // 標高 (T.P.) でのおおよその桁上面
// LOD2 の採用範囲は高架区間も含めた全線から測る
const nearCourseAny = makeIndex(centerline);

// 軌道敷 (JR山陰本線・一畑電車) も建物を通せないので除外対象にする
const rail = JSON.parse(readFileSync('data/rail.json', 'utf8'));
function densify(pts, step = 5) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, z0] = toXZ(pts[i].lat, pts[i].lon);
    const [x1, z1] = toXZ(pts[i + 1].lat, pts[i + 1].lon);
    const len = Math.hypot(x1 - x0, z1 - z0);
    const m = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < m; k++) out.push([x0 + (x1 - x0) * (k / m), z0 + (z1 - z0) * (k / m)]);
  }
  const last = pts[pts.length - 1];
  out.push(toXZ(last.lat, last.lon));
  return out;
}
const RAIL_CORRIDORS = [
  { name: 'jr', index: makeIndex(densify(rail.jr.path)), margin: 8 },
  { name: 'ichibata', index: makeIndex(densify(rail.ichibata.path)), margin: 5 },
];
// コース路面の半幅 + 余裕
const COURSE_MARGIN = course.roadWidth / 2 + 2.5;

// ランドマーク (松江城天守は PLATEAU の LOD3 を別に描く) と重なる建物は除く
const LANDMARK_ZONES = Object.values(rail.landmarks).filter(l => l.excludeRadius > 0).map(l => { const [x, z] = toXZ(l.lat, l.lon); return { x, z, r: l.excludeRadius }; });
const inLandmark = (x, z) => LANDMARK_ZONES.some(L => Math.hypot(x - L.x, z - L.z) < L.r);

/** 建物のいずれかの頂点がコース・軌道敷に掛かるか (topZ は建物頂部の標高) */
function blocksWay(verts, topZ) {
  for (const [x, z] of verts) {
    if (nearCourse(x, z, COURSE_MARGIN)) return 'course';
    for (const c of RAIL_CORRIDORS) if (c.index(x, z, c.margin)) return c.name;
  }
  return null;
}

// ---------------- 高架区間のくり抜き箱 ----------------
// 高架のコースが建物を貫くところは、建物を丸ごと消さずに箱の形にくり抜く。
// (参考: web-metaverse の carveBoxes。広島駅の2階を通り抜けさせるのと同じ考え方)
const GROUND_GUESS = 3.5;      // 駅周辺の地面標高 (T.P. m)
const CARVE_HALF_W = 12;       // 道路半幅 + 余裕
const CARVE_BELOW = 2.0;       // 桁の下側
const CARVE_ABOVE = 6.0;       // 車両が通る高さ
const carveBoxes = [];
{
  const pathPts = coursePath.points, elev = coursePath.elevated;
  for (let i = 0; i < pathPts.length; i++) {
    if (!(elev[i] > 1.5)) continue;
    if (i % 4 !== 0) continue;                    // 8m ごと
    const j = (i + 1) % pathPts.length;
    const dx = pathPts[j][0] - pathPts[i][0], dz = pathPts[j][1] - pathPts[i][1];
    const yaw = Math.atan2(dx, dz);
    const deck = GROUND_GUESS + elev[i];
    carveBoxes.push({ cx: pathPts[i][0], cz: pathPts[i][1], yaw,
      y0: deck - CARVE_BELOW, y1: deck + CARVE_ABOVE, hw: CARVE_HALF_W, hl: 6 });
  }
}
if (carveBoxes.length) console.log(`くり抜き箱 ${carveBoxes.length} 個 (高架が建物を貫く所)`);
const carveIndex = new Map();
for (const b of carveBoxes) {
  const k = `${Math.floor(b.cx / 40)},${Math.floor(b.cz / 40)}`;
  let a = carveIndex.get(k); if (!a) { a = []; carveIndex.set(k, a); } a.push(b);
}
function boxesNear(x, z) {
  const out = [];
  const ci = Math.floor(x / 40), cj = Math.floor(z / 40);
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const a = carveIndex.get(`${ci + di},${cj + dj}`);
    if (a) out.push(...a);
  }
  return out;
}
function insideCarve(p, boxes) {
  for (const b of boxes) {
    if (p[1] < b.y0 || p[1] > b.y1) continue;
    const dx = p[0] - b.cx, dz = p[2] - b.cz;
    const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw);
    const lz = dx * s + dz * c, lx = dx * c - dz * s;
    if (Math.abs(lx) < b.hw && Math.abs(lz) < b.hl) return true;
  }
  return false;
}
/** 箱に当たる三角形を細かく割り、箱の中に入る部分だけ落とす */
function carveTriangle(a, b, c, ua, ub, uc, boxes, depth, out) {
  const inA = insideCarve(a, boxes), inB = insideCarve(b, boxes), inC = insideCarve(c, boxes);
  if (!inA && !inB && !inC) {
    // 3 頂点とも外でも、辺が箱を貫くことがあるので重心も見る
    const g = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    if (!insideCarve(g, boxes)) { out.push([a, b, c, ua, ub, uc]); return; }
  }
  if (inA && inB && inC) return;                    // 完全に中 → 消す
  const edge = Math.max(
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
    Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]),
    Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]));
  if (depth <= 0 || edge < 0.6) {
    const g = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    if (!insideCarve(g, boxes)) out.push([a, b, c, ua, ub, uc]);
    return;
  }
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
  const midU = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
  const uab = midU(ua, ub), ubc = midU(ub, uc), uca = midU(uc, ua);
  carveTriangle(a, ab, ca, ua, uab, uca, boxes, depth - 1, out);
  carveTriangle(ab, b, bc, uab, ub, ubc, boxes, depth - 1, out);
  carveTriangle(ca, bc, c, uca, ubc, uc, boxes, depth - 1, out);
  carveTriangle(ab, bc, ca, uab, ubc, uca, boxes, depth - 1, out);
}

// ---------------- 解析 ----------------
/** appearance セクションから polyId → {img, uv:[[u,v],...]} を作る */
function parseAppearance(text) {
  const map = new Map();
  // 広島のデータは Appearance がファイルの先頭、松江は末尾にある
  const appStart = text.indexOf('<app:Appearance');
  const appEnd = text.indexOf('</app:Appearance>');
  const app = appEnd < 0 ? text : text.slice(Math.max(0, appStart), appEnd);
  let i = 0;
  while (true) {
    const s = app.indexOf('<app:ParameterizedTexture>', i);
    if (s < 0) break;
    const e = app.indexOf('</app:ParameterizedTexture>', s);
    if (e < 0) break;
    i = e + 27;
    const blk = app.slice(s, e);
    const im = /<app:imageURI>([^<]*)<\/app:imageURI>/.exec(blk);
    if (!im) continue;
    const img = im[1].trim();
    const reT = /<app:target uri="#([^"]+)">([\s\S]*?)<\/app:target>/g;
    let m;
    while ((m = reT.exec(blk))) {
      const polyId = m[1];
      const tc = /<app:textureCoordinates[^>]*>([^<]*)<\/app:textureCoordinates>/.exec(m[2]);
      if (!tc) continue;
      const v = tc[1].trim().split(/\s+/).map(Number);
      const uv = [];
      for (let k = 0; k + 1 < v.length; k += 2) uv.push([v[k], v[k + 1]]);
      map.set(polyId, { img, uv });
    }
  }
  return map;
}

const buildings = []; // { polys: [{pos:[[x,y,z]..], uv:[[u,v]..], img}] }
const lod2Ids = [];
const imgSet = new Set();
let skippedFar = 0, skippedNoTex = 0;
const blocked = {};

for (const mesh of MESHES) {
  const file = path.join(DIR, `${mesh}_bldg.gml`);
  const text = readFileSync(file, 'utf8');
  const appear = parseAppearance(text);
  const appStart = text.indexOf('<app:Appearance'), appEnd = text.indexOf('</app:Appearance>');
  const firstBldg = text.indexOf('<bldg:Building ');
  const body = appStart < 0 ? text : appStart < firstBldg ? text.slice(appEnd) : text.slice(0, appStart);
  let idx = 0, kept = 0;
  while (true) {
    const s = body.indexOf('<bldg:Building ', idx);
    if (s < 0) break;
    const e = body.indexOf('</bldg:Building>', s);
    if (e < 0) break;
    idx = e + 16;
    const blk = body.slice(s, e);
    const ls = blk.indexOf('<bldg:lod2Solid>');
    if (ls < 0) continue;
    const gid = /gml:id="([^"]+)"/.exec(blk);
    // lod2Solid が参照する polygon id
    const solid = blk.slice(ls, blk.indexOf('</bldg:lod2Solid>', ls));
    const refs = [...solid.matchAll(/xlink:href="#([^"]+)"/g)].map(m => m[1]);
    if (refs.length === 0) continue;
    // boundedBy 側の Polygon 定義を集める (exterior の LinearRing のみ)
    const polyPos = new Map();
    const reP = /<gml:Polygon gml:id="([^"]+)">\s*<gml:exterior>\s*<gml:LinearRing gml:id="[^"]*">\s*<gml:posList>([^<]*)<\/gml:posList>/g;
    let pm;
    while ((pm = reP.exec(blk))) polyPos.set(pm[1], pm[2]);
    // 重心で範囲判定 + コース・軌道敷との干渉判定
    let cx = 0, cz = 0, cn = 0, topZ = -1e9;
    const allXZ = [];
    for (const id of refs) {
      const pl = polyPos.get(id);
      if (!pl) continue;
      const v = pl.trim().split(/\s+/);
      for (let k = 0; k + 2 < v.length; k += 3) {
        const p = toXZ(+v[k], +v[k + 1]);
        allXZ.push(p);
        if (+v[k + 2] > topZ) topZ = +v[k + 2];
        cx += p[0]; cz += p[1]; cn++;
      }
    }
    if (!cn) continue;
    cx /= cn; cz /= cn;
    if (!nearCourseAny(cx, cz, CORRIDOR)) { skippedFar++; continue; }
    // 道路・線路の上に建物が残ると通行できないため除去 (LOD1 と同じ扱い)
    if (inLandmark(cx, cz)) { blocked.landmark = (blocked.landmark ?? 0) + 1; continue; }
    const why = blocksWay(allXZ, topZ);
    if (why) { blocked[why] = (blocked[why] ?? 0) + 1; continue; }
    // ポリゴン + テクスチャ
    const polys = [];
    for (const id of refs) {
      const pl = polyPos.get(id);
      if (!pl) continue;
      const a = appear.get(id);
      if (!a) continue; // テクスチャ無し面 (X3DMaterial のみ) はスキップ
      const v = pl.trim().split(/\s+/).map(Number);
      const pos = [];
      for (let k = 0; k + 2 < v.length; k += 3) { const [x, z] = toXZ(v[k], v[k + 1]); pos.push([x, v[k + 2], z]); }
      // 末尾の閉じ点を除去
      if (pos.length > 1) {
        const f = pos[0], l = pos[pos.length - 1];
        if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6 && Math.abs(f[2] - l[2]) < 1e-6) pos.pop();
      }
      const uv = a.uv.slice(0, pos.length);
      if (uv.length !== pos.length) continue;
      polys.push({ pos, uv, img: a.img });
      imgSet.add(a.img);
    }
    if (polys.length === 0) { skippedNoTex++; continue; }
    buildings.push({ polys });
    if (gid) lod2Ids.push(gid[1]);
    kept++;
  }
  console.log(`lod2 ${mesh}: ${kept} 棟 (textures ${appear.size} 面)`);
}
console.log(`LOD2 採用 ${buildings.length} 棟 / コース外 ${skippedFar} / テクスチャ無 ${skippedNoTex}`);
console.log(`通行のため除去: ${JSON.stringify(blocked)}`);
console.log(`テクスチャ画像 ${imgSet.size} 枚`);

// ---------------- アトラス割り当て ----------------
const images = [...imgSet].sort();
const slotOf = new Map();
images.forEach((img, i) => {
  const a = Math.floor(i / PER_ATLAS), r = Math.floor((i % PER_ATLAS) / PER_ROW), c = (i % PER_ATLAS) % PER_ROW;
  slotOf.set(img, { atlas: a, px: c * CELL, py: r * CELL });
});
const atlasCount = Math.ceil(images.length / PER_ATLAS);
console.log(`アトラス ${atlasCount} 枚 (${ATLAS}px, 1枚あたり ${PER_ATLAS} タイル)`);

// ---------------- 出力 ----------------
// アトラスごとに三角形をまとめる
const perAtlas = Array.from({ length: atlasCount }, () => ({ pos: [], uv: [] }));
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
let triCount = 0, carved = 0;
for (const b of buildings) {
  for (const poly of b.polys) {
    const slot = slotOf.get(poly.img);
    const bucket = perAtlas[slot.atlas];
    const tris = triangulate(poly.pos);
    for (const t of tris) {
      const [ia, ib, ic] = t;
      const A = poly.pos[ia], B = poly.pos[ib], C = poly.pos[ic];
      const boxes = carveBoxes.length ? boxesNear((A[0] + B[0] + C[0]) / 3, (A[2] + B[2] + C[2]) / 3) : [];
      let pieces;
      if (boxes.length) {
        pieces = [];
        carveTriangle(A, B, C, poly.uv[ia], poly.uv[ib], poly.uv[ic], boxes, 5, pieces);
        if (pieces.length !== 1) carved++;
      } else {
        pieces = [[A, B, C, poly.uv[ia], poly.uv[ib], poly.uv[ic]]];
      }
      for (const [pa, pb, pc, qa, qb, qc] of pieces) {
        for (const [p, uv] of [[pa, qa], [pb, qb], [pc, qc]]) {
          bucket.pos.push(p[0], p[1], p[2]);
          // CityGML の v は画像下端が 0。アトラスは flipY=false で使うため上下を反転して配置する
          const u = (slot.px + PAD + clamp01(uv[0]) * IMG) / ATLAS;
          const v = (slot.py + PAD + (1 - clamp01(uv[1])) * IMG) / ATLAS;
          bucket.uv.push(u, v);
        }
        triCount++;
      }
    }
  }
}
console.log(`三角形 ${triCount} (くり抜きで加工した三角形 ${carved})`);

const groups = [];
let posAll = [], uvAll = [], offset = 0;
perAtlas.forEach((b, i) => {
  const count = b.pos.length / 3;
  groups.push({ atlas: i, start: offset, count });
  posAll.push(b.pos); uvAll.push(b.uv);
  offset += count;
});
const total = offset;
const pos = new Float32Array(total * 3), uv = new Float32Array(total * 2);
let o3 = 0, o2 = 0;
for (const a of posAll) { pos.set(a, o3); o3 += a.length; }
for (const a of uvAll) { uv.set(a, o2); o2 += a.length; }

const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(uv.buffer)]);
writeFileSync('public/data/lod2.bin', bin);
writeFileSync('public/data/lod2.json', JSON.stringify({
  vertexCount: total,
  atlasSize: ATLAS,
  atlases: Array.from({ length: atlasCount }, (_, i) => `lod2_atlas_${i}.jpg`),
  groups,
  skipIds: lod2Ids,
}));
writeFileSync('data/lod2_images.json', JSON.stringify({
  atlasSize: ATLAS, cell: CELL, pad: PAD, img: IMG, perAtlas: PER_ATLAS, perRow: PER_ROW,
  images: images.map(img => ({ img, ...slotOf.get(img) })),
}));
console.log(`lod2.bin ${(bin.length / 1e6).toFixed(1)}MB / 頂点 ${total}`);
