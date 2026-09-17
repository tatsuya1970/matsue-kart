// 緑地 — 松江城山公園・宍道湖岸の公園の芝生と樹木 (濠を持つ公園にも対応)。
//
// PLATEAU には公園の輪郭が無い。建築物 (bldg)・道路 (tran)・地形 (dem) には
// 公園が含まれず、土地利用 (luse) は 250m メッシュを塗っただけなので輪郭に使えない。
// そのため data/parks.json に OpenStreetMap の輪郭を置き、次の 3 段で再現する。
//
//   1. carve: DEM を掘って濠にし (moat があるとき)、公園内で誤って水面と判定されている低地は埋める
//   2. draw:  地面テクスチャに芝と水面を描く (道路とコースはこの上に描かれる)
//   3. build: 濠の水面・石垣 (moat があるとき) と、樹木のメッシュを作る
//
// 松江城の内堀 (堀川) は DEM に水面として入っているので moat は null にしてある。
import * as THREE from 'three';
import parkData from '../data/parks.json';
import { llToXZ, COURSE_PATH, ROAD_WIDTH, rng } from './geo';
import { landmarkBlocksBuilding } from './landmarks';
import type { Terrain } from './terrain';
import type { Track } from './track';
import type { BuildingsData } from './buildings';

type Ring = number[]; // [x0, z0, x1, z1, ...] ワールド座標

interface Area {
  name: string;
  kind: 'lawn' | 'grove';
  trees: number;
  ring: Ring;
}

/** 走行線から carve/植樹を遠ざける距離 (m) */
const COURSE_CLEAR = ROAD_WIDTH / 2 + 7;

function toRing(ll: [number, number][]): Ring {
  const out: number[] = [];
  for (const [lat, lon] of ll) { const [x, z] = llToXZ(lat, lon); out.push(x, z); }
  return out;
}

function inside(ring: Ring, x: number, z: number): boolean {
  let c = false;
  const m = ring.length / 2;
  for (let i = 0, j = m - 1; i < m; j = i++) {
    const xi = ring[i * 2], zi = ring[i * 2 + 1], xj = ring[j * 2], zj = ring[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

function bbox(ring: Ring) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]);
    z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]);
  }
  return { x0, x1, z0, z1 };
}

/** 走行線 (2m 間隔の点列) の近傍判定。Track を作る前でも使えるよう COURSE_PATH を直接見る */
function courseIndex() {
  const CELL = 40;
  const grid = new Map<number, number[]>();
  const pts = COURSE_PATH.points;
  const key = (i: number, j: number) => (i + 4000) * 20000 + (j + 4000);
  pts.forEach(([x, z], k) => {
    const g = key(Math.floor(x / CELL), Math.floor(z / CELL));
    let a = grid.get(g);
    if (!a) { a = []; grid.set(g, a); }
    a.push(k);
  });
  return (x: number, z: number, limit: number) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    const r = Math.ceil(limit / CELL);
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = grid.get(key(ci + di, cj + dj));
      if (!a) continue;
      for (const k of a) {
        const dx = pts[k][0] - x, dz = pts[k][1] - z;
        if (dx * dx + dz * dz < limit * limit) return true;
      }
    }
    return false;
  };
}

export class Parks {
  readonly areas: Area[] = [];
  readonly moatInner: Ring | null = null;
  readonly moatOuter: Ring | null = null;
  readonly waterLevel: number = 0;
  private readonly bedLevel: number = 0;
  private terrain: Terrain;

  constructor(terrain: Terrain) {
    this.terrain = terrain;
    const d = parkData as any;
    for (const a of d.areas) this.areas.push({ name: a.name, kind: a.kind, trees: a.trees, ring: toRing(a.ring) });
    if (d.moat) {
      this.moatInner = toRing(d.moat.inner);
      this.moatOuter = toRing(d.moat.outer);
      this.waterLevel = d.moat.waterLevel;
      this.bedLevel = d.moat.bedLevel;
    }
  }

  /** 濠の帯 (outer の内側かつ inner の外側) か */
  inMoat(x: number, z: number): boolean {
    if (!this.moatOuter || !this.moatInner) return false;
    return inside(this.moatOuter, x, z) && !inside(this.moatInner, x, z);
  }

