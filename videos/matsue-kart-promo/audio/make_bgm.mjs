// プロモ動画の BGM を合成する (外部素材なし・著作権フリー)
//   node audio/make_bgm.mjs   → audio/bgm.wav (30 秒, 120 BPM, 44.1kHz stereo)
//
// 構成は STORYBOARD.md のフレームに合わせる (1 拍 = 0.5 秒)。
//   0.0–18.5s  全開 (キック 4 つ打ち・クラップ・ハイハット・ベース・アルペジオ)
//   18.5–21.0s ブレイク (嫁ヶ島の息継ぎ): パッドだけ + ライザー
//   21.0–28.0s 再び全開 (数字カード → エンドカード)
//   28.0–30.0s 最後の和音を伸ばしてフェードアウト
// 乱数は使わず、ノイズも決定的な擬似乱数で作る。
import { writeFileSync } from 'node:fs';

const SR = 44100, DUR = 30, BPM = 120;
const BEAT = 60 / BPM, STEP = BEAT / 4;
const N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);

let seed = 12345;
const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
const midi = m => 440 * Math.pow(2, (m - 69) / 12);
const add = (i, l, r = l) => { if (i >= 0 && i < N) { L[i] += l; R[i] += r; } };

const inBreak = t => t >= 18.5 && t < 21.0;
const isOutro = t => t >= 28.0;

// コード進行 (A minor): Am - F - C - G を 2 小節ずつ
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const chordAt = t => CHORDS[Math.floor(t / (BEAT * 8)) % 4];
const BASS_ROOT = [45, 41, 48, 43];
const rootAt = t => BASS_ROOT[Math.floor(t / (BEAT * 8)) % 4];

// ---- キック ----
function kick(t0, gain = 1) {
  const s = Math.floor(t0 * SR), len = Math.floor(0.35 * SR);
  let ph = 0;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    const f = 45 + 110 * Math.exp(-t * 28);
    ph += (2 * Math.PI * f) / SR;
    const env = Math.exp(-t * 7);
    const click = k < 60 ? noise() * 0.3 * (1 - k / 60) : 0;
    add(s + k, (Math.sin(ph) * env + click) * 0.9 * gain);
  }
}
// ---- クラップ ----
function clap(t0, gain = 1) {
  const s = Math.floor(t0 * SR), len = Math.floor(0.25 * SR);
  let lp = 0;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    const burst = t < 0.03 ? (Math.floor(t / 0.01) % 2 === 0 ? 1 : 0.4) : 1;
    const env = Math.exp(-t * 18) * burst;
    const n = noise();
    lp += 0.35 * (n - lp);
    const v = (n - lp) * env * 0.35 * gain;
    add(s + k, v * 0.9, v);
  }
}
// ---- ハイハット ----
function hat(t0, open = false, gain = 1) {
  const s = Math.floor(t0 * SR), len = Math.floor((open ? 0.18 : 0.05) * SR);
  let prev = 0;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    const n = noise();
    const hp = n - prev; prev = n;
    const env = Math.exp(-t * (open ? 22 : 90));
    const v = hp * env * 0.12 * gain;
    add(s + k, v * 0.7, v);
  }
}
// ---- ベース (ノコギリ波 + ローパス、キックでサイドチェイン) ----
function bassNote(t0, dur, m, gain = 1) {
  const s = Math.floor(t0 * SR), len = Math.floor(dur * SR);
  const f = midi(m);
  let ph = 0, lp = 0;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    ph = (ph + f / SR) % 1;
    const saw = 2 * ph - 1;
    const cutoff = 0.08 + 0.25 * Math.exp(-t * 12);
    lp += cutoff * (saw - lp);
    const env = Math.min(1, t * 400) * Math.exp(-t * 3);
    add(s + k, Math.tanh(lp * 2.2) * env * 0.32 * gain);
  }
}
// ---- アルペジオ (矩形波 + ディレイ) ----
function pluck(t0, m, gain = 1, pan = 0) {
  const s = Math.floor(t0 * SR), len = Math.floor(0.22 * SR);
  const f = midi(m);
  let ph = 0;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    ph = (ph + f / SR) % 1;
    const sq = ph < 0.5 ? 1 : -1;
    const tri = 4 * Math.abs(ph - 0.5) - 1;
    const env = Math.exp(-t * 16);
    const v = (sq * 0.35 + tri * 0.65) * env * 0.09 * gain;
    add(s + k, v * (1 - pan), v * (1 + pan));
    // 付点 8 分のディレイ
    const d = Math.floor(BEAT * 0.75 * SR);
    add(s + k + d, v * 0.35 * (1 + pan), v * 0.35 * (1 - pan));
  }
}
// ---- パッド (デチューンしたノコギリ波 3 本) ----
function pad(t0, dur, notes, gain = 1) {
  const s = Math.floor(t0 * SR), len = Math.floor(dur * SR);
  const phs = notes.flatMap(() => [0, 0, 0]);
  let lpL = 0, lpR = 0;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    let vl = 0, vr = 0;
    notes.forEach((m, i) => {
      [-0.08, 0, 0.08].forEach((dt, j) => {
        const idx = i * 3 + j;
        phs[idx] = (phs[idx] + midi(m + dt) / SR) % 1;
        const v = 2 * phs[idx] - 1;
        if (j === 0) vl += v; else if (j === 2) vr += v; else { vl += v * 0.5; vr += v * 0.5; }
      });
    });
    const env = Math.min(1, t / 0.4) * Math.min(1, (dur - t) / 0.5);
    lpL += 0.04 * (vl - lpL); lpR += 0.04 * (vr - lpR);
    add(s + k, lpL * env * 0.035 * gain, lpR * env * 0.035 * gain);
  }
}
// ---- ライザー (ホワイトノイズのスイープ) ----
function riser(t0, dur, gain = 1) {
  const s = Math.floor(t0 * SR), len = Math.floor(dur * SR);
  let lp = 0;
  for (let k = 0; k < len; k++) {
    const u = k / len;
    const n = noise();
    lp += (0.02 + 0.5 * u * u) * (n - lp);
    const v = (n - lp * 0.5) * u * u * 0.22 * gain;
    add(s + k, v, v);
  }
}
// ---- クラッシュ ----
function crash(t0, gain = 1) {
  const s = Math.floor(t0 * SR), len = Math.floor(1.8 * SR);
  let prev = 0;
  for (let k = 0; k < len; k++) {
    const t = k / SR;
    const n = noise();
    const hp = n - prev * 0.6; prev = n;
    const v = hp * Math.exp(-t * 2.2) * 0.16 * gain;
    add(s + k, v * 0.9, v);
  }
}

