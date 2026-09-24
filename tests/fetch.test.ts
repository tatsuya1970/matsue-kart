import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBlob, fetchBuffer, fetchJson, FetchError } from '../src/fetch';

const ok = (body: BodyInit) => new Response(body, { status: 200 });
const notFound = () => new Response('<html>404</html>', { status: 404 });

afterEach(() => vi.unstubAllGlobals());

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
