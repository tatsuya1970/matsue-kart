import { beforeAll, describe, expect, it, vi } from 'vitest';

// src/i18n.ts は読み込み時に location を見る (言語の判定)
vi.stubGlobal('location', new URL('http://localhost/'));
let cleanName: typeof import('../src/ranking').cleanName;
let eligibleRun: typeof import('../src/ranking').eligibleRun;
let formatTime: typeof import('../src/ranking').formatTime;
let formatDate: typeof import('../src/ranking').formatDate;
beforeAll(async () => ({ cleanName, eligibleRun, formatTime, formatDate } = await import('../src/ranking')));
// Worker の検査もここで行う (JavaScript。vitest は型を見ないのでそのまま読める)
import { cleanName as workerCleanName, cleanTime, siteOf } from '../workers/turn/worker.js';

describe('ランキング (ページ側)', () => {
  it('名前は制御文字を除き、前後の空白を取り、10 文字に切る (絵文字も 1 文字)', () => {
    expect(cleanName('  たけむら  ')).toBe('たけむら');
    expect(cleanName('a' + String.fromCharCode(0) + 'b' + String.fromCharCode(0x200b) + 'c')).toBe('abc');
    expect(cleanName('0123456789ABC')).toBe('0123456789');
    expect([...cleanName('🏎🏎🏎🏎🏎🏎🏎🏎🏎🏎🏎🏎')]).toHaveLength(10);
    expect(cleanName('   ')).toBe('');
  });
  it('デバッグ・撮影用の URL で走った記録は登録しない', () => {
    expect(eligibleRun('')).toBe(true);
    expect(eligibleRun('?lang=en&q=low')).toBe(true);
    expect(eligibleRun('?debug=1')).toBe(false);
    expect(eligibleRun('?steps=20')).toBe(false);
    expect(eligibleRun('?ai=1')).toBe(false);
    expect(eligibleRun('?rec=1')).toBe(false);
  });
  it('タイムを m:ss.ss で出す', () => {
    expect(formatTime(385.2)).toBe('6:25.20');
    expect(formatTime(59.994)).toBe('0:59.99');
  });
  it('登録した日時を YYYY/MM/DD HH:mm で出す (端末の時刻)', () => {
    expect(formatDate(new Date(2026, 8, 24, 19, 5).getTime())).toBe('2026/09/24 19:05');
    expect(formatDate(NaN)).toBe('');
    expect(formatDate(0)).toBe('');
  });
});

describe('ランキング (Worker 側)', () => {
  it('Origin からサイト名を取る', () => {
    expect(siteOf('https://matsue.citykart.jp')).toBe('matsue');
    expect(siteOf('https://hiroshima.citykart.jp')).toBe('hiroshima');
    expect(siteOf('not a url')).toBe('');
  });
  it('ページ側と同じ規則で名前を整える', () => {
    for (const s of ['  たけむら ', 'a\u0000b', '0123456789ABC', '<img src=x>']) expect(workerCleanName(s)).toBe(cleanName(s));
    expect(workerCleanName(undefined)).toBe('');
  });
  it('ありえない速さ・遅さ・数でないタイムは拒否し、0.01 秒に丸める', () => {
    expect(cleanTime('matsue', 400.123)).toBe(400.12);
    expect(cleanTime('matsue', 100)).toBeNull();      // 松江 19.2 km を 100 秒は無理
    expect(cleanTime('fukuyama', 190)).toBeNull();
    expect(cleanTime('hiroshima', 150)).toBe(150);
    expect(cleanTime('matsue', 4000)).toBeNull();
    expect(cleanTime('matsue', NaN)).toBeNull();
    expect(cleanTime('matsue', '400')).toBe(400);
    expect(cleanTime('matsue', Infinity)).toBeNull();
  });
});

describe('使えない名前 (workers/turn/ngwords.js)', () => {
  it('不適切な言葉を含む名前を弾く (全角・カタカナ・空白・当て字もそろえてから比べる)', async () => {
    const { isNgName } = await import('../workers/turn/ngwords.js');
    for (const n of ['死ね', 'シネ', 'セックス', 'ｓｅｘ', 'S E X', 's3x', 'FUCK', 'fuckyou', 'きちがい', 'キチガイ太郎', 'ちんこ', 'ﾁﾝｺ', 'バカ', 'うんこ', 'Hitler']) {
      expect(isNgName(n), n).toBe(true);
    }
  });
  it('普通の名前は通す (短い語は名前全体が一致したときだけ弾く)', async () => {
    const { isNgName } = await import('../workers/turn/ngwords.js');
    for (const n of ['たけむら', 'Takemura', 'grape', 'class', 'バカンス', 'あほうどり', 'しねま', 'Sussex', 'かすてら', 'ごみや', 'しじみ', 'Diego', 'Nazir', 'Mc Kart', '松江太郎', '🏎🏎']) {
      expect(isNgName(n), n).toBe(false);
    }
  });
});
