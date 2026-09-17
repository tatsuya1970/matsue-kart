// HUD (DOM) とミニマップ
import type { Kart } from './kart';
import type { Track } from './track';
import { ITEM_ICON } from './items';

const $ = (id: string) => document.getElementById(id)!;

// タイトル画面のコース図。走行線と経由地名、スタート地点と進行方向を描く。
// canvas は実ピクセルを 2 倍で持ち、以下は論理座標 (CSS ピクセル) で描く。
export function drawCourseMap(canvas: HTMLCanvasElement, track: Track) {
  const c = canvas.getContext('2d')!;
  const W = canvas.width / 2, H = canvas.height / 2;
  c.setTransform(2, 0, 0, 2, 0, 0);
  c.clearRect(0, 0, W, H);

  let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < track.n; i++) {
    xMin = Math.min(xMin, track.px[i]); xMax = Math.max(xMax, track.px[i]);
    zMin = Math.min(zMin, track.pz[i]); zMax = Math.max(zMax, track.pz[i]);
  }
  const padX = 56, padY = 24;   // 地点名を外側に置くぶん左右を広めにとる
  const scale = Math.min((W - padX * 2) / (xMax - xMin), (H - padY * 2) / (zMax - zMin));
  const ox = (W - (xMax - xMin) * scale) / 2 - xMin * scale;
  const oz = (H - (zMax - zMin) * scale) / 2 - zMin * scale;
  const toMap = (x: number, z: number): [number, number] => [x * scale + ox, z * scale + oz];
  // ラベルを外向きに逃がすための重心
  let cx = 0, cz = 0;
  for (let i = 0; i < track.n; i++) { cx += track.px[i]; cz += track.pz[i]; }
  cx /= track.n; cz /= track.n;

  const stroke = (from: number, to: number, width: number, color: string) => {
    c.lineWidth = width; c.strokeStyle = color; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath();
    for (let i = from; i <= to; i += 2) {
      const p = toMap(track.px[i % track.n], track.pz[i % track.n]);
      i === from ? c.moveTo(p[0], p[1]) : c.lineTo(p[0], p[1]);
    }
    c.stroke();
  };
  stroke(0, track.n, 9, 'rgba(0,0,0,.45)');          // 縁取り
  stroke(0, track.n, 5, 'rgba(255,255,255,.92)');    // 走行線
  // 高架区間 (course.json の elevated) だけ色を変える
  for (let i = 0; i < track.n; i++) {
    if (track.elev[i] <= 1) continue;
    let j = i; while (j + 1 < track.n && track.elev[j + 1] > 1) j++;
    stroke(i, j, 5, '#5aa0ff');
    i = j;
  }

  // 進行方向の矢印
  c.fillStyle = '#ffd83d';
  for (let k = 0; k < 4; k++) {
    const i = Math.floor((k + 0.5) / 4 * track.n);
    const p = toMap(track.px[i], track.pz[i]);
    const a = Math.atan2(track.tz[i], track.tx[i]);
    c.save(); c.translate(p[0], p[1]); c.rotate(a);
    c.beginPath(); c.moveTo(7, 0); c.lineTo(-4, 4.5); c.lineTo(-4, -4.5); c.closePath(); c.fill();
    c.restore();
  }

  // 経由地
  c.font = 'bold 11px "Hiragino Sans", "Noto Sans JP", sans-serif';
  c.textBaseline = 'middle';
  for (const l of track.labels) {
    const p = toMap(track.px[l.idx], track.pz[l.idx]);
    let dx = track.px[l.idx] - cx, dz = track.pz[l.idx] - cz;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    let tx = p[0] + dx * 13;
    const ty = Math.max(9, Math.min(H - 9, p[1] + dz * 13));
    c.beginPath(); c.arc(p[0], p[1], 3, 0, Math.PI * 2);
    c.fillStyle = '#fff'; c.fill();
    c.lineWidth = 1.5; c.strokeStyle = 'rgba(0,0,0,.6)'; c.stroke();
    const align = dx > 0.25 ? 'left' : dx < -0.25 ? 'right' : 'center';
    c.textAlign = align;
    // 画面外へはみ出さないよう左右に寄せ戻す
    const tw = c.measureText(l.name).width;
    const x0 = align === 'left' ? tx : align === 'right' ? tx - tw : tx - tw / 2;
    tx += Math.max(0, 3 - x0) - Math.max(0, x0 + tw - (W - 3));
    c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.75)';
    c.strokeText(l.short, tx, ty);
    c.fillStyle = '#ffd83d';
    c.fillText(l.short, tx, ty);
  }

  // スタート地点
  const s = toMap(track.px[0], track.pz[0]);
  c.beginPath(); c.arc(s[0], s[1], 6, 0, Math.PI * 2);
  c.fillStyle = '#ff4b4b'; c.fill();
  c.lineWidth = 2.5; c.strokeStyle = '#fff'; c.stroke();
}

