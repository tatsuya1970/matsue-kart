import { beforeAll, describe, expect, it, vi } from 'vitest';

// src/i18n.ts は読み込み時に location を見る (言語の判定)
vi.stubGlobal('location', new URL('http://localhost/'));
let cleanName: typeof import('../src/ranking').cleanName;
let eligibleRun: typeof import('../src/ranking').eligibleRun;
let formatTime: typeof import('../src/ranking').formatTime;
let formatDate: typeof import('../src/ranking').formatDate;
beforeAll(async () => ({ cleanName, eligibleRun, formatTime, formatDate } = await import('../src/ranking')));
// Worker の検査もここで行う (JavaScript。vitest は型を見ないのでそのまま読める)
import worker, { Leaderboard, cleanName as workerCleanName, cleanRun, cleanTime, parseJstTime, siteOf } from '../workers/turn/worker.js';

/**
 * Durable Object の storage の代わり (Leaderboard が使う範囲)。本物と同じく値は写しにする。
 * PITR は呼ばれた引数を覚えるだけ (手元では本物を試せない)
 */
class FakeStorage {
  map = new Map<string, unknown>();
  restoreTo: string | null = null;
  async get(key: string) { const v = this.map.get(key); return v === undefined ? undefined : structuredClone(v); }
  async put(key: string, value: unknown) { this.map.set(key, structuredClone(value)); }
  async getBookmarkForTime(at: number) { return `bm-${at}`; }
  async onNextSessionRestoreBookmark(bookmark: string) { this.restoreTo = bookmark; return 'bm-undo'; }
}

const newBoard = () => {
  const storage = new FakeStorage();
  // 本物の abort は、呼んだ要求を失敗させてインスタンスを終わらせる
  const abort = vi.fn(() => { throw new Error('aborted'); });
  return { board: new Leaderboard({ storage, abort }) as any, storage, abort };
};
const addTo = (board: any, body: Record<string, unknown>) =>
  board.fetch(new Request('https://board/add', { method: 'POST', body: JSON.stringify(body) })).then((r: Response) => r.json());
const topOf = (board: any) => board.fetch(new Request('https://board/top')).then((r: Response) => r.json());
/** 本文がゆっくり届く要求。release() を呼ぶまで json() が終わらない */
function slowRequest(url: string, body: unknown) {
  let release!: () => void;
  const arrived = new Promise<void>(r => { release = r; });
  return { request: { method: 'POST', url, json: () => arrived.then(() => body) }, release };
}

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
  it('同時に来た登録が、互いの書き込みを消さない (本文の届くのが遅い要求があっても)', async () => {
    const { board } = newBoard();
    const slow = slowRequest('https://board/add', { name: 'A', time: 300 });
    const adding = board.fetch(slow.request);
    await addTo(board, { name: 'B', time: 310 });
    slow.release();
    await adding;
    expect((await topOf(board)).entries.map((e: any) => e.name)).toEqual(['A', 'B']);
  });
  it('同じレース (run) の再送は 1 件にして、前の結果を返す。run は一覧に出さない', async () => {
    const { board } = newBoard();
    const run = '0123456789abcdef0123456789abcdef';
    const first = await addTo(board, { name: 'A', time: 300, run });
    await addTo(board, { name: 'B', time: 290 });
    const again = await addTo(board, { name: 'A2', time: 300, run });
    expect(again.id).toBe(first.id);
    expect(again.rank).toBe(2);
    const { entries } = await topOf(board);
    expect(entries.map((e: any) => e.name)).toEqual(['B', 'A']);
    expect(entries.some((e: any) => 'run' in e)).toBe(false);
    expect(again.entries.some((e: any) => 'run' in e)).toBe(false);
    // run の無い古いページからの登録は、これまでどおり毎回入る
    await addTo(board, { name: 'C', time: 320 });
    await addTo(board, { name: 'C', time: 320 });
    expect((await topOf(board)).entries).toHaveLength(4);
  });
  it('run は 16〜64 文字の 16 進とハイフンだけ受け付ける', () => {
    expect(cleanRun('0123456789ABCDEF-0123')).toBe('0123456789abcdef-0123');
    expect(cleanRun('short')).toBeUndefined();
    expect(cleanRun('x'.repeat(20))).toBeUndefined();
    expect(cleanRun(123)).toBeUndefined();
  });
  it('戻す時刻は、時差が無ければ日本時間として読む', () => {
    expect(parseJstTime('2026-10-28 12:00')).toBe(Date.UTC(2026, 9, 28, 3, 0));
    expect(parseJstTime('2026-10-28T12:00:30')).toBe(Date.UTC(2026, 9, 28, 3, 0, 30));
    expect(parseJstTime('2026-10-28T03:00:00Z')).toBe(Date.UTC(2026, 9, 28, 3, 0));
    expect(parseJstTime('1761620400000')).toBe(1761620400000);
    expect(parseJstTime('2026-10-28')).toBeNaN();
    expect(parseJstTime('')).toBeNaN();
    expect(parseJstTime(null)).toBeNaN();
  });
  it('管理用の復旧: 合言葉が要り、その時刻の bookmark へ戻して、起動し直した後の一覧を返す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T03:00:00Z'));
    try {
      const { board, storage, abort } = newBoard();
      await addTo(board, { name: 'A', time: 300 });
      const env = { ADMIN_TOKEN: 'secret', LEADERBOARD: { idFromName: (s: string) => s, get: () => ({ fetch: (u: string, init?: RequestInit) => board.fetch(new Request(u, init)) }) } };
      const call = (query: string, token = 'secret', method = 'POST') =>
        worker.fetch(new Request(`https://w.example/ranking/restore?${query}`, { method, headers: { authorization: `Bearer ${token}` } }), env, {});
      expect((await call('site=matsue&at=2026-10-28+11:00', 'wrong')).status).toBe(403);
      expect((await call('site=matsue&at=2026-10-28+11:00', 'secret', 'GET')).status).toBe(405);
      expect((await call('site=matsue')).status).toBe(400);
      expect((await call('site=matsue&at=2026-10-29+11:00')).status).toBe(400);   // 未来
      expect((await call('site=matsue&at=2026-09-01+11:00')).status).toBe(400);   // 30 日より前
      expect(storage.restoreTo).toBeNull();

      const res = await call('site=matsue&at=2026-10-28+11:00');
      expect(res.status).toBe(200);
      const at = Date.UTC(2026, 9, 28, 2, 0);
      expect(await res.json()).toEqual({ site: 'matsue', restoredTo: `bm-${at}`, undo: 'bm-undo', entries: [expect.objectContaining({ name: 'A' })] });
      expect(storage.restoreTo).toBe(`bm-${at}`);
      expect(abort).toHaveBeenCalledTimes(1);
      // 取り消し: undo の bookmark へ戻す
      expect((await call('site=matsue&bookmark=bm-undo')).status).toBe(200);
      expect(storage.restoreTo).toBe('bm-undo');
    } finally {
      vi.useRealTimers();
    }
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
