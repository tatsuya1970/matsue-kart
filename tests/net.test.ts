import { beforeAll, describe, expect, it, vi } from 'vitest';

// src/net.ts は読み込み時に location を見る (本番と開発の appId の切り替え)
vi.stubGlobal('location', new URL('http://localhost/'));
let net: typeof import('../src/net');
beforeAll(async () => { net = await import('../src/net'); });

describe('resolveHost', () => {
  it('作成者がいればその人', () => {
    expect(net.resolveHost(['a', 'b', 'c'], { c: true }, 'join', 0)).toBe('c');
  });
  it('公開ロビーは ID が最小の人', () => {
    expect(net.resolveHost(['a', 'b'], {}, 'open', 0)).toBe('a');
  });
  it('合言葉で参加した直後は作成者が分かるまで決めない', () => {
    expect(net.resolveHost(['a', 'b'], {}, 'join', 1000)).toBe('');
    expect(net.resolveHost(['a', 'b'], {}, 'join', 6000)).toBe('a');
  });
});

describe('TURN config', () => {
  it('STUN と TURN を区別する', () => {
    expect(net.isTurnIceServer({ urls: 'stun:stun.example.test:3478' })).toBe(false);
    expect(net.isTurnIceServer({ urls: ['stun:x', 'turns:turn.example.test:5349'] })).toBe(true);
  });

  // turn.json → 資格情報 API の順に読む loadTurn を、fetch を差し替えて通す
  const withFetch = (api: () => Response) => vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) =>
    /turn\.json/.test(url) ? new Response('{"url":"https://turn.example.workers.dev/"}', { status: 200 }) : api()));
  const turnList = '{"iceServers":[{"urls":"turn:t.example:3478","username":"u","credential":"c"}]}';

  it('資格情報 API が返せば ok', async () => {
    withFetch(() => new Response(turnList, { status: 200 }));
    expect(await net.loadTurn()).toBe(1);
    expect(net.turnState()).toBe('ok');
    vi.unstubAllGlobals();
  });
  it('1 日の上限 (503 + daily_cap) は capped、ほかの失敗は error', async () => {
    withFetch(() => new Response('{"error":"daily_cap","count":500,"cap":500}', { status: 503 }));
    expect(await net.loadTurn()).toBe(0);
    expect(net.turnState()).toBe('capped');
    withFetch(() => new Response('upstream HTTP 500', { status: 502 }));
    expect(await net.loadTurn()).toBe(0);
    expect(net.turnState()).toBe('error');
    vi.unstubAllGlobals();
  });
  it('turn.json が無ければ none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('not found', { status: 404 })));
    expect(await net.loadTurn()).toBe(0);
    expect(net.turnState()).toBe('none');
    vi.unstubAllGlobals();
  });
});

describe('acceptLobby', () => {
  const info = { order: ['a', 'b'], names: { a: 'A', b: 'B' }, seed: 1, deadline: 0 };
  it('自分から見たホストの座席表だけを受け入れる', () => {
    expect(net.acceptLobby('a', 'a', info)).toBe(true);
    // 別の人が「自分がホストだ」と思って配った座席表 (直結できない組がいるとき) は捨てる
    expect(net.acceptLobby('b', 'a', info)).toBe(false);
    // ホストがまだ決まっていないときも捨てる
    expect(net.acceptLobby('a', '', info)).toBe(false);
  });
  it('形のおかしい座席表は捨てる', () => {
    expect(net.acceptLobby('a', 'a', null)).toBe(false);
    expect(net.acceptLobby('a', 'a', { ...info, order: 'a' })).toBe(false);
    expect(net.acceptLobby('a', 'a', { ...info, order: ['b'] })).toBe(false);   // 送り主が席に入っていない
    expect(net.acceptLobby('a', 'a', { ...info, order: Array.from({ length: 9 }, (_, i) => i ? `p${i}` : 'a') })).toBe(false);
    expect(net.acceptLobby('a', 'a', { ...info, order: ['a', 1] })).toBe(false);
  });
});

