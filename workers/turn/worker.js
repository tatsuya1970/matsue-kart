// TURN の資格情報を発行する API の前に置く Cloudflare Worker。
//
// なぜ要るか: turn.json は静的サイトとして配信され誰でも読める。そこに
// 「?apiKey=... 付きの資格情報 API の URL」を書くと、鍵ごと公開されて誰でも
// 自分の枠で TURN の資格情報を取れる (枠が尽きると 3 サイトの対戦PLAY が止まる)。
// この Worker が鍵を持ち、サイトの Origin からの GET だけを上流へ通す。
//
// 守れること / 守れないこと:
//   - 鍵はブラウザに渡らない。差し替えも Worker の secret だけで済む。
//   - 他のサイトのページからは呼べない (Origin と CORS)。ただし curl は Origin を
//     偽れるので、上流を叩く回数は RATE_LIMITER (wrangler.toml) と短時間の
//     キャッシュで抑える。キャッシュは独自ドメインに載せたときだけ効く
//     (*.workers.dev では Cache API は何もしない)。
//   - 資格情報そのものの有効期限は上流で決まる。短くできるなら短くする。
//   - 1 日 (日本時間) に上流へ発行してもらう回数に上限を掛ける (DAILY_CAP)。上限に達した
//     日は 503 を返し、サイト側は TURN が取れないので対戦PLAY を出さない。翌日 0 時に戻る。
//     これで「資格情報を大量に取られる」ことは防げるが、1 つの資格情報で有効期間の
//     あいだに流せる量までは縛れない (それは上流の仕様)。費用の上限は上流のプランで
//     決める: metered.ca の無料プランはカード登録が無く、枠を超えても請求は無い。
//     数は Durable Object (DailyCounter) で数える。いまの数は GET /status で見られる
//     (Origin 不要、秘密は出ない)。
//
// 使い方 (1 つの Worker を 3 サイトで共有する。上流は metered.ca の無料プラン):
//   metered.ca でアプリと TURN の資格情報 (credential) を 1 つ作り、その行の「Show API Key」の
//   鍵で URL を組む: https://<アプリ名>.metered.live/api/v1/turn/credentials?apiKey=<資格情報の API キー>
//   (Developers にある Secret key はアカウント全体の鍵なので使わない)
//   cd workers/turn
//   npx wrangler login
//   npx wrangler secret put TURN_API_URL      # 上の URL
//   npx wrangler deploy
// デプロイで出た URL を、各リポジトリの GitHub variable TURN_CONFIG_URL に設定する。
// 許可する Origin と 1 日の上限は wrangler.toml の [vars]。
// Cloudflare の TURN に切り替えるなら TURN_API_URL を発行 API の URL、TURN_API_TOKEN を
// API トークンにし、[vars] の POST の 2 行のコメントを外す (Bearer 認証の POST になる)。

/** 上流の応答をこの秒数だけ使い回す (同じ資格情報を配っても構わない) */
const CACHE_SEC = 60;

/** ICE サーバーの一覧に turn: / turns: があるか (tools/turn_config.mjs と同じ判定) */
function hasTurnServer(list) {
  return list.some(server => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some(url => typeof url === 'string' && /^turns?:/i.test(url));
  });
}

/**
 * 上流の応答を { iceServers: [...] } にそろえる。metered.ca は配列を返し、
 * Cloudflare TURN は { iceServers: { urls, username, credential } } (配列でない) を返す。
 */
function normalize(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.iceServers)) return value.iceServers;
  if (value && value.iceServers && typeof value.iceServers === 'object') return [value.iceServers];
  return [];
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

function withCors(res, origin) {
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.set('Vary', 'Origin');
  return res;
}

const text = (status, body) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

/** 日本時間の日付 (YYYY-MM-DD)。上限はこの単位で数え、0 時に戻る */
export function jstDay(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 次の日本時間 0 時 (ミリ秒)。上限に達したときの応答に載せる */
export function nextJstMidnight(now = Date.now()) {
  const jst = new Date(now + 9 * 3600 * 1000);
  return Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() + 1) - 9 * 3600 * 1000;
}

/**
 * 1 日の発行回数を数える Durable Object。1 つだけ作り (idFromName('turn'))、
 * 全リクエストがここを通るので数え漏れも数え過ぎもない (同じ Object の処理は直列)。
 *   POST /take   { day, limit } → { ok, count }   上限内なら 1 増やして ok
 *   GET  /status                → { day, count }
 * cloudflare:workers の DurableObject を継承しない fetch 方式にしてあるのは、
 * Node でそのまま読み込んで動作確認できるようにするため (tools/ の検査と同じ流儀)。
 */