  /**
   * DEM を書き換える。Track を作る前に呼ぶこと (走行線の標高にも効かせるため)。
   *  - 濠の帯は堀底まで掘り下げる
   *  - 公園内で水面と判定されている低地は周囲の陸地の高さで埋める
   *    (中央公園の一帯は平坦で標高が低く、地形生成が河川と誤判定する)
   * どちらも走行線の近くは触らない。道路が沈んだり水没したりするのを避ける。
   */
  carve(): void {
    const { w, h, cell, x0, z0, water, scale } = this.terrain.meta;
    const data = this.terrain.data;
    const nearCourse = courseIndex();
    const idx = (x: number, z: number) => {
      const i = Math.round((x - x0) / cell), j = Math.round((z - z0) / cell);
      return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
    };
    // ---- 濠を掘り、城内は水面より高く均す ----
    // 城内の DEM は天守のまわりだけが高く、北辺の東寄りなどは 2-3m しかない。
    // そのまま水面 (2.5m) を張ると城内が水没して見えるので、内側は一段持ち上げる。
    let dug = 0, raised = 0;
    if (this.moatOuter && this.moatInner) {
      const b = bbox(this.moatOuter);
      const bed = Math.round(this.bedLevel / scale);
      const yard = Math.round((this.waterLevel + 2.2) / scale);
      for (let z = b.z0; z <= b.z1; z += cell) for (let x = b.x0; x <= b.x1; x += cell) {
        const k = idx(x, z);
        if (k < 0) continue;
        if (nearCourse(x, z, COURSE_CLEAR)) continue;
        if (this.inMoat(x, z)) {
          if (data[k] === water || data[k] > bed) { data[k] = bed; dug++; }
        } else if (inside(this.moatInner!, x, z)) {
          if (data[k] === water || data[k] < yard) { data[k] = yard; raised++; }
        }
      }
    }
    // ---- 公園内の誤った水面を埋める ----
    let filled = 0;
    for (const a of this.areas) {
      const b = bbox(a.ring);
      // 埋める高さ: 輪郭の内側にある陸地セルの中央値
      const land: number[] = [];
      for (let z = b.z0; z <= b.z1; z += cell * 4) for (let x = b.x0; x <= b.x1; x += cell * 4) {
        if (!inside(a.ring, x, z)) continue;
        const k = idx(x, z);
        if (k >= 0 && data[k] !== water) land.push(data[k]);
      }
      if (land.length < 8) continue;
      land.sort((p, q) => p - q);
      const med = land[land.length >> 1];
      for (let z = b.z0; z <= b.z1; z += cell) for (let x = b.x0; x <= b.x1; x += cell) {
        if (!inside(a.ring, x, z)) continue;
        if (this.inMoat(x, z)) continue;
        if (nearCourse(x, z, COURSE_CLEAR)) continue;
        const k = idx(x, z);
        if (k >= 0 && data[k] === water) { data[k] = med; filled++; }
      }
    }
    console.log(`公園: 濠 ${dug} セルを掘り、城内 ${raised} セルを均し、誤判定の水面 ${filled} セルを埋めました`);
  }

