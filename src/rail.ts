// 松江の鉄道 — 実在位置の線路と、実際に走る車両
//   一畑電車 北松江線: 宍道湖の北岸を国道431号と並んで走る単線。電化 (架線柱つき)。
//                      コースと踏切で交わるので、電車に接触するとスピンする
//   JR 山陰本線:       松江駅の前後は高架、浜乃木の南は地上。非電化 (気動車)
import * as THREE from 'three';
import railData from '../data/rail.json';
import { llToXZ, lerp } from './geo';
import type { Terrain } from './terrain';
import type { Track } from './track';
import { makeTrainSideTexture, makeBallastTexture, makeConcreteTexture } from './textures';

/** el: 地面からのかさ上げ (高架なら数 m、地上なら 0) */
export interface RailPoint { x: number; z: number; y: number; tx: number; tz: number; s: number; el: number; }

type Kind = 'ichibata' | 'jr';
type LL = { lat: number; lon: number; h?: number };

/** 緯度経度の折れ線を Catmull-Rom で滑らかにして等間隔サンプル (h も一緒に補間) */
function samplePath(pts: LL[], step: number): { p: THREE.Vector3; h: number }[] {
  const v = pts.map(p => { const [x, z] = llToXZ(p.lat, p.lon); return new THREE.Vector3(x, 0, z); });
  const curve = new THREE.CatmullRomCurve3(v, false, 'centripetal', 0.5);
  const n = Math.max(2, Math.floor(curve.getLength() / step));
  const out = curve.getSpacedPoints(n);
  // 高さは元の折れ線の最寄り区間から線形補間する
  return out.map(p => {
    let best = Infinity, h = 0;
    for (let i = 0; i + 1 < v.length; i++) {
      const a = v[i], b = v[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / (abx * abx + abz * abz || 1)));
      const d = (a.x + abx * t - p.x) ** 2 + (a.z + abz * t - p.z) ** 2;
      if (d < best) { best = d; h = lerp(pts[i].h ?? 0, pts[i + 1].h ?? 0, t); }
    }
    return { p, h };
  });
}

/**
 * 両端に直線の延長を足す。車両は終端で折り返さず反対の端へ回るので、
 * その入れ替わりが駅や踏切の外で起きるようにするための引き込み線。
 */
function withTail(pts: { p: THREE.Vector3; h: number }[], tailStart: number, tailEnd: number) {
  const n = pts.length;
  const ext = (from: THREE.Vector3, toward: THREE.Vector3, len: number) =>
    from.clone().sub(toward).normalize().multiplyScalar(len).add(from);
  return [
    ...(tailStart > 0 ? [{ p: ext(pts[0].p, pts[1].p, tailStart), h: pts[0].h }] : []),
    ...pts,
    ...(tailEnd > 0 ? [{ p: ext(pts[n - 1].p, pts[n - 2].p, tailEnd), h: pts[n - 1].h }] : []),
  ];
}

/** 距離 s を [0, L) に丸める (終端で反対の端へ回すため) */
function wrapS(s: number, L: number): number {
  return ((s % L) + L) % L;
}

export class RailLine {
  kind: Kind;
  pts: RailPoint[] = [];
  length = 0;
  private grid = new Map<number, number[]>();
  private static readonly CELL = 25;

