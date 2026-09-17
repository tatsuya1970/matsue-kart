// PLATEAU 建築物 LOD1 → テクスチャ付きメッシュ (種類ごとにマージ)
import * as THREE from 'three';
import type { Track } from './track';
import type { Terrain } from './terrain';
import { makeWallTexture, makeRoofTexture } from './textures';
import { hashInt } from './geo';
import { t } from './i18n';

export interface BuildingsData {
  count: number;
  items: number[][]; // [height, baseZ, usage, x0, z0, x1, z1, ...]
}

const VARIANTS = 6;
const TILE_W = 4, TILE_H = 3.5;

function pickVariant(h: number, usage: number, hash: number): number {
  const r = hash % 100;
  if (h > 45) return r < 80 ? 0 : 1;
  if (h > 22) return r < 45 ? 1 : r < 75 ? 2 : r < 90 ? 0 : 5;
  if (h > 11) return r < 35 ? 2 : r < 60 ? 1 : r < 80 ? 3 : 5;
  if (h > 6) return r < 40 ? 4 : r < 65 ? 3 : r < 85 ? 5 : 2;
  return r < 75 ? 4 : 3;
}

export function buildBuildings(data: BuildingsData, track: Track, terrain: Terrain, onStat?: (s: string) => void, extraBlocker?: (ring: number[]) => boolean): THREE.Group {
  const group = new THREE.Group();
  const wallPos: number[][] = [], wallUv: number[][] = [], wallNrm: number[][] = [];
  for (let v = 0; v < VARIANTS; v++) { wallPos.push([]); wallUv.push([]); wallNrm.push([]); }
  const roofPos: number[] = [], roofUv: number[] = [], roofIdx: number[] = [];
  let kept = 0, removed = 0;
  const v2: THREE.Vector2[] = [];

  for (const it of data.items) {
    const h = it[0], usage = it[2];
    const ring = it.slice(3);
    const m = ring.length / 2;
    if (m < 3) continue;
    // コース帯・軌道敷に掛かる建物は除去 (道路と線路を通す)
    if (track.blocks(ring, 2.5, h)) { removed++; continue; }
    if (extraBlocker && extraBlocker(ring)) { removed++; continue; }
    // 符号付き面積 (x,z): 負になるよう向きを揃える → 側面法線が外向き
    let area = 0;
    for (let k = 0; k < m; k++) { const k2 = (k + 1) % m; area += ring[k * 2] * ring[k2 * 2 + 1] - ring[k2 * 2] * ring[k * 2 + 1]; }
    if (Math.abs(area) < 1) continue;
    let xs: number[] = [], zs: number[] = [];
    for (let k = 0; k < m; k++) { xs.push(ring[k * 2]); zs.push(ring[k * 2 + 1]); }
    if (area > 0) { xs.reverse(); zs.reverse(); }
    // 基準高さ: フットプリント頂点の地形標高の最小値
    let base = Infinity;
    for (let k = 0; k < m; k++) base = Math.min(base, terrain.groundHeight(xs[k], zs[k]));
    base -= 0.4;
    const top = base + h;
    const variant = pickVariant(h, usage, hashInt(xs[0], zs[0]));
    const P = wallPos[variant], U = wallUv[variant], N = wallNrm[variant];
    // 側面
    let u = 0;
    for (let k = 0; k < m; k++) {
      const k2 = (k + 1) % m;
      const x0 = xs[k], z0 = zs[k], x1 = xs[k2], z1 = zs[k2];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.05) continue;
      const dx = (x1 - x0) / len, dz = (z1 - z0) / len;
      const nx = -dz, nz = dx; // 負面積リングでの外向き法線
      const u0 = u / TILE_W, u1 = (u + len) / TILE_W, v1 = h / TILE_H;
      // 2 三角形: (p0b, p1b, p1t), (p0b, p1t, p0t)
      P.push(x0, base, z0, x1, base, z1, x1, top, z1, x0, base, z0, x1, top, z1, x0, top, z0);
      U.push(u0, 0, u1, 0, u1, v1, u0, 0, u1, v1, u0, v1);
      for (let q = 0; q < 6; q++) N.push(nx, 0, nz);
      u += len;
    }
    // 屋根
    v2.length = 0;
    for (let k = 0; k < m; k++) v2.push(new THREE.Vector2(xs[k], zs[k]));
    let tris: number[][];
    try { tris = THREE.ShapeUtils.triangulateShape(v2, []); } catch { tris = []; }
    const baseIdx = roofPos.length / 3;
    for (let k = 0; k < m; k++) { roofPos.push(xs[k], top, zs[k]); roofUv.push(xs[k] / 10, zs[k] / 10); }
    for (const t of tris) {
      const [a, b, c] = t;
      // 法線が +Y になるよう向きを揃える
      const ux = xs[b] - xs[a], uz = zs[b] - zs[a], vx = xs[c] - xs[a], vz = zs[c] - zs[a];
      const ny = uz * vx - ux * vz;
      if (ny > 0) roofIdx.push(baseIdx + a, baseIdx + b, baseIdx + c); else roofIdx.push(baseIdx + a, baseIdx + c, baseIdx + b);
    }
    kept++;
  }
  onStat?.(t('load.bldgDone', kept, removed));

  for (let v = 0; v < VARIANTS; v++) {
    if (wallPos[v].length === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(wallPos[v], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(wallUv[v], 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(wallNrm[v], 3));
    const mat = new THREE.MeshLambertMaterial({ map: makeWallTexture(v) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(roofPos, 3));
  rg.setAttribute('uv', new THREE.Float32BufferAttribute(roofUv, 2));
  rg.setIndex(roofIdx);
  rg.computeVertexNormals();
  const roof = new THREE.Mesh(rg, new THREE.MeshLambertMaterial({ map: makeRoofTexture() }));
  roof.castShadow = true; roof.receiveShadow = true; roof.frustumCulled = false;
  group.add(roof);
  return group;
}
