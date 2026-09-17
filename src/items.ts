// アイテムボックス・コイン・バナナ・甲羅
import * as THREE from 'three';
import type { Track } from './track';
import { Kart, type ItemType } from './kart';
import { makeItemBoxTexture, makeCoinTexture } from './textures';
import { t } from './i18n';

interface Box { idx: number; lateral: number; mesh: THREE.Mesh; respawn: number; }
interface Coin { idx: number; lateral: number; mesh: THREE.Mesh; taken: number; }
interface Banana { x: number; z: number; y: number; mesh: THREE.Group; owner: Kart; age: number; }
interface Shell { x: number; z: number; y: number; vx: number; vz: number; mesh: THREE.Mesh; owner: Kart; life: number; bounces: number; trackIdx: number; }

export interface ItemEvents {
  onPickup(k: Kart): void;
  onCoin(k: Kart): void;
  onHit(victim: Kart, by: Kart | null): void;
  onUse(k: Kart): void;
  onBoost(k: Kart): void;
}

export class ItemSystem {
  group = new THREE.Group();
  boxes: Box[] = [];
  coins: Coin[] = [];
  bananas: Banana[] = [];
  shells: Shell[] = [];
  private boxGeo = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  private boxMat: THREE.Material;
  private coinGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.12, 20);
  private coinMat: THREE.Material;
  private shellGeo = new THREE.SphereGeometry(0.55, 14, 10);
  private shellMat = new THREE.MeshPhongMaterial({ color: 0x2ecc40, shininess: 60 });
  private bananaTemplate: THREE.Group;
  private time = 0;

  constructor(private track: Track, private rand: () => number) {
    this.boxMat = new THREE.MeshPhongMaterial({ map: makeItemBoxTexture(), transparent: true, opacity: 0.85, shininess: 100, specular: 0xffffff });
    const ct = makeCoinTexture();
    this.coinMat = new THREE.MeshPhongMaterial({ color: 0xffd23f, map: ct, shininess: 90, specular: 0xffffff, emissive: 0x6a4d00 });
    // バナナ
    this.bananaTemplate = new THREE.Group();
    const bm = new THREE.MeshPhongMaterial({ color: 0xffe135, shininess: 40 });
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.16, 8, 14, Math.PI * 0.9), bm);
    arc.rotation.x = Math.PI / 2; arc.rotation.z = Math.PI; arc.position.y = 0.2;
    this.bananaTemplate.add(arc);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.3, 6), new THREE.MeshPhongMaterial({ color: 0x5a3b12 }));
    stem.position.set(-0.55, 0.35, 0); this.bananaTemplate.add(stem);
    this.bananaTemplate.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });

    // アイテムボックス列: 周回 8 箇所 x 3 個
    const rows = 8;
    for (let r = 0; r < rows; r++) {
      const s = ((r + 0.6) / rows) * track.length;
      const idx = track.idxAtS(s);
      for (const lat of [-5.5, 0, 5.5]) {
        const mesh = new THREE.Mesh(this.boxGeo, this.boxMat);
        mesh.castShadow = true;
        const p = track.pointAt(idx, lat);
        mesh.position.set(p.x, p.y + 1.3, p.z);
        this.group.add(mesh);
        this.boxes.push({ idx, lateral: lat, mesh, respawn: 0 });
      }
    }
    // コイン: 約 220m ごとに 5 枚
    const groups = Math.floor(track.length / 220);
    for (let g = 0; g < groups; g++) {
      const s0 = (g + 0.3) / groups * track.length;
      const lat = (this.rand() - 0.5) * (track.halfWidth - 4) * 2;
      for (let k = 0; k < 5; k++) {
        const idx = track.idxAtS(s0 + k * 4);
        const mesh = new THREE.Mesh(this.coinGeo, this.coinMat);
        mesh.rotation.x = Math.PI / 2;
        const p = track.pointAt(idx, lat);
        mesh.position.set(p.x, p.y + 0.9, p.z);
        this.group.add(mesh);
        this.coins.push({ idx, lateral: lat, mesh, taken: 0 });
      }
    }
  }

  /** 順位に応じたアイテム抽選 */
  roll(rank: number, total: number): ItemType {
    const r = this.rand();
    const behind = (rank - 1) / Math.max(1, total - 1); // 0 = 先頭
    if (behind > 0.7) return r < 0.4 ? 'mushroom' : r < 0.7 ? 'star' : r < 0.9 ? 'shell' : 'banana';
    if (behind > 0.35) return r < 0.4 ? 'mushroom' : r < 0.75 ? 'shell' : r < 0.9 ? 'banana' : 'star';
    return r < 0.45 ? 'banana' : r < 0.8 ? 'shell' : 'mushroom';
  }

  use(k: Kart, ev: ItemEvents) {
    if (!k.item || k.itemRoulette > 0) return;
    const it = k.item; k.item = null;
    ev.onUse(k);
    this.spawn(it, k, k.x, k.z, k.y, k.heading, k.speed, ev);
  }

  /**
   * アイテムを実体化する。オンライン対戦では、他の人が使ったアイテムも
   * 受信した位置でここから出す (spawnFromNet)。
   */
  private spawn(it: ItemType, owner: Kart, x0: number, z0: number, y0: number, heading: number, speed: number, ev: ItemEvents | null) {
    const fx = Math.cos(heading), fz = Math.sin(heading);
    if (it === 'mushroom') { owner.boostTimer = 1.6; owner.boostPower = 1.4; ev?.onBoost(owner); }
    else if (it === 'star') { owner.starTimer = 7; owner.spinTimer = 0; }
    else if (it === 'banana') {
      const mesh = this.bananaTemplate.clone();
      const x = x0 - fx * 3, z = z0 - fz * 3;
      const nr = this.track.nearest(x, z, owner.trackIdx);
      const lat = Math.max(-this.track.halfWidth + 1, Math.min(this.track.halfWidth - 1, nr.lateral));
      const p = this.track.pointAt(nr.idx, lat);
      mesh.position.copy(p);
      this.group.add(mesh);
      this.bananas.push({ x: p.x, z: p.z, y: p.y, mesh, owner, age: 0 });
    } else if (it === 'shell') {
      const mesh = new THREE.Mesh(this.shellGeo, this.shellMat);
      mesh.castShadow = true;
      const sp = Math.max(speed, 0) + 32;
      const x = x0 + fx * 2.5, z = z0 + fz * 2.5;
      mesh.position.set(x, y0 + 0.55, z);
      this.group.add(mesh);
      this.shells.push({ x, z, y: y0 + 0.55, vx: fx * sp, vz: fz * sp, mesh, owner, life: 7, bounces: 0, trackIdx: owner.trackIdx });
    }
  }

  /** オンライン対戦: 他の人が使ったアイテムを、受信した位置で出す */
  spawnFromNet(it: ItemType, owner: Kart, x: number, z: number, y: number, heading: number, speed: number) {
    this.spawn(it, owner, x, z, y, heading, speed, null);
  }

  /**
   * @param owns そのカートの判定を自分の画面で行ってよいか。オンライン対戦では
   *   「自分が動かしているカート」だけ true にする。取得も被弾も持ち主の画面だけで
   *   決め、結果をイベントで配らないと、各自の画面で別々に当たったことになる。
   */
  update(dt: number, karts: Kart[], ev: ItemEvents, owns: (k: Kart) => boolean = () => true) {
    this.time += dt;
    const hw = this.track.halfWidth;
    // ボックス
    for (const b of this.boxes) {
      if (b.respawn > 0) { b.respawn -= dt; b.mesh.visible = b.respawn <= 0; if (b.respawn > 0) continue; }
      b.mesh.rotation.y = this.time * 1.2; b.mesh.rotation.x = this.time * 0.8;
      b.mesh.position.y = this.track.py[b.idx] + 1.3 + Math.sin(this.time * 2 + b.idx) * 0.15;
      for (const k of karts) {
        if (k.item || k.itemRoulette > 0 || !owns(k)) continue;
        const dx = k.x - b.mesh.position.x, dz = k.z - b.mesh.position.z;
        if (dx * dx + dz * dz < 2.4 * 2.4) {
          b.respawn = 3; b.mesh.visible = false;
          k.itemRoulette = k.def.isPlayer ? 1.6 : 1.0;
          ev.onPickup(k);
          break;
        }
      }
    }
    // コイン
    for (const c of this.coins) {
      if (c.taken > 0) { c.taken -= dt; c.mesh.visible = c.taken <= 0; if (c.taken > 0) continue; }
      c.mesh.rotation.z = this.time * 3;
      for (const k of karts) {
        if (!owns(k)) continue;
        const dx = k.x - c.mesh.position.x, dz = k.z - c.mesh.position.z;
        if (dx * dx + dz * dz < 2.0 * 2.0) {
          c.taken = 12; c.mesh.visible = false;
          k.coins = Math.min(10, k.coins + 1);
          ev.onCoin(k);
          break;
        }
      }
    }
    // バナナ
    for (let i = this.bananas.length - 1; i >= 0; i--) {
      const b = this.bananas[i];
      b.age += dt;
      b.mesh.rotation.y = this.time;
      let hit = false;
      for (const k of karts) {
        if (k === b.owner && b.age < 1.0) continue;
        const dx = k.x - b.x, dz = k.z - b.z;
        if (dx * dx + dz * dz < 1.9 * 1.9) {
          if (owns(k) && !k.invincible) { k.spinTimer = 1.3; k.drifting = 0; ev.onHit(k, b.owner); }
          hit = true; break;
        }
      }
      if (hit || b.age > 60) { this.group.remove(b.mesh); this.bananas.splice(i, 1); }
    }
    // 甲羅
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.life -= dt;
      s.x += s.vx * dt; s.z += s.vz * dt;
      const nr = this.track.nearest(s.x, s.z, s.trackIdx);
      s.trackIdx = nr.idx;
      if (Math.abs(nr.lateral) > hw - 0.6) {
        // 壁で反射
        const nx = this.track.nx[nr.idx], nz = this.track.nz[nr.idx];
        const vn = s.vx * nx + s.vz * nz;
        s.vx -= 2 * vn * nx; s.vz -= 2 * vn * nz;
        const sgn = Math.sign(nr.lateral);
        const over = Math.abs(nr.lateral) - (hw - 0.6);
        s.x -= nx * sgn * over; s.z -= nz * sgn * over;
        s.bounces++;
      }
      s.y = this.track.py[nr.idx] + 0.55;
      s.mesh.position.set(s.x, s.y, s.z);
      s.mesh.rotation.y += dt * 12;
      let dead = s.life <= 0 || s.bounces > 6;
      if (!dead) for (const k of karts) {
        if (k === s.owner && s.life > 6.6) continue;
        const dx = k.x - s.x, dz = k.z - s.z;
        if (dx * dx + dz * dz < 1.9 * 1.9) {
          if (owns(k) && !k.invincible) { k.spinTimer = 1.4; k.drifting = 0; ev.onHit(k, s.owner); }
          dead = true; break;
        }
      }
      if (!dead) for (const b of this.bananas) { const dx = b.x - s.x, dz = b.z - s.z; if (dx * dx + dz * dz < 1.5) { dead = true; this.group.remove(b.mesh); this.bananas.splice(this.bananas.indexOf(b), 1); break; } }
      if (dead) { this.group.remove(s.mesh); this.shells.splice(i, 1); }
    }
  }
}

export const ITEM_ICON: Record<ItemType, string> = { mushroom: '🍄', banana: '🍌', shell: '🐢', star: '⭐' };
export const ITEM_NAME: Record<ItemType, string> = { mushroom: t('item.mushroom'), banana: t('item.banana'), shell: t('item.shell'), star: t('item.star') };