  constructor(kind: Kind, raw: { p: THREE.Vector3; h: number }[], heightAt: (x: number, z: number, el: number) => number) {
    this.kind = kind;
    const n = raw.length;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const p = raw[i].p;
      const a = raw[Math.max(0, i - 1)].p, b = raw[Math.min(n - 1, i + 1)].p;
      let tx = b.x - a.x, tz = b.z - a.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      this.pts.push({ x: p.x, z: p.z, y: heightAt(p.x, p.z, raw[i].h), tx, tz, s, el: raw[i].h });
      if (i < n - 1) s += Math.hypot(raw[i + 1].p.x - p.x, raw[i + 1].p.z - p.z);
    }
    this.length = s;
    // 高さを平滑化 (地形のノイズを消す)
    const R = 6;
    const src = this.pts.map(p => p.y);
    for (let i = 0; i < n; i++) {
      let sum = 0, c = 0;
      for (let d = -R; d <= R; d++) { const j = i + d; if (j < 0 || j >= n) continue; sum += src[j]; c++; }
      this.pts[i].y = sum / c;
    }
    // 最寄り点の検索を軽くする格子 (建物の除去で数十万回呼ばれる)
    this.pts.forEach((p, i) => {
      const k = this.key(Math.floor(p.x / RailLine.CELL), Math.floor(p.z / RailLine.CELL));
      let a = this.grid.get(k);
      if (!a) { a = []; this.grid.set(k, a); }
      a.push(i);
    });
  }

  private key(i: number, j: number) { return (i + 4000) * 20000 + (j + 4000); }

  /** 距離 s の位置と向き */
  at(s: number): RailPoint {
    const n = this.pts.length;
    if (s <= 0) return this.pts[0];
    if (s >= this.length) return this.pts[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.pts[m].s <= s) lo = m; else hi = m; }
    const a = this.pts[lo], b = this.pts[hi];
    const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
    return {
      x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), y: lerp(a.y, b.y, t),
      tx: lerp(a.tx, b.tx, t), tz: lerp(a.tz, b.tz, t), s, el: lerp(a.el, b.el, t),
    };
  }

  /** 中心線からの距離 (limit より遠ければ Infinity) */
  distance(x: number, z: number, limit: number): number {
    const C = RailLine.CELL;
    const ci = Math.floor(x / C), cj = Math.floor(z / C), r = Math.ceil(limit / C);
    let best = Infinity;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = this.grid.get(this.key(ci + di, cj + dj));
      if (!a) continue;
      for (const i of a) {
        const p = this.pts[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }
}

/** 1 両の車体 */
function buildCar(len: number, width: number, height: number, nose: 'none' | 'front' | 'back', sideTex: THREE.Texture, roofColor: number, noseColor: number, pantograph: boolean): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshPhongMaterial({ map: sideTex, shininess: 55 });
  const roofMat = new THREE.MeshPhongMaterial({ color: roofColor, shininess: 20 });
  const skirtMat = new THREE.MeshPhongMaterial({ color: 0x2b2f34, shininess: 10 });
  const glassMat = new THREE.MeshPhongMaterial({ color: 0x1d2b38, shininess: 110, specular: 0x99bbdd });

  const bodyLen = nose === 'none' ? len : len - 1.2;
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, bodyLen), bodyMat);
  body.position.y = height / 2 + 0.6;
  body.position.z = nose === 'front' ? -(len - bodyLen) / 2 : nose === 'back' ? (len - bodyLen) / 2 : 0;
  g.add(body);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(width * 0.94, 0.35, bodyLen * 0.99), roofMat);
  roof.position.set(0, height + 0.72, body.position.z);
  g.add(roof);
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(width * 0.82, 0.7, bodyLen * 0.92), skirtMat);
  skirt.position.set(0, 0.5, body.position.z);
  g.add(skirt);
  if (nose !== 'none') {
    const sgn = nose === 'front' ? -1 : 1;
    const zEdge = body.position.z + sgn * bodyLen / 2;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(width, height, len - bodyLen), new THREE.MeshPhongMaterial({ color: noseColor, shininess: 60 }));
    cap.position.set(0, height / 2 + 0.6, zEdge + sgn * (len - bodyLen) / 2);
    g.add(cap);
    const wind = new THREE.Mesh(new THREE.BoxGeometry(width * 0.86, height * 0.4, 0.12), glassMat);
    wind.position.set(0, height * 0.68 + 0.6, zEdge + sgn * ((len - bodyLen) - 0.03));
    g.add(wind);
    for (const sx of [-1, 1]) {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff6d0 }));
      l.position.set(sx * width * 0.32, height * 0.3 + 0.6, zEdge + sgn * ((len - bodyLen) - 0.02));
      g.add(l);
    }
  }
  if (pantograph) {
    const pmat = new THREE.MeshPhongMaterial({ color: 0x6b7076 });
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 0.08), pmat);
    arm.position.set(0, height + 1.35, body.position.z + bodyLen * 0.25);
    arm.rotation.x = 0.5;
    g.add(arm);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(width * 0.7, 0.07, 0.12), pmat);
    bar.position.set(0, height + 1.85, body.position.z + bodyLen * 0.25 + 0.25);
    g.add(bar);
  }
  const wheelMat = new THREE.MeshPhongMaterial({ color: 0x14161a });
  for (const zz of [-bodyLen * 0.34, bodyLen * 0.34]) {
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.18, 12), wheelMat);
      w.rotation.z = Math.PI / 2;
      w.position.set(sx * 0.72, 0.43, body.position.z + zz);
      g.add(w);
    }
  }
  g.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

