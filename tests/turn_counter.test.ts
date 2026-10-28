import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Worker は JavaScript (型定義なし)。vitest は型を検査しないのでそのまま読める
import worker, { DailyCounter, FAIL_TTL_SEC, ICE_TTL_SEC } from '../workers/turn/worker.js';

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
const ENV = { TURN_API_URL: 'https://example.metered.live/api/v1/turn/credentials?apiKey=k1' };

const newCounter = (env: Record<string, string> = ENV, storage = new FakeStorage()) => new DailyCounter({ storage }, env);
const ice = (c: any, limit = 500) => c.fetch(new Request('https://counter/ice', { method: 'POST', body: JSON.stringify({ limit }) })).then((r: Response) => r.json());
const status = (c: any) => c.fetch(new Request('https://counter/status')).then((r: Response) => r.json());

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
    // 古くなったら聞き直し、そのときだけ数える
    vi.setSystemTime(Date.now() + 2000);
    await ice(c);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect((await status(c)).count).toBe(2);
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
    upstream.mockImplementation(async () => { throw new TypeError('network'); });
    expect(await ice(newCounter())).toMatchObject({ ok: false, message: 'upstream unreachable: network' });
    upstream.mockImplementation(async () => Response.json([{ urls: 'stun:stun.example:3478' }]));
    expect(await ice(newCounter())).toMatchObject({ ok: false, message: 'upstream returned no turn: server' });
  });

  it('上限に達したら上流を呼ばずに daily_cap。保存分が新しいあいだは配り続け、翌日は 0 から', async () => {
    const c = newCounter();
    expect((await ice(c, 1)).ok).toBe(true);
    expect((await ice(c, 1)).ok).toBe(true);   // 保存分
    vi.setSystemTime(Date.now() + ICE_TTL_SEC * 1000);
    expect(await ice(c, 1)).toEqual({ ok: false, error: 'daily_cap', count: 1 });
    expect(upstream).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-28T15:00:00Z'));   // 日本時間の翌日 0 時
    expect((await ice(c, 1)).ok).toBe(true);
    expect(await status(c)).toMatchObject({ day: '2026-10-29', count: 1 });
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
    await ice(newCounter({ TURN_API_URL: 'https://example.metered.live/api/v1/turn/credentials?apiKey=k2' }, storage));
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream.mock.calls[1][0]).toContain('apiKey=k2');
  });

  it('Worker の入口: 許可した Origin に配り、上限と上流の失敗は理由と CORS を付けて返す', async () => {
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } });
    const c = newCounter();
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

    vi.setSystemTime(Date.now() + ICE_TTL_SEC * 1000);
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
      vi.setSystemTime(Date.now() + ICE_TTL_SEC * 1000);
    }
    expect((await status(c)).count).toBe(3);
  });
});
