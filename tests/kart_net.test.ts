import { describe, expect, it } from 'vitest';
import { Kart, NET_EXTRAPOLATE_SEC } from '../src/kart';
import type { Track } from '../src/track';

/** netApply が使う範囲だけの走行線 (最寄点は常に 0 番) */
const track = { length: 1000, nearest: () => ({ idx: 0 }) } as unknown as Track;

function remoteKart(): Kart {
  const k = new Kart({ name: 'B', color: 0, accent: 0, isPlayer: false, skill: 1 });
  // main.ts の applyPoses と同じ受け取り方 (東向きに 50 m/s)
  k.hasNet = true; k.netAge = 0;
  k.netX = 0; k.netZ = 0; k.netY = 0; k.netHeading = 0; k.netSpeed = 50;
  return k;
}

describe('他人のカートの外挿 (Kart.netApply)', () => {
  it('位置が届くあいだは速度で前へ進める', () => {
    const k = remoteKart();
    for (let i = 0; i < 4; i++) k.netApply(1 / 60, track);
    expect(k.netX).toBeCloseTo(50 * 4 / 60, 5);
    expect(k.speed).toBe(50);
  });

  it('途絶えたら NET_EXTRAPOLATE_SEC で打ち切って止まる (建物を突き抜けて直進しない)', () => {
    const k = remoteKart();
    for (let i = 0; i < 600; i++) k.netApply(1 / 60, track);   // 10 秒届かない
    expect(k.netX).toBeCloseTo(50 * NET_EXTRAPOLATE_SEC, 5);
    expect(k.x).toBeCloseTo(50 * NET_EXTRAPOLATE_SEC, 1);
    expect(k.speed).toBe(0);
  });

  it('次に届いたらまた進める', () => {
    const k = remoteKart();
    for (let i = 0; i < 120; i++) k.netApply(1 / 60, track);
    k.netAge = 0; k.netX = 100;   // 新しい位置が届いた
    k.netApply(1 / 60, track);
    expect(k.netX).toBeCloseTo(100 + 50 / 60, 5);
    expect(k.speed).toBe(50);
  });
});
