// 実在ランドマーク
//   松江城天守     — PLATEAU 建築物 LOD3 (テクスチャ付き) をそのまま描く
//   嫁ヶ島         — 宍道湖に浮かぶ松の島 (宍道湖夕日スポットから見える)
//   宍道湖夕日スポット — 国道9号沿いの湖岸の展望デッキ (とるぱ)
import * as THREE from 'three';
import railData from '../data/rail.json';
import { llToXZ, assetUrl, rng } from './geo';
import { fetchBuffer, fetchJson } from './fetch';
import type { Terrain } from './terrain';
import type { Track } from './track';
import { makeSignTexture } from './textures';
import { isJa } from './i18n';
import { loadTexture } from './texture';

type LandmarkInfo = { name: string; lat: number; lon: number; headingDeg: number; excludeRadius: number };
const LM = (railData as any).landmarks as Record<string, LandmarkInfo>;

/**
 * ランドマークの専用モデルと重なる PLATEAU 建物を除く。
 *
 * tools/convert_citygml.mjs も同じ除外を行うが、あちらはデータ生成時にしか効かない。
 * 生成済みの public/data/ を作り直さずにランドマークを足せるよう、実行時にも判定する。
 */
export function landmarkBlocksBuilding(ring: number[]): boolean {
  for (const info of Object.values(LM)) {
    if (!info.excludeRadius) continue;
    const [lx, lz] = llToXZ(info.lat, info.lon);
    const r2 = info.excludeRadius * info.excludeRadius;
    for (let k = 0; k + 1 < ring.length; k += 2) {
      const dx = ring[k] - lx, dz = ring[k + 1] - lz;
      if (dx * dx + dz * dz < r2) return true;
    }
  }
  return false;
}

interface CastleMeta {
  vertexCount: number;
  center: [number, number];
  yMin: number;
  yMax: number;
  groups: { texture: string | null; start: number; count: number }[];
}

/**
 * 松江城天守。PLATEAU 松江市 (2024) には天守の LOD3 モデルがあり、壁・屋根・破風・
 * 窓・扉を面ごとに持つ (約 4.3 万面、テクスチャは部位ごとの 6 枚 + 単色)。
 * tools/convert_castle.mjs が三角形に割って castle.bin に書き出したものを読む。
 * 座標は標高 (T.P.) のままなので、DEM の城山の頂 (約 27m) にそのまま載る。
 */
export async function loadMatsueCastle(): Promise<THREE.Group> {
  const g = new THREE.Group();
  const meta = await fetchJson<CastleMeta>(assetUrl('data/castle.json'));
  const n = meta.vertexCount;
  // 位置 3 + UV 2 + 色 3 の float32
  const buf = await fetchBuffer(assetUrl('data/castle.bin'), n * 8 * 4);
  const pos = new Float32Array(buf, 0, n * 3);
  const uv = new Float32Array(buf, n * 3 * 4, n * 2);
  const col = new Float32Array(buf, n * 5 * 4, n * 3);
  await Promise.all(meta.groups.map(async grp => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(grp.start * 3, (grp.start + grp.count) * 3), 3));
    let mat: THREE.Material;
    if (grp.texture) {
      const tex = await loadTexture(assetUrl(`data/${grp.texture}`));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false; // UV 側で上下を反転済み
      tex.anisotropy = 8;
      geo.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(grp.start * 2, (grp.start + grp.count) * 2), 2));
      // LOD3 の面の向き (巻き順) はそろっていないので両面で描く
      mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    } else {
      // X3DMaterial の色は線形値として書かれている
      geo.setAttribute('color', new THREE.BufferAttribute(col.subarray(grp.start * 3, (grp.start + grp.count) * 3), 3));
      mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    }
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }));
  console.log(`松江城天守 (PLATEAU LOD3): ${n / 3} 三角形`);
  return g;
}

/**
 * 嫁ヶ島。長さ 110m ほどの細長い島に松が並び、東の端に石の鳥居が立つ。
 * DEM では島の形が崩れているので、湖面の上に低い盛り土を置いて作る。
 */