interface TrainDef { cars: number; carLen: number; width: number; height: number; speed: number; gap: number; pantograph: boolean; roof: number; nose: number; }
const TRAIN: Record<Kind, TrainDef> = {
  // 一畑電車 7000系 (1 両 18m、2 両編成で走る時間帯を想定)
  ichibata: { cars: 2, carLen: 18, width: 2.8, height: 3.0, speed: 15, gap: 0.5, pantograph: true, roof: 0x9aa3ab, nose: 0xf4f6f8 },
  // JR 西日本 キハ126 系 (気動車 2 両)
  jr: { cars: 2, carLen: 21, width: 2.9, height: 3.1, speed: 24, gap: 0.6, pantograph: false, roof: 0x8c949b, nose: 0xb22234 },
};

class Train {
  group = new THREE.Group();
  s: number;
  dir: number;
  speed: number;
  private carGroups: THREE.Group[] = [];
  private carEl: number[] = [];
  private line: RailLine;
  private def: TrainDef;

  constructor(line: RailLine, def: TrainDef, sideTex: THREE.Texture, s0: number, dir: number) {
    this.line = line; this.def = def; this.s = s0; this.dir = dir; this.speed = def.speed;
    for (let i = 0; i < def.cars; i++) {
      const nose = i === 0 ? (dir > 0 ? 'back' : 'front') : i === def.cars - 1 ? (dir > 0 ? 'front' : 'back') : 'none';
      const car = buildCar(def.carLen, def.width, def.height, nose as 'none' | 'front' | 'back', sideTex, def.roof, def.nose, def.pantograph);
      this.carGroups.push(car);
      this.carEl.push(0);
      this.group.add(car);
    }
  }

  /**
   * 終端で止まったり折り返したりせず、反対の端へ回して同じ向きに走り続ける。
   * 単線なので、行き違いが見えないよう上り・下りの編成は離して置く。
   * カートとの接触は電車の動きに一切影響しない (main.ts の接触処理はカートだけを回転させる)。
   */
  update(dt: number) {
    const L = this.line.length;
    this.s = wrapS(this.s + this.speed * this.dir * dt, L);
    const step = this.def.carLen + this.def.gap;
    for (let i = 0; i < this.carGroups.length; i++) {
      const cs = wrapS(this.s - this.dir * (i - (this.carGroups.length - 1) / 2) * step, L);
      const p = this.line.at(cs);
      this.carGroups[i].position.set(p.x, p.y, p.z);
      this.carGroups[i].rotation.y = Math.atan2(p.tx, p.tz);
      this.carEl[i] = p.el;
    }
  }

  /** 地上を走っている車体のおおよその占有 (接触判定用。高架の上は当たらない) */
  *segments(): Generator<{ x: number; z: number; halfLen: number; halfWid: number; ang: number }> {
    for (let i = 0; i < this.carGroups.length; i++) {
      if (this.carEl[i] > 1.5) continue;
      const c = this.carGroups[i];
      yield { x: c.position.x, z: c.position.z, halfLen: this.def.carLen / 2, halfWid: this.def.width / 2, ang: c.rotation.y };
    }
  }
}

export interface RailSystem {
  group: THREE.Group;
  lines: { ichibata: RailLine; jr: RailLine };
  update(dt: number): void;
  /** 地上を走る電車・気動車に接触したか (踏切でコースと交わる) */
  hitTrain(x: number, z: number, r: number): boolean;
  /** 建物を除去すべき軌道敷か */
  blocksBuilding(ring: number[]): boolean;
}

