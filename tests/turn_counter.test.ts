import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Worker は JavaScript (型定義なし)。vitest は型を検査しないのでそのまま読める
import worker, { DailyCounter } from '../workers/turn/worker.js';

// worker.js の ICE_TTL_SEC / FAIL_TTL_SEC と同じ値 (Worker の入口からは数を export できない)
const ICE_TTL_SEC = 3600;
const FAIL_TTL_SEC = 30;

/** Durable Object の storage の代わり (DailyCounter が使う get / put の形だけ) */
class FakeStorage {
  map = new Map<string, unknown>();
  async get(key: string | string[]) {
    return Array.isArray(key) ? new Map(key.filter(k => this.map.has(k)).map(k => [k, this.map.get(k)])) : this.map.get(key);
  }
  async put(entries: Record<string, unknown>) {
    for (const [k, v] of Object.entries(entries)) this.map.set(k, v);
  }
}

const TURN = [{ urls: 'stun:stun.example:3478' }, { urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }];
const TURN2 = [{ urls: 'turn:turn2.example:3478', username: 'u2', credential: 'c2' }];
const ENV = { TURN_API_URL: 'https://example.metered.live/api/v1/turn/credentials?apiKey=k1' };
/** secret を入れ替えた後の設定 */
const ENV2 = { TURN_API_URL: 'https://example.metered.live/api/v1/turn/credentials?apiKey=k2' };

const newCounter = (env: Record<string, string> = ENV, storage = new FakeStorage()) => new DailyCounter({ storage }, env);
const ice = (c: any, limit = 500) => c.fetch(new Request('https://counter/ice', { method: 'POST', body: JSON.stringify({ limit }) })).then((r: Response) => r.json());
const status = (c: any) => c.fetch(new Request('https://counter/status')).then((r: Response) => r.json());
/** 裏で上流を呼んでいる分が終わるまで待つ */
const idle = (c: any) => vi.waitFor(() => expect(c.pending).toBeNull());

