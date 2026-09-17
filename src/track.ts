// コース: ウェイポイント → Catmull-Rom スプライン → 等間隔サンプル
import * as THREE from 'three';
import { ROAD_WIDTH, COURSE_PATH } from './geo';
import { isJa } from './i18n';
import type { Terrain } from './terrain';
import { makeRoadTexture, makeCheckerTexture, makeCurbTexture, makeSignTexture, makeBannerTexture } from './textures';

export interface Nearest {
  idx: number;
  s: number;
  lateral: number; // 左が正
  dist: number;
}

const STEP = 2; // サンプル間隔 (m)

export class Track {
  n = 0;
  px!: Float32Array; py!: Float32Array; pz!: Float32Array;
  tx!: Float32Array; tz!: Float32Array; // 単位接線 (xz)
  nx!: Float32Array; nz!: Float32Array; // 左法線 (xz)
  ss!: Float32Array; // 累積距離
  bridge!: Uint8Array; // 水面上 (橋) か
  elev!: Float32Array; // 高架のかさ上げ量 (m)。0 なら地上
  length = 0;
  halfWidth = ROAD_WIDTH / 2;
  /**
   * name  = コース上の看板の主表記 (選んだ言語)
   * sub   = その下に小さく出すもう一方の言語
   * short = 地図に描く短い名前 (選んだ言語)
   */
  labels: { idx: number; name: string; sub: string; short: string }[] = [];
  private hash = new Map<number, number[]>();
  private readonly HCELL = 30;

  private terrain!: Terrain;