export function buildRail(terrain: Terrain, track: Track): RailSystem {
  const group = new THREE.Group();
  const d = railData as any;

  /** 踏切: コースの路面上なら路面の高さに合わせる */
  const onCourse = (x: number, z: number) => {
    const nr = track.nearest(x, z, -1, false);
    return nr.idx >= 0 && nr.dist < 40 && Math.abs(nr.lateral) < track.halfWidth + 5 ? nr.idx : -1;
  };
  const railHeight = (emb: number) => (x: number, z: number, el: number) => {
    const ci = onCourse(x, z);
    if (ci >= 0 && el < 1) return track.py[ci] + 0.02;
    return Math.max(terrain.groundHeight(x, z), 0.3) + (el > 0.05 ? el : emb);
  };

  /**
   * 並走区間の線路を路面の外へ出す。一畑電車は国道431号の、JR は県道24号のすぐ脇を
   * 走るが、コースは幅 18m で道路の中央に敷いているので、OSM の線形のままだと線路が
   * 路面に乗ってしまう (実測で中心から 7-10m)。コースと平行な所だけ中心から CLEAR m
   * まで横へずらし、ずらし量は前後でならす。踏切 (交差角が大きい所) は動かさない。
   */
  const CLEAR = track.halfWidth + 6.5;
  const keepOffCourse = (raw: { p: THREE.Vector3; h: number }[]) => {
    const n = raw.length;
    const shift = raw.map((r, i) => {
      if (r.h > 1.5) return [0, 0];
      const nr = track.nearest(r.p.x, r.p.z, -1, false);
      if (nr.idx < 0 || Math.abs(nr.lateral) >= CLEAR || nr.dist > CLEAR + 4) return [0, 0];
      const a = raw[Math.max(0, i - 1)].p, b = raw[Math.min(n - 1, i + 1)].p;
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const par = Math.abs(((b.x - a.x) * track.tx[nr.idx] + (b.z - a.z) * track.tz[nr.idx]) / l);
      if (par < 0.8) return [0, 0];
      const side = nr.lateral >= 0 ? 1 : -1;
      const m = side * CLEAR - nr.lateral;
      return [track.nx[nr.idx] * m, track.nz[nr.idx] * m];
    });
    const R = 5;
    return raw.map((r, i) => {
      let sx = 0, sz = 0, big = 0;
      for (let d = -R; d <= R; d++) {
        const s = shift[Math.min(n - 1, Math.max(0, i + d))];
        // ならすと端でずらし量が足りなくなるので、窓の中で最大のものを使う
        if (Math.hypot(s[0], s[1]) > big) { big = Math.hypot(s[0], s[1]); sx = s[0]; sz = s[1]; }
      }
      return { p: new THREE.Vector3(r.p.x + sx, 0, r.p.z + sz), h: r.h };
    });
  };

  // ---- 一畑電車 ----
  // 松江しんじ湖温泉 (終端) から西へ。終端の先は駅の中へ 30m 伸ばし、西の端は 60m 伸ばす
  const ichiLine = new RailLine('ichibata', keepOffCourse(withTail(samplePath(d.ichibata.path, 5), 30, 60)), railHeight(d.ichibata.embankment));
  // ---- JR 山陰本線 ----
  const jrLine = new RailLine('jr', keepOffCourse(withTail(samplePath(d.jr.path, 6), 60, 60)), railHeight(d.jr.embankment));

  const ballastTex = makeBallastTexture();
  const concreteTex = makeConcreteTexture();
  // 橋脚・架線柱がコース上に立たないようにする (実際の高架も道路をまたぐ)
  const clearOfCourse = (x: number, z: number) => {
    const nr = track.nearest(x, z, -1, false);
    return !(nr.idx >= 0 && Math.abs(nr.lateral) < track.halfWidth + 3 && nr.dist < track.halfWidth + 8);
  };

  group.add(buildGroundTrack(ichiLine, ballastTex, terrain, d.ichibata.embankment, clearOfCourse, onCourse, true));
  group.add(buildGroundTrack(jrLine, ballastTex, terrain, d.jr.embankment, clearOfCourse, onCourse, false));
  group.add(buildViaduct(jrLine, concreteTex, terrain, clearOfCourse));

  // ---- 駅 ----
  group.add(station(d.ichibata.stations, ichiLine, 0x3b6ea5, 4, 50, 1));
  group.add(station(d.jr.stations, jrLine, 0x5a6470, 6, 130, 0));

  // ---- 車両 ----
  const ichiTex = makeTrainSideTexture('ichibata');
  const jrTex = makeTrainSideTexture('jr');
  const trains: Train[] = [];
  for (const [f, dir] of [[0.1, -1], [0.55, 1]] as [number, number][]) {
    const t = new Train(ichiLine, TRAIN.ichibata, ichiTex, ichiLine.length * f, dir);
    trains.push(t); group.add(t.group);
  }
  for (const [f, dir] of [[0.2, 1], [0.7, -1]] as [number, number][]) {
    const t = new Train(jrLine, TRAIN.jr, jrTex, jrLine.length * f, dir);
    trains.push(t); group.add(t.group);
  }

  const lines = { ichibata: ichiLine, jr: jrLine };
  return {
    group, lines,
    update(dt: number) { for (const t of trains) t.update(dt); },
    hitTrain(x: number, z: number, r: number) {
      for (const t of trains) {
        for (const seg of t.segments()) {
          const dx = x - seg.x, dz = z - seg.z;
          if (dx * dx + dz * dz > (seg.halfLen + r) ** 2) continue;
          const c = Math.cos(seg.ang), s = Math.sin(seg.ang);
          const lz = dx * s + dz * c, lx = dx * c - dz * s;
          if (Math.abs(lz) < seg.halfLen + r && Math.abs(lx) < seg.halfWid + r) return true;
        }
      }
      return false;
    },
    blocksBuilding(ring: number[]) {
      for (const [line, margin] of [[jrLine, 8], [ichiLine, 5]] as [RailLine, number][]) {
        for (let k = 0; k < ring.length; k += 2) {
          if (line.distance(ring[k], ring[k + 1], margin) < margin) return true;
        }
      }
      return false;
    },
  };
}