  /** 地面テクスチャに芝と濠を描く (道路・コースより先に呼ぶ) */
  draw(ctx: CanvasRenderingContext2D, sx: number, sz: number, x0: number, z0: number): void {
    const path = (ring: Ring) => {
      ctx.beginPath();
      for (let i = 0; i < ring.length; i += 2) {
        const X = (ring[i] - x0) * sx, Z = (ring[i + 1] - z0) * sz;
        if (i === 0) ctx.moveTo(X, Z); else ctx.lineTo(X, Z);
      }
      ctx.closePath();
    };
    for (const a of this.areas) {
      ctx.fillStyle = a.kind === 'grove' ? '#6d8b4e' : '#83a45e';
      path(a.ring); ctx.fill();
      // 樹冠のムラ (上から見たときに単色にならないように)
      const b = bbox(a.ring);
      const rand = rng(a.ring.length * 7919 + 13);
      for (let k = 0; k < 900; k++) {
        const x = b.x0 + rand() * (b.x1 - b.x0), z = b.z0 + rand() * (b.z1 - b.z0);
        if (!inside(a.ring, x, z)) continue;
        ctx.fillStyle = `rgba(${70 + rand() * 40 | 0},${100 + rand() * 45 | 0},${55 + rand() * 30 | 0},0.5)`;
        ctx.beginPath();
        ctx.arc((x - x0) * sx, (z - z0) * sz, (3 + rand() * 9) * sx, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 濠 (外周を塗ってから内側を芝で塗り戻す)。堀底は水を透かして見えるので暗い泥色
    if (this.moatOuter && this.moatInner) {
      ctx.fillStyle = '#3b4c46';
      path(this.moatOuter); ctx.fill();
      ctx.fillStyle = '#6d8b4e';
      path(this.moatInner); ctx.fill();
    }
  }

  /** 濠に掛かる PLATEAU 建物は除く (水面に建物が立たないように) */
  blocksBuilding(ring: number[]): boolean {
    for (let k = 0; k + 1 < ring.length; k += 2) if (this.inMoat(ring[k], ring[k + 1])) return true;
    return false;
  }

  /** 濠の水面・石垣と樹木 */
  build(buildings: BuildingsData, track: Track): THREE.Group {
    const g = new THREE.Group();
    if (this.moatOuter && this.moatInner) g.add(this.buildMoat(this.moatInner, this.moatOuter));
    g.add(this.buildTrees(buildings, track));
    return g;
  }

  /** 濠: 水面の帯 + 内外の石垣 */
  private buildMoat(moatInner: Ring, moatOuter: Ring): THREE.Group {
    const g = new THREE.Group();
    const n = moatInner.length / 2;
    // ---- 水面 (inner と outer の間を帯で張る) ----
    const pos: number[] = [], idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const k = (i % n) * 2;
      pos.push(moatInner[k], this.waterLevel, moatInner[k + 1]);
      pos.push(moatOuter[k], this.waterLevel, moatOuter[k + 1]);
      if (i < n) { const q = i * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const waterMat = new THREE.MeshPhongMaterial({
      color: 0x35707a, shininess: 70, specular: 0x5a8b96,
      transparent: true, opacity: 0.74, side: THREE.DoubleSide,
    });
    const water = new THREE.Mesh(geo, waterMat);
    water.renderOrder = 1;
    g.add(water);
    // ---- 石垣 (水面から岸の高さまでの垂直な帯) ----
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x8b8578, side: THREE.DoubleSide });
    for (const ring of [moatInner, moatOuter]) {
      const p: number[] = [], ix: number[] = [];
      for (let i = 0; i <= n; i++) {
        const k = (i % n) * 2;
        const x = ring[k], z = ring[k + 1];
        // 岸の高さ: 帯の中は掘ってあるので、帯の外側 (中心と反対) 8m の地形を見る
        const cx = (moatInner[k] + moatOuter[k]) / 2, cz = (moatInner[k + 1] + moatOuter[k + 1]) / 2;
        let dx = x - cx, dz = z - cz;
        const l = Math.hypot(dx, dz) || 1;
        dx = (dx / l) * 8; dz = (dz / l) * 8;
        const top = Math.max(this.terrain.groundHeight(x + dx, z + dz), this.waterLevel + 0.5);
        p.push(x, this.waterLevel - 1.4, z);
        p.push(x, top, z);
        if (i < n) { const q = i * 2; ix.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
      }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      wg.setIndex(ix);
      wg.computeVertexNormals();
      const wall = new THREE.Mesh(wg, stoneMat);
      wall.receiveShadow = true;
      g.add(wall);
    }
    return g;
  }

  /**
   * 樹木。輪郭の内側に決定的な乱数で撒き、水面・走行線・建物の上は避ける。
   * 幹と樹冠 2 種を InstancedMesh にまとめる (500 本前後でもドローコールは 3)。
   */
  private buildTrees(buildings: BuildingsData, track: Track): THREE.Group {
    const g = new THREE.Group();
    // 建物の占有 (重心 + 外接半径) を格子に入れて当たり判定を軽くする
    const BCELL = 60;
    const bgrid = new Map<number, { x: number; z: number; r: number }[]>();
    const bkey = (i: number, j: number) => (i + 4000) * 20000 + (j + 4000);
    for (const it of buildings.items) {
      const ring = it.slice(3);
      const m = ring.length / 2;
      if (m < 3) continue;
      let cx = 0, cz = 0;
      for (let k = 0; k < m; k++) { cx += ring[k * 2]; cz += ring[k * 2 + 1]; }
      cx /= m; cz /= m;
      let r = 0;
      for (let k = 0; k < m; k++) r = Math.max(r, Math.hypot(ring[k * 2] - cx, ring[k * 2 + 1] - cz));
      const key = bkey(Math.floor(cx / BCELL), Math.floor(cz / BCELL));
      let a = bgrid.get(key);
      if (!a) { a = []; bgrid.set(key, a); }
      a.push({ x: cx, z: cz, r });
    }
    const onBuilding = (x: number, z: number) => {
      const ci = Math.floor(x / BCELL), cj = Math.floor(z / BCELL);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = bgrid.get(bkey(ci + di, cj + dj));
        if (!a) continue;
        for (const b of a) if (Math.hypot(b.x - x, b.z - z) < b.r + 3) return true;
      }
      return false;
    };

    interface Tree { x: number; y: number; z: number; h: number; rot: number; cone: boolean }
    const trees: Tree[] = [];
    const SPACING = 9; // 最小間隔 (格子で担保する)
    for (let ai = 0; ai < this.areas.length; ai++) {
      const a = this.areas[ai];
      const b = bbox(a.ring);
      const rand = rng(104729 + ai * 7919 + a.ring.length);
      const taken = new Set<number>();
      let placed = 0;
      for (let tries = 0; tries < a.trees * 60 && placed < a.trees; tries++) {
        const x = b.x0 + rand() * (b.x1 - b.x0), z = b.z0 + rand() * (b.z1 - b.z0);
        const cellKey = Math.floor(x / SPACING) * 100000 + Math.floor(z / SPACING);
        if (taken.has(cellKey)) continue;
        if (!inside(a.ring, x, z)) continue;
        if (this.inMoat(x, z)) continue;
        if (this.terrain.isWater(x, z)) continue;
        const nr = track.nearest(x, z);
        if (Math.abs(nr.lateral) < track.halfWidth + 6 && nr.dist < track.halfWidth + 10) continue;
        if (onBuilding(x, z)) continue;
        // ランドマークの敷地 (ピースウィングは中央公園の中に建つ) には植えない。
        // 1 点だけの ring を渡すとその点の判定になる。
        if (landmarkBlocksBuilding([x, z])) continue;
        taken.add(cellKey);
        placed++;
        trees.push({
          x, y: this.terrain.groundHeight(x, z) - 0.2, z,
          h: 5.5 + rand() * 4.5,
          rot: rand() * Math.PI * 2,
          cone: rand() < (a.kind === 'grove' ? 0.35 : 0.2),
        });
      }
    }
    if (!trees.length) return g;

    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b5745 });
    const leafMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 1, 6);
    trunkGeo.translate(0, 0.5, 0);
    const roundGeo = new THREE.IcosahedronGeometry(1, 0);
    const coneGeo = new THREE.ConeGeometry(1, 2.4, 7);
    coneGeo.translate(0, 1.2, 0);

