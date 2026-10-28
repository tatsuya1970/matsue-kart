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
//     偽れるので、1 つの IP からの回数を RATE_LIMITER (wrangler.toml) で抑える。
//   - 上流の応答は Durable Object (DailyCounter) に ICE_TTL_SEC (1 時間) 保存して配り回す。
//     metered.ca の資格情報は固定 (既定では期限切れにならない) なので、毎回上流に聞いても
//     同じものが返るだけで、聞く回数を増やしても守れるものは無い。上流を呼ぶのは 1 時間に
//     1 回ほどになり、誰かが叩き続けても下の上限には届かない。保存した応答は TURN_API_URL などの
//     設定と組にしてあるので、資格情報を作り直して secret を入れ替えれば次の要求から新しい方を配る。
//   - 資格情報そのものの有効期限は上流で決まる。短くできるなら短くする (Cloudflare の TURN に
//     切り替えるなら ttl を ICE_TTL_SEC より十分長くする)。
//   - 1 日 (日本時間) に上流へ発行してもらう回数に上限を掛ける (DAILY_CAP)。数えるのは
//     上流が正しく応答した回だけで、普段は 1 日 24 回ほど。保存が効かなくなったときの保険で、
//     上限に達しても保存分があればそれを配る。保存分が無いとき (secret の入れ替え直後など) は 503 を返し、
//     サイト側は TURN が取れないので対戦PLAY を出さない。翌日 0 時に戻る。
//     1 つの資格情報で有効期間のあいだに流せる量までは縛れない (それは上流の仕様)。費用の上限は
//     上流のプランで決める: metered.ca の無料プランはカード登録が無く、枠を超えても請求は無い。
//   - 保存分が ICE_TTL_SEC より古くても、いまの設定で取ったものなら待たせずにそれを返し、裏で取り直す。
//     上流が失敗しているあいだも保存分を配り続ける (資格情報は固定なので古くても使える)。
//     利用者が上流の応答を待つのは、保存分が無いとき (初回と secret の入れ替え直後) だけになる。
//   - 上流が失敗したら、FAIL_TTL_SEC (30 秒) は上流を呼ばない (障害中に叩き続けない)。保存分が無ければ同じ失敗を返す。
//     いまの数と、応答を保存した時刻は GET /status で見られる (Origin 不要、秘密は出ない)。
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

/** Worker の Cache API で応答を使い回す秒数 (独自ドメインに載せたときだけ効く。*.workers.dev では何もしない) */
const CACHE_SEC = 60;
// 下の 2 つは export しない。Workers の実行環境は、入口のモジュールが関数・クラス以外を export していると
// 起動を拒む (wrangler dev の workerd で "Incorrect type for map entry")。tests/ は同じ値を自分で持つ
/** 上流の応答を DailyCounter に保存して配り回す秒数 (同じ資格情報を配っても構わない) */
const ICE_TTL_SEC = 3600;
/** 上流が失敗したあと、上流を呼ばずに同じ失敗を返す秒数 */
const FAIL_TTL_SEC = 30;

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

/**
 * 本文を max バイトまで読む。超えたら null。Content-Length で先に断り、無いとき (chunked) も
 * 読みながら数えて打ち切る (大きな本文を読み切ってから断ると、そのあいだメモリと時間を使う)
 */