/**
 * 地上区間: バラスト + 盛土 + レール (単線)。
 * 高架区間 (el > 1.5) は buildViaduct が描くので除く。踏切 (コースと交わる所) は
 * 路面を見せるためバラストと盛土を描かず、レールだけ置く。
 */
function buildGroundTrack(line: RailLine, tex: THREE.Texture, terrain: Terrain, emb: number,
  poleOk: (x: number, z: number) => boolean, onCourse: (x: number, z: number) => number, catenary: boolean): THREE.Group {
  const g = new THREE.Group();
  const w = 2.4;
  const n = line.pts.length;
  const crossing = line.pts.map(p => onCourse(p.x, p.z) >= 0);
  const ground = (i: number) => line.pts[i].el <= 1.5;
  const rawWater = line.pts.map(p => terrain.isWater(p.x, p.z));
  const water = rawWater.map((_, i) => rawWater[i] || rawWater[i - 1] || rawWater[i + 1]);
  const ballast = (i: number) => ground(i) && !crossing[i];
  g.add(skirt(line, w, terrain, emb, new THREE.MeshLambertMaterial({ color: 0x6f6a5e }), i => ballast(i) && !water[i]));
  g.add(partialStrip(line, -w, w, 0.02, new THREE.MeshLambertMaterial({ map: tex }), ballast));
  // 小さな川は桁橋で渡る
  const bridgeMat = new THREE.MeshLambertMaterial({ color: 0x8d9298 });
  const onWater = (i: number) => ground(i) && water[i];
  g.add(partialStrip(line, -w, w, -0.9, bridgeMat, onWater, true));
  for (const side of [1, -1]) g.add(partialVertical(line, side * w, -0.9, 0.9, bridgeMat, onWater));
  const railMat = new THREE.MeshPhongMaterial({ color: 0x9aa0a6, shininess: 120, specular: 0xffffff });
  const tieMat = new THREE.MeshLambertMaterial({ color: 0x4a4038 });
  for (const o of [-0.5335, 0.5335]) g.add(partialStrip(line, o - 0.05, o + 0.05, 0.14, railMat, ground));
  g.add(partialStrip(line, -1.1, 1.1, 0.06, tieMat, ballast));
  // 架線柱 (一畑電車は電化されている)
  if (catenary) {
    const poles: THREE.Matrix4[] = [];
    const beams: THREE.Matrix4[] = [];
    for (let i = 0; i < n; i++) {
      const p = line.pts[i];
      if (!ground(i) || p.s % 45 > 4.9 || crossing[i]) continue;
      const px = p.x + p.tz * 3.0, pz = p.z - p.tx * 3.0;
      if (!poleOk(px, pz)) continue;
      const yaw = Math.atan2(p.tx, p.tz);
      poles.push(new THREE.Matrix4().makeTranslation(px, p.y + 3.2, pz));
      beams.push(new THREE.Matrix4().makeTranslation(p.x + p.tz * 1.5, p.y + 6.1, p.z - p.tx * 1.5).multiply(new THREE.Matrix4().makeRotationY(yaw)));
    }
    const poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.18, 6.4, 6), new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }), Math.max(1, poles.length));
    poles.forEach((m, i) => poleMesh.setMatrixAt(i, m));
    const beamMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(3.4, 0.14, 0.14), new THREE.MeshLambertMaterial({ color: 0x80878e }), Math.max(1, beams.length));
    beams.forEach((m, i) => beamMesh.setMatrixAt(i, m));
    poleMesh.count = poles.length; beamMesh.count = beams.length;
    poleMesh.castShadow = true;
    g.add(poleMesh, beamMesh);
    // 架線 (トロリ線)
    const wire = partialStrip(line, -0.03, 0.03, 5.5, new THREE.MeshBasicMaterial({ color: 0x333333 }), ground);
    g.add(wire);
  }
  return g;
}

