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
// ほかに、ゴールタイムのランキング (/ranking) と本番で起きたことの記録 (/telemetry) も
// この Worker が受ける (下のそれぞれの節に説明)。

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

// ---- ランキング (ゴールタイム) ----
import { isNgName } from './ngwords.js';
//
// サイトごと (matsue / fukuyama / hiroshima) に 1 つの Durable Object (Leaderboard) を持ち、
// 速い順に RANK_KEEP 件だけ残す。サイトは Origin のホスト名の先頭で決める
// (matsue.citykart.jp → matsue)。ページ側から送るのは名前とタイムだけ。
//   GET    /ranking            → { entries: 上位 RANK_SHOW 件 }
//   POST   /ranking {name,time} → { id, rank (RANK_KEEP 位までに入らなければ null), entries }
//   DELETE /ranking?site=&id=  → 管理用 (Authorization: Bearer <ADMIN_TOKEN>)。不適切な名前や不正な記録を消す
// 守れること / 守れないこと: カートの物理はブラウザで計算しているので、タイムの正しさは
// サーバーで確かめられない。改造したページや curl から速いタイムを送ることはできる。
// ここでできるのは、ありえない速さ (MIN_TIME) の拒否、回数制限、名前の整形、管理用の削除まで。

/** 保存する件数と、返す件数 */
const RANK_KEEP = 100;
const RANK_SHOW = 20;
/**
 * これより速いタイムは受け付けない (秒)。カートの最高速 56 m/s にコイン・ブースト・むてきを
 * すべて重ねても毎秒 100 m 程度なので、レース全長 ÷ 100 m/s を目安に切り下げた値。
 * 松江 9.6 km × 2 周、広島 7.3 km × 2 周、福山 20.8 km の一本道。
 */
const MIN_TIME = { matsue: 180, hiroshima: 140, fukuyama: 200 };
const MAX_TIME = 3600;

/** Origin (https://matsue.citykart.jp) からサイト名 (matsue) を取る */
export function siteOf(origin) {
  try {
    return new URL(origin).hostname.split('.')[0];
  } catch {
    return '';
  }
}

/** 名前を整える: 文字列にし、制御文字と前後の空白を除き、10 文字 (絵文字も 1 文字) に切る */
export function cleanName(v) {
  const bad = c => c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
  const s = [...String(v ?? '').normalize('NFC')].filter(ch => !bad(ch.codePointAt(0))).join('').trim();
  return [...s].slice(0, 10).join('');
}

/** タイムを検査して 0.01 秒に丸める。範囲外は null */
export function cleanTime(site, v) {
  const t = Number(v);
  if (!Number.isFinite(t) || t < (MIN_TIME[site] ?? 120) || t > MAX_TIME) return null;
  return Math.round(t * 100) / 100;
}

/**
 * サイトごとのランキング。上位 RANK_KEEP 件を 1 つの配列として保存する (件数が少ないので十分)。
 * DailyCounter と同じく fetch 方式にして、Node でもそのまま動作確認できるようにしてある。
 *   GET  /top              → { entries }
 *   POST /add { name, time } → { id, rank, entries }
 *   POST /delete { id }    → { ok }
 */
export class Leaderboard {
  constructor(state) {
    this.storage = state.storage;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const list = (await this.storage.get('top')) ?? [];
    if (request.method === 'POST' && url.pathname === '/add') {
      const { name, time } = await request.json();
      const entry = { id: crypto.randomUUID(), name, time, at: Date.now() };
      // 同じタイムなら先に出した人が上
      let i = list.findIndex(e => e.time > time);
      if (i < 0) i = list.length;
      list.splice(i, 0, entry);
      const kept = list.slice(0, RANK_KEEP);
      await this.storage.put('top', kept);
      return Response.json({ id: entry.id, rank: i < RANK_KEEP ? i + 1 : null, entries: kept.slice(0, RANK_SHOW) });
    }
    if (request.method === 'POST' && url.pathname === '/delete') {
      const { id } = await request.json();
      const kept = list.filter(e => e.id !== id);
      await this.storage.put('top', kept);
      return Response.json({ ok: kept.length !== list.length });
    }
    return Response.json({ entries: list.slice(0, RANK_SHOW) });
  }
}

function board(env, site) {
  return env.LEADERBOARD.get(env.LEADERBOARD.idFromName(site));
}

/** /ranking の処理。origin は許可済み */
async function handleRanking(request, env, origin, fail) {
  if (!env.LEADERBOARD) return fail(503, 'ranking is not configured');
  const site = siteOf(origin);
  if (request.method === 'GET') {
    const res = await board(env, site).fetch('https://board/top');
    return withCors(new Response(res.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }), origin);
  }
  if (request.method !== 'POST') return fail(405, 'method not allowed');
  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: `rank:${ip}` });
    if (!success) return fail(429, 'too many requests');
  }
  let body;
  try {
    body = JSON.parse((await request.text()).slice(0, 1000));
  } catch {
    return fail(400, 'bad json');
  }
  const name = cleanName(body?.name);
  const time = cleanTime(site, body?.time);
  if (!name) return fail(400, 'name required');
  // 使えない言葉 (ngwords.js)。ページ側も同じ判定で先に止めるが、改造したページからも保存させない
  if (isNgName(name)) return fail(400, 'ng_name');
  if (time === null) return fail(400, 'time out of range');
  const res = await board(env, site).fetch('https://board/add', { method: 'POST', body: JSON.stringify({ name, time }) });
  return withCors(new Response(res.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }), origin);
}

