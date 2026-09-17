// コースの走行線を PLATEAU の道路面 (tran) の上に載せる。
//   1. roads.json の道路ポリゴンを 2m グリッドへラスタライズ
//   2. 道路の縁からの距離を求める (中央寄りを走らせるため)
//   3. 地図に描かれた経路 (data/drawn_route.json) からの距離も重みに入れる
//   4. 制御点どうしを A* でつなぐ
//   5. 広島駅には道路が無いので、駅の2階を貫く区間 (course.json の stationPass) を差し込む
//   6. 往復を除去し、平滑化して data/course_path.json に出力
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CELL = 2;                 // グリッド解像度 (m)
const PREFER_HALF = 6;          // これくらい (セル) 道路の中央に寄せたい
const OFFROAD_COST = 60;        // 道路外を通る場合の割増
const CENTER_COST = 3.0;        // 縁に寄るほど増える割増
const GUIDE_COST = 6;           // 指示線から離れるほどの割増
const GUIDE_RANGE = 40;         // 割増が頭打ちになる距離 (m)

const course = JSON.parse(readFileSync('data/course.json', 'utf8'));
const roads = JSON.parse(readFileSync('public/data/roads.json', 'utf8')).items;
const lat0 = course.origin.lat, lon0 = course.origin.lon;
const mPerLat = 110950, mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const toXZ = (lat, lon) => [(lon - lon0) * mPerLon, -(lat - lat0) * mPerLat];

// ---------------- 1. ラスタライズ ----------------
let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
for (const poly of roads) {
  for (let i = 1; i < poly.length; i += 2) {
    if (poly[i] < xMin) xMin = poly[i];
    if (poly[i] > xMax) xMax = poly[i];
    if (poly[i + 1] < zMin) zMin = poly[i + 1];
    if (poly[i + 1] > zMax) zMax = poly[i + 1];
  }
}
xMin -= 20; xMax += 20; zMin -= 20; zMax += 20;
const W = Math.ceil((xMax - xMin) / CELL) + 1;
const H = Math.ceil((zMax - zMin) / CELL) + 1;
console.log(`グリッド ${W}x${H} (${CELL}m)`);
const road = new Uint8Array(W * H);

for (const poly of roads) {
  const xs = [], zs = [];
  for (let i = 1; i < poly.length; i += 2) { xs.push((poly[i] - xMin) / CELL); zs.push((poly[i + 1] - zMin) / CELL); }
  const n = xs.length;
  if (n < 3) continue;
  const j0 = Math.max(0, Math.floor(Math.min(...zs))), j1 = Math.min(H - 1, Math.ceil(Math.max(...zs)));
  for (let j = j0; j <= j1; j++) {
    const y = j + 0.5;
    const xsAt = [];
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      const z1 = zs[k], z2 = zs[k2];
      if ((z1 <= y && z2 > y) || (z2 <= y && z1 > y)) xsAt.push(xs[k] + ((y - z1) / (z2 - z1)) * (xs[k2] - xs[k]));
    }
    xsAt.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xsAt.length; k += 2) {
      const a = Math.max(0, Math.ceil(xsAt[k] - 0.5)), b = Math.min(W - 1, Math.floor(xsAt[k + 1] + 0.5));
      for (let i = a; i <= b; i++) road[j * W + i] = 1;
    }
  }
}
let roadCells = 0;
for (let k = 0; k < road.length; k++) if (road[k]) roadCells++;
console.log(`道路セル ${roadCells} (${(roadCells / (W * H) * 100).toFixed(1)}%)`);