export function buildYomegashima(terrain: Terrain): THREE.Group {
  const info = LM.yomegashima;
  const g = new THREE.Group();
  const [x, z] = llToXZ(info.lat, info.lon);
  const water = terrain.WATER_LEVEL;
  g.position.set(x, water, z);
  g.rotation.y = THREE.MathUtils.degToRad(-12); // 島の長軸はほぼ東西
  // 島 (低い楕円の盛り土 + 石積みの護岸)
  const L = 55, W = 13;
  const shape = new THREE.Shape();
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    const px = L * Math.sign(c) * Math.abs(c) ** 0.7, pz = W * Math.sign(s) * Math.abs(s) ** 0.8;
    if (i === 0) shape.moveTo(px, pz); else shape.lineTo(px, pz);
  }
  const bank = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: 2.2, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 1.6, bevelSegments: 2 }),
    new THREE.MeshLambertMaterial({ color: 0x7d7568 }),
  );
  bank.rotation.x = -Math.PI / 2;
  bank.position.y = -1.4;
  bank.receiveShadow = true;
  g.add(bank);
  const grass = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshLambertMaterial({ color: 0x5f7f45 }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = 1.25;
  grass.receiveShadow = true;
  g.add(grass);
  // 松 (幹が傾き、上に平たい樹冠が何段か乗る)
  const rand = rng(1971);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a4636 });
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x2f5a34 });
  for (let i = 0; i < 16; i++) {
    const px = -L * 0.8 + (i / 15) * L * 1.5 + (rand() - 0.5) * 4;
    const pz = (rand() - 0.5) * W * 0.9;
    const h = 7 + rand() * 5;
    const pine = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.45, h, 6), trunkMat);
    trunk.position.y = h / 2;
    trunk.rotation.z = (rand() - 0.5) * 0.35;
    trunk.castShadow = true;
    pine.add(trunk);
    for (let k = 0; k < 3; k++) {
      const r = 2.8 - k * 0.6 + rand() * 0.8;
      const crown = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 5), leafMat);
      crown.scale.set(r, 0.7, r * (0.8 + rand() * 0.4));
      crown.position.set((rand() - 0.5) * 1.6, h - 1.2 + k * 1.1, (rand() - 0.5) * 1.6);
      crown.castShadow = true;
      pine.add(crown);
    }
    pine.position.set(px, 1.25, pz);
    g.add(pine);
  }
  // 石の鳥居 (東の端)
  const stone = new THREE.MeshLambertMaterial({ color: 0xa8a39a });
  const torii = new THREE.Group();
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 4.2, 10), stone);
    post.position.set(0, 2.1, s * 1.7);
    torii.add(post);
  }
  const kasagi = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 5.2), stone);
  kasagi.position.y = 4.35;
  torii.add(kasagi);
  const nuki = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 4.2), stone);
  nuki.position.y = 3.5;
  torii.add(nuki);
  torii.position.set(L * 0.92, 1.25, 0);
  torii.traverse(o => { o.castShadow = true; });
  g.add(torii);
  return g;
}

/** コース上で (x, z) に最も近い点と、湖 (水面) のある側の向き */
function besideCourse(track: Track, terrain: Terrain, x: number, z: number, wantWater: boolean) {
  const nr = track.nearest(x, z);
  const i = nr.idx;
  let side = 1;
  const probe = track.halfWidth + 20;
  const leftWater = terrain.isWater(track.px[i] + track.nx[i] * probe, track.pz[i] + track.nz[i] * probe);
  const rightWater = terrain.isWater(track.px[i] - track.nx[i] * probe, track.pz[i] - track.nz[i] * probe);
  if (wantWater) side = leftWater ? 1 : rightWater ? -1 : 1;
  else side = nr.lateral >= 0 ? 1 : -1;
  return { i, side, px: track.px[i], py: track.py[i], pz: track.pz[i], nx: track.nx[i] * side, nz: track.nz[i] * side, tx: track.tx[i], tz: track.tz[i] };
}

/**
 * 宍道湖夕日スポット (とるぱ)。国道9号の湖側に張り出した石張りのデッキと柵、
 * 夕日の方角 (西) を向いたベンチ、道路側から読める案内板。
 */
export function buildSunsetSpot(terrain: Terrain, track: Track): THREE.Group {
  const info = LM.sunsetSpot;
  const g = new THREE.Group();
  const [x, z] = llToXZ(info.lat, info.lon);
  const b = besideCourse(track, terrain, x, z, true);
  const off = track.halfWidth + 9;
  const cx = b.px + b.nx * off, cz = b.pz + b.nz * off;
  const deckY = Math.max(terrain.WATER_LEVEL + 1.4, b.py - 0.6);
  // ローカルの +x がコースの左 (法線) を向くので、湖が右側にあるときは反転する
  const yaw = Math.atan2(b.tx, b.tz) + (b.side < 0 ? Math.PI : 0);
  const deck = new THREE.Group();
  deck.position.set(cx, deckY, cz);
  deck.rotation.y = yaw;
  // デッキ (ローカル: +z = 進行方向, +x = 湖側)
  const DL = 70, DW = 12;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(DW, 1.2, DL), new THREE.MeshLambertMaterial({ color: 0xc9bfae }));
  slab.position.y = -0.6;
  slab.receiveShadow = true;
  deck.add(slab);
  // 湖側の柵
  const railMat = new THREE.MeshLambertMaterial({ color: 0x6b5a48 });
  const handrail = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, DL), railMat);
  handrail.position.set(DW / 2 - 0.3, 1.05, 0);
  deck.add(handrail);
  for (let k = -DL / 2; k <= DL / 2; k += 3) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.05, 0.14), railMat);
    post.position.set(DW / 2 - 0.3, 0.52, k);
    deck.add(post);
  }
  // ベンチ (湖を向く)
  const benchMat = new THREE.MeshLambertMaterial({ color: 0x8a6a4a });
  for (let k = -24; k <= 24; k += 12) {
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 2.4), benchMat);
    seat.position.set(DW / 2 - 3, 0.22, k);
    seat.castShadow = true;
    deck.add(seat);
  }
  // 案内板 (道路側を向く)
  const signTex = makeSignTexture(isJa ? '宍道湖夕日スポット' : 'Lake Shinji Sunset Spot', isJa ? 'Lake Shinji Sunset Spot' : '宍道湖夕日スポット');
  const board = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.9), new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide }));
  board.position.set(-DW / 2 + 0.5, 2.6, 0);
  board.rotation.y = -Math.PI / 2;
  deck.add(board);
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.6, 6), railMat);
    leg.position.set(-DW / 2 + 0.55, 1.3, s * 4.6);
    deck.add(leg);
  }
  g.add(deck);
  return g;
}