export class DailyCounter {
  constructor(state) {
    this.storage = state.storage;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const stored = (await this.storage.get(['day', 'count']));
    const day = stored.get('day');
    const count = stored.get('count') ?? 0;
    if (request.method === 'POST' && url.pathname === '/take') {
      const body = await request.json();
      const cur = body.day === day ? count : 0;   // 日付が変わったら 0 から
      if (cur >= body.limit) return Response.json({ ok: false, count: cur });
      await this.storage.put({ day: body.day, count: cur + 1 });
      return Response.json({ ok: true, count: cur + 1 });
    }
    return Response.json({ day: day ?? null, count });
  }
}

/** 今日の発行数を 1 つ確保する。上限に達していれば false。上限が無効なら常に true */
async function takeDaily(env) {
  const cap = Number(env.DAILY_CAP) || 0;
  if (cap <= 0 || !env.DAILY_COUNTER) return { ok: true, count: 0, cap };
  const stub = env.DAILY_COUNTER.get(env.DAILY_COUNTER.idFromName('turn'));
  const res = await stub.fetch('https://counter/take', { method: 'POST', body: JSON.stringify({ day: jstDay(), limit: cap }) });
  const r = await res.json();
  return { ...r, cap };
}

async function dailyStatus(env) {
  const cap = Number(env.DAILY_CAP) || 0;
  if (!env.DAILY_COUNTER) return { day: jstDay(), count: 0, cap };
  const stub = env.DAILY_COUNTER.get(env.DAILY_COUNTER.idFromName('turn'));
  const r = await (await stub.fetch('https://counter/status')).json();
  // 日付が変わっていれば、まだ数え直していないだけなので 0 として見せる
  return { day: jstDay(), count: r.day === jstDay() ? r.count : 0, cap };
}

export default {
  async fetch(request, env, ctx) {
    // 今日の発行数 (監視用。Origin 不要、秘密は出ない)
    if (request.method === 'GET' && new URL(request.url).pathname === '/status') {
      return Response.json(await dailyStatus(env), { headers: { 'cache-control': 'no-store' } });
    }
    const origin = request.headers.get('Origin') ?? '';
    if (!allowedOrigins(env).includes(origin)) return text(403, 'forbidden');
    // 許可した Origin への失敗応答には CORS ヘッダーを付ける。付けないとブラウザは
    // 状態コードも本文も読めず、サイト側が「上限に達した」と「つながらない」を区別できない
    const fail = (status, body) => withCors(text(status, body), origin);
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), origin);
    if (request.method !== 'GET') return fail(405, 'method not allowed');
    if (!env.TURN_API_URL) return fail(500, 'TURN_API_URL is not set');

    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return fail(429, 'too many requests');
    }

    // 短時間のキャッシュ。呼び出しが集中しても上流は CACHE_SEC に 1 回しか叩かない
    const cache = caches.default;
    const cacheKey = new Request(new URL('/ice-servers', request.url).toString());
    let cached = await cache.match(cacheKey);
    if (!cached) {
      // 上流に発行してもらう回数の上限 (キャッシュから返すぶんは数えない)
      const daily = await takeDaily(env);
      if (!daily.ok) {
        // サイト側 (src/net.ts の loadTurn) は error: 'daily_cap' を見て
        // 「今日は対戦はできません。午前 0 時にリセットします」と出す
        const body = { error: 'daily_cap', count: daily.count, cap: daily.cap, day: jstDay(), resetAt: nextJstMidnight() };
        return withCors(Response.json(body, { status: 503, headers: { 'cache-control': 'no-store' } }), origin);
      }
      const init = { method: env.TURN_API_METHOD || 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) };
      if (env.TURN_API_TOKEN) init.headers.authorization = `Bearer ${env.TURN_API_TOKEN}`;
      if (env.TURN_API_BODY) { init.body = env.TURN_API_BODY; init.headers['content-type'] = 'application/json'; }
      let upstream;
      try {
        upstream = await fetch(env.TURN_API_URL, init);
      } catch (e) {
        return fail(502, `upstream unreachable: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!upstream.ok) return fail(502, `upstream HTTP ${upstream.status}`);
      let servers;
      try {
        servers = normalize(await upstream.json());
      } catch {
        return fail(502, 'upstream returned non-JSON');
      }
      // STUN だけの応答は配らない (サイト側は TURN があるかで対戦PLAY の可否を決める)
      if (!hasTurnServer(servers)) return fail(502, 'upstream returned no turn: server');
      cached = new Response(JSON.stringify({ iceServers: servers }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${CACHE_SEC}` },
      });
      ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    }
    const res = new Response(cached.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    return withCors(res, origin);
  },
};