// ---------------- 2. 距離変換 ----------------
function chamfer(field) {
  const D2 = Math.SQRT2;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (field[k] === 0) continue;
    let d = field[k];
    if (i > 0) d = Math.min(d, field[k - 1] + 1);
    if (j > 0) d = Math.min(d, field[k - W] + 1);
    if (i > 0 && j > 0) d = Math.min(d, field[k - W - 1] + D2);
    if (i < W - 1 && j > 0) d = Math.min(d, field[k - W + 1] + D2);
    field[k] = d;
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i;
    if (field[k] === 0) continue;
    let d = field[k];
    if (i < W - 1) d = Math.min(d, field[k + 1] + 1);
    if (j < H - 1) d = Math.min(d, field[k + W] + 1);
    if (i < W - 1 && j < H - 1) d = Math.min(d, field[k + W + 1] + D2);
    if (i > 0 && j < H - 1) d = Math.min(d, field[k + W - 1] + D2);
    field[k] = d;
  }
}
const dist = new Float32Array(W * H);
for (let k = 0; k < road.length; k++) dist[k] = road[k] ? 1e9 : 0;
chamfer(dist);

// ---------------- 3. 指示線からの距離 ----------------
let guide = null, drawn = null;
if (existsSync('data/drawn_route.json')) {
  drawn = JSON.parse(readFileSync('data/drawn_route.json', 'utf8'));
  guide = new Float32Array(W * H).fill(1e9);
  const pts = drawn.points.map(p => toXZ(p.lat, p.lon));
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const m = Math.max(1, Math.ceil(L / CELL));
    for (let k = 0; k <= m; k++) {
      const x = a[0] + (b[0] - a[0]) * k / m, z = a[1] + (b[1] - a[1]) * k / m;
      const i2 = Math.round((x - xMin) / CELL), j2 = Math.round((z - zMin) / CELL);
      if (i2 >= 0 && j2 >= 0 && i2 < W && j2 < H) guide[j2 * W + i2] = 0;
    }
  }
  chamfer(guide);
  console.log(`指示線に沿わせます (${drawn.points.length} 点, 位置合わせ誤差 ${drawn.fitError}m)`);
} else {
  console.log('data/drawn_route.json が無いので経由地だけで経路を作ります');
}

// ---------------- 4. A* ----------------
function cellCost(k) {
  let c;
  if (!road[k]) c = OFFROAD_COST;
  else {
    const d = dist[k];
    const lack = Math.max(0, PREFER_HALF - d) / PREFER_HALF;
    c = 1 + CENTER_COST * lack * lack;
  }
  if (guide) c += GUIDE_COST * Math.min(1, (guide[k] * CELL) / GUIDE_RANGE);
  return c;
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node) {
    const a = this.a; a.push(node);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

function astar(sk, gk) {
  const gScore = new Float32Array(W * H).fill(1e9);
  const came = new Int32Array(W * H).fill(-1);
  const closed = new Uint8Array(W * H);
  const gi = gk % W, gj = (gk - gi) / W;
  const h = k => { const i = k % W, j = (k - i) / W; return Math.hypot(i - gi, j - gj); };
  gScore[sk] = 0;
  const open = new Heap();
  open.push({ k: sk, f: h(sk) });
  while (open.size) {
    const k = open.pop().k;
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === gk) break;
    const i = k % W, j = (k - i) / W;
    for (const [di, dj, len] of NB) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nk = nj * W + ni;
      if (closed[nk]) continue;
      const g = gScore[k] + len * cellCost(nk);
      if (g < gScore[nk]) { gScore[nk] = g; came[nk] = k; open.push({ k: nk, f: g + h(nk) }); }
    }
  }
  if (came[gk] < 0 && gk !== sk) return null;
  const p = [];
  for (let k = gk; k !== -1; k = came[k]) { p.push(k); if (k === sk) break; }
  p.reverse();
  return p;
}

function snap(x, z) {
  const i0 = Math.round((x - xMin) / CELL), j0 = Math.round((z - zMin) / CELL);
  let best = -1, bestScore = -Infinity;
  for (let r = 0; r <= 60; r++) {
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const i = i0 + di, j = j0 + dj;
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const k = j * W + i;
      if (!road[k]) continue;
      const score = Math.min(dist[k], PREFER_HALF) - r * 0.6;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    if (best >= 0 && r > 6) break;
  }
  return best;
}
const cellToXZ = k => { const i = k % W; return [xMin + i * CELL, zMin + ((k - i) / W) * CELL]; };