/** 高架区間: 桁 + 橋脚 + 低い壁 + レール */
function buildViaduct(line: RailLine, tex: THREE.Texture, terrain: Terrain, pierOk: (x: number, z: number) => boolean): THREE.Group {
  const g = new THREE.Group();
  const w = 3.6;
  const up = (i: number) => line.pts[i].el > 1.5;
  const deckMat = new THREE.MeshLambertMaterial({ map: tex });
  g.add(partialStrip(line, -w, w, 0.05, deckMat, up));
  g.add(partialStrip(line, -w, w, -1.8, deckMat, up, true));
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xb7bcc2, side: THREE.DoubleSide });
  for (const side of [1, -1]) {
    g.add(partialVertical(line, side * w, -1.8, 1.85, deckMat, up));
    g.add(partialVertical(line, side * w, 0.05, 1.1, wallMat, up));
  }
  const piers: THREE.Matrix4[] = [];
  for (const p of line.pts) {
    if (p.el <= 1.5 || p.s % 24 > 5.9 || !pierOk(p.x, p.z)) continue;
    const ground = Math.max(terrain.groundHeight(p.x, p.z), -1);
    const ph = p.y - 1.8 - ground;
    if (ph < 1) continue;
    piers.push(new THREE.Matrix4()
      .makeTranslation(p.x, ground + ph / 2, p.z)
      .multiply(new THREE.Matrix4().makeRotationY(Math.atan2(p.tx, p.tz)))
      .multiply(new THREE.Matrix4().makeScale(1, ph / 10, 1)));
  }
  if (piers.length) {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(5.2, 10, 1.4), new THREE.MeshLambertMaterial({ color: 0xa9aeb4 }), piers.length);
    piers.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.castShadow = true; inst.receiveShadow = true;
    g.add(inst);
  }
  const railMat = new THREE.MeshPhongMaterial({ color: 0x9aa0a6, shininess: 120, specular: 0xffffff });
  for (const o of [-0.5335, 0.5335]) g.add(partialStrip(line, o - 0.05, o + 0.05, 0.2, railMat, up));
  g.add(partialStrip(line, -1.3, 1.3, 0.08, new THREE.MeshLambertMaterial({ color: 0x6d6a66 }), up));
  return g;
}

/** 条件を満たす区間だけの水平な帯 (faceDown で下向きの面) */
function partialStrip(line: RailLine, a: number, b: number, dy: number, mat: THREE.Material, pred: (i: number) => boolean, faceDown = false): THREE.Mesh {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const n = line.pts.length;
  let vi = 0;
  for (let i = 0; i + 1 < n; i++) {
    if (!pred(i) || !pred(i + 1)) continue;
    for (const k of [i, i + 1]) {
      const p = line.pts[k];
      pos.push(p.x + p.tz * a, p.y + dy, p.z - p.tx * a);
      pos.push(p.x + p.tz * b, p.y + dy, p.z - p.tx * b);
      const v = p.s / 6;
      uv.push(0, v, 1, v);
    }
    // 巻き順で法線の向きが決まる。上から見る面は上向き、桁の底面だけ下向き
    if (faceDown) idx.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
    else idx.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3);
    vi += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true; mesh.frustumCulled = false;
  return mesh;
}