// ---- 本番で起きたことの記録 (telemetry) ----
//
// ページの src/telemetry.ts が、捕まえ損ねた例外・読み込みの失敗・WebGL のコンテキスト喪失・
// 読み込み時間・対戦の成否を text/plain の POST で送ってくる (sendBeacon。text/plain なので
// CORS の事前確認が無い)。サイトごとに 1 つの Durable Object (TelemetryLog) に、新しいものから
// TELEMETRY_KEEP 件だけ残す。定期監視 (.github/workflows/monitor.yml → tools/telemetry_report.mjs)
// が「まだ通知していない記録」を読み出して Issue にまとめ、読んだところまでを通知済みにする。
//   POST /telemetry                          ページから (許可した Origin のみ)。本文は JSON 1 件
//   GET  /telemetry?site=matsue[&since=N]    まだ通知していない記録 (since を付ければ N 番より後の全部)
//   POST /telemetry/ack?site=matsue&upto=N   N 番までを通知済みにする
// GET と ack は Origin は要らないが Authorization: Bearer <TELEMETRY_TOKEN> が要る
// (npx wrangler secret put TELEMETRY_TOKEN。GitHub の secret TELEMETRY_TOKEN と同じ値)。
// 守れること / 守れないこと: 送り主はブラウザなので中身は偽れる。ここでできるのは Origin の確認、
// 回数制限、大きさと項目の制限まで。名前や peer ID はページ側が送らない。

/** サイトごとに残す件数 (古いものから消す) */
const TELEMETRY_KEEP = 1000;
const TELEMETRY_KINDS = ['error', 'load', 'net', 'gl'];
/** 1 件の本文の上限 (文字)。これより長ければ受け付けない */
const TELEMETRY_MAX_BODY = 8000;

/** 記録の番号をキーにする (0 詰めして辞書順 = 番号順にする) */
export function telemetryKey(seq) {
  return `r:${String(seq).padStart(10, '0')}`;
}

/**
 * ページから来た記録を検査して、残す項目だけに整える。種類が違う・event が無いものは null。
 * data の中は文字列 (1500 文字まで)・数・真偽だけ残す。
 */
export function cleanTelemetry(value) {
  if (!value || typeof value !== 'object') return null;
  if (!TELEMETRY_KINDS.includes(value.kind)) return null;
  const event = typeof value.event === 'string' ? value.event.slice(0, 60) : '';
  if (!event) return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const data = {};
  if (value.data && typeof value.data === 'object') {
    for (const [k, v] of Object.entries(value.data).slice(0, 12)) {
      if (typeof v === 'string') data[k.slice(0, 30)] = v.slice(0, 1500);
      else if (typeof v === 'number' || typeof v === 'boolean') data[k.slice(0, 30)] = v;
    }
  }
  return {
    kind: value.kind,
    event,
    data,
    at: Number.isFinite(value.at) ? Math.round(value.at) : 0,
    build: str(value.build, 20),
    path: str(value.path, 200),
    ua: str(value.ua, 300),
    quality: str(value.quality, 20),
    lang: str(value.lang, 10),
  };
}

/**
 * サイトごとの記録。1 件 1 キー (r:0000000001 …) で保存し、meta に最後の番号・通知済みの番号・件数を持つ。
 * DailyCounter と同じく fetch 方式にして、Node でもそのまま動作確認できるようにしてある。
 *   POST /add  { ...record }   → { seq }
 *   GET  /list[?since=N]       → { last, notified, records }  (since 省略時は notified より後)
 *   POST /ack  { upto }        → { notified }
 */
export class TelemetryLog {
  constructor(state) {
    this.storage = state.storage;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const meta = (await this.storage.get('meta')) ?? { last: 0, notified: 0, count: 0 };
    if (request.method === 'POST' && url.pathname === '/add') {
      const rec = await request.json();
      const seq = meta.last + 1;
      await this.storage.put(telemetryKey(seq), { seq, t: Date.now(), ...rec });
      meta.last = seq;
      meta.count += 1;
      if (meta.count > TELEMETRY_KEEP) {
        const old = await this.storage.list({ prefix: 'r:', limit: meta.count - TELEMETRY_KEEP });
        await this.storage.delete([...old.keys()]);
        meta.count = TELEMETRY_KEEP;
      }
      await this.storage.put('meta', meta);
      return Response.json({ seq });
    }
    if (request.method === 'POST' && url.pathname === '/ack') {
      const { upto } = await request.json();
      meta.notified = Math.max(meta.notified, Math.min(Number(upto) || 0, meta.last));
      await this.storage.put('meta', meta);
      return Response.json({ notified: meta.notified });
    }
    const sinceParam = url.searchParams.get('since');
    const since = sinceParam === null ? meta.notified : Math.max(0, Number(sinceParam) || 0);
    const map = await this.storage.list({ prefix: 'r:', start: telemetryKey(since + 1) });
    return Response.json({ last: meta.last, notified: meta.notified, records: [...map.values()] });
  }
}

