import { describe, expect, it, vi } from 'vitest';
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

describe('受信したアイテムの数の上限 (netSpawnAllowed)', () => {
  it('1 台が置いたオイル・ボールが上限に達したら出さない。ほかのカートの分は数えない', async () => {
    // src/items.ts → src/i18n.ts は読み込み時に location を見る (言語の判定)
    vi.stubGlobal('location', new URL('http://localhost/'));
    const { NET_MAX_PLACED, netSpawnAllowed } = await import('../src/items');
    const a = remoteKart(), b = remoteKart();
    const oils = Array.from({ length: NET_MAX_PLACED.banana - 1 }, () => ({ owner: a }));
    expect(netSpawnAllowed('banana', a, oils)).toBe(true);
    oils.push({ owner: a });
    expect(netSpawnAllowed('banana', a, oils)).toBe(false);
    expect(netSpawnAllowed('banana', b, oils)).toBe(true);
    const balls = Array.from({ length: NET_MAX_PLACED.shell }, () => ({ owner: a }));
    expect(netSpawnAllowed('shell', a, balls)).toBe(false);
    // 物を置かないアイテム (ダッシュ・むてき) は数えない
    expect(netSpawnAllowed('mushroom', a, oils)).toBe(true);
    expect(netSpawnAllowed('star', a, oils)).toBe(true);
  });
});