export async function readBody(request, max) {
  if (Number(request.headers.get('content-length')) > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

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
 * 上流の設定 (呼び方・URL・鍵・本文) の指紋。保存した応答がいまの設定で取ったものかを見分ける。
 * 資格情報を作り直して secret を入れ替えたら、保存分を捨てて上流に聞き直すため (secret そのものは保存しない)
 */
export async function iceSource(env) {
  const text = [env.TURN_API_METHOD, env.TURN_API_URL, env.TURN_API_TOKEN, env.TURN_API_BODY].map(v => v ?? '').join('\n');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 文の中の URL のクエリ (?apiKey=... など) を伏せる。ログに鍵を残さないため */
export function redactQuery(s) {
  return String(s).replace(/\?\S*/g, '?…');
}

/** 上流 (metered.ca など) に ICE サーバーの一覧を聞く。→ { ok: true, iceServers } / { ok: false, error: 'upstream', message } */
export async function fetchIceServers(env) {
  const failed = message => ({ ok: false, error: 'upstream', message });
  if (!env.TURN_API_URL) return failed('TURN_API_URL is not set');
  const init = { method: env.TURN_API_METHOD || 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) };
  if (env.TURN_API_TOKEN) init.headers.authorization = `Bearer ${env.TURN_API_TOKEN}`;
  if (env.TURN_API_BODY) { init.body = env.TURN_API_BODY; init.headers['content-type'] = 'application/json'; }
  let upstream;
  try {
    upstream = await fetch(env.TURN_API_URL, init);
  } catch (e) {
    // 例外の文は利用者に返さない。fetch は URL が壊れているとき、文に URL (鍵の付いた TURN_API_URL) を入れることがある。
    // 詳しくは Workers のログ (持ち主だけが見られる) に、クエリを伏せて残す
    console.error(`upstream unreachable: ${redactQuery(e instanceof Error ? e.message : String(e))}`);
    return failed('upstream unreachable');
  }
  if (!upstream.ok) return failed(`upstream HTTP ${upstream.status}`);
  let servers;
  try {
    servers = normalize(await upstream.json());
  } catch {
    return failed('upstream returned non-JSON');
  }
  // STUN だけの応答は配らない (サイト側は TURN があるかで対戦PLAY の可否を決める)
  if (!hasTurnServer(servers)) return failed('upstream returned no turn: server');
  return { ok: true, iceServers: servers };
}

/**
 * 上流の応答を保存して配り回し、上流に発行してもらった回数を 1 日単位で数える Durable Object。
 * 1 つだけ作り (idFromName('turn'))、全リクエストがここを通る (同じ Object の処理は直列)。
 *   POST /ice { limit } → { ok: true, iceServers }
 *                         / { ok: false, error: 'daily_cap', count } / { ok: false, error: 'upstream', message }
 *   GET  /status        → { day, count, cachedAt }
 * 保存した応答が ICE_TTL_SEC より新しく、いまの設定で取ったものなら、上流を呼ばずにそれを返す。
 * 古ければ保存分をそのまま返しつつ、裏で上流を呼んで取り直す。保存分が無ければ上流の応答を待つ。
 * 上流が正しく応答したときだけ数を 1 増やす (上流の障害で上限を使い切らないように)。
 * 失敗したら FAIL_TTL_SEC のあいだは上流を呼ばない (保存分が無ければ同じ失敗を返す)。上流を呼んでいる
 * 最中に来た要求は、その 1 回の結果に相乗りする (同時に何本も上流を呼ばない)。
 * 名前は 1 日の回数だけを数えていたころのまま (変えるには Durable Object の移行が要る)。
 * cloudflare:workers の DurableObject を継承しない fetch 方式にしてあるのは、
 * Node でそのまま読み込んで動作確認できるようにするため (tools/ の検査と同じ流儀)。
 */
export class DailyCounter {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env ?? {};
    /** 上流を呼んでいる最中の Promise */
    this.pending = null;
    /** 直近の上流の失敗 { at, message } */
    this.failure = null;
    /** いまの設定の指紋 (iceSource)。設定は Object が生きているあいだ変わらない */
    this.source = '';
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/ice') {
      // 本文はストレージを読む前に読み切る。読んでから書くまでのあいだにストレージ以外の
      // await を挟むと、同時に来た要求が同じ値を読んで、片方の書き込みが消える
      const { limit } = await request.json();
      return Response.json(await this.ice(Number(limit) || 0));
    }
    const stored = await this.storage.get(['day', 'count', 'ice']);
    return Response.json({ day: stored.get('day') ?? null, count: stored.get('count') ?? 0, cachedAt: stored.get('ice')?.at ?? null });
  }
  async ice(limit) {
    this.source ||= await iceSource(this.env);
    const now = Date.now();
    const cached = await this.storage.get('ice');
    const usable = cached && cached.source === this.source;
    if (usable && now - cached.at < ICE_TTL_SEC * 1000) return { ok: true, iceServers: cached.iceServers };
    const failing = this.failure && now - this.failure.at < FAIL_TTL_SEC * 1000;
    if (usable) {
      // 古いが、いまの設定で取ったもの。待たせずに返し、裏で取り直す (結果は次の要求から)。
      // 失敗は refresh が this.failure に残すので、ここでは捨てる
      if (!failing) void this.refreshOnce(limit).catch(() => {});
      return { ok: true, iceServers: cached.iceServers };
    }
    if (failing) return { ok: false, error: 'upstream', message: this.failure.message };
    return this.refreshOnce(limit);
  }
  /** 上流を呼んでいる最中なら、その 1 回に相乗りする */
  refreshOnce(limit) {
    // pending を立てるまで await を挟まない (挟むと同時に来た要求が上流を二重に呼ぶ)
    this.pending ??= this.refresh(limit).finally(() => { this.pending = null; });
    return this.pending;
  }
  async refresh(limit) {
    const day = jstDay();
    const stored = await this.storage.get(['day', 'count']);
    const count = stored.get('day') === day ? (stored.get('count') ?? 0) : 0;   // 日付が変わったら 0 から
    if (limit > 0 && count >= limit) return { ok: false, error: 'daily_cap', count };
    const r = await fetchIceServers(this.env);
    if (!r.ok) {
      this.failure = { at: Date.now(), message: r.message };
      return r;
    }
    this.failure = null;
    await this.storage.put({ day, count: count + 1, ice: { at: Date.now(), source: this.source, iceServers: r.iceServers } });
    return r;
  }
}