describe('席の持ち主だけが位置とイベントを送れる', () => {
  // a がホストで席 0、b が席 1。席 2〜7 は空き枠 (AI) でホストが動かす
  const order = ['a', 'b'];
  const host = 'a';
  const pose = (slot: number, x = 1) => [slot, x, 2, 3, 0.5, 20, 0, 0, 1, 100, 0, 0];

  it('slotOwner: 人の席はその人、空き枠はホスト、範囲外は誰にも渡さない', () => {
    expect(net.slotOwner(order, host, 0)).toBe('a');
    expect(net.slotOwner(order, host, 1)).toBe('b');
    expect(net.slotOwner(order, host, 5)).toBe('a');
    expect(net.slotOwner(order, host, net.MAX_SLOTS)).toBe('');
    expect(net.slotOwner(order, host, -1)).toBe('');
    expect(net.slotOwner(order, host, 1.5)).toBe('');
    expect(net.slotOwner(order, host, '__proto__')).toBe('');
    expect(net.slotOwner(order, '', 5)).toBe('');   // ホスト未定なら AI 枠も渡さない
  });

  it('pose: 自分の席と (ホストなら) 空き枠だけ通り、他人の席は捨てる', () => {
    expect(net.parsePoses(pose(1), 'b', order, host)).toHaveLength(1);
    expect(net.parsePoses([...pose(0), ...pose(3)], 'a', order, host)).toHaveLength(2);
    expect(net.parsePoses(pose(0), 'b', order, host)).toEqual([]);      // b が a の席を名乗る
    expect(net.parsePoses(pose(3), 'b', order, host)).toEqual([]);      // b が AI 枠を名乗る
    // まとめて送った中に他人の席が混ざっていれば、その席だけ捨てる
    expect(net.parsePoses([...pose(1), ...pose(0)], 'b', order, host).map(p => p.slot)).toEqual([1]);
  });

  it('pose: 壊れた配列と有限でない値は捨てる', () => {
    expect(net.parsePoses(null, 'b', order, host)).toEqual([]);
    expect(net.parsePoses([], 'b', order, host)).toEqual([]);
    expect(net.parsePoses(pose(1).slice(0, 11), 'b', order, host)).toEqual([]);          // 長さが合わない
    expect(net.parsePoses(new Array(12 * 9).fill(0), 'a', order, host)).toEqual([]);      // 全枠より多い
    expect(net.parsePoses([1, NaN, 2, 3, 0, 0, 0, 0, 1, 0, 0, 0], 'b', order, host)).toEqual([]);
    expect(net.parsePoses([1, 0, Infinity, 3, 0, 0, 0, 0, 1, 0, 0, 0], 'b', order, host)).toEqual([]);
    expect(net.parsePoses(['1', 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0], 'b', order, host)).toEqual([]);
    expect(net.parsePoses(['__proto__', 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0], 'b', order, host)).toEqual([]);
  });

  it('ev: 他人の席のゴール・被弾・アイテム使用は捨てる', () => {
    expect(net.parseEvent({ t: 'fin', slot: 1, time: 123.4 }, 'b', order, host)).toEqual({ t: 'fin', slot: 1, time: 123.4 });
    expect(net.parseEvent({ t: 'fin', slot: 0, time: 0 }, 'b', order, host)).toBeNull();   // b が a のゴールを偽装
    expect(net.parseEvent({ t: 'hit', slot: 1 }, 'a', order, host)).toBeNull();            // a が b の被弾を偽装
    expect(net.parseEvent({ t: 'hit', slot: 1 }, 'b', order, host)).toEqual({ t: 'hit', slot: 1 });
    expect(net.parseEvent({ t: 'hit', slot: 4 }, 'a', order, host)).toEqual({ t: 'hit', slot: 4 });   // AI 枠はホスト
    expect(net.parseEvent({ t: 'hit', slot: 4 }, 'b', order, host)).toBeNull();
  });

  it('ev: 形の違うもの・知らないアイテム・有限でない値は捨てる', () => {
    const use = { t: 'use', slot: 1, item: 'shell', x: 1, z: 2, y: 3, heading: 0.1, speed: 30 };
    expect(net.parseEvent(use, 'b', order, host)).toEqual(use);
    expect(net.parseEvent({ ...use, item: 'nuke' }, 'b', order, host)).toBeNull();
    expect(net.parseEvent({ ...use, x: NaN }, 'b', order, host)).toBeNull();
    expect(net.parseEvent({ ...use, speed: '30' }, 'b', order, host)).toBeNull();
    expect(net.parseEvent({ t: 'fin', slot: 1, time: -1 }, 'b', order, host)).toBeNull();
    expect(net.parseEvent({ t: 'fin', slot: 1, time: Infinity }, 'b', order, host)).toBeNull();
    expect(net.parseEvent({ t: 'boom', slot: 1 }, 'b', order, host)).toBeNull();
    expect(net.parseEvent({ t: 'hit', slot: '__proto__' }, 'b', order, host)).toBeNull();
    expect(net.parseEvent(null, 'b', order, host)).toBeNull();
    expect(net.parseEvent([1, 2], 'b', order, host)).toBeNull();
    expect(net.parseEvent('hit', 'b', order, host)).toBeNull();
  });
});

