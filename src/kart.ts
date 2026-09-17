// カート: 物理 (アーケード), 3Dモデル, AI 制御
import * as THREE from 'three';
import type { Track } from './track';
import type { Input } from './input';
import { clamp, lerp } from './geo';

export type ItemType = 'mushroom' | 'banana' | 'shell' | 'star';

export const MAX_SPEED = 56; // m/s (約 200 km/h)
const ACCEL = 20;
const BRAKE = 34;
const REVERSE_MAX = -10;

export interface RacerDef {
  name: string;
  color: number;
  accent: number;
  isPlayer: boolean;
  skill: number; // 0..1
}

export class Kart {
  def: RacerDef;
  mesh = new THREE.Group();
  body!: THREE.Group;
  wheelSpinners: THREE.Group[] = [];
  frontWheels: THREE.Group[] = [];
  driftSparks: THREE.Points | null = null;
  starLight: THREE.PointLight | null = null;

  x = 0; z = 0; y = 0;
  heading = 0; // rad, 0 = +x
  speed = 0;
  steer = 0;
  visYaw = 0;
  pitch = 0; roll = 0;
  trackIdx = 0; lateral = 0; s = 0; prevS = 0;
  lap = 0; finished = false; finishTime = 0; // スタートライン通過で 1 になる
  progress = 0; rank = 1;
  wrongWayTime = 0;

  item: ItemType | null = null;
  itemRoulette = 0; // >0 の間ルーレット中
  boostTimer = 0; boostPower = 1;
  spinTimer = 0; spinAngle = 0;
  starTimer = 0;
  coins = 0;
  drifting = 0; // 0 / -1 / 1
  driftTime = 0;
  bumpCooldown = 0;
  hop = 0;
  wheelSpin = 0;

  // AI
  aiLane = 0; aiLaneTarget = 0; aiTimer = 0; aiItemTimer = 2;
  aiThrottle = 1;

  // オンライン対戦: 他人が動かすカートの受信位置
  netX = 0; netZ = 0; netY = 0; netHeading = 0; netSpeed = 0;
  hasNet = false;

  constructor(def: RacerDef) {
    this.def = def;
    this.buildModel();
  }

  get maxSpeed() {
    let m = MAX_SPEED * (1 + this.coins * 0.006);
    if (this.boostTimer > 0) m *= this.boostPower;
    if (this.starTimer > 0) m *= 1.2;
    if (!this.def.isPlayer) m *= this.aiSpeedScale;
    return m;
  }
  aiSpeedScale = 1;

  get forward() { return new THREE.Vector2(Math.cos(this.heading), Math.sin(this.heading)); }
  get invincible() { return this.starTimer > 0; }