export class Hud {
  private lapNum = $('lapNum');
  private lapTotal = $('lapTotal');
  private timer = $('timer');
  private pos = $('pos');
  private item = $('item');
  private speed = $('speed');
  private coins = $('coins');
  private landmark = $('landmark');
  private center = $('center');
  private wrong = $('wrong');
  private mm = $('minimap') as HTMLCanvasElement;
  private mctx = this.mm.getContext('2d')!;
  /** スマホでは CSS (pointer: coarse) でミニマップを隠しているので、描画も省く */
  private mmHidden = getComputedStyle(this.mm).display === 'none';
  private mapPts: [number, number][] = [];
  private mapScale = 1; private mapOx = 0; private mapOz = 0;
  private landmarkTimer = 0;
  private centerTimer = 0;
  private rouletteIcons = ['🍄', '🍌', '🐢', '⭐'];

  constructor(track: Track, laps: number) {
    this.lapTotal.textContent = String(laps);
    let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < track.n; i++) { xMin = Math.min(xMin, track.px[i]); xMax = Math.max(xMax, track.px[i]); zMin = Math.min(zMin, track.pz[i]); zMax = Math.max(zMax, track.pz[i]); }
    const pad = 14;
    this.mapScale = Math.min((this.mm.width - pad * 2) / (xMax - xMin), (this.mm.height - pad * 2) / (zMax - zMin));
    this.mapOx = (this.mm.width - (xMax - xMin) * this.mapScale) / 2 - xMin * this.mapScale;
    this.mapOz = (this.mm.height - (zMax - zMin) * this.mapScale) / 2 - zMin * this.mapScale;
    for (let i = 0; i < track.n; i += 3) this.mapPts.push(this.toMap(track.px[i], track.pz[i]));
  }

  private toMap(x: number, z: number): [number, number] { return [x * this.mapScale + this.mapOx, z * this.mapScale + this.mapOz]; }

  showLandmark(name: string) { this.landmark.textContent = name; this.landmark.style.opacity = '1'; this.landmarkTimer = 2.2; }
  showCenter(text: string, dur = 1, color = '#ffd83d') { this.center.textContent = text; this.center.style.color = color; this.center.style.opacity = '1'; this.centerTimer = dur; }

  update(dt: number, player: Kart, karts: Kart[], raceTime: number, track: Track, labels: { idx: number; name: string; sub: string; short: string }[]) {
    this.lapNum.textContent = String(Math.max(1, Math.min(player.lap, Number(this.lapTotal.textContent))));
    const t = Math.max(0, raceTime);
    const m = Math.floor(t / 60), s = t - m * 60;
    this.timer.textContent = `${m}:${s.toFixed(2).padStart(5, '0')}`;
    const r = player.rank;
    const suffix = r === 1 ? 'st' : r === 2 ? 'nd' : r === 3 ? 'rd' : 'th';
    this.pos.innerHTML = `${r}<small>${suffix}</small>`;
    this.pos.style.color = r === 1 ? '#ffd83d' : r <= 3 ? '#fff' : '#cfd8e3';
    this.speed.innerHTML = `${Math.round(Math.abs(player.speed) * 3.6)}<small> km/h</small>`;
    this.coins.textContent = `🪙 ${player.coins}`;
    if (player.itemRoulette > 0) this.item.textContent = this.rouletteIcons[Math.floor(performance.now() / 90) % 4];
    else this.item.textContent = player.item ? ITEM_ICON[player.item] : '';
    this.item.style.borderColor = player.item ? '#ffd83d' : '#fff';
    if (this.landmarkTimer > 0) { this.landmarkTimer -= dt; if (this.landmarkTimer <= 0) this.landmark.style.opacity = '0'; }
    if (this.centerTimer > 0) { this.centerTimer -= dt; if (this.centerTimer <= 0) this.center.style.opacity = '0'; }
    this.wrong.style.display = player.wrongWayTime > 1.2 ? 'block' : 'none';
    // ミニマップ
    if (this.mmHidden) return;
    const c = this.mctx;
    c.clearRect(0, 0, this.mm.width, this.mm.height);
    c.lineWidth = 5; c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineJoin = 'round';
    c.beginPath();
    this.mapPts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
    c.closePath(); c.stroke();
    c.fillStyle = '#ffd83d'; c.font = '9px sans-serif'; c.textAlign = 'center';
    for (const l of labels) { const p = this.toMap(track.px[l.idx], track.pz[l.idx]); c.fillText(l.short, p[0], p[1] - 6); }
    for (const k of karts) {
      const p = this.toMap(k.x, k.z);
      c.beginPath(); c.arc(p[0], p[1], k.def.isPlayer ? 6 : 4, 0, Math.PI * 2);
      c.fillStyle = '#' + k.def.color.toString(16).padStart(6, '0'); c.fill();
      c.lineWidth = k.def.isPlayer ? 2.5 : 1; c.strokeStyle = k.def.isPlayer ? '#fff' : 'rgba(0,0,0,0.6)'; c.stroke();
    }
  }
}