// ---- 並べる ----
const steps = Math.round(DUR / STEP);
for (let i = 0; i < steps; i++) {
  const t = i * STEP;
  if (inBreak(t)) continue;
  const beatPos = i % 4, bar16 = i % 16;
  const outro = isOutro(t);
  if (outro && t > 28.0) break;
  if (beatPos === 0) kick(t);
  if (bar16 === 4 || bar16 === 12) clap(t);
  if (beatPos === 2) hat(t, true, 0.9); else hat(t, false, beatPos === 0 ? 0.5 : 0.8);
  // ベース: 16 分のうねり (キックの拍は休む = サイドチェイン)
  if (beatPos !== 0) bassNote(t, STEP * 0.9, rootAt(t) + (beatPos === 3 ? 12 : 0), 0.9);
  // アルペジオ: 和音を上下
  const ch = chordAt(t);
  const pattern = [0, 1, 2, 1, 2, 0, 1, 2];
  const note = ch[pattern[i % 8]] + 12 + (i % 16 >= 12 ? 12 : 0);
  if (t >= 3.0) pluck(t, note, 0.9, (i % 2 ? 0.4 : -0.4));
}
// パッド: 全体の下地
for (let b = 0; b < DUR; b += BEAT * 8) {
  const ch = chordAt(b);
  pad(b, Math.min(BEAT * 8, DUR - b), ch.map(m => m + 12), inBreak(b + 0.1) ? 1.6 : 0.7);
}
// ブレイク: パッドを厚く + ライザー
pad(18.5, 2.6, [57, 60, 64, 69], 1.4);
riser(19.0, 2.0, 1.2);
// 区切りの一発
crash(0.0, 0.8);
crash(6.0, 0.6);
crash(21.0, 1.0);
crash(25.5, 0.7);
kick(28.0, 1.2);
crash(28.0, 1.0);
pad(28.0, 2.0, [45, 57, 60, 64, 69], 1.6);
bassNote(28.0, 1.8, 33, 1.4);

// ---- マスター: ソフトクリップ + 最後のフェード ----
let peak = 0;
for (let k = 0; k < N; k++) {
  const t = k / SR;
  const fade = t > 29.0 ? Math.max(0, (30 - t)) : 1;
  const fin = Math.min(1, t / 0.02);
  L[k] = Math.tanh(L[k] * 1.1) * fade * fin;
  R[k] = Math.tanh(R[k] * 1.1) * fade * fin;
  peak = Math.max(peak, Math.abs(L[k]), Math.abs(R[k]));
}
const norm = 0.89 / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let k = 0; k < N; k++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[k] * norm)) * 32767), 44 + k * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[k] * norm)) * 32767), 46 + k * 4);
}
writeFileSync(new URL('./bgm.wav', import.meta.url), buf);
console.log(`audio/bgm.wav ${DUR}s ${BPM}BPM (peak ${peak.toFixed(2)} → 0.89)`);
