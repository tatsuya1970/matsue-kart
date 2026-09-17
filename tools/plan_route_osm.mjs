// 経由地 (tools/route_vias.json) を OSM の道路網 (data/osm/matsue.json, tools/fetch_osm.mjs で取得) の最短路でつなぐ。
//   node tools/plan_route_osm.mjs [vias.json] [out.json]   → data/drawn_route.json
// 経由地の 3 番目の要素は道路の絞り込み ("ref|name|highway" に対する正規表現)。
// links は OSM でつながっていない踏切などを手でつなぐ。
// OSM 道路網で経由地を最短路でつなぎ、案内線を作る
import { readFileSync, writeFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('data/osm/matsue.json', 'utf8')).elements;
const vias = JSON.parse(readFileSync(process.argv[2] ?? 'tools/route_vias.json', 'utf8'));
const W = { trunk: 1, primary: 1, trunk_link: 1.2, primary_link: 1.2, secondary: 1.1, tertiary: 1.3, unclassified: 2.2, residential: 3.5 };
const kx = 111320 * Math.cos(35.47 * Math.PI / 180), ky = 110950;
const nodes = new Map(); // key -> {lat,lon,adj:[],tags:[]}
const key = p => p.lat.toFixed(7) + ',' + p.lon.toFixed(7);
for (const e of d) {
  if (e.type !== 'way' || !e.tags.highway || !W[e.tags.highway]) continue;
  const g = e.geometry;
  for (let i = 0; i < g.length; i++) { const k = key(g[i]); if (!nodes.has(k)) nodes.set(k, { lat: g[i].lat, lon: g[i].lon, adj: [], tags: [] }); nodes.get(k).tags.push((e.tags.ref||"")+"|"+(e.tags.name||"")+"|"+e.tags.highway); }
  for (let i = 0; i + 1 < g.length; i++) {
    const a = key(g[i]), b = key(g[i + 1]);
    const L = Math.hypot((g[i].lat - g[i + 1].lat) * ky, (g[i].lon - g[i + 1].lon) * kx);
    const c = L * W[e.tags.highway] * (vias.avoid?.some(r => inBox(g[i], r)) ? 50 : 1);
    nodes.get(a).adj.push([b, c]); nodes.get(b).adj.push([a, c]);
  }
}
function inBox(p, r) { return p.lat >= r[0] && p.lat <= r[1] && p.lon >= r[2] && p.lon <= r[3]; }
const keys = [...nodes.keys()];
function snap(lat, lon, f) { const re = f ? new RegExp(f) : null; let best, bd = Infinity; for (const k of keys) { const n = nodes.get(k); if (re && !n.tags.some(t => re.test(t))) continue; const dd = ((n.lat - lat) * ky) ** 2 + ((n.lon - lon) * kx) ** 2; if (dd < bd) { bd = dd; best = k; } } return best; }
function dijkstra(s, t, used) {
  const dist = new Map([[s, 0]]), prev = new Map(); const open = [[0, s]]; const done = new Set();
  while (open.length) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [du, u] = open.splice(bi, 1)[0];
    if (done.has(u)) continue; done.add(u);
    if (u === t) break;
    for (const [v, c] of nodes.get(u).adj) {
      const pen = used.has(u + '|' + v) || used.has(v + '|' + u) ? 30 : 1;
      const nd = du + c * pen;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); open.push([nd, v]); }
    }
  }
  const p = []; for (let k = t; k; k = prev.get(k)) { p.push(k); if (k === s) break; }
  return p.reverse();
}
for (const l of vias.links ?? []) { const a = snap(l[0], l[1], l[2]), b = snap(l[3], l[4], l[5]); const na = nodes.get(a), nb = nodes.get(b); const c = Math.hypot((na.lat - nb.lat) * ky, (na.lon - nb.lon) * kx); na.adj.push([b, c]); nb.adj.push([a, c]); console.log("link", c.toFixed(1) + "m"); }
const pts = []; const used = new Set();
const V = vias.points;
for (let i = 0; i < V.length; i++) {
  const a = V[i], b = V[(i + 1) % V.length];
  const p = dijkstra(snap(a[0], a[1], a[2]), snap(b[0], b[1], b[2]), used);
  for (let j = 0; j + 1 < p.length; j++) used.add(p[j] + '|' + p[j + 1]);
  for (let j = 0; j < p.length - 1; j++) { const n = nodes.get(p[j]); pts.push({ lat: n.lat, lon: n.lon }); }
}
let L = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; L += Math.hypot((a.lat - b.lat) * ky, (a.lon - b.lon) * kx); }
writeFileSync(process.argv[3] ?? 'data/drawn_route.json', JSON.stringify({ comment: 'OSM の道路網で経由地 (tools/route_vias.json) をつないだ案内線。tools/plan_route_osm.mjs が生成。A* の重みとして使う。', fitError: 0, points: pts.map(p => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })) }));
console.log('points', pts.length, 'length', Math.round(L));