// ---------------- 5. 制御点 ----------------
let anchorsLL;
if (drawn) {
  const step = Math.max(1, Math.round(drawn.points.length / 26));
  anchorsLL = drawn.points.filter((_, i) => i % step === 0);
  console.log(`制御点を指示線から ${anchorsLL.length} 点とりました`);
} else {
  anchorsLL = course.waypoints;
}
const anchors = anchorsLL.map(w => {
  const [x, z] = toXZ(w.lat, w.lon);
  const k = snap(x, z);
  if (k < 0) throw new Error('道路が見つかりません');
  return k;
});

// ---------------- 6. 広島駅の貫通区間 ----------------
const sp = course.stationPass;
let passSpan = null;
if (sp && sp.points?.length >= 2) {
  const nearestAnchor = (lat, lon) => {
    const [x, z] = toXZ(lat, lon);
    let best = 0, bd = Infinity;
    anchors.forEach((k, i) => { const [ax, az] = cellToXZ(k); const d = Math.hypot(ax - x, az - z); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const a = nearestAnchor(sp.points[0].lat, sp.points[0].lon);
  const b = nearestAnchor(sp.points[sp.points.length - 1].lat, sp.points[sp.points.length - 1].lon);
  const n = anchors.length;
  const fwd = (b - a + n) % n;
  passSpan = fwd > 0 && fwd <= n / 2 ? { a, b, reverse: false } : { a: b, b: a, reverse: true };
  console.log(`駅の貫通区間: 制御点 ${passSpan.a} → ${passSpan.b}${passSpan.reverse ? ' (南→北)' : ''}`);
}

// ---------------- 6b. 貫通区間の両端を道路の中央へ ----------------
// 貫通区間の端点は手で置いた座標なので、道路の中央 (A* が通る所) から横にずれている
// ことがある。ずれたままだと、A* は端点ではなく最寄りの制御点から始まるため、
// 端点から制御点へ引き返す往復が経路に残り、スロープが着地する所で道路・軌道が
// 食い違う。端点を横断方向に見て道路の中央へ寄せ、ずれの分はスロープ全体で徐々に
// 吸収する。A* もその点から始める (端点の近くに道路が無ければ何もしない)。
let passSeq = null; // [x, z, h] の列 (経路の向き)
if (passSpan) {
  passSeq = (passSpan.reverse ? [...sp.points].reverse() : sp.points).map(p => [...toXZ(p.lat, p.lon), p.h]);
  const n = passSeq.length;
  const top = Math.max(...passSeq.map(p => p[2]));
  const isTop = p => p[2] >= top - 1e-6;
  const firstTop = passSeq.findIndex(isTop);
  const lastTop = n - 1 - [...passSeq].reverse().findIndex(isTop);
  // 端点 p から隣点 q の向きに直交する線上で、道路の縁から最も遠いセル (= 道路の中央)
  const roadCenterAcross = (p, q, range = 40) => {
    let tx = q[0] - p[0], tz = q[1] - p[1];
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    const nx = tz, nz = -tx;
    let best = -1, bestD = 0, bestOff = Infinity;
    for (let o = -range; o <= range; o += 1) {
      const i = Math.round((p[0] + nx * o - xMin) / CELL), j = Math.round((p[1] + nz * o - zMin) / CELL);
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const k = j * W + i;
      if (!road[k]) continue;
      if (dist[k] > bestD + 1e-6 || (Math.abs(dist[k] - bestD) <= 1e-6 && Math.abs(o) < bestOff)) { bestD = dist[k]; bestOff = Math.abs(o); best = k; }
    }
    return best;
  };
  // from..to のスロープに横ずれ delta を徐々にかける (端 endIdx で 1、もう一方で 0)
  const shiftRamp = (from, to, endIdx, delta) => {
    const cum = [0];
    for (let i = from + 1; i <= to; i++) cum.push(cum[cum.length - 1] + Math.hypot(passSeq[i][0] - passSeq[i - 1][0], passSeq[i][1] - passSeq[i - 1][1]));
    const total = cum[cum.length - 1] || 1;
    for (let i = from; i <= to; i++) {
      let w = cum[i - from] / total;
      if (endIdx === from) w = 1 - w;
      passSeq[i][0] += delta[0] * w; passSeq[i][1] += delta[1] * w;
    }
  };
  for (const [endIdx, nextIdx, anchorKey, rampFrom, rampTo, label] of [
    [n - 1, n - 2, 'b', lastTop, n - 1, '終点'],
    [0, 1, 'a', 0, firstTop, '始点'],
  ]) {
    const k = roadCenterAcross(passSeq[endIdx], passSeq[nextIdx]);
    if (k < 0) { console.log(`  貫通区間の${label}の横に道路が無いのでそのまま`); continue; }
    const [cx, cz] = cellToXZ(k);
    const delta = [cx - passSeq[endIdx][0], cz - passSeq[endIdx][1]];
    shiftRamp(rampFrom, rampTo, endIdx, delta);
    anchors[passSpan[anchorKey]] = k;
    console.log(`  貫通区間の${label}を道路の中央へ ${Math.hypot(delta[0], delta[1]).toFixed(1)}m 寄せました`);
  }
}

// ---------------- 7. 経路の組み立て ----------------
const pts = [];
const nAnchors = anchors.length;
const inPassSpan = i => {
  if (!passSpan) return false;
  const { a, b } = passSpan;
  return a <= b ? (i >= a && i < b) : (i >= a || i < b);
};
for (let a = 0; a < nAnchors; a++) {
  const b = (a + 1) % nAnchors;
  if (inPassSpan(a)) {
    if (a === passSpan.a) {
      const seq = passSeq;
      for (let i = 0; i + 1 < seq.length; i++) {
        const p0 = seq[i], p1 = seq[i + 1];
        const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const m = Math.max(1, Math.ceil(L / CELL));
        for (let k = 0; k < m; k++) {
          const t = k / m;
          pts.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t]);
        }
      }
      console.log(`  駅の貫通: ${sp.points.length} 点をそのまま使用 (最高 ${Math.max(...sp.points.map(p => p.h))}m)`);
    }
    continue;
  }
  const seg = astar(anchors[a], anchors[b]);
  if (!seg) throw new Error(`制御点 ${a} → ${b} の経路が見つかりません`);
  for (let i = 0; i < seg.length - 1; i++) { const [x, z] = cellToXZ(seg[i]); pts.push([x, z, 0]); }
}

// ---------------- 8. 往復の除去 ----------------
function removeSpurs(seq) {
  const seen = new Map();
  const out = [];
  for (const p of seq) {
    const key = `${Math.round(p[0] / 6)},${Math.round(p[1] / 6)}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      const back = out.length - prev;
      if (back > 12 && back < 520) {
        out.length = prev + 1;
        for (const [kk, vv] of seen) if (vv > prev) seen.delete(kk);
        continue;
      }
    } else seen.set(key, out.length);
    out.push(p);
  }
  return out;
}
const rotate = (arr, k) => arr.slice(k).concat(arr.slice(0, k));
const before = pts.length;
let cleaned = removeSpurs(pts);
cleaned = rotate(cleaned, Math.floor(cleaned.length / 2));
cleaned = removeSpurs(cleaned);
// スタート/ゴールは「広島駅」の最寄りへ
{
  const [sx, sz] = toXZ(course.waypoints[0].lat, course.waypoints[0].lon);
  let best = 0, bd = Infinity;
  cleaned.forEach((p, i) => { const d = (p[0] - sx) ** 2 + (p[1] - sz) ** 2; if (d < bd) { bd = d; best = i; } });
  cleaned = rotate(cleaned, best);
}
console.log(`往復の除去: ${before} → ${cleaned.length} 点`);

// ---------------- 9. 平滑化と再サンプル ----------------
function smoothLoop(p, radius, passes) {
  let cur = p;
  for (let t = 0; t < passes; t++) {
    const n = cur.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0, sz = 0, sh = 0, c = 0;
      for (let d = -radius; d <= radius; d++) { const q = cur[((i + d) % n + n) % n]; sx += q[0]; sz += q[1]; sh += q[2]; c++; }
      out[i] = [sx / c, sz / c, sh / c];
    }
    cur = out;
  }
  return cur;
}
let smooth = smoothLoop(cleaned, 3, 2);
smooth = smoothLoop(smooth, 6, 2);

const path = [];
{
  let carry = 0;
  for (let i = 0; i < smooth.length; i++) {
    const a = smooth[i], b = smooth[(i + 1) % smooth.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    let t = carry;
    while (t < len) {
      const u = t / len;
      path.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
      t += 2;
    }
    carry = t - len;
  }
}

// ---------------- 10. ラベル ----------------
const labelWps = course.waypoints;
const idxOfWaypoint = labelWps.map(w => {
  const [x, z] = toXZ(w.lat, w.lon);
  let best = 0, bd = Infinity;
  path.forEach((p, i) => { const d = (p[0] - x) ** 2 + (p[1] - z) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
});

let total = 0, onRoad = 0, maxH = 0;
for (let i = 0; i < path.length; i++) {
  const a = path[i], b = path[(i + 1) % path.length];
  total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (a[2] > maxH) maxH = a[2];
  const ci = Math.round((a[0] - xMin) / CELL), cj = Math.round((a[1] - zMin) / CELL);
  if (ci >= 0 && cj >= 0 && ci < W && cj < H && road[cj * W + ci]) onRoad++;
}
console.log(`経路 ${path.length} 点 / 全長 ${Math.round(total)}m / 道路上 ${(onRoad / path.length * 100).toFixed(1)}% / 最高 ${maxH.toFixed(1)}m`);

writeFileSync('data/course_path.json', JSON.stringify({
  origin: course.origin,
  roadWidth: course.roadWidth,
  viaductHeight: course.viaductHeight,
  length: Math.round(total),
  points: path.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
  elevated: path.map(p => Math.round(p[2] * 100) / 100),
  stationCarve: sp?.carve ?? null,
  labels: labelWps.map((w, i) => ({ name: w.name, short: w.short ?? w.name, en: w.en ?? w.name, idx: idxOfWaypoint[i], label: !!w.label })),
}));
console.log('data/course_path.json を書き出しました');

// ---------------- 11. 確認用の図 ----------------
{
  const SC = 3;
  const iw = Math.ceil(W / SC), ih = Math.ceil(H / SC);
  const img = Buffer.alloc(iw * ih * 3, 0x1a);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!road[j * W + i]) continue;
    const o = ((j / SC | 0) * iw + (i / SC | 0)) * 3;
    img[o] = 0x6b; img[o + 1] = 0x6f; img[o + 2] = 0x74;
  }
  const put = (x, z, r, g, b, rad) => {
    const ci = Math.round((x - xMin) / CELL / SC), cj = Math.round((z - zMin) / CELL / SC);
    for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= iw || j >= ih) continue;
      const o = (j * iw + i) * 3;
      img[o] = r; img[o + 1] = g; img[o + 2] = b;
    }
  };
  if (drawn) for (const p of drawn.points) { const [x, z] = toXZ(p.lat, p.lon); put(x, z, 0x2e, 0x5f, 0xa8, 1); }
  for (const p of path) put(p[0], p[1], p[2] > 1 ? 0xff : 0xe6, p[2] > 1 ? 0xb0 : 0x39, p[2] > 1 ? 0x20 : 0x46, 1);
  for (const w of labelWps) { const [x, z] = toXZ(w.lat, w.lon); put(x, z, 0x3a, 0x86, 0xff, 3); }
  const raw = Buffer.alloc(ih * (iw * 3 + 1));
  for (let j = 0; j < ih; j++) { raw[j * (iw * 3 + 1)] = 0; img.copy(raw, j * (iw * 3 + 1) + 1, j * iw * 3, (j + 1) * iw * 3); }
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(iw, 0); ihdr.writeUInt32BE(ih, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync('data/course_map.png', Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
  console.log(`data/course_map.png (${iw}x${ih}) を書き出しました`);
}