  private buildModel() {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshPhongMaterial({ color: this.def.color, shininess: 80 });
    const dark = new THREE.MeshPhongMaterial({ color: 0x24262b, shininess: 30 });
    const accent = new THREE.MeshPhongMaterial({ color: this.def.accent, shininess: 60 });
    const chrome = new THREE.MeshPhongMaterial({ color: 0xcfd6dd, shininess: 120, specular: 0xffffff });
    // シャーシ (前方 = +x)
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.28, 1.25), bodyMat); chassis.position.y = 0.42; g.add(chassis);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.36, 0.8), bodyMat); nose.position.set(1.35, 0.55, 0); g.add(nose);
    const noseTip = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.6, 12), accent); noseTip.rotation.z = -Math.PI / 2; noseTip.position.set(2.05, 0.55, 0); g.add(noseTip);
    const cowl = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.3, 0.9), accent); cowl.position.set(0.2, 0.6, 0); g.add(cowl);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.7), dark); seat.position.set(-0.75, 0.85, 0); g.add(seat);
    const rear = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.45, 1.3), bodyMat); rear.position.set(-0.95, 0.55, 0); g.add(rear);
    for (const s of [1, -1]) { const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.5, 8), chrome); ex.rotation.z = Math.PI / 2; ex.position.set(-1.35, 0.5, s * 0.35); g.add(ex); }
    // ハンドル
    const wheelCol = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6), chrome); wheelCol.rotation.z = 0.6; wheelCol.position.set(0.45, 0.95, 0); g.add(wheelCol);
    const sw = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.03, 6, 16), dark); sw.rotation.y = Math.PI / 2; sw.rotation.x = 0; sw.position.set(0.62, 1.12, 0); sw.rotation.z = 0.6; g.add(sw);
    // ドライバー
    const skin = new THREE.MeshPhongMaterial({ color: 0xf1c8a0 });
    const suit = new THREE.MeshPhongMaterial({ color: this.def.accent });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.6), suit); torso.position.set(-0.55, 1.05, 0); g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 14, 12), skin); head.position.set(-0.5, 1.6, 0); g.add(head);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat); cap.position.set(-0.5, 1.62, 0); g.add(cap);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.4), bodyMat); brim.position.set(-0.25, 1.65, 0); g.add(brim);
    for (const s of [1, -1]) { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.14, 0.14), suit); arm.position.set(-0.05, 1.1, s * 0.32); arm.rotation.z = -0.3; g.add(arm); }
    // タイヤ
    const tireGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14);
    const tireMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1c, shininess: 10 });
    const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.32, 10);
    for (const [wx, wz, front] of [[0.85, 0.75, 1], [0.85, -0.75, 1], [-0.85, 0.78, 0], [-0.85, -0.78, 0]] as const) {
      // holder: 車体上の位置 + 操舵 (y 回転), spinner: 車軸まわりの回転
      const holder = new THREE.Group();
      holder.position.set(wx, 0.34, wz);
      const spinner = new THREE.Group();
      spinner.add(new THREE.Mesh(tireGeo, tireMat));
      spinner.add(new THREE.Mesh(rimGeo, chrome));
      holder.add(spinner);
      g.add(holder);
      this.wheelSpinners.push(spinner);
      if (front) this.frontWheels.push(holder);
    }
    g.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    this.body = g;
    this.mesh.add(g);
    // ドリフトの火花
    const sp = new THREE.BufferGeometry();
    const cnt = 40;
    sp.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cnt * 3), 3));
    const pm = new THREE.PointsMaterial({ color: 0xffb020, size: 0.22, transparent: true, opacity: 0.9 });
    this.driftSparks = new THREE.Points(sp, pm);
    this.driftSparks.visible = false;
    this.driftSparks.frustumCulled = false;
    this.mesh.add(this.driftSparks);
    this.starLight = new THREE.PointLight(0xfff2a0, 0, 12);
    this.starLight.position.set(0, 1.5, 0);
    this.mesh.add(this.starLight);
  }

  placeAt(track: Track, idx: number, lateral: number) {
    const p = track.pointAt(idx, lateral);
    this.x = p.x; this.z = p.z; this.y = p.y;
    this.heading = Math.atan2(track.tz[track.wrap(idx)], track.tx[track.wrap(idx)]);
    this.trackIdx = track.wrap(idx);
    this.lateral = lateral;
    this.s = track.ss[this.trackIdx];
    this.prevS = this.s;
    this.speed = 0;
    this.syncMesh(track, 0);
  }

  /** 物理更新 */
  update(dt: number, input: Input, track: Track, events: KartEvents) {
    // タイマー
    this.boostTimer = Math.max(0, this.boostTimer - dt);
    this.starTimer = Math.max(0, this.starTimer - dt);
    this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);
    if (this.itemRoulette > 0) { this.itemRoulette -= dt; if (this.itemRoulette <= 0) events.onRouletteDone(this); }

    const spinning = this.spinTimer > 0;
    if (spinning) { this.spinTimer -= dt; this.spinAngle += dt * 9; }

    const maxS = this.maxSpeed;
    const throttle = spinning ? 0 : input.throttle;
    // 加減速
    if (throttle > 0) {
      const a = ACCEL * (this.boostTimer > 0 ? 2 : 1) * (1 - Math.max(0, this.speed / maxS) * 0.55);
      this.speed += a * throttle * dt;
    } else if (input.brake > 0) {
      if (this.speed > 0.5) this.speed -= BRAKE * dt; else this.speed = Math.max(REVERSE_MAX, this.speed - ACCEL * 0.5 * dt);
    } else {
      this.speed -= this.speed * 0.6 * dt; // 惰性
    }
    if (spinning) this.speed -= this.speed * 3 * dt;
    if (this.speed > maxS) this.speed -= (this.speed - maxS) * 4 * dt;

    // ドリフト
    const wantDrift = input.drift && !spinning && this.speed > 18 && Math.abs(input.steer) > 0.2;
    if (this.drifting === 0) {
      if (wantDrift && input.drift) { this.drifting = Math.sign(input.steer) || 1; this.driftTime = 0; this.hop = 1; }
    } else {
      if (!input.drift || this.speed < 12 || spinning) {
        if (this.driftTime > 0.9) { this.boostTimer = this.driftTime > 2.0 ? 1.4 : 0.8; this.boostPower = this.driftTime > 2.0 ? 1.35 : 1.22; events.onBoost(this); }
        this.drifting = 0; this.driftTime = 0;
      } else this.driftTime += dt;
    }
    // ステアリング
    const steerTarget = clamp(input.steer, -1, 1);
    this.steer = lerp(this.steer, steerTarget, Math.min(1, dt * 9));
    const speedFactor = clamp(Math.abs(this.speed) / 14, 0, 1) * (1 - 0.3 * clamp(this.speed / MAX_SPEED, 0, 1));
    let yawRate = this.steer * 2.0 * speedFactor;
    if (this.drifting !== 0) {
      const inward = this.steer * this.drifting; // ドリフト方向へのハンドル量 (-1..1)
      yawRate = this.drifting * (1.15 + 0.85 * clamp(inward, -0.6, 1)) * speedFactor * 1.35;
    }
    if (this.speed < 0) yawRate = -yawRate * 0.7;
    this.heading += yawRate * dt;

    // 位置更新
    const fx = Math.cos(this.heading), fz = Math.sin(this.heading);
    this.x += fx * this.speed * dt;
    this.z += fz * this.speed * dt;
    // コース拘束
    const nr = track.nearest(this.x, this.z, this.trackIdx);
    this.trackIdx = nr.idx;
    const lim = track.halfWidth - 1.0;
    if (Math.abs(nr.lateral) > lim) {
      const over = Math.abs(nr.lateral) - lim;
      const sgn = Math.sign(nr.lateral);
      this.x -= track.nx[nr.idx] * sgn * over;
      this.z -= track.nz[nr.idx] * sgn * over;
      // 壁との衝突: 壁方向の速度成分を減衰
      const vx = fx * this.speed, vz = fz * this.speed;
      const wallDot = (vx * track.nx[nr.idx] + vz * track.nz[nr.idx]) * sgn;
      if (wallDot > 2 && this.bumpCooldown <= 0) {
        this.speed *= wallDot > 15 ? 0.55 : 0.8;
        this.bumpCooldown = 0.35;
        events.onBump(this, wallDot);
      }
      // 壁沿いに向きを寄せる
      const tAng = Math.atan2(track.tz[nr.idx], track.tx[nr.idx]);
      let d = tAng - this.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) < Math.PI / 2) this.heading += d * Math.min(1, dt * 4);
      this.lateral = sgn * lim;
    } else this.lateral = nr.lateral;
    // 進行距離・ラップ
    this.prevS = this.s;
    this.s = nr.s;
    const L = track.length;
    if (this.prevS > L * 0.85 && this.s < L * 0.15) { this.lap++; events.onLap(this); }
    else if (this.prevS < L * 0.15 && this.s > L * 0.85) { this.lap--; }
    this.progress = (this.lap - 1) * L + this.s;
    // 逆走判定
    const dir = fx * track.tx[nr.idx] + fz * track.tz[nr.idx];
    if (dir < -0.2 && this.speed > 3) this.wrongWayTime += dt; else this.wrongWayTime = 0;
    // 高さ / 姿勢
    const yTrack = track.py[nr.idx];
    this.hop = Math.max(0, this.hop - dt * 5);
    this.y = yTrack + Math.sin(Math.min(1, this.hop) * Math.PI) * 0.5;
    const ahead = track.wrap(nr.idx + 5), behind = track.wrap(nr.idx - 5);
    const slope = (track.py[ahead] - track.py[behind]) / 20;
    this.pitch = lerp(this.pitch, -Math.atan(slope) * (dir > 0 ? 1 : -1), Math.min(1, dt * 6));
    this.wheelSpin += this.speed * dt / 0.34;
    this.syncMesh(track, dt);
  }

  /**
   * オンライン対戦で、他人が動かしているカートを表示する。
   *
   * 受信は 15Hz 程度なので、受け取った位置を速度で前へ進めながら (デッドレコニング)
   * 表示位置をそこへ寄せる。物理は回さない。回すと相手の画面と食い違い、
   * ぶつかってもいないのに弾かれて見えるため。
   */
  netApply(dt: number, track: Track) {
    if (!this.hasNet) return;
    this.netX += Math.cos(this.netHeading) * this.netSpeed * dt;
    this.netZ += Math.sin(this.netHeading) * this.netSpeed * dt;
    const k = Math.min(1, dt * 9);
    this.x = lerp(this.x, this.netX, k);
    this.z = lerp(this.z, this.netZ, k);
    this.y = lerp(this.y, this.netY, k);
    let d = this.netHeading - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * k;
    this.speed = this.netSpeed;
    this.spinTimer = Math.max(0, this.spinTimer - dt);
    if (this.spinTimer > 0) this.spinAngle += dt * 9;
    this.boostTimer = Math.max(0, this.boostTimer - dt);
    this.starTimer = Math.max(0, this.starTimer - dt);
    if (this.drifting !== 0) this.driftTime += dt;
    this.trackIdx = track.nearest(this.x, this.z, this.trackIdx).idx;
    this.progress = (this.lap - 1) * track.length + this.s;
    this.wheelSpin += this.speed * dt / 0.34;
    this.syncMesh(track, dt);
  }

  syncMesh(_track: Track, dt: number) {
    this.mesh.position.set(this.x, this.y, this.z);
    const driftYaw = this.drifting !== 0 ? -this.drifting * 0.45 : 0;
    this.visYaw = lerp(this.visYaw, driftYaw, Math.min(1, dt * 6));
    const spin = this.spinTimer > 0 ? this.spinAngle : 0;
    this.mesh.rotation.set(0, -this.heading + this.visYaw + spin, 0, 'YXZ');
    this.body.rotation.z = this.pitch; // 前方 +x なので z 軸回転がピッチ
    this.body.rotation.x = lerp(this.body.rotation.x, -this.steer * 0.06 * clamp(this.speed / 30, 0, 1), Math.min(1, dt * 5));
    for (const w of this.frontWheels) w.rotation.y = -this.steer * 0.45;
    // シリンダー軸 (y) を車軸 (z) に倒し、その軸まわりに回転: R = Rx(90°) * Ry(spin)
    for (const sp of this.wheelSpinners) sp.rotation.set(Math.PI / 2, -this.wheelSpin, 0, 'XYZ');
    // 火花
    if (this.driftSparks) {
      const show = this.drifting !== 0 && this.driftTime > 0.25;
      this.driftSparks.visible = show;
      if (show) {
        const pos = this.driftSparks.geometry.attributes.position as THREE.BufferAttribute;
        const strong = this.driftTime > 2.0;
        (this.driftSparks.material as THREE.PointsMaterial).color.set(strong ? 0xff40c0 : this.driftTime > 0.9 ? 0x40c0ff : 0xffb020);
        for (let i = 0; i < pos.count; i++) {
          pos.setXYZ(i, -0.8 - Math.random() * 1.6, 0.1 + Math.random() * 0.5, (Math.random() - 0.5) * 1.8);
        }
        pos.needsUpdate = true;
      }
    }
    if (this.starLight) {
      this.starLight.intensity = this.starTimer > 0 ? 3 + Math.sin(performance.now() / 60) * 2 : 0;
      this.body.traverse(o => {
        const m = (o as THREE.Mesh).material as THREE.MeshPhongMaterial | undefined;
        if (m && m.emissive) m.emissive.setHex(this.starTimer > 0 ? ((performance.now() / 80 | 0) % 2 ? 0xffe040 : 0x40e0ff) : 0x000000);
      });
    }
  }

  /** AI 入力生成 */
  aiInput(dt: number, track: Track, karts: Kart[], player: Kart, rand: () => number): Input {
    this.aiTimer -= dt;
    if (this.aiTimer <= 0) { this.aiTimer = 2 + rand() * 4; this.aiLaneTarget = (rand() - 0.5) * (track.halfWidth - 3) * 2; }
    this.aiLane = lerp(this.aiLane, this.aiLaneTarget, Math.min(1, dt * 0.8));
    // ランバーバンド
    const gap = player.progress - this.progress; // 正ならプレイヤーが前
    const skill = this.def.skill;
    let scale = 0.86 + skill * 0.1;
    if (gap > 120) scale += Math.min(0.14, (gap - 120) / 1500);
    else if (gap < -120) scale -= Math.min(0.12, (-gap - 120) / 1500);
    this.aiSpeedScale = lerp(this.aiSpeedScale, scale, Math.min(1, dt));
    // 先読み目標
    const look = 8 + this.speed * 0.32;
    const target = track.pointAt(this.trackIdx + look / 2, this.aiLane);
    // 前方カートの回避 (簡易)
    for (const o of karts) {
      if (o === this) continue;
      const dx = o.x - this.x, dz = o.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d < 12) {
        const fwd = dx * Math.cos(this.heading) + dz * Math.sin(this.heading);
        if (fwd > 0) { const side = Math.sign((o.lateral - this.lateral) || 1); target.x -= track.nx[this.trackIdx] * side * 3; target.z -= track.nz[this.trackIdx] * side * 3; }
      }
    }
    const want = Math.atan2(target.z - this.z, target.x - this.x);
    let d = want - this.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
    const steer = clamp(d * 2.2, -1, 1);
    // カーブの先読みで減速
    const i1 = this.trackIdx, i2 = track.wrap(this.trackIdx + 20);
    const a1 = Math.atan2(track.tz[i1], track.tx[i1]), a2 = Math.atan2(track.tz[i2], track.tx[i2]);
    let turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
    let throttle = 1;
    if (turn > 0.55 && this.speed > 34) throttle = 0.15;
    else if (turn > 0.35 && this.speed > 44) throttle = 0.5;
    if (Math.abs(d) > 1.2) throttle = 0.3;
    // ドリフト: 長いカーブで使う
    const drift = turn > 0.3 && this.speed > 26 && Math.abs(steer) > 0.35 && skill > 0.3;
    // アイテム使用
    this.aiItemTimer -= dt;
    let item = false;
    if (this.item && this.aiItemTimer <= 0) { item = true; this.aiItemTimer = 1.5 + rand() * 3; }
    return { throttle, brake: 0, steer, drift, item, lookBack: false };
  }
}

export interface KartEvents {
  onLap(k: Kart): void;
  onBoost(k: Kart): void;
  onBump(k: Kart, force: number): void;
  onRouletteDone(k: Kart): void;
}
