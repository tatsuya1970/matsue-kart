import { describe, expect, it } from 'vitest';
// Worker と tools/ は JavaScript (型定義なし)。vitest は型を検査しないのでそのまま読める
import { TelemetryLog, cleanTelemetry, telemetryKey } from '../workers/turn/worker.js';
import { browserOf, isErrorRecord, summarize } from '../tools/telemetry_report.mjs';

/** Durable Object の storage の代わり (get / put / delete / list の使う範囲だけ) */
class FakeStorage {
  map = new Map<string, unknown>();
  async get(key: string) { return this.map.get(key); }
  async put(key: string, value: unknown) { this.map.set(key, value); }
  async delete(keys: string[]) { for (const k of keys) this.map.delete(k); }
  async list(opts: { prefix?: string; start?: string; limit?: number } = {}) {
    const keys = [...this.map.keys()].filter(k => k.startsWith(opts.prefix ?? '') && (opts.start === undefined || k >= opts.start)).sort();
    return new Map(keys.slice(0, opts.limit ?? keys.length).map(k => [k, this.map.get(k)]));
  }
}

const newLog = () => new TelemetryLog({ storage: new FakeStorage() });
const add = (log: any, rec: unknown) => log.fetch(new Request('https://log/add', { method: 'POST', body: JSON.stringify(rec) })).then((r: Response) => r.json());
const list = (log: any, since?: number) => log.fetch(new Request(`https://log/list${since === undefined ? '' : `?since=${since}`}`)).then((r: Response) => r.json());
const ack = (log: any, upto: number) => log.fetch(new Request('https://log/ack', { method: 'POST', body: JSON.stringify({ upto }) })).then((r: Response) => r.json());

const uncaught = (message: string, extra: Record<string, unknown> = {}) => ({
  kind: 'error', event: 'uncaught', data: { message, stack: `${message}\n    at x (a.js:1:2)`, where: 'https://x/a.js:1:2' },
  at: 1200, build: 'abc1234', path: '/', ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36', quality: 'high', lang: 'ja', t: 1_700_000_000_000, ...extra,
});

describe('本番の記録 (Worker 側)', () => {
  it('ページから来た記録は種類と項目を検査して整える', () => {
    const rec = cleanTelemetry({ kind: 'error', event: 'uncaught', data: { message: 'x'.repeat(2000), n: 1, ok: true, nested: { a: 1 } }, at: 12.6, build: 'abc', path: '/en/', ua: 'UA', quality: 'low', lang: 'en', extra: 'dropped' });
    expect(rec).toMatchObject({ kind: 'error', event: 'uncaught', at: 13, build: 'abc', path: '/en/', ua: 'UA', quality: 'low', lang: 'en' });
    expect(rec!.data.message).toHaveLength(1500);
    expect(rec!.data).toMatchObject({ n: 1, ok: true });
    expect(rec!.data).not.toHaveProperty('nested');
    expect(rec).not.toHaveProperty('extra');
  });
  it('知らない種類や event の無いものは受け付けない', () => {
    expect(cleanTelemetry({ kind: 'other', event: 'x' })).toBeNull();
    expect(cleanTelemetry({ kind: 'error' })).toBeNull();
    expect(cleanTelemetry('text')).toBeNull();
    expect(cleanTelemetry(null)).toBeNull();
  });
  it('番号のキーは辞書順 = 番号順', () => {
    expect(telemetryKey(9) < telemetryKey(10)).toBe(true);
    expect(telemetryKey(999) < telemetryKey(1000)).toBe(true);
  });
  it('記録を番号順に残し、通知済みより後だけを返す', async () => {
    const log = newLog();
    for (const m of ['a', 'b', 'c']) await add(log, { kind: 'error', event: 'uncaught', data: { message: m } });
    let r = await list(log);
    expect(r).toMatchObject({ last: 3, notified: 0 });
    expect(r.records.map((x: any) => [x.seq, x.data.message])).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
    expect(r.records[0].t).toBeGreaterThan(0);
    expect(await ack(log, 2)).toEqual({ notified: 2 });
    r = await list(log);
    expect(r.records.map((x: any) => x.seq)).toEqual([3]);
    // 最後の番号より先には進まない。戻りもしない
    expect(await ack(log, 10)).toEqual({ notified: 3 });
    expect(await ack(log, 1)).toEqual({ notified: 3 });
    expect((await list(log)).records).toEqual([]);
    expect((await list(log, 0)).records).toHaveLength(3);
  });
  it('上限を超えたら古いものから消す', async () => {
    const log = newLog();
    for (let i = 0; i < 1001; i++) await add(log, { kind: 'load', event: 'ready', data: { ms: i } });
    const r = await list(log, 0);
    expect(r.last).toBe(1001);
    expect(r.records).toHaveLength(1000);
    expect(r.records[0].seq).toBe(2);
  });
});

describe('本番の記録のまとめ (tools/telemetry_report.mjs)', () => {
  it('通知するのは例外・読み込み失敗・WebGL の喪失', () => {
    expect(isErrorRecord({ kind: 'error', event: 'main' })).toBe(true);
    expect(isErrorRecord({ kind: 'gl', event: 'contextlost' })).toBe(true);
    expect(isErrorRecord({ kind: 'load', event: 'resource' })).toBe(true);
    expect(isErrorRecord({ kind: 'load', event: 'ready' })).toBe(false);
    expect(isErrorRecord({ kind: 'net', event: 'presence' })).toBe(false);
  });
  it('UA はブラウザと端末に丸める', () => {
    expect(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari (スマホ)');
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge (PC)');
    expect(browserOf('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36')).toBe('Chrome (スマホ)');
    expect(browserOf('')).toBe('その他 (PC)');
  });
  it('同じ内容をまとめ、多い順に出す。ほかの記録は件数だけ', () => {
    const records = [
      uncaught('TypeError: a is undefined'),
      uncaught('TypeError: a is undefined', { ua: 'Mozilla/5.0 (iPhone) Safari/604.1', quality: 'low' }),
      uncaught('RangeError: bad'),
      { kind: 'load', event: 'resource', data: { message: 'https://x/data/lod2.bin' }, t: 1_700_000_100_000 },
      { kind: 'load', event: 'ready', data: { ms: 8000 } },
      { kind: 'load', event: 'ready', data: { ms: 4000 } },
      { kind: 'net', event: 'presence', data: { others: 1 } },
    ];
    const { count, markdown } = summarize(records);
    expect(count).toBe(4);
    expect(markdown).toContain('3 種類のエラーが起きました (記録 4 件');
    expect(markdown.indexOf('### 1. error/uncaught: TypeError: a is undefined — 2 件')).toBeGreaterThan(0);
    expect(markdown.indexOf('### 1.')).toBeLessThan(markdown.indexOf('### 2.'));
    expect(markdown).toContain('load/resource: https://x/data/lod2.bin — 1 件');
    expect(markdown).toContain('Chrome (PC), Safari (スマホ)');
    expect(markdown).toContain('画質: high, low');
    expect(markdown).toContain('at x (a.js:1:2)');
    expect(markdown).toContain('読み込み完了 2 件 (中央値 8.0 秒)、net presence 1 件');
    expect(markdown).not.toContain('Mozilla');
  });
  it('エラーが無ければ何も書かない', () => {
    expect(summarize([{ kind: 'load', event: 'ready', data: { ms: 1 } }])).toEqual({ count: 0, markdown: '' });
    expect(summarize([])).toEqual({ count: 0, markdown: '' });
  });
});