/** 条件を満たす区間だけの縦板 */
function partialVertical(line: RailLine, off: number, y0: number, h: number, mat: THREE.Material, pred: (i: number) => boolean): THREE.Mesh {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const n = line.pts.length;
  let vi = 0;
  for (let i = 0; i + 1 < n; i++) {
    if (!pred(i) || !pred(i + 1)) continue;
    for (const k of [i, i + 1]) {
      const p = line.pts[k];
      pos.push(p.x + p.tz * off, p.y + y0, p.z - p.tx * off);
      pos.push(p.x + p.tz * off, p.y + y0 + h, p.z - p.tx * off);
      uv.push(p.s / 6, 0, p.s / 6, h / 6);
    }
    idx.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
    vi += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.frustumCulled = false;
  return mesh;
}

/** 盛土の斜面 */
function skirt(line: RailLine, w: number, terrain: Terrain, emb: number, mat: THREE.Material, pred: (i: number) => boolean): THREE.Mesh {
  const pos: number[] = [], idx: number[] = [];
  const n = line.pts.length;
  let vi = 0;
  for (const side of [1, -1]) {
    for (let i = 0; i + 1 < n; i++) {
      if (!pred(i) || !pred(i + 1)) continue;
      for (const k of [i, i + 1]) {
        const p = line.pts[k];
        const topX = p.x + p.tz * side * w, topZ = p.z - p.tx * side * w;
        const footOff = w + emb * 1.5 + 0.5;
        const fx = p.x + p.tz * side * footOff, fz = p.z - p.tx * side * footOff;
        pos.push(topX, p.y - 0.04, topZ);
        pos.push(fx, Math.min(p.y - 0.1, Math.max(terrain.groundHeight(fx, fz), -1.2)), fz);
      }
      idx.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
      vi += 4;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: (mat as THREE.MeshLambertMaterial).color, side: THREE.DoubleSide }));
  mesh.receiveShadow = true; mesh.frustumCulled = false;
  return mesh;
}

/** 駅 (ホーム + 上屋)。sides=1 なら片側だけ (一畑の終端駅) */
function station(stations: { name: string; lat: number; lon: number }[], line: RailLine, roofColor: number, platW: number, len: number, sides: 0 | 1): THREE.Group {
  const g = new THREE.Group();
  for (const st of stations) {
    const [x, z] = llToXZ(st.lat, st.lon);
    let best = line.pts[0], bd = Infinity;
    for (const p of line.pts) { const d = (p.x - x) ** 2 + (p.z - z) ** 2; if (d < bd) { bd = d; best = p; } }
    const s = new THREE.Group();
    s.position.set(best.x, best.y, best.z);
    s.rotation.y = Math.atan2(best.tx, best.tz);
    const platMat = new THREE.MeshLambertMaterial({ color: 0xbfc4c9 });
    for (const side of sides ? [1] : [1, -1]) {
      const cx = side * (platW / 2 + 1.7);
      const plat = new THREE.Mesh(new THREE.BoxGeometry(platW, 1.1, len), platMat);
      plat.position.set(cx, 0.55, 0);
      plat.receiveShadow = true;
      s.add(plat);
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.02, len), new THREE.MeshLambertMaterial({ color: 0xe8c33a }));
      edge.position.set(cx - side * (platW / 2 - 0.6), 1.11, 0);
      s.add(edge);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(platW + 1.4, 0.35, len * 0.8), new THREE.MeshLambertMaterial({ color: roofColor }));
      roof.position.set(cx, 5.0, 0);
      roof.castShadow = true;
      s.add(roof);
      for (let k = -3; k <= 3; k++) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 3.9, 8), new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }));
        post.position.set(cx, 3.0, (k * len) / 8);
        s.add(post);
      }
    }
    g.add(s);
  }
  return g;
}