    const round = trees.filter(t => !t.cone), cones = trees.filter(t => t.cone);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const crownR = new THREE.InstancedMesh(roundGeo, leafMat, Math.max(1, round.length));
    const crownC = new THREE.InstancedMesh(coneGeo, leafMat.clone(), Math.max(1, cones.length));
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    trees.forEach((t, i) => {
      m.makeTranslation(t.x, t.y, t.z)
        .multiply(new THREE.Matrix4().makeRotationY(t.rot))
        .multiply(new THREE.Matrix4().makeScale(1, t.h * 0.45, 1));
      trunks.setMatrixAt(i, m);
    });
    const setCrown = (mesh: THREE.InstancedMesh, list: Tree[], rad: number, lift: number) => {
      list.forEach((t, i) => {
        const r = t.h * rad;
        m.makeTranslation(t.x, t.y + t.h * lift, t.z)
          .multiply(new THREE.Matrix4().makeRotationY(t.rot))
          .multiply(new THREE.Matrix4().makeScale(r, r * 1.05, r));
        mesh.setMatrixAt(i, m);
        // 樹冠の色をばらして単調さを消す
        const v = ((t.x * 37 + t.z * 17) % 10 + 10) % 10 / 10;
        c.setRGB(0.24 + v * 0.14, 0.42 + v * 0.16, 0.18 + v * 0.1);
        mesh.setColorAt(i, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
    };
    setCrown(crownR, round, 0.32, 0.44);
    setCrown(crownC, cones, 0.26, 0.34);
    trunks.instanceMatrix.needsUpdate = true;
    trunks.castShadow = true;
    trunks.frustumCulled = false;
    g.add(trunks);
    if (round.length) g.add(crownR);
    if (cones.length) g.add(crownC);
    console.log(`公園: 樹木 ${trees.length} 本 (${this.areas.map(a => a.name).join('・')})`);
    return g;
  }
}