  constructor(terrain: Terrain) {
    this.terrain = terrain;
    // 走行線は PLATEAU の道路面の上を通るよう事前に探索した経路をそのまま使う
    const n = COURSE_PATH.points.length;
    this.n = n;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.tx = new Float32Array(n); this.tz = new Float32Array(n);
    this.nx = new Float32Array(n); this.nz = new Float32Array(n);
    this.ss = new Float32Array(n);
    this.bridge = new Uint8Array(n);
    for (let i = 0; i < n; i++) { this.px[i] = COURSE_PATH.points[i][0]; this.pz[i] = COURSE_PATH.points[i][1]; }
    // 接線・法線・累積距離
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, k = (i - 1 + n) % n;
      let dx = this.px[j] - this.px[k], dz = this.pz[j] - this.pz[k];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      this.tx[i] = dx; this.tz[i] = dz;
      this.nx[i] = dz; this.nz[i] = -dx;
      this.ss[i] = s;
      s += Math.hypot(this.px[j] - this.px[i], this.pz[j] - this.pz[i]);
    }
    this.length = s;
    // 標高: 地形をサンプル、水面(橋)は両岸から補間、平滑化
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let water = 0;
      for (const off of [-6, 0, 6]) if (terrain.isWater(this.px[i] + this.nx[i] * off, this.pz[i] + this.nz[i] * off)) water++;
      const h = terrain.heightAt(this.px[i], this.pz[i]);
      if (water >= 1 || h === null) { raw[i] = NaN; this.bridge[i] = 1; } else raw[i] = h;
    }
    // 橋区間を拡張 (前後 12m) して欄干を長めに
    const b2 = new Uint8Array(this.bridge);
    for (let i = 0; i < n; i++) if (this.bridge[i]) for (let d = -6; d <= 6; d++) b2[(i + d + n) % n] = 1;
    this.bridge = b2;
    // NaN 補間 (円環)。探索は補間前のコピー (src) に対して行う。補間済みの raw を
    // 見ると、直前に持ち上げた値を岸の高さとして再利用して桁が積み上がり、
    // 橋の途中で 10m 以上せり上がってしまう。
    // 岸の高さは水際 (DEM は護岸の斜面で低い) ではなく、その手前 24m の最高点
    // (堤防上の道路面) を使う。
    const src = Float32Array.from(raw);
    const bankLevel = (k: number, step: number) => {
      let m = -Infinity;
      for (let d = 0; d < 12; d++) { const v = src[(k + step * d + n) % n]; if (!Number.isNaN(v) && v > m) m = v; }
      return m === -Infinity ? 3 : m;
    };
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(src[i])) continue;
      let a = i, b = i, la = 0, lb = 0;
      while (Number.isNaN(src[a]) && la < n) { a = (a - 1 + n) % n; la++; }
      while (Number.isNaN(src[b]) && lb < n) { b = (b + 1) % n; lb++; }
      const hmax = Math.max(bankLevel(a, -1), bankLevel(b, 1));
      // 橋はアーチ状に少し持ち上げる
      const t = la / (la + lb);
      raw[i] = hmax + Math.sin(t * Math.PI) * 0.8;
    }
    // 移動平均 2 回 (窓 ±20 サンプル = 40m)
    let cur = raw;
    for (let pass = 0; pass < 3; pass++) {
      const out = new Float32Array(n);
      const R = 20;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let d = -R; d <= R; d++) sum += cur[(i + d + n) % n];
        out[i] = sum / (2 * R + 1);
      }
      cur = out;
    }
    // 平滑化で地面 (DEM) より低くなった所を持ち上げる。DEM に橋の桁面などの局所的な
    // 盛り上がりがあると移動平均で削れ、地形が路面を突き抜けて見える (駅前大橋など)。
    // 地面より下にはならないよう下限を掛け、できた段差は短い窓で慣らす。
    // 慣らすとまた下回るので何度か繰り返し、最後にもう一度下限を掛ける。
    // 下限で急な山ができた所 (護岸・堤防) は、前後を持ち上げて勾配を 5% 以下に抑える。
    const floor = (v: Float32Array) => { for (let i = 0; i < n; i++) if (v[i] < raw[i] + 0.05) v[i] = raw[i] + 0.05; };
    const limitSlope = (v: Float32Array, maxStep: number) => {
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i <= n; i++) { const k = i % n, p = i - 1; if (v[k] < v[p] - maxStep) v[k] = v[p] - maxStep; }
        for (let i = n - 2; i >= -1; i--) { const k = (i + n) % n, q = (i + 1 + n) % n; if (v[k] < v[q] - maxStep) v[k] = v[q] - maxStep; }
      }
    };
    const MAX_STEP = 0.05 * STEP;
    for (let pass = 0; pass < 3; pass++) {
      floor(cur); limitSlope(cur, MAX_STEP);
      const out = new Float32Array(n);
      const R = 6;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let d = -R; d <= R; d++) sum += cur[(i + d + n) % n];
        out[i] = sum / (2 * R + 1);
      }
      cur = out;
    }
    floor(cur); limitSlope(cur, MAX_STEP);
    // 高架区間 (実在しない新設道路) のかさ上げ量。経路の印を平滑化してスロープにする
    this.elev = new Float32Array(n);
    {
      // course_path.json の elevated はメートル単位のかさ上げ量
      let raw = Array.from(COURSE_PATH.elevated, v => v);
      for (let pass = 0; pass < 2; pass++) {
        const R = 4, out = new Array<number>(n);
        for (let i = 0; i < n; i++) {
          let sum = 0;
          for (let d = -R; d <= R; d++) sum += raw[this.wrapRaw(i + d, n)];
          out[i] = sum / (2 * R + 1);
        }
        raw = out;
      }
      for (let i = 0; i < n; i++) this.elev[i] = raw[i];
    }
    for (let i = 0; i < n; i++) this.py[i] = cur[i] + 0.35 + this.elev[i];
    // 空間ハッシュ
    for (let i = 0; i < n; i++) {
      const key = this.hkey(this.px[i], this.pz[i]);
      let arr = this.hash.get(key);
      if (!arr) { arr = []; this.hash.set(key, arr); }
      arr.push(i);
    }
    // ラベル (経路上の位置は build_course.mjs が算出済み)
    for (const l of COURSE_PATH.labels) {
      if (!l.label) continue;
      // 看板は選んだ言語を大きく、もう一方を副題に出す (切り替えても迷わない)
      const en = l.en ?? l.name;
      this.labels.push({
        idx: this.wrap(l.idx),
        name: isJa ? l.name : en,
        sub: isJa ? en : l.name,
        short: isJa ? (l.short ?? l.name) : en,
      });
    }
  }

  private hkey(x: number, z: number) {
    return (Math.floor(x / this.HCELL) + 5000) * 20000 + (Math.floor(z / this.HCELL) + 5000);
  }

  wrap(i: number) { return ((i % this.n) + this.n) % this.n; }
  private wrapRaw(i: number, n: number) { return ((i % n) + n) % n; }

  /** 最寄りサンプルと横方向オフセット。hint があれば局所探索 */
  nearest(x: number, z: number, hint = -1, full = true): Nearest {
    let best = -1, bestD = Infinity;
    const consider = (i: number) => {
      const dx = x - this.px[i], dz = z - this.pz[i];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    };
    if (hint >= 0) {
      for (let d = -40; d <= 40; d++) consider(this.wrap(hint + d));
      if (bestD > 60 * 60) { best = -1; bestD = Infinity; }
    }
    if (best < 0) {
      const cx = Math.floor(x / this.HCELL), cz = Math.floor(z / this.HCELL);
      for (let r = 0; r <= 6 && best < 0; r++) {
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const arr = this.hash.get((cx + di + 5000) * 20000 + (cz + dj + 5000));
          if (arr) for (const i of arr) consider(i);
        }
      }
      if (best < 0) {
        if (!full) return { idx: -1, s: 0, lateral: Infinity, dist: Infinity };
        for (let i = 0; i < this.n; i += 4) consider(i);
      }
    }
    // 接線方向に射影して s を補正
    const dx = x - this.px[best], dz = z - this.pz[best];
    const along = dx * this.tx[best] + dz * this.tz[best];
    const lateral = dx * this.nx[best] + dz * this.nz[best];
    let s = this.ss[best] + along;
    if (s < 0) s += this.length; if (s >= this.length) s -= this.length;
    return { idx: best, s, lateral, dist: Math.sqrt(bestD) };
  }

  /** 距離 s (m) → サンプル index (小数) */
  idxAtS(s: number) {
    s = ((s % this.length) + this.length) % this.length;
    return this.wrap(Math.round(s / STEP));
  }

  pointAt(idx: number, lateral: number, out = new THREE.Vector3()) {
    const i = this.wrap(Math.round(idx));
    return out.set(this.px[i] + this.nx[i] * lateral, this.py[i], this.pz[i] + this.nz[i] * lateral);
  }

  heightAtIdx(fi: number) {
    const i0 = this.wrap(Math.floor(fi)), i1 = this.wrap(i0 + 1), t = fi - Math.floor(fi);
    return this.py[i0] * (1 - t) + this.py[i1] * t;
  }

  /**
   * 建物のフットプリントがコース帯に掛かるか。
   * 高架区間は建物の上を通るので、桁より低い建物は残す。
   */
  blocks(ring: number[], margin: number, height = 1e9): boolean {
    const lim = this.halfWidth + margin;
    const clears = (i: number) => this.elev[i] > 1.5 && height < this.py[i] - 2.4 - this.terrain.groundHeight(this.px[i], this.pz[i]);
    // 重心が遠ければ即除外 (全探索を避ける)
    let cx = 0, cz = 0; const m = ring.length / 2;
    for (let k = 0; k < ring.length; k += 2) { cx += ring[k]; cz += ring[k + 1]; }
    const nr = this.nearest(cx / m, cz / m, -1, false);
    if (nr.idx < 0 || nr.dist > 120) return false;
    const hits = (x: number, z: number, hint: number) => {
      const p = this.nearest(x, z, hint);
      return Math.abs(p.lateral) < lim && p.dist < lim + 4 && !clears(p.idx);
    };
    if (hits(cx / m, cz / m, nr.idx)) return true;
    // 頂点 + 辺の中点 (局所探索)
    for (let k = 0; k < ring.length; k += 2) {
      const k2 = (k + 2) % ring.length;
      if (hits(ring[k], ring[k + 1], nr.idx)) return true;
      if (hits((ring[k] + ring[k2]) / 2, (ring[k + 1] + ring[k2 + 1]) / 2, nr.idx)) return true;
    }
    return false;
  }

  /** 地面テクスチャにコース帯 (路肩) を描く */
  drawMask(ctx: CanvasRenderingContext2D, sx: number, sz: number, x0: number, z0: number) {
    ctx.strokeStyle = '#6a6a6e';
    ctx.lineWidth = (ROAD_WIDTH + 8) * sx;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // 高架区間は空中を通るので地面には描かない
    let drawing = false;
    for (let i = 0; i <= this.n; i += 2) {
      const k = this.wrap(i);
      if (this.elev[k] > 1.5) { if (drawing) { ctx.stroke(); drawing = false; } continue; }
      const X = (this.px[k] - x0) * sx, Z = (this.pz[k] - z0) * sz;
      if (!drawing) { ctx.beginPath(); ctx.moveTo(X, Z); drawing = true; } else ctx.lineTo(X, Z);
    }
    if (drawing) ctx.stroke();
  }

  /** 路面・縁石・欄干・看板のメッシュ */
  buildMesh(): THREE.Group {
    const g = new THREE.Group();
    const n = this.n, hw = this.halfWidth;
    // ---- 路面リボン ----
    const pos = new Float32Array((n + 1) * 2 * 3), uv = new Float32Array((n + 1) * 2 * 2);
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const k = this.wrap(i);
      const lx = this.px[k] + this.nx[k] * hw, lz = this.pz[k] + this.nz[k] * hw;
      const rx = this.px[k] - this.nx[k] * hw, rz = this.pz[k] - this.nz[k] * hw;
      const y = this.py[k];
      pos.set([lx, y, lz, rx, y, rz], i * 6);
      const v = (i * STEP) / 20;
      uv.set([0, v, 1, v], i * 4);
      if (i < n) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const road = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: makeRoadTexture() }));
    road.receiveShadow = true;
    g.add(road);

    // ---- 橋の床板 (水面上) ----
    const deckGeo = this.ribbon(hw + 1.5, -0.9, 1, i => this.bridge[i] === 1);
    if (deckGeo) {
      const deck = new THREE.Mesh(deckGeo, new THREE.MeshLambertMaterial({ color: 0x8d8d90 }));
      deck.castShadow = true; deck.receiveShadow = true; g.add(deck);
    }

    // ---- 高架道路 (新設区間) ----
    g.add(this.buildViaduct());

    // ---- 縁石 (両側) ----
    const curbTex = makeCurbTexture();
    for (const side of [1, -1]) {
      const cg = this.strip(side * (hw + 0.1), side * (hw + 0.9), 0, 0.25, 2);
      const curb = new THREE.Mesh(cg, new THREE.MeshLambertMaterial({ map: curbTex }));
      curb.receiveShadow = true;
      g.add(curb);
    }
    // ---- ガードレール / 欄干 (両側, 橋は高め) ----
    const railMat = new THREE.MeshLambertMaterial({ color: 0xd9dde3 });
    const postMat = new THREE.MeshLambertMaterial({ color: 0x6f7780 });
    for (const side of [1, -1]) {
      const rg = this.strip(side * (hw + 0.9), side * (hw + 1.05), 0.55, 0.85, 1);
      const rail = new THREE.Mesh(rg, railMat); rail.castShadow = true; g.add(rail);
      const bg = this.ribbon(hw + 1.0, 0.85, 1.5, i => this.bridge[i] === 1, side);
      if (bg) { const br = new THREE.Mesh(bg, new THREE.MeshLambertMaterial({ color: 0x9aa4ad, transparent: true, opacity: 0.85, side: THREE.DoubleSide })); g.add(br); }
      // 橋の側面 (桁)
      const sk = this.ribbon(hw + 1.5, -1.6, 1.6, i => this.bridge[i] === 1, side);
      if (sk) { const skirt = new THREE.Mesh(sk, new THREE.MeshLambertMaterial({ color: 0x7d838a, side: THREE.DoubleSide })); skirt.castShadow = true; g.add(skirt); }
    }
    // 支柱 (InstancedMesh)
    const postCount = Math.floor(n / 4) * 2;
    const postGeo = new THREE.BoxGeometry(0.16, 0.9, 0.16);
    const posts = new THREE.InstancedMesh(postGeo, postMat, postCount);
    const m = new THREE.Matrix4();
    let pi = 0;
    for (let i = 0; i < n; i += 4) for (const side of [1, -1]) {
      const off = side * (hw + 0.97);
      m.makeTranslation(this.px[i] + this.nx[i] * off, this.py[i] + 0.45, this.pz[i] + this.nz[i] * off);
      posts.setMatrixAt(pi++, m);
    }
    posts.castShadow = true;
    g.add(posts);

    // ---- スタートライン ----
    const sl = this.strip(-hw, hw, 0.02, 0.02, 1, 0, 3);
    const slMesh = new THREE.Mesh(sl, new THREE.MeshBasicMaterial({ map: makeCheckerTexture() }));
    g.add(slMesh);
    // スタートゲート
    g.add(this.gate(0, makeBannerTexture(), 4.5, hw + 2));
    // ---- 地名看板 ----
    for (const l of this.labels) {
      if (l.idx < 30 || l.idx > n - 30) continue; // スタートゲートと重なる
      g.add(this.gate(l.idx, makeSignTexture(l.name, l.sub), 2.2, hw + 2));
    }
    return g;
  }

  /** 新設の高架道路: 桁・側面・橋脚・壁高欄 */
  private buildViaduct(): THREE.Group {
    const g = new THREE.Group();
    const hw = this.halfWidth;
    const up = (i: number) => this.elev[i] > 1.5;
    const deckMat = new THREE.MeshLambertMaterial({ color: 0xb0b5ba });
    const sideMat = new THREE.MeshLambertMaterial({ color: 0x9aa0a6 });
    // 桁の底面と側面
    const bottom = this.ribbon(hw + 1.4, -1.9, 1, up);
    if (bottom) { const m = new THREE.Mesh(bottom, deckMat); m.receiveShadow = true; g.add(m); }
    for (const side of [1, -1]) {
      const s = this.ribbon(hw + 1.4, -1.9, 1.9, up, side);
      if (s) { const m = new THREE.Mesh(s, sideMat); m.castShadow = true; g.add(m); }
      // 壁高欄
      const p = this.ribbon(hw + 1.4, 0.0, 1.15, up, side);
      if (p) { const m = new THREE.Mesh(p, new THREE.MeshLambertMaterial({ color: 0xd3d7db, side: THREE.DoubleSide })); m.castShadow = true; g.add(m); }
    }
    // 橋脚 (30m 間隔)
    const piers: THREE.Matrix4[] = [];
    for (let i = 0; i < this.n; i++) {
      if (!up(i) || this.ss[i] % 30 > 2) continue;
      const ground = Math.max(this.terrain.groundHeight(this.px[i], this.pz[i]), -1);
      const h = this.py[i] - 1.9 - ground;
      if (h < 2) continue;
      piers.push(new THREE.Matrix4()
        .makeTranslation(this.px[i], ground + h / 2, this.pz[i])
        .multiply(new THREE.Matrix4().makeRotationY(Math.atan2(this.tx[i], this.tz[i])))
        .multiply(new THREE.Matrix4().makeScale(1, h / 10, 1)));
    }
    if (piers.length) {
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(3.6, 10, 2.6), new THREE.MeshLambertMaterial({ color: 0xa9aeb4 }), piers.length);
      piers.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.castShadow = true; inst.receiveShadow = true;
      g.add(inst);
    }
    return g;
  }

  /** 横位置 a..b, 高さ ya..yb の帯 (上面のみ) */
  private strip(a: number, b: number, ya: number, yb: number, texPer: number, from = 0, count = -1): THREE.BufferGeometry {
    const n = count < 0 ? this.n : count;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const k = this.wrap(from + i);
      pos.push(this.px[k] + this.nx[k] * a, this.py[k] + ya, this.pz[k] + this.nz[k] * a);
      pos.push(this.px[k] + this.nx[k] * b, this.py[k] + yb, this.pz[k] + this.nz[k] * b);
      const v = (i * STEP) / texPer;
      uv.push(v, 0, v, 1);
      if (i < n) { const q = i * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /** 条件を満たす区間だけの帯 (side=0 なら路面全幅, side=±1 なら片側の垂直板) */
  private ribbon(hw: number, y0: number, yh: number, pred: (i: number) => boolean, side = 0): THREE.BufferGeometry | null {
    const pos: number[] = [], idx: number[] = [];
    let vi = 0, any = false;
    for (let i = 0; i < this.n; i++) {
      if (!pred(i) || !pred(this.wrap(i + 1))) continue;
      any = true;
      for (const k of [i, this.wrap(i + 1)]) {
        if (side === 0) {
          pos.push(this.px[k] + this.nx[k] * hw, this.py[k] + y0, this.pz[k] + this.nz[k] * hw);
          pos.push(this.px[k] - this.nx[k] * hw, this.py[k] + y0, this.pz[k] - this.nz[k] * hw);
        } else {
          const off = side * hw;
          pos.push(this.px[k] + this.nx[k] * off, this.py[k] + y0, this.pz[k] + this.nz[k] * off);
          pos.push(this.px[k] + this.nx[k] * off, this.py[k] + y0 + yh, this.pz[k] + this.nz[k] * off);
        }
      }
      idx.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
      vi += 4;
    }
    if (!any) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /** 道路をまたぐ看板ゲート */
  private gate(idx: number, tex: THREE.Texture, height: number, halfSpan: number): THREE.Group {
    const g = new THREE.Group();
    const i = this.wrap(idx);
    const x = this.px[i], y = this.py[i], z = this.pz[i];
    const angle = Math.atan2(this.tx[i], this.tz[i]);
    g.position.set(x, y, z);
    g.rotation.y = angle;
    // ローカル: 進行方向 = +z, 左 = +x
    const postGeo = new THREE.CylinderGeometry(0.25, 0.3, 7.5, 10);
    const postMat = new THREE.MeshLambertMaterial({ color: 0x3a3f47 });
    for (const s of [1, -1]) { const p = new THREE.Mesh(postGeo, postMat); p.position.set(s * halfSpan, 3.75, 0); p.castShadow = true; g.add(p); }
    const board = new THREE.Mesh(new THREE.PlaneGeometry(halfSpan * 2 + 0.6, height), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    board.position.set(0, 7.5 - height / 2 + 0.5, 0);
    board.rotation.y = Math.PI; // 進行方向手前から読めるように
    g.add(board);
    return g;
  }
}