describe('presence の分室', () => {
  it('対戦待ちは最初の部屋と全分室に入り、それ以外は自分の部屋だけ', () => {
    const all = net.presenceRooms('wait', net.PRESENCE_ROOM);
    expect(all).toHaveLength(net.PRESENCE_SHARDS + 1);
    expect(all).toContain(net.PRESENCE_ROOM);
    expect(net.presenceRooms('title', net.shardRoom(2))).toEqual([net.shardRoom(2)]);
    expect(net.presenceRooms('race', net.PRESENCE_ROOM)).toEqual([net.PRESENCE_ROOM]);
  });

  it('最初の部屋が混んだら分室へ移る。対戦待ちと移った後は動かない', () => {
    expect(net.shouldSplit('title', net.PRESENCE_ROOM, net.PRESENCE_SPLIT_AT)).toBe(false);
    expect(net.shouldSplit('title', net.PRESENCE_ROOM, net.PRESENCE_SPLIT_AT + 1)).toBe(true);
    expect(net.shouldSplit('wait', net.PRESENCE_ROOM, 100)).toBe(false);
    expect(net.shouldSplit('title', net.shardRoom(1), 100)).toBe(false);
  });

  it('分室は ID で決まり、偏らない', () => {
    expect(net.shardOf('abc')).toBe(net.shardOf('abc'));
    const counts = new Array(net.PRESENCE_SHARDS).fill(0);
    for (let i = 0; i < 4000; i++) counts[net.shardOf(Math.random().toString(36).slice(2, 22))]++;
    for (const c of counts) expect(c).toBeGreaterThan(4000 / net.PRESENCE_SHARDS * 0.8);
  });
});

describe('sanitizeLobby', () => {
  it('名前を文字列にして 10 文字に切り、席にいない人の名前は捨てる', () => {
    const info = net.sanitizeLobby({
      order: ['a', 'b'],
      names: { a: '<img src=x onerror=alert(1)>', b: 12345 as unknown as string, z: 'extra' },
      seed: 7, deadline: 1000,
    }, 1);
    expect(info.names).toEqual({ a: '<img src=x', b: '12345' });
    expect(info.seed).toBe(7);
    expect(info.deadline).toBe(1000);
  });
  it('数値でない seed / deadline は既定値にする', () => {
    const info = net.sanitizeLobby({ order: ['a'], names: {}, seed: 'x' as unknown as number, deadline: 'y' as unknown as number }, 42);
    expect(info.seed).toBe(42);
    expect(info.deadline).toBe(0);
    expect(info.names.a).toBe('???');
    // Infinity の締切はカウントダウンが止まったまま残るので 0 に戻す
    expect(net.sanitizeLobby({ order: ['a'], names: {}, seed: 1, deadline: Infinity }, 42).deadline).toBe(0);
    expect(net.sanitizeLobby({ order: ['a'], names: {}, seed: 1, deadline: -5 }, 42).deadline).toBe(0);
  });
});
