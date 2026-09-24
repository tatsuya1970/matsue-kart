import { describe, expect, it } from 'vitest';
// tools/ は JavaScript (型定義なし)。vitest は型を検査しないのでそのまま読める
import { apiHeaders, hasStaticCredential, originFromCname, rejectStaticCredential, secretParamIn, validateConfigUrl } from '../tools/turn_config.mjs';

describe('TURN の資格情報を公開しない', () => {
  it('username / credential を直接書いた設定を見つける', () => {
    expect(hasStaticCredential({ iceServers: [{ urls: 'turn:t.example:3478', username: 'u', credential: 'p' }] })).toBe(true);
    expect(hasStaticCredential([{ urls: 'turns:t.example:5349', credential: 'p' }])).toBe(true);
    expect(() => rejectStaticCredential({ iceServers: [{ urls: 'turn:t.example', username: 'u', credential: 'p' }] })).toThrow(/誰でも読めます/);
  });
  it('資格情報 API の URL だけの設定や、資格情報の無い一覧は通す', () => {
    expect(hasStaticCredential({ url: 'https://example.test/credentials' })).toBe(false);
    expect(hasStaticCredential({ iceServers: [{ urls: 'stun:s.example:3478' }] })).toBe(false);
  });
});

describe('資格情報 API の URL に鍵を入れない', () => {
  it('クエリの鍵らしき名前を見つける', () => {
    expect(secretParamIn('https://x.metered.live/api/v1/turn/credentials?apiKey=abc')).toBe('apiKey');
    expect(secretParamIn('https://api.example.test/turn?api_key=abc')).toBe('api_key');
    expect(secretParamIn('https://api.example.test/turn?token=abc')).toBe('token');
    expect(secretParamIn('https://api.example.test/turn?ttl=600')).toBe('');
    expect(secretParamIn('https://turn.example.workers.dev/')).toBe('');
  });
  it('validateConfigUrl は https 以外と鍵付きの URL を止める', () => {
    expect(validateConfigUrl('https://turn.example.workers.dev/')).toBe('https://turn.example.workers.dev/');
    expect(() => validateConfigUrl('http://turn.example.workers.dev/')).toThrow(/https/);
    expect(() => validateConfigUrl('https://x.metered.live/api/v1/turn/credentials?apiKey=abc')).toThrow(/apiKey/);
  });
  it('CNAME からサイトの Origin を作り、API の呼び出しで名乗る', () => {
    expect(originFromCname('matsue.citykart.jp\n')).toBe('https://matsue.citykart.jp');
    expect(originFromCname('')).toBe('');
    expect(apiHeaders('https://matsue.citykart.jp')).toEqual({ accept: 'application/json', origin: 'https://matsue.citykart.jp' });
    expect(apiHeaders('')).toEqual({ accept: 'application/json' });
  });
});