const counter = env => env.DAILY_COUNTER.get(env.DAILY_COUNTER.idFromName('turn'));

/** ICE サーバーの一覧を得る。DailyCounter があれば保存分か上流から (上限つき)、無ければ毎回上流から */
async function getIceServers(env) {
  if (!env.DAILY_COUNTER) return fetchIceServers(env);
  const res = await counter(env).fetch('https://counter/ice', { method: 'POST', body: JSON.stringify({ limit: Number(env.DAILY_CAP) || 0 }) });
  return res.json();
}

async function dailyStatus(env) {
  const cap = Number(env.DAILY_CAP) || 0;
  if (!env.DAILY_COUNTER) return { day: jstDay(), count: 0, cap, cachedAt: null };
  const r = await (await counter(env).fetch('https://counter/status')).json();
  // 日付が変わっていれば、まだ数え直していないだけなので 0 として見せる
  return { day: jstDay(), count: r.day === jstDay() ? r.count : 0, cap, cachedAt: r.cachedAt ? new Date(r.cachedAt).toISOString() : null };
}

// ---- ランキング (ゴールタイム) ----
import { isNgName } from './ngwords.js';
//
// サイトごと (matsue / fukuyama / hiroshima / kure) に 1 つの Durable Object (Leaderboard) を持ち、
// 速い順に RANK_KEEP 件だけ残す。サイトは Origin のホスト名の先頭で決める
// (matsue.citykart.jp → matsue)。ページ側から送るのは名前とタイムだけ。
//   GET    /ranking            → { entries: 上位 RANK_SHOW 件 }
//   POST   /ranking {name,time,run} → { id, rank (RANK_KEEP 位までに入らなければ null), entries }
//          run はページがレースごとに作る ID。同じ run の再送 (応答が届かず押し直した) は保存せず、前の結果を返す
//   DELETE /ranking?site=&id=  → 管理用 (Authorization: Bearer <ADMIN_TOKEN>)。不適切な名前や不正な記録を消す
//   POST   /ranking/restore?site=&at=  → 管理用。その時刻の状態に戻す (過去 30 日。下の handleRankingRestore)
// 守れること / 守れないこと: カートの物理はブラウザで計算しているので、タイムの正しさは
// サーバーで確かめられない。改造したページや curl から速いタイムを送ることはできる。
// ここでできるのは、ありえない速さ (MIN_TIME) の拒否、回数制限、名前の整形、管理用の削除まで。