function telemetryLog(env, site) {
  return env.TELEMETRY_LOG.get(env.TELEMETRY_LOG.idFromName(site));
}

/** ページからの記録 (POST /telemetry)。origin は許可済み */
async function handleTelemetryPost(request, env, origin, fail) {
  if (!env.TELEMETRY_LOG) return fail(503, 'telemetry is not configured');
  if (request.method !== 'POST') return fail(405, 'method not allowed');
  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: `tel:${ip}` });
    if (!success) return fail(429, 'too many requests');
  }
  const body = await request.text();
  if (body.length > TELEMETRY_MAX_BODY) return fail(413, 'too large');
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return fail(400, 'bad json');
  }
  const rec = cleanTelemetry(value);
  if (!rec) return fail(400, 'bad record');
  await telemetryLog(env, siteOf(origin)).fetch('https://log/add', { method: 'POST', body: JSON.stringify(rec) });
  return withCors(new Response(null, { status: 204 }), origin);
}

/** 定期監視からの読み出しと通知済みの印 (GET /telemetry, POST /telemetry/ack)。Origin は要らないが TELEMETRY_TOKEN が要る */
async function handleTelemetryAdmin(request, env) {
  const auth = request.headers.get('Authorization') ?? '';
  if (!env.TELEMETRY_TOKEN || auth !== `Bearer ${env.TELEMETRY_TOKEN}`) return text(403, 'forbidden');
  if (!env.TELEMETRY_LOG) return text(503, 'telemetry is not configured');
  const url = new URL(request.url);
  const site = url.searchParams.get('site') ?? '';
  if (!/^[a-z]+$/.test(site)) return text(400, 'site required');
  const log = telemetryLog(env, site);
  if (url.pathname === '/telemetry/ack') {
    if (request.method !== 'POST') return text(405, 'method not allowed');
    const upto = Number(url.searchParams.get('upto'));
    if (!Number.isFinite(upto)) return text(400, 'upto required');
    const res = await log.fetch('https://log/ack', { method: 'POST', body: JSON.stringify({ upto }) });
    return new Response(res.body, { headers: { 'content-type': 'application/json' } });
  }
  if (request.method !== 'GET') return text(405, 'method not allowed');
  const since = url.searchParams.get('since');
  const res = await log.fetch(`https://log/list${since === null ? '' : `?since=${encodeURIComponent(since)}`}`);
  return new Response(res.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/** 管理用の削除。Origin は要らないが ADMIN_TOKEN が要る */
async function handleRankingDelete(request, env) {
  const auth = request.headers.get('Authorization') ?? '';
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return text(403, 'forbidden');
  if (!env.LEADERBOARD) return text(503, 'ranking is not configured');
  const url = new URL(request.url);
  const site = url.searchParams.get('site') ?? '';
  const id = url.searchParams.get('id') ?? '';
  if (!site || !id) return text(400, 'site and id required');
  const res = await board(env, site).fetch('https://board/delete', { method: 'POST', body: JSON.stringify({ id }) });
  return new Response(res.body, { headers: { 'content-type': 'application/json' } });
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    // 今日の発行数 (監視用。Origin 不要、秘密は出ない)
    if (request.method === 'GET' && path === '/status') {
      return Response.json(await dailyStatus(env), { headers: { 'cache-control': 'no-store' } });
    }
    if (request.method === 'DELETE' && path === '/ranking') return handleRankingDelete(request, env);
    // 記録の読み出しと通知済みの印 (定期監視から。Origin 不要、TELEMETRY_TOKEN が要る)
    if ((request.method === 'GET' && path === '/telemetry') || path === '/telemetry/ack') return handleTelemetryAdmin(request, env);
    const origin = request.headers.get('Origin') ?? '';
    if (!allowedOrigins(env).includes(origin)) return text(403, 'forbidden');
    // 許可した Origin への失敗応答には CORS ヘッダーを付ける。付けないとブラウザは
    // 状態コードも本文も読めず、サイト側が「上限に達した」と「つながらない」を区別できない
    const fail = (status, body) => withCors(text(status, body), origin);
    if (request.method === 'OPTIONS') {
      const pre = withCors(new Response(null, { status: 204 }), origin);
      pre.headers.set('Access-Control-Allow-Methods', 'GET, POST');
      pre.headers.set('Access-Control-Allow-Headers', 'content-type');
      return pre;
    }
    if (path === '/ranking') return handleRanking(request, env, origin, fail);
    if (path === '/telemetry') return handleTelemetryPost(request, env, origin, fail);
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
