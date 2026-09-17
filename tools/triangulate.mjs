// 多角形の三角形分割 (平面へ投影して耳刈り)。convert_lod2.mjs と convert_castle.mjs で共用する
export function triangulate(verts) {
  // verts: [[x,y,z], ...] (末尾の閉じ点は除去済み)
  const m = verts.length;
  if (m < 3) return [];
  if (m === 3) return [[0, 1, 2]];
  // Newell 法で法線
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < m; i++) {
    const a = verts[i], b = verts[(i + 1) % m];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const an = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  // 最大成分の軸を落として 2D 化 (向きは法線の符号に合わせる)
  let pick;
  if (an >= ay && an >= az) pick = nx > 0 ? (v => [v[1], v[2]]) : (v => [v[2], v[1]]);
  else if (ay >= an && ay >= az) pick = ny > 0 ? (v => [v[2], v[0]]) : (v => [v[0], v[2]]);
  else pick = nz > 0 ? (v => [v[0], v[1]]) : (v => [v[1], v[0]]);
  const p = verts.map(pick);
  // 面積が 0 に近いものは捨てる
  let area = 0;
  for (let i = 0; i < m; i++) { const a = p[i], b = p[(i + 1) % m]; area += a[0] * b[1] - b[0] * a[1]; }
  if (Math.abs(area) < 1e-9) return [];
  const idx = [];
  for (let i = 0; i < m; i++) idx.push(i);
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < m * m + 20) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i - 1 + idx.length) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      const a = p[i0], b = p[i1], c = p[i2];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (cross <= 0) continue; // 凸でない
      let ok = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTri(p[j], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push([i0, i1, i2]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // 自己交差など: 残りは扇状に分割
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  else if (idx.length > 3) for (let i = 1; i + 1 < idx.length; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
  return tris;
}
function pointInTri(pt, a, b, c) {
  const d1 = (b[0] - a[0]) * (pt[1] - a[1]) - (pt[0] - a[0]) * (b[1] - a[1]);
  const d2 = (c[0] - b[0]) * (pt[1] - b[1]) - (pt[0] - b[0]) * (c[1] - b[1]);
  const d3 = (a[0] - c[0]) * (pt[1] - c[1]) - (pt[0] - c[0]) * (a[1] - c[1]);
  return d1 >= 0 && d2 >= 0 && d3 >= 0;
}

