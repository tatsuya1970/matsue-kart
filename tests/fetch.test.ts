import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBlob, fetchBuffer, fetchJson, FetchError } from '../src/fetch';

const ok = (body: BodyInit) => new Response(body, { status: 200 });
const notFound = () => new Response('<html>404</html>', { status: 404 });

afterEach(() => vi.unstubAllGlobals());

/** 再試行の待ち時間だけを記録する (時間切れ用の長いタイマーは除く)。タイマー自体は本物のまま */
function recordWaits(timeoutMs = 60000): () => number[] {
  const ms: number[] = [];
  const real = globalThis.setTimeout;
  vi.stubGlobal('setTimeout', ((fn: () => void, delay?: number) => {
    if (delay !== undefined && delay < timeoutMs) ms.push(delay);
    return real(fn, delay);
  }) as unknown as typeof setTimeout);
  return () => ms;
}

describe('fetchJson', () => {
  it('404 は例外にして、再試行で取れたら成功する', async () => {
    const f = vi.fn().mockResolvedValueOnce(notFound()).mockResolvedValueOnce(ok('{"a":1}'));
    vi.stubGlobal('fetch', f);
    await expect(fetchJson('x.json', { backoffMs: 1 })).resolves.toEqual({ a: 1 });
    expect(f).toHaveBeenCalledTimes(2);
    // 再試行はキャッシュを通さない
    expect(f.mock.calls[1][1].cache).toBe('reload');
  });

  it('再試行しきったら最後の失敗 (状態コード付き) を投げる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => notFound()));
    const err = await fetchJson('x.json', { retries: 1, backoffMs: 1 }).catch(e => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.status).toBe(404);
    // API が返す理由 (workers/turn/ の daily_cap など) を読めるよう、本文の先頭も持つ
    expect(err.body).toContain('404');
  });

  it('403 は間を空けて試し直し、通れば成功する', async () => {
    const blocked = () => new Response('', { status: 403 });
    const f = vi.fn().mockResolvedValueOnce(blocked()).mockResolvedValueOnce(ok('{"a":1}'));
    vi.stubGlobal('fetch', f);
    await expect(fetchJson('x.json', { backoffMs: 1, blockedBackoffMs: 1 })).resolves.toEqual({ a: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('403 の待ちは backoffMs ではなく blockedBackoffMs に従う', async () => {
    const waits = recordWaits();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('', { status: 403 })));
    await fetchJson('x.json', { backoffMs: 1, blockedBackoffMs: 40 }).catch(() => {});
    expect(waits()).toHaveLength(2);
    // ±25% ばらすので下限だけ見る
    for (const ms of waits()) expect(ms).toBeGreaterThanOrEqual(30);
  });

  it('404 は従来どおり短い間隔で試し直す', async () => {
    const waits = recordWaits();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => notFound()));
    await fetchJson('x.json', { backoffMs: 10 }).catch(() => {});
    expect(waits()).toEqual([10, 20]);
  });

  it('応答が来なければ時間切れにする', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_: string, init: RequestInit) => new Promise((_r, rej) => {
      init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })));
    const err = await fetchJson('slow.json', { timeoutMs: 20, retries: 0 }).catch(e => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.message).toMatch(/timeout/);
  });
});

describe('fetchBuffer', () => {
  it('json から見た長さに足りなければ再試行し、それでも足りなければ失敗する', async () => {
    const f = vi.fn().mockImplementation(async () => ok(new Uint8Array(10)));
    vi.stubGlobal('fetch', f);
    await expect(fetchBuffer('t.bin', 16, { retries: 2, backoffMs: 1 })).rejects.toThrow(/short body 10 < 16/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('長さが足りていれば返す', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(new Uint8Array(16))));
    await expect(fetchBuffer('t.bin', 16)).resolves.toHaveProperty('byteLength', 16);
  });
});

describe('fetchBlob', () => {
  it('画像本文が停止しても時間切れにする', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_: string, init: RequestInit) => new Promise((_r, rej) => {
      init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })));
    await expect(fetchBlob('stalled.jpg', { timeoutMs: 20, retries: 0 })).rejects.toThrow(/timeout/);
  });
});

describe('テレメトリ', () => {
  it('読み込みに失敗した URL はクエリとフラグメントを除いて送る', async () => {
    const { stripQuery } = await import('../src/telemetry');
    expect(stripQuery('https://x.example/a/b.png?token=secret#frag')).toBe('https://x.example/a/b.png');
    expect(stripQuery('/assets/x.js?v=1')).toBe('/assets/x.js');
  });
  it('送る前に、文の中の URL のクエリとメールアドレスを伏せる', async () => {
    // 送り先は読み込み時に決まるので、設定してから読み込み直す
    vi.resetModules();
    vi.stubEnv('VITE_TELEMETRY_URL', 'https://t.example/telemetry');
    vi.stubGlobal('location', new URL('https://matsue.citykart.jp/'));
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { sent.push(String(init.body)); return new Response(null, { status: 204 }); }));
    try {
      const { report } = await import('../src/telemetry');
      report('error', 'uncaught', { message: 'Failed to fetch https://api.example/x?token=secret (taro@example.com)', n: 1 });
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]).data).toEqual({ message: 'Failed to fetch https://api.example/x?… (<email>)', n: 1 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