let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-28T03:00:00Z'));   // 日本時間 12:00
  upstream = vi.fn(async () => Response.json(TURN));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TURN の資格情報の保存と 1 日の上限 (DailyCounter)', () => {
  it('上流の応答を保存して、ICE_TTL_SEC のあいだは上流を呼ばずに配る', async () => {
    const c = newCounter();
    expect(await ice(c)).toEqual({ ok: true, iceServers: TURN });
    expect(await ice(c)).toEqual({ ok: true, iceServers: TURN });
    vi.setSystemTime(Date.now() + (ICE_TTL_SEC - 1) * 1000);
    await ice(c);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await status(c)).toMatchObject({ day: '2026-10-28', count: 1 });
    // 古くなったら保存分を待たせずに返し、裏で聞き直す (そのときだけ数える)。次の要求から新しい方
    upstream.mockImplementation(async () => Response.json(TURN2));
    vi.setSystemTime(Date.now() + 2000);
    expect(await ice(c)).toEqual({ ok: true, iceServers: TURN });
    await idle(c);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect((await status(c)).count).toBe(2);
    expect(await ice(c)).toEqual({ ok: true, iceServers: TURN2 });
  });

  it('上流が落ちていても古い保存分を配り続け、取り直しは FAIL_TTL_SEC おき', async () => {
    const c = newCounter();
    await ice(c);
    upstream.mockImplementation(async () => new Response('down', { status: 500 }));
    vi.setSystemTime(Date.now() + ICE_TTL_SEC * 1000);
    expect(await ice(c)).toEqual({ ok: true, iceServers: TURN });
    await idle(c);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(await ice(c)).toEqual({ ok: true, iceServers: TURN });   // 失敗の直後は上流を呼ばない
    await idle(c);
    expect(upstream).toHaveBeenCalledTimes(2);
    upstream.mockImplementation(async () => Response.json(TURN2));
    vi.setSystemTime(Date.now() + FAIL_TTL_SEC * 1000);
    expect(await ice(c)).toEqual({ ok: true, iceServers: TURN });
    await idle(c);
    expect(await ice(c)).toEqual({ ok: true, iceServers: TURN2 });
    expect((await status(c)).count).toBe(2);   // 失敗した回は数えない
  });

  it('上流が失敗した回は数えず、FAIL_TTL_SEC のあいだは上流を呼ばずに同じ失敗を返す', async () => {
    upstream.mockImplementation(async () => new Response('down', { status: 500 }));
    const c = newCounter();
    expect(await ice(c)).toEqual({ ok: false, error: 'upstream', message: 'upstream HTTP 500' });
    expect(await ice(c)).toEqual({ ok: false, error: 'upstream', message: 'upstream HTTP 500' });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((await status(c)).count).toBe(0);
    // 時間がたてばもう一度聞く。戻っていれば配る
    upstream.mockImplementation(async () => Response.json(TURN));
    vi.setSystemTime(Date.now() + FAIL_TTL_SEC * 1000);
    expect(await ice(c)).toEqual({ ok: true, iceServers: TURN });
    expect((await status(c)).count).toBe(1);
  });

  it('上流が届かない・STUN だけを返すのも失敗として扱う', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      upstream.mockImplementation(async () => { throw new TypeError('network'); });
      expect(await ice(newCounter())).toMatchObject({ ok: false, message: 'upstream unreachable' });
      upstream.mockImplementation(async () => Response.json([{ urls: 'stun:stun.example:3478' }]));
      expect(await ice(newCounter())).toMatchObject({ ok: false, message: 'upstream returned no turn: server' });
    } finally {
      log.mockRestore();
    }
  });

  it('上流に届かないときの例外の文は返さず、ログにはクエリ (鍵) を伏せて残す', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // fetch は URL が壊れているとき、例外の文に URL を入れることがある
      upstream.mockImplementation(async () => { throw new TypeError(`Fetch API cannot load: ${ENV.TURN_API_URL}`); });
      const r = await ice(newCounter());
      expect(r).toEqual({ ok: false, error: 'upstream', message: 'upstream unreachable' });
      expect(JSON.stringify(r)).not.toContain('k1');
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('Fetch API cannot load: https://example.metered.live/api/v1/turn/credentials?…');
      expect(log.mock.calls[0][0]).not.toContain('k1');
    } finally {
      log.mockRestore();
    }
  });

  it('上限に達しても保存分があれば配る。使える保存分が無ければ上流を呼ばずに daily_cap、翌日は 0 から', async () => {
    const storage = new FakeStorage();
    const c = newCounter(ENV, storage);
    expect((await ice(c, 1)).ok).toBe(true);
    vi.setSystemTime(Date.now() + ICE_TTL_SEC * 1000);
    expect(await ice(c, 1)).toEqual({ ok: true, iceServers: TURN });   // 古い保存分
    await idle(c);
    expect(upstream).toHaveBeenCalledTimes(1);   // 上限なので取り直さない
    // secret を入れ替えると、前の設定で取った保存分は配らない
    const c2 = newCounter(ENV2, storage);
    expect(await ice(c2, 1)).toEqual({ ok: false, error: 'daily_cap', count: 1 });
    expect(upstream).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-28T15:00:00Z'));   // 日本時間の翌日 0 時
    expect((await ice(c2, 1)).ok).toBe(true);
    expect(await status(c2)).toMatchObject({ day: '2026-10-29', count: 1 });
  });

  it('同時に来た要求は、上流を呼んでいる最中の 1 回に相乗りする', async () => {
    let release!: () => void;
    upstream.mockImplementation(() => new Promise<Response>(r => { release = () => r(Response.json(TURN)); }));
    const c = newCounter();
    const all = Promise.all([ice(c), ice(c), ice(c)]);
    await vi.waitFor(() => expect(upstream).toHaveBeenCalled());
    release();
    expect((await all).every((r: any) => r.ok)).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect((await status(c)).count).toBe(1);
  });

  it('設定 (secret) を入れ替えたら、保存分を捨てて新しい設定で聞き直す', async () => {
    const storage = new FakeStorage();
    await ice(newCounter(ENV, storage));
    // デプロイや secret の入れ替えで Object が作り直される (storage は残る)
    await ice(newCounter(ENV, storage));
    expect(upstream).toHaveBeenCalledTimes(1);
    await ice(newCounter(ENV2, storage));
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls[1][0]).toContain('apiKey=k2');
  });

  it('Worker の入口: 許可した Origin に配り、上限と上流の失敗は理由と CORS を付けて返す', async () => {
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } });
    const storage = new FakeStorage();
    let c = newCounter(ENV, storage);
    const env = {
      ...ENV, ALLOWED_ORIGINS: 'https://matsue.citykart.jp', DAILY_CAP: '1',
      DAILY_COUNTER: { idFromName: () => 'turn', get: () => ({ fetch: (u: string, init?: RequestInit) => c.fetch(new Request(u, init)) }) },
    };
    const ctx = { waitUntil() {} };
    const get = (origin = 'https://matsue.citykart.jp', path = '/') => worker.fetch(new Request(`https://w.example${path}`, { headers: { origin } }), env, ctx);

    expect((await get('https://evil.example')).status).toBe(403);
    let res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://matsue.citykart.jp');
    expect(await res.json()).toEqual({ iceServers: TURN });
    expect(await (await get('', '/status')).json()).toMatchObject({ count: 1, cap: 1, cachedAt: '2026-10-28T03:00:00.000Z' });

    // 上限に達していても、古い保存分は配る
    vi.setSystemTime(Date.now() + ICE_TTL_SEC * 1000);
    res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ iceServers: TURN });
    await idle(c);
    // secret を入れ替えた直後 (使える保存分が無い) に上限に達していれば 503
    c = newCounter(ENV2, storage);
    res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://matsue.citykart.jp');
    expect(await res.json()).toMatchObject({ error: 'daily_cap', count: 1, cap: 1 });

    vi.setSystemTime(new Date('2026-10-28T15:00:00Z'));
    upstream.mockImplementation(async () => new Response('down', { status: 503 }));
    res = await get();
    expect(res.status).toBe(502);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://matsue.citykart.jp');
    expect(await res.text()).toBe('upstream HTTP 503');
  });

  it('上限を 0 にすると数えるだけで止めない', async () => {
    const c = newCounter();
    for (let i = 0; i < 3; i++) {
      expect((await ice(c, 0)).ok).toBe(true);
      await idle(c);
      vi.setSystemTime(Date.now() + ICE_TTL_SEC * 1000);
    }
    expect((await status(c)).count).toBe(3);
  });
});