/** 保存する件数と、返す件数 */
const RANK_KEEP = 100;
const RANK_SHOW = 20;
/**
 * これより速いタイムは受け付けない (秒)。カートの最高速 56 m/s にコイン・ブースト・むてきを
 * すべて重ねても毎秒 100 m 程度なので、レース全長 ÷ 100 m/s を目安に切り下げた値。
 * 松江 9.6 km × 2 周、広島 7.3 km × 2 周、福山 20.8 km の一本道、呉 12.2 km の一本道。
 */
const MIN_TIME = { matsue: 180, hiroshima: 140, fukuyama: 200, kure: 120 };
const MAX_TIME = 3600;
/** 登録の本文の上限 (バイト)。名前・タイム・run だけなので 200 バイトほど */
const RANK_MAX_BODY = 1000;

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

/** ページが送る run (レースごとの ID) の形。違えば無いものとして扱う (重複の判定をしないだけ) */
export function cleanRun(v) {
  return typeof v === 'string' && /^[0-9a-f-]{16,64}$/i.test(v) ? v.toLowerCase() : undefined;
}

/** 返す一覧。run は返さない (他人の run を知っても害は無いが、見せる理由も無い) */
const shown = list => list.slice(0, RANK_SHOW).map(({ run, ...e }) => e);

/**
 * サイトごとのランキング。上位 RANK_KEEP 件を 1 つの配列として保存する (件数が少ないので十分)。
 * DailyCounter と同じく fetch 方式にして、Node でもそのまま動作確認できるようにしてある。
 *   GET  /top                     → { entries }
 *   POST /add { name, time, run } → { id, rank, entries }
 *   POST /delete { id }           → { ok }
 *   POST /restore { at | bookmark } → { target, undo }  次に起動したときに、その時点の状態に戻す
 *   POST /abort                   → いまのインスタンスを終わらせる (/restore の後に呼ぶ)
 */
export class Leaderboard {
  constructor(state) {
    this.state = state;
    this.storage = state.storage;
  }
  async fetch(request) {
    const url = new URL(request.url);
    // 本文はストレージを読む前に読み切る (DailyCounter と同じ)。読んでから書くまでにストレージ以外の
    // await を挟むと、同時に来た登録が同じ一覧を読み、後から書いた方が先の登録を消す
    const body = request.method === 'POST' ? await request.json() : null;
    if (request.method === 'POST' && url.pathname === '/restore') {
      // Durable Object の PITR (SQLite 方式で使える。過去 30 日)。戻すのは次に起動したとき
      const target = body.bookmark || await this.storage.getBookmarkForTime(body.at);
      const undo = await this.storage.onNextSessionRestoreBookmark(target);
      return Response.json({ target, undo });
    }
    if (request.method === 'POST' && url.pathname === '/abort') {
      this.state.abort('restore');
      return Response.json({ ok: true });
    }
    const list = (await this.storage.get('top')) ?? [];
    if (request.method === 'POST' && url.pathname === '/add') {
      const { name, time, run } = body;
      // 同じレースの再送なら保存せずに前の結果を返す (保存した後で応答だけ失われ、押し直したとき)。
      // 前の記録が RANK_KEEP 位から落ちていれば見つからないが、同じタイムなのでまた圏外になる
      const prev = run ? list.findIndex(e => e.run === run) : -1;
      if (prev >= 0) return Response.json({ id: list[prev].id, rank: prev + 1, entries: shown(list) });
      const entry = { id: crypto.randomUUID(), name, time, at: Date.now(), ...(run ? { run } : {}) };
      // 同じタイムなら先に出した人が上
      let i = list.findIndex(e => e.time > time);
      if (i < 0) i = list.length;
      list.splice(i, 0, entry);
      const kept = list.slice(0, RANK_KEEP);
      await this.storage.put('top', kept);
      return Response.json({ id: entry.id, rank: i < RANK_KEEP ? i + 1 : null, entries: shown(kept) });
    }
    if (request.method === 'POST' && url.pathname === '/delete') {
      const kept = list.filter(e => e.id !== body.id);
      await this.storage.put('top', kept);
      return Response.json({ ok: kept.length !== list.length });
    }
    return Response.json({ entries: shown(list) });
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
  const raw = await readBody(request, RANK_MAX_BODY);
  if (raw === null) return fail(413, 'too large');
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'bad json');
  }
  const name = cleanName(body?.name);
  const time = cleanTime(site, body?.time);
  if (!name) return fail(400, 'name required');
  // 使えない言葉 (ngwords.js)。ページ側も同じ判定で先に止めるが、改造したページからも保存させない
  if (isNgName(name)) return fail(400, 'ng_name');
  if (time === null) return fail(400, 'time out of range');
  const run = cleanRun(body?.run);
  const res = await board(env, site).fetch('https://board/add', { method: 'POST', body: JSON.stringify({ name, time, run }) });
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
// 回数制限、大きさと項目の制限まで。名前や peer ID はページ側が送らない。文の中の URL のクエリや
// メールアドレスはページでも伏せるが、改造したページは伏せずに送れるので、ここでも伏せる (redact.js)。
import { redactText } from './redact.js';

/**
 * サイトごとに残す件数 (古いものから消す)。未通知のものも消える。番号は 1 ずつ増えるので、
 * 消えた件数は tools/telemetry_report.mjs が番号の抜けから数えて Issue に書く
 */
const TELEMETRY_KEEP = 1000;
const TELEMETRY_KINDS = ['error', 'load', 'net', 'gl'];
/** 1 件の本文の上限 (バイト)。ページが送るのは多くても 8 KB ほど (スタック 1,500 文字が日本語でも) */
const TELEMETRY_MAX_BODY = 16000;

/** 記録の番号をキーにする (0 詰めして辞書順 = 番号順にする) */
export function telemetryKey(seq) {
  return `r:${String(seq).padStart(10, '0')}`;
}

/**
 * ページから来た記録を検査して、残す項目だけに整える。種類が違う・event が無いものは null。
 * data の中は文字列 (1500 文字まで)・数・真偽だけ残す。文の中の URL のクエリとメールアドレスは伏せる。
 * kind 'admin' (管理用の口の操作。auditAdmin) は Worker が自分で書くもので、ページからは受け付けない。
 */
export function cleanTelemetry(value) {
  if (!value || typeof value !== 'object') return null;
  if (!TELEMETRY_KINDS.includes(value.kind)) return null;
  const event = typeof value.event === 'string' ? redactText(value.event).slice(0, 60) : '';
  if (!event) return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const data = {};
  if (value.data && typeof value.data === 'object') {
    for (const [k, v] of Object.entries(value.data).slice(0, 12)) {
      if (typeof v === 'string') data[k.slice(0, 30)] = redactText(v).slice(0, 1500);
      else if (typeof v === 'number' || typeof v === 'boolean') data[k.slice(0, 30)] = v;
    }
  }
  return {
    kind: value.kind,
    event,
    data,
    at: Number.isFinite(value.at) ? Math.round(value.at) : 0,
    build: str(value.build, 20),
    path: typeof value.path === 'string' ? redactText(value.path).slice(0, 200) : undefined,
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
    // 本文はストレージを読む前に読み切る (Leaderboard と同じ)。挟むと、同時に来た追加や通知済みの印が
    // 古い meta を書き戻し、番号が戻って次の記録が既存の記録を上書きする
    const body = request.method === 'POST' ? await request.json() : null;
    const meta = (await this.storage.get('meta')) ?? { last: 0, notified: 0, count: 0 };
    if (request.method === 'POST' && url.pathname === '/add') {
      const rec = body;
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
      const { upto } = body;
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
  const body = await readBody(request, TELEMETRY_MAX_BODY);
  if (body === null) return fail(413, 'too large');
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

// ---- 管理用の口 (記録の読み出し、ランキングの削除・復旧) ----

/**
 * 管理用の口の合言葉 (Authorization: Bearer <secret>) を確かめる。通せば null、通さなければ返す応答。
 * 合言葉を見る前に、1 つの IP からの回数を RATE_LIMITER (wrangler.toml。1 分に 20 回) で数える
 * (総当たりで当てられないように。外れたときだけ数えると、上限を超えても当たりの要求だけは通るので、
 * 当たったかどうかが分かってしまう)
 */
async function denyAdmin(request, env, secret) {
  if (env.RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key: `admin:${ip}` });
    if (!success) return text(429, 'too many requests');
  }
  if (!secret || !(await sameSecret(request.headers.get('Authorization') ?? '', `Bearer ${secret}`))) return text(403, 'forbidden');
  return null;
}

/**
 * 2 つの文字列が同じか。かかる時間が中身によらないように、両方の SHA-256 を全バイト比べる
 * (=== は最初に食い違ったところで止まるので、時間を測れば合言葉を先頭から推測できてしまう)
 */
export async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async s => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** 定期監視からの読み出しと通知済みの印 (GET /telemetry, POST /telemetry/ack)。Origin は要らないが TELEMETRY_TOKEN が要る */
async function handleTelemetryAdmin(request, env) {
  const denied = await denyAdmin(request, env, env.TELEMETRY_TOKEN);
  if (denied) return denied;
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

/**
 * 管理用の口でランキングを変えた (削除・復旧) ことを残す。そのサイトの記録 (TelemetryLog) に kind 'admin' として
 * 足すと、定期監視がほかの記録と一緒に Issue で知らせるので、合言葉が漏れて誰かが使ったときに気づける。
 * Issue は公開なので IP は記録に入れず、Workers のログにだけ書く (保存はしていないので、npx wrangler tail で
 * 見ているあいだだけ見える)
 */
async function auditAdmin(request, env, site, action, detail) {
  console.log(`admin ${action} site=${site} ${JSON.stringify(detail)} ip=${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
  if (!env.TELEMETRY_LOG) return;
  const rec = { kind: 'admin', event: action, data: detail, at: 0 };
  await telemetryLog(env, site).fetch('https://log/add', { method: 'POST', body: JSON.stringify(rec) }).catch(() => {});
}

/** 管理用の削除。Origin は要らないが ADMIN_TOKEN が要る */
async function handleRankingDelete(request, env) {
  const denied = await denyAdmin(request, env, env.ADMIN_TOKEN);
  if (denied) return denied;
  if (!env.LEADERBOARD) return text(503, 'ranking is not configured');
  const url = new URL(request.url);
  const site = url.searchParams.get('site') ?? '';
  const id = url.searchParams.get('id') ?? '';
  if (!/^[a-z]+$/.test(site) || !id) return text(400, 'site and id required');
  const r = await (await board(env, site).fetch('https://board/delete', { method: 'POST', body: JSON.stringify({ id }) })).json();
  if (r.ok) await auditAdmin(request, env, site, 'delete', { id });
  return Response.json(r);
}

/** Durable Object の PITR で戻せる期間 */
const RESTORE_DAYS = 30;

/**
 * 時刻の文字列をミリ秒にする。時差の無いもの ("2026-10-28 12:00") は日本時間として読む。
 * 数字だけならミリ秒のまま。読めなければ NaN
 */
export function parseJstTime(v) {
  const s = String(v ?? '').trim().replace(' ', 'T');
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s)) return NaN;
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : `${s}+09:00`);
}

/**
 * 管理用: ランキングをある時刻の状態に戻す。ADMIN_TOKEN が要る。
 *   POST /ranking/restore?site=matsue&at=2026-10-28 12:00   (時差が無ければ日本時間)
 *   POST /ranking/restore?site=matsue&bookmark=<undo>       (戻したのを取り消す)
 * → { site, restoredTo, undo, entries }。entries は戻した後の上位 RANK_SHOW 件で、違っていれば
 * undo の bookmark でもう一度呼べば戻す前に戻る。Durable Object の PITR (SQLite 方式、過去 30 日) を使う。
 * 戻した時刻より後の登録は消える。手元の wrangler dev では PITR が無いので試せない
 */
async function handleRankingRestore(request, env) {
  const denied = await denyAdmin(request, env, env.ADMIN_TOKEN);
  if (denied) return denied;
  if (!env.LEADERBOARD) return text(503, 'ranking is not configured');
  if (request.method !== 'POST') return text(405, 'method not allowed');
  const url = new URL(request.url);
  const site = url.searchParams.get('site') ?? '';
  if (!/^[a-z]+$/.test(site)) return text(400, 'site required');
  const bookmark = url.searchParams.get('bookmark') ?? '';
  const at = parseJstTime(url.searchParams.get('at'));
  if (!bookmark) {
    if (!Number.isFinite(at)) return text(400, 'at (e.g. 2026-10-28 12:00, JST) or bookmark required');
    if (at > Date.now() || at < Date.now() - RESTORE_DAYS * 86400 * 1000) return text(400, `at must be within the last ${RESTORE_DAYS} days`);
  }
  let r;
  try {
    const res = await board(env, site).fetch('https://board/restore', { method: 'POST', body: JSON.stringify(bookmark ? { bookmark } : { at }) });
    r = await res.json();
  } catch (e) {
    return text(502, `restore failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await auditAdmin(request, env, site, 'restore', bookmark ? { bookmark } : { at: new Date(at).toISOString() });
  // 戻るのは次に起動したとき。いまのインスタンスを終わらせる (終わらせた要求は失敗として返ってくる)
  await board(env, site).fetch('https://board/abort', { method: 'POST', body: '{}' }).catch(() => {});
  // 起動し直した後の一覧で、戻ったかを確かめられるようにする (abort した stub は使えないので取り直す)
  let entries = null;
  for (let i = 0; i < 3 && !entries; i++) {
    try {
      entries = (await (await board(env, site).fetch('https://board/top')).json()).entries;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return Response.json({ site, restoredTo: r.target, undo: r.undo, entries }, { headers: { 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    // 今日の発行数 (監視用。Origin 不要、秘密は出ない)
    if (request.method === 'GET' && path === '/status') {
      return Response.json(await dailyStatus(env), { headers: { 'cache-control': 'no-store' } });
    }
    if (request.method === 'DELETE' && path === '/ranking') return handleRankingDelete(request, env);
    if (path === '/ranking/restore') return handleRankingRestore(request, env);
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

    // 短時間のキャッシュ (独自ドメインのときだけ効く)。外れたら DailyCounter の保存分か上流から
    const cache = caches.default;
    const cacheKey = new Request(new URL('/ice-servers', request.url).toString());
    let cached = await cache.match(cacheKey);
    if (!cached) {
      let r;
      try {
        r = await getIceServers(env);
      } catch (e) {
        // Durable Object の一時的な失敗 (デプロイ直後のリセットなど)。CORS を付けて理由を返す
        // (中の例外の文は返さず、Workers のログにだけ残す)
        console.error(`counter unavailable: ${redactQuery(e instanceof Error ? e.message : String(e))}`);
        return fail(502, 'counter unavailable');
      }
      if (r.error === 'daily_cap') {
        // サイト側 (src/net.ts の loadTurn) は error: 'daily_cap' を見て
        // 「今日は対戦はできません。午前 0 時にリセットします」と出す
        const body = { error: 'daily_cap', count: r.count, cap: Number(env.DAILY_CAP) || 0, day: jstDay(), resetAt: nextJstMidnight() };
        return withCors(Response.json(body, { status: 503, headers: { 'cache-control': 'no-store' } }), origin);
      }
      if (!r.ok) return fail(502, r.message);
      cached = new Response(JSON.stringify({ iceServers: r.iceServers }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${CACHE_SEC}` },
      });
      ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    }
    const res = new Response(cached.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    return withCors(res, origin);
  },
};
