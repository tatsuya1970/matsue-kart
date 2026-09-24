// オンライン対戦 — サーバー無しの P2P (WebRTC)
//
// このゲームは GitHub Pages で配信しているので、常駐サーバーを置けない。
// そのため trystero を使い、公開リレーをシグナリングにして WebRTC を直接つなぐ。
// 通るのはシグナリング (どの部屋に誰がいるか) だけで、レース中の通信は
// ブラウザ同士の直結になる。
//
// 権威の持ち方:
//   - 自分のカートは自分だけが物理計算する (クライアント権威)。他人のカートは
//     受け取った位置へ補間するだけ。カートゲームなので多少ずれても破綻しない。
//   - 空き枠の AI はホストだけが計算し、位置を配る。
//   - アイテムボックスの取得と被弾は「そのカートを持っている側」だけが判定し、
//     結果をイベントで配る。判定を一箇所に寄せないと、各自の画面で別々に
//     当たったことになってしまう。
//   - 位置もイベントも「その席の持ち主」から届いたものだけを受け入れる (slotOwner)。
//     改造したクライアントが他人の席のゴールや被弾を送っても捨てる。自分の席の
//     値をいじる (瞬間移動など) のはクライアント権威である以上どのみち防げない。
//   - ホストは部屋を作った人。抜けたら残った中で ID が最小の人へ自動的に移る。
//     作った人という申告は相手の自己申告で、サーバーが無いので確かめようがない。
//     ホストにできるのは席順・締切・発走の合図・空き枠の AI の操作までで、
//     座席表の中身は acceptLobby / sanitizeLobby で絞る。
import { joinRoom, selfId, getRelaySockets } from 'trystero/nostr';
import type { JsonValue, MessageAction, Room } from 'trystero/nostr';
import { assetUrl } from './geo';
import { fetchJson, FetchError } from './fetch';

// 開発サーバー (vite) では別の appId にして、本番の利用者と部屋や presence を共有しない。
// 同じにしておくと、テスト用のブラウザが本番のトップ画面に「見ている人」として映り、
// テストが本番の利用者の部屋に入ってしまうこともある (実際に起きた)。
// 開発サーバーから本番の相手と試したいときは ?net=prod を付ける。
const useProdNet = !import.meta.env.DEV || new URLSearchParams(location.search).get('net') === 'prod';
const APP_ID = useProdNet ? 'matsue-kart' : 'matsue-kart-dev';
/**
 * シグナリングに使う公開リレーの数。trystero は既定の一覧から appId で決まる順に
 * この数だけ使う (全員が同じ組になる)。既定の 5 つのうち 1 つは落ちていたので (実測)、
 * 多めに取って落ちているリレーがあっても相手を見つけられるようにする。
 */
const RELAY_CONFIG = { redundancy: 8 };

/** つながっているリレーの数 (トップ画面の「確認中」の説明に出す) */
export function relayStatus(): { open: number; total: number } {
  const sockets = Object.values(getRelaySockets() as Record<string, WebSocket>);
  return { open: sockets.filter(s => s.readyState === WebSocket.OPEN).length, total: sockets.length };
}

// ---- TURN (NAT 越えの中継) ----
//
// WebRTC の直結は STUN で自分の外側の住所を知って相手に伝える方式なので、携帯回線
// (CGNAT, 対称型 NAT) と家庭の回線の組み合わせでは直結できないことがある。そのとき
// だけ通信を中継するのが TURN で、これはサーバーが要る。誰でも使える無料の公開 TURN
// (Open Relay) は候補が取れなくなっていた (2026-09 実測) ので、設定はサイトの持ち主が
// 用意する: public/turn.json に { "iceServers": [...] } を置くか、
// { "url": "https://..." } で ICE サーバーの一覧を返す URL (metered.ca 等) を指す。
// 無ければ STUN だけで動く (直結できる相手とだけつながる)。
type IceServer = { urls: string | string[]; username?: string; credential?: string };
let turnConfig: IceServer[] = [];

export function isTurnIceServer(server: IceServer): boolean {
  const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
  return urls.some(url => typeof url === 'string' && /^turns?:/i.test(url));
}

/**
 * TURN の資格情報を取れたか、取れなかった理由 (画面の案内用)。
 *   unknown = まだ読んでいない / ok = 取れた / none = turn.json が無い (開発サーバーなど)
 *   capped = 資格情報 API (workers/turn/) が 1 日の発行上限に達した (翌日 0 時に戻る)
 *   error = 資格情報 API が応答しない・壊れた応答
 */
export type TurnStatus = 'unknown' | 'ok' | 'none' | 'capped' | 'error';
let turnStatus: TurnStatus = 'unknown';

export function turnState(): TurnStatus {
  return turnStatus;
}

export async function loadTurn(): Promise<number> {
  let cfg: unknown;
  try {
    // 置いていない (404) のが普通なので再試行しない。呼び出し側も 4 秒で見切る
    cfg = await fetchJson<unknown>(assetUrl('turn.json'), { cache: 'no-store', timeoutMs: 3000, retries: 0 });
  } catch {
    turnStatus = 'none';
    return 0;
  }
  const asObj = cfg as { url?: unknown; iceServers?: unknown } | null;
  const fromApi = !!asObj && typeof asObj.url === 'string';
  if (!fromApi) {
    // turn.json に固定の資格情報がそのまま書かれていたら使わない。配信物は誰でも読めるので、
    // 使えば第三者に中継を使われる。デプロイ前の検査 (tools/prepare_turn_config.mjs) を
    // 通さずに置かれた場合の保険。資格情報 API (Worker) が返す短期の資格情報はこの対象外
    const direct = Array.isArray(cfg) ? cfg : (cfg as { iceServers?: unknown })?.iceServers;
    if (Array.isArray(direct) && direct.some(s => s && typeof s === 'object' && ('username' in s || 'credential' in s))) {
      turnStatus = 'error';
      return 0;
    }
  }
  if (fromApi && asObj && typeof asObj.url === 'string') {
    try {
      cfg = await fetchJson<unknown>(asObj.url, { timeoutMs: 3000, retries: 0 });
    } catch (e) {
      // 資格情報 API (workers/turn/) は 1 日の上限に達すると 503 と { "error": "daily_cap" } を返す。
      // 画面で「今日は対戦できない」と伝えるために、ほかの失敗と区別する
      turnStatus = e instanceof FetchError && e.status === 503 && e.body.includes('daily_cap') ? 'capped' : 'error';
      return 0;
    }
  }
  const list = Array.isArray(cfg) ? cfg : Array.isArray((cfg as { iceServers?: unknown })?.iceServers) ? (cfg as { iceServers: unknown[] }).iceServers : [];
  // STUN だけの応答を「TURN 設定済み」と誤表示しない。
  turnConfig = (list as IceServer[]).filter(isTurnIceServer);
  turnStatus = turnConfig.length ? 'ok' : 'none';
  return turnConfig.length;
}

/**
 * turn.json が置かれていて TURN を使える見込みがあるか。同じサイトのファイルだけを読み、
 * 資格情報の発行 API (外部) はまだ呼ばない。通信の許可を得る前に、対戦PLAY を
 * 出せるかを決めるために使う。
 */
export async function turnConfigured(): Promise<boolean> {
  try {
    const cfg = await fetchJson<unknown>(assetUrl('turn.json'), { cache: 'no-store', timeoutMs: 3000, retries: 0 });
    const o = cfg as { url?: unknown; iceServers?: unknown } | null;
    if (o && typeof o.url === 'string') return true;
    const list = Array.isArray(cfg) ? cfg : Array.isArray(o?.iceServers) ? (o!.iceServers as unknown[]) : [];
    return (list as IceServer[]).some(isTurnIceServer);
  } catch {
    return false;
  }
}

/** TURN が設定されているか (診断表示用) */
export function hasTurn(): boolean {
  return turnConfig.length > 0;
}

export type NatKind = 'cone' | 'symmetric' | 'blocked' | 'unknown';

/**
 * NAT の種類を調べる (診断表示用)。
 * STUN サーバー 2 つに聞いて、外側の口 (住所:ポート) が相手ごとに変わるなら対称型 NAT で、
 * 携帯回線に多い。対称型どうし、または対称型と家庭用ルータ (ポート制限コーン) の組み合わせは
 * TURN 無しでは直結できない。srflx 候補が 1 つも取れなければ STUN が塞がれている。
 * TURN が設定されていれば relay 候補が取れるかも見る。
 */
export async function natProbe(timeoutMs = 4000): Promise<{ nat: NatKind; relay: boolean }> {
  if (typeof RTCPeerConnection === 'undefined') return { nat: 'unknown', relay: false };
  try {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }, ...turnConfig],
    });
    pc.createDataChannel('probe');
    // 同じ内側の口 (raddr:rport) から見た外側の口を集める。IPv4 と IPv6 は別に数える
    const mapped = new Map<string, Set<string>>();
    let relay = false;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicecandidate = e => {
        const c = e.candidate;
        if (!c) { clearTimeout(timer); resolve(); return; }
        const m = /typ (\w+)(?: raddr (\S+) rport (\d+))?/.exec(c.candidate);
        const type = c.type ?? m?.[1];
        if (type === 'relay') relay = true;
        if (type !== 'srflx') return;
        const addr = c.address ?? /candidate:\S+ \d+ \S+ \d+ (\S+) (\d+)/.exec(c.candidate)?.[1] ?? '';
        const port = c.port ?? Number(/candidate:\S+ \d+ \S+ \d+ \S+ (\d+)/.exec(c.candidate)?.[1] ?? 0);
        const family = addr.includes(':') ? 'v6' : 'v4';
        const base = `${family} ${c.relatedAddress ?? m?.[2] ?? ''}:${c.relatedPort ?? m?.[3] ?? ''}`;
        (mapped.get(base) ?? mapped.set(base, new Set()).get(base)!).add(`${addr}:${port}`);
      };
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => { clearTimeout(timer); resolve(); });
    });
    pc.close();
    if (!mapped.size) return { nat: 'blocked', relay };
    const symmetric = [...mapped.values()].some(s => s.size >= 2);
    return { nat: symmetric ? 'symmetric' : 'cone', relay };
  } catch {
    return { nat: 'unknown', relay: false };
  }
}

/**
 * アプリ内ブラウザ (Facebook / Instagram / LINE / X など) かどうか。
 * WebView は WebRTC が制限されていたり、裏に回ると接続が切れたりして対戦が不安定なので、
 * Safari / Chrome で開くよう勧める。
 */
export function inAppBrowser(): string {
  const ua = navigator.userAgent;
  if (/FBAN|FBAV|FB_IAB/.test(ua)) return 'Facebook';
  if (/Instagram/.test(ua)) return 'Instagram';
  if (/\bLine\//i.test(ua)) return 'LINE';
  if (/Twitter|X11; .*TwitterAndroid/.test(ua)) return 'X';
  if (/MicroMessenger/.test(ua)) return 'WeChat';
  return '';
}
/** 作成者が誰か分かるまで、参加した側がホストを名乗らずに待つ時間 */
const HOST_GRACE_MS = 5000;

/** 1 カート分の同期データ */
export interface Pose {
  slot: number;
  x: number; z: number; y: number;
  heading: number;
  speed: number;
  drifting: number;
  spin: number;
  lap: number;
  s: number;
  boost: number;
  star: number;
  finished: number;
}

const POSE_LEN = 12;
/** カートの枠の数 (src/main.ts の RACERS と同じ)。席も pose の slot もこの範囲に収まる */
export const MAX_SLOTS = 8;

function packPose(p: Pose): number[] {
  return [p.slot, p.x, p.z, p.y, p.heading, p.speed, p.drifting, p.spin, p.lap, p.s, p.boost, p.star];
}

function unpackPose(a: number[], off: number): Pose {
  return {
    slot: a[off], x: a[off + 1], z: a[off + 2], y: a[off + 3], heading: a[off + 4],
    speed: a[off + 5], drifting: a[off + 6], spin: a[off + 7], lap: a[off + 8], s: a[off + 9],
    boost: a[off + 10], star: a[off + 11], finished: 0,
  };
}

export interface LobbyInfo {
  /** 座席順の peer id。添字がそのままカートの枠になる */
  order: string[];
  names: Record<string, string>;
  seed: number;
  /** 発走の締切 (ミリ秒)。公開ロビーで 2 人そろうとホストが決める。0 = まだ相手待ち */
  deadline: number;
}

/** アイテムの使用・被弾など、位置以外の出来事 */
export type NetEvent =
  | { t: 'use'; slot: number; item: string; x: number; z: number; y: number; heading: number; speed: number }
  | { t: 'hit'; slot: number }
  | { t: 'fin'; slot: number; time: number };

/** アイテムの種類 (src/kart.ts の ItemType と合わせる)。受信したイベントの検査用 */
const ITEM_TYPES: ReadonlySet<string> = new Set(['mushroom', 'banana', 'shell', 'star']);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * その席のカートを動かしてよい人。人の席は座席表の order[slot]、空き枠 (AI) はホスト。
 * 席が範囲外・未定なら '' (誰にも渡さない)。
 *
 * 受信側はこれと送り主を照合する。照合しないと、改造したクライアントが他人の席の
 * ゴール・被弾・アイテム使用や位置を送れてしまう (自分の席に届いた fin で自分の
 * カートが AI 操作へ切り替わり、リザルトでは 0 秒で 1 位になる)。
 */
export function slotOwner(order: string[], host: string, slot: unknown): string {
  if (!Number.isInteger(slot) || (slot as number) < 0 || (slot as number) >= MAX_SLOTS) return '';
  return (slot as number) < order.length ? order[slot as number] : host;
}

/**
 * 受信した位置の配列を検査して Pose に戻す。持ち主でない席と壊れた値は捨てる。
 * 配列は POSE_LEN の倍数で、最大でも全枠分。値はすべて有限の数 (NaN / Infinity を
 * 入れると、受け取った側でそのカートが消えたり順位の計算が崩れたりする)。
 */
export function parsePoses(d: unknown, sender: string, order: string[], host: string): Pose[] {
  if (!Array.isArray(d) || !d.length || d.length % POSE_LEN !== 0 || d.length > POSE_LEN * MAX_SLOTS) return [];
  if (!d.every(finite)) return [];
  const out: Pose[] = [];
  for (let i = 0; i < d.length; i += POSE_LEN) {
    const p = unpackPose(d as number[], i);
    if (slotOwner(order, host, p.slot) === sender && poseInRange(p)) out.push(p);
  }
  return out;
}

/** 座標の上限 (m)。地形はコースの周り十数 km なので十分に広い */
const WORLD = 50_000;
const within = (v: number, lo: number, hi: number) => v >= lo && v <= hi;

/**
 * 値がありえる範囲か。有限でも 1e308 のような値は、受け取った側の補間で Infinity になり
 * カートが消えたり順位が崩れたりする。上限はゲームの実際の値より十分に広くとってある
 * (向きは周回ごとに増え続けるので広め、タイマー類は数秒、速度は最高速 56 m/s の数倍)。
 */
export function poseInRange(p: Pose): boolean {
  return within(p.x, -WORLD, WORLD) && within(p.z, -WORLD, WORLD) && within(p.y, -5000, 5000)
    && within(p.heading, -1e5, 1e5) && within(p.speed, -200, 200) && within(p.drifting, -1, 1)
    // タイマー類は 0 付近で少しマイナスになることがある (スピンの残り時間は終わる瞬間に
    // 負になり、次に当たるまでそのまま)。受け取る側は大きいほうを採るだけなので負も通す
    && within(p.spin, -30, 30) && within(p.boost, -30, 30) && within(p.star, -30, 30)
    && Number.isInteger(p.lap) && within(p.lap, 0, 20) && within(p.s, -1e6, 1e6);
}

/**
 * 相手ごとの受信回数の上限 (トークンバケット)。正しい値でも大量に送られると、受け取った側で
 * カートの更新や画面の描き直しが回り続ける。挨拶 (hi) はホストが座席表を全員へ配り直す
 * きっかけなので、1 通が全員への送信に増幅される。上限を超えた分は黙って捨てる。
 * 通信量そのものと、通信ライブラリが中身を読む手間は、受け取る側では防げない。
 */
export class RateGate {
  private buckets = new Map<string, { tokens: number; at: number }>();
  /** @param perSec 1 秒あたりに補充する数  @param burst ためておける上限 */
  constructor(private perSec: number, private burst: number) {}
  allow(peer: string, now = performance.now()): boolean {
    const b = this.buckets.get(peer) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) / 1000 * this.perSec);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(peer, b);
    return ok;
  }
  forget(peer: string): void {
    this.buckets.delete(peer);
  }
}

/**
 * 種類ごとの上限。普段の送信は位置が 15 回/秒 (src/main.ts の POSE_HZ)、イベントは
 * ホストが AI の分もまとめて送るので数回/秒、挨拶と座席表は入退室のたびに数回。
 * どれも普段の数倍にしてあり、普通に遊んでいて捨てられることはない。
 */
const RATES = { pose: [40, 40], ev: [30, 30], hi: [2, 5], lobby: [10, 20], go: [2, 5], busy: [2, 5], st: [5, 10] } as const;
export const makeGates = () => Object.fromEntries(Object.entries(RATES).map(([k, [r, b]]) => [k, new RateGate(r, b)])) as Record<keyof typeof RATES, RateGate>;

/** ゴールタイムの範囲 (秒)。どのコースでも 1 分より速くは走れない */
const FIN_MIN = 60;
const FIN_MAX = 3600;

/** 受信したイベントを検査する。形が違う・持ち主でない席・知らないアイテムは null */
export function parseEvent(d: unknown, sender: string, order: string[], host: string): NetEvent | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const e = d as Record<string, unknown>;
  const owner = slotOwner(order, host, e.slot);
  if (!owner || owner !== sender) return null;
  const s = e.slot as number;
  switch (e.t) {
    case 'hit':
      return { t: 'hit', slot: s };
    case 'fin':
      return finite(e.time) && within(e.time, FIN_MIN, FIN_MAX) ? { t: 'fin', slot: s, time: e.time } : null;
    case 'use':
      if (typeof e.item !== 'string' || !ITEM_TYPES.has(e.item)) return null;
      if (![e.x, e.z, e.y, e.heading, e.speed].every(finite)) return null;
      if (!within(e.x as number, -WORLD, WORLD) || !within(e.z as number, -WORLD, WORLD) || !within(e.y as number, -5000, 5000)
        || !within(e.heading as number, -1e5, 1e5) || !within(e.speed as number, -200, 200)) return null;
      return { t: 'use', slot: s, item: e.item, x: e.x as number, z: e.z as number, y: e.y as number, heading: e.heading as number, speed: e.speed as number };
    default:
      return null;
  }
}

export interface NetHandlers {
  onLobby(info: LobbyInfo): void;
  onStart(): void;
  onPose(poses: Pose[]): void;
  onEvent(ev: NetEvent): void;
  onPeers(): void;
  /** 入った部屋が既にレース中だった (席をもらえないので別の部屋へ) */
  onBusy(): void;
}

/** あいことば: 紛らわしい文字 (0/O, 1/I) を除いた 5 文字 */
export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export function normalizeRoomCode(v: string): string {
  return v.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

/**
 * 公開ロビーのカウントダウン (秒)。2 人そろった時点でホストが締切を決めて配る。
 * 1 人のあいだは締切が無く、相手が来るまで待つ (「すぐ始める」で AI と走ることはできる)。
 */
export const COUNTDOWN_SEC = 30;

/**
 * 公開ロビーの部屋名。押した人が新しく作る。
 *
 * 同じ部屋に集まる手段は presence (下の Presence) で、待っている人の部屋が見えていれば
 * そこへ入り、見えていなければ新しい部屋を作る。お互いに見えないまま部屋が 2 つできた
 * ときは、1 人で待っている側が名前の小さいほうへ移って合流する (src/main.ts の maybeMergeLobby)。
 * 以前は壁時計を 30 秒で区切った部屋名にしていたが、「2 人そろってからカウントダウン」
 * にするには締切を人数で決める必要があり、時刻から決まる部屋名とは相容れない。
 */
export function newOpenCode(): string {
  return `OPEN${makeRoomCode()}`;
}

/**
 * 公開ロビーの部屋名の形か (OPEN + あいことばの 5 文字)。対戦待ちの表示 (presence) で
 * 届いた部屋名は相手の自己申告なので、この形でなければ使わない。対戦PLAY で入るのは
 * 公開ロビーだけにして、任意の名前の部屋 (合言葉の部屋など) へ誘導されないようにする。
 */
export function isOpenCode(code: string): boolean {
  return /^OPEN[A-HJ-NP-Z2-9]{5}$/.test(code);
}

/** create=合言葉で部屋を作った / join=合言葉で参加した / open=公開ロビー */
export type RoomKind = 'create' | 'join' | 'open';

/**
 * ホストを決める。部屋を作った人がいればその人、いなければ ID が最小の人。
 * here は部屋にいる全員の ID (自分を含む, 昇順)。
 *
 * 参加した直後は、まだ相手の挨拶が届いておらず作成者が誰か分からない。
 * そのまま ID 順で決めると、参加した側が一瞬ホストだと思い込んで座席表を
 * 配ってしまい、席が入れ替わる。合言葉で参加した側は少し待つ ('' = まだ決めない)。
 */
export function resolveHost(here: string[], creators: Record<string, boolean>, kind: RoomKind, sinceJoinMs: number): string {
  const made = here.filter(id => creators[id]);
  if (made.length) return made[0];
  // 公開ロビーには作成者がいないので待つ意味がない
  if (kind === 'join' && sinceJoinMs < HOST_GRACE_MS) return '';
  return here[0] ?? '';
}

/**
 * 座席表を受け入れてよいか。自分から見たホストが送ったものだけを採る。
 *
 * 誰からでも受け取ると、直結できない組 (対称型 NAT どうしで TURN が無い) がいるときに
 * 「自分がホストだ」と思い込んだ 2 人が別々の座席表を配り、受け取った側の席が
 * 行ったり来たりする。改造したクライアントが座席表を差し替えることもできてしまう。
 * 自分から見たホストと食い違う相手の座席表は捨て、ホストとつながっていない人は
 * 席をもらえないまま発走して 1 人で走る (main.ts の beginOnlineRace)。
 */
export function acceptLobby(sender: string, host: string, info: unknown): info is LobbyInfo {
  if (!host || sender !== host) return false;
  const i = info as Partial<LobbyInfo> | null;
  if (!i || !Array.isArray(i.order) || i.order.length > MAX_SLOTS) return false;
  if (!i.order.every(id => typeof id === 'string') || !i.order.includes(sender)) return false;
  return typeof i.names === 'object' && i.names !== null;
}

/**
 * 受け入れた座席表の中身を正規化する。名前は画面 (ロビー・吹き出し・リザルト) に出すので、
 * 文字列にして 10 文字に切る。ホストが改造したクライアントでも HTML や長い文字列を
 * 混ぜられないようにする。
 */
export function sanitizeLobby(info: LobbyInfo, fallbackSeed: number): LobbyInfo {
  const names: Record<string, string> = {};
  for (const id of info.order) names[id] = String(info.names[id] ?? '???').slice(0, 10);
  const seed = Number(info.seed);
  const deadline = Number(info.deadline);
  return {
    order: [...info.order],
    names,
    seed: Number.isFinite(seed) ? seed : fallbackSeed,
    // Infinity を通すとカウントダウンが「Infinity 秒」のまま止まる
    deadline: Number.isFinite(deadline) && deadline > 0 ? deadline : 0,
  };
}

export class NetSession {
  readonly code: string;
  readonly selfId = selfId;
  private room: Room;
  private handlers: NetHandlers;
  private myName: string;

  /** 部屋にいる人の名前 (自分を含む) */
  names: Record<string, string> = {};
  /** 部屋を作った人 (ホストはここから決める) */
  private creators: Record<string, boolean> = {};
  private joinedAt = Date.now();
  readonly kind: RoomKind;
  /** ホストが決めた座席順。ロビー受信まで空 */
  order: string[] = [];
  seed = 20240803;
  /** 発走の締切 (ミリ秒)。公開ロビーで 2 人そろうと決まる。0 = 相手待ち (合言葉の部屋は常に 0) */
  deadline = 0;
  started = false;

  // trystero 0.25 の makeAction は { send, onMessage } を返す
  private hi: MessageAction<JsonValue>;
  private lobby: MessageAction<JsonValue>;
  private go: MessageAction<JsonValue>;
  private busy: MessageAction<JsonValue>;
  private pose: MessageAction<JsonValue>;
  private ev: MessageAction<JsonValue>;
  /** 相手ごとの受信回数の上限 (RateGate) */
  private gates = makeGates();

  constructor(code: string, name: string, kind: RoomKind, handlers: NetHandlers) {
    this.code = code;
    this.myName = name;
    this.handlers = handlers;
    this.names[selfId] = name;
    this.kind = kind;
    this.creators[selfId] = kind === 'create';
    this.room = joinRoom({ appId: APP_ID, relayConfig: RELAY_CONFIG, turnConfig }, `mk-${code}`);

    this.hi = this.room.makeAction<JsonValue>('hi', {
      onMessage: (d, ctx) => {
        if (!this.gates.hi.allow(ctx.peerId)) return;
        const msg = d as { name?: string; creator?: boolean };
        this.names[ctx.peerId] = String(msg?.name ?? '???').slice(0, 10);
        // 「部屋を作った」は相手の自己申告。公開ロビーには作った人がいないので聞かない
        // (聞くと、改造したページが作成者を名乗るだけでホストを奪える)。
        // 合言葉の部屋 (?room=) では作った人をホストにするために使う
        if (this.kind !== 'open') this.creators[ctx.peerId] = !!msg?.creator;
        // レース中に来た人には席を用意できない。そう伝えて別の部屋へ行ってもらう
        // (伝えないと、相手は誰も来ないロビーで待ち続ける)
        if (this.started) { void this.busy.send({}, { target: ctx.peerId }); return; }
        handlers.onPeers();
        // 座席順を決めて配るのはホストだけ
        if (this.isHost) this.publishLobby();
      },
    });
    this.lobby = this.room.makeAction<JsonValue>('lobby', {
      onMessage: (d, ctx) => {
        if (!this.gates.lobby.allow(ctx.peerId)) return;
        const raw: unknown = d;
        if (!acceptLobby(ctx.peerId, this.host, raw)) return;
        const info = sanitizeLobby(raw, this.seed);
        this.order = info.order;
        this.names = { ...this.names, ...info.names };
        this.seed = info.seed;
        this.deadline = info.deadline;
        handlers.onLobby(info);
      },
    });
    this.go = this.room.makeAction<JsonValue>('go', {
      // 発走の合図もホストからだけ受ける (食い違ったホストの合図で走り出さないように)
      onMessage: (_, ctx) => { if (this.gates.go.allow(ctx.peerId) && ctx.peerId === this.host && !this.started) { this.started = true; handlers.onStart(); } },
    });
    this.busy = this.room.makeAction<JsonValue>('busy', {
      // 「レース中なので入れない」はホストからだけ受ける。誰からでも受けると、同じ部屋の
      // 改造したページが送るだけで、相手を別の部屋へ移し続けられる。レース中の部屋では
      // 全員が busy を返すので、ホストの分も必ず届く
      onMessage: (_, ctx) => { if (this.gates.busy.allow(ctx.peerId) && ctx.peerId === this.host && !this.started && this.mySlot < 0) handlers.onBusy(); },
    });
    // 位置もイベントも、その席の持ち主から届いたものだけを受け入れる (slotOwner)
    this.pose = this.room.makeAction<JsonValue>('pose', {
      onMessage: (d, ctx) => {
        if (!this.gates.pose.allow(ctx.peerId)) return;
        const out = parsePoses(d, ctx.peerId, this.order, this.host);
        if (out.length) handlers.onPose(out);
      },
    });
    this.ev = this.room.makeAction<JsonValue>('ev', {
      onMessage: (d, ctx) => {
        if (!this.gates.ev.allow(ctx.peerId)) return;
        const e = parseEvent(d, ctx.peerId, this.order, this.host);
        if (e) handlers.onEvent(e);
      },
    });

    this.room.onPeerJoin = peer => {
      // 新しく来た人へ自分の名前を渡す。名簿はホストがまとめて配る。
      void this.hi.send({ name: this.myName, creator: !!this.creators[selfId] }, { target: peer });
      handlers.onPeers();
      if (this.isHost) this.publishLobby();
    };
    this.room.onPeerLeave = peer => {
      for (const g of Object.values(this.gates)) g.forget(peer);
      handlers.onPeers();
      // ホストが抜けたら ID 順で次の人がホストになる
      if (this.isHost) this.publishLobby();
    };
    // 既にいる人へ挨拶
    void this.hi.send({ name: this.myName, creator: !!this.creators[selfId] });
  }

  /** 部屋にいる全員の ID (自分を含む, 昇順) */
  peerIds(): string[] {
    return [selfId, ...Object.keys(this.room.getPeers())].sort();
  }

  /**
   * ホスト = 部屋を作った人。抜けたら残った中で ID が最小の人へ自動的に移る。
   * ID 順だけで決めると「部屋を作ったのに開始ボタンを押せない」ことになる (resolveHost)。
   */
  get host(): string {
    return resolveHost(this.peerIds(), this.creators, this.kind, Date.now() - this.joinedAt);
  }

  get isHost(): boolean {
    return this.host === selfId;
  }

  /** 自分のカートの枠。まだ席が決まっていなければ -1 */
  get mySlot(): number {
    return this.order.indexOf(selfId);
  }

  /** ホストが座席順を決めて配る。既に決まっている席は動かさない (レース中の入れ替え防止) */
  publishLobby(): void {
    // レース中は席を配り直さない。途中で誰か抜けたときに枠がずれると、
    // 走っているカートの持ち主が入れ替わってしまう。
    if (!this.isHost || this.started) return;
    const here = new Set(this.peerIds());
    const order = this.order.filter(id => here.has(id));
    // ホストは必ず先頭。名前がまだ届いていない人は席に着けない
    // (?????? のまま配ると、相手の画面で自分の名前が上書きされてしまう)
    if (!order.includes(selfId)) order.unshift(selfId);
    for (const id of this.peerIds()) if (!order.includes(id) && this.names[id]) order.push(id);
    this.order = order.slice(0, 8);
    const names: Record<string, string> = {};
    for (const id of this.order) names[id] = this.names[id] ?? '???';
    this.names = { ...this.names, ...names };
    // 公開ロビーは 2 人そろった時点でカウントダウンを始める。1 人に戻ったら止める
    // (相手が抜けたのに 1 人で発走してしまわないように)。合言葉の部屋は開始ボタンで始める。
    if (this.kind === 'open') {
      if (this.order.length >= 2) { if (!this.deadline) this.deadline = Date.now() + COUNTDOWN_SEC * 1000; }
      else this.deadline = 0;
    }
    const info: LobbyInfo = { order: this.order, names, seed: this.seed, deadline: this.deadline };
    void this.lobby.send(info as unknown as JsonValue);
    this.handlers.onLobby(info);
  }

  startRace(): void {
    if (!this.isHost || this.started) return;
    this.started = true;
    void this.go.send({});
    this.handlers.onStart();
  }

  /**
   * ホストからの合図を待たずに自分だけ始める。
   * 締切を過ぎても go が届かないとき (ホストが落ちた・回線が詰まった) の保険。
   */
  startLocally(): void {
    if (this.started) return;
    this.started = true;
    this.handlers.onStart();
  }

  /** 自分が持っているカートの位置をまとめて送る */
  sendPoses(poses: Pose[]): void {
    if (!poses.length) return;
    const a: number[] = [];
    for (const p of poses) a.push(...packPose(p));
    void this.pose.send(a);
  }

  emit(ev: NetEvent): void {
    void this.ev.send(ev as unknown as JsonValue);
  }

  leave(): void {
    void this.room.leave().catch(() => { /* 切断済み */ });
  }
}

// ---- トップ画面の「対戦待ち」表示 (presence) ----
//
// 対戦PLAY を押す前から、レースの部屋とは別の常設の部屋 (mk-presence) に全員が入り、
// 「トップ画面にいる / 対戦待ち / レース中」を伝え合う。トップ画面はこれを見て
// 「いま 1 人が対戦待ち (相手を待っています)」「いま 2 人が対戦待ち (発走まで 18 秒)」
// のように出す。対戦PLAY を押したときに入る部屋もここで決める (待っている人の部屋)。
//
// trystero 0.25 は同じ appId なら部屋をまたいで WebRTC 接続を共有する
// (@trystero-p2p/core の SharedPeerManager)。ここでつながった相手とは、
// 対戦PLAY を押した瞬間にリレーの往復なしで同じ部屋に入れるので、
// 相手とつながるまでの 8〜19 秒をページの読み込み中に済ませておく意味もある。
//
// 部屋を分ける (分室): WebRTC は全員どうしで張るので、1 つの部屋に N 人いると
// 1 台あたり N-1 本、全体で N(N-1)/2 本の接続になる。人が集まった瞬間にスマホの
// CPU と回線が先に尽きて対戦どころではなくなるので、最初の部屋 (mk-presence) が
// PRESENCE_SPLIT_AT 人を超えたら、トップ画面の人は ID で決まる分室へ移る。
// 対戦待ちの人は最初の部屋と全分室に入るので、どこにいる人からも見え、待っている
// 人どうしも互いに見える (合流の maybeMergeLobby が効く)。代わりにトップ画面の人数は
// 自分の部屋の分しか数えない。接続数は 1 台あたりおおよそ
//   トップ画面: PRESENCE_SPLIT_AT + N / PRESENCE_SHARDS + 対戦待ちの人数
//   対戦待ち: N (待っている間だけ)
// 分室を増やすと、対戦待ちの人が入る部屋ごとにリレーへの告知が増える
// (部屋ごとに入室直後の数回 + 60 秒おき)。リレーの流量制限に掛からないよう 4 にしてある。
// 最初の部屋の名前は以前と同じなので、古い版のページとも互いに見える。

export type PresenceState = 'title' | 'wait' | 'race';

export interface PresenceInfo {
  s: PresenceState;
  /** 対戦待ちのときだけ: 名前・部屋・締切 (ミリ秒, 0 = まだ相手待ちでカウントダウン前) */
  name?: string;
  room?: string;
  deadline?: number;
}

/** 対戦待ちの人がいる部屋。deadline 0 = 相手待ち (カウントダウン前) */
export interface WaitingRoom { code: string; deadline: number; names: string[] }

export interface PresenceSummary {
  /** 自分以外でつながっている人数 (0 ならまだ誰ともつながっていないか、本当に誰もいない) */
  others: number;
  title: number;
  racing: number;
  /** 人数の多い順、同数なら部屋名順 (合流先の優先順) */
  waiting: WaitingRoom[];
}

/**
 * カウントダウン中の部屋へ途中から入るのに要る最低の残り秒数。
 * 接続は presence で共有済みなので、残るのは席の受け渡し (数百ミリ秒) だけ。
 */
export const JOIN_MIN_WAIT = 3;

export const PRESENCE_ROOM = 'mk-presence';
export const PRESENCE_SHARDS = 4;
/** 最初の部屋にこれより多くいたら分室へ移る */
export const PRESENCE_SPLIT_AT = 12;

export const shardRoom = (i: number): string => `${PRESENCE_ROOM}-${i}`;

/** ID から分室の番号を決める (全員が同じ計算をするので、同じ ID は同じ分室) */
export function shardOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % PRESENCE_SHARDS;
}

/** その状態で入っておく presence の部屋。対戦待ちは全部、それ以外は自分の部屋だけ */
export function presenceRooms(s: PresenceState, home: string): string[] {
  if (s === 'wait') return [PRESENCE_ROOM, ...Array.from({ length: PRESENCE_SHARDS }, (_, i) => shardRoom(i))];
  return [home];
}

/** 最初の部屋が混んできたので分室へ移るか。一度移ったら戻らない (出入りを繰り返さないように) */
export function shouldSplit(s: PresenceState, home: string, peersInFirstRoom: number): boolean {
  return s !== 'wait' && home === PRESENCE_ROOM && peersInFirstRoom > PRESENCE_SPLIT_AT;
}

export class Presence {
  private rooms = new Map<string, { room: Room; st: MessageAction<JsonValue> }>();
  /** 相手ごとの状態通知の上限 (RateGate)。部屋をまたいで共通 */
  private stGate = new RateGate(RATES.st[0], RATES.st[1]);
  private peers: Record<string, PresenceInfo> = {};
  private me: PresenceInfo = { s: 'title' };
  /** 対戦待ちでないときに入っている部屋 */
  private home = PRESENCE_ROOM;
  /** 誰かの状態が変わった (表示の更新用) */
  onChange: (() => void) | null = null;

  constructor() {
    this.sync();
  }

  /** いま入っている部屋 (診断用) */
  get roomIds(): string[] {
    return [...this.rooms.keys()];
  }

  private join(id: string): void {
    if (this.rooms.has(id)) return;
    const room = joinRoom({ appId: APP_ID, relayConfig: RELAY_CONFIG, turnConfig }, id);
    const st = room.makeAction<JsonValue>('st', {
      onMessage: (d, ctx) => {
        if (!this.stGate.allow(ctx.peerId)) return;
        const m = d as { s?: string; name?: string; room?: string; deadline?: number } | null;
        const s: PresenceState = m?.s === 'wait' || m?.s === 'race' ? m.s : 'title';
        // 部屋名と締切は相手の自己申告。表示に使うので長さと値の範囲だけ絞る
        // (Infinity の締切は「まもなく発走」のまま永遠に残る)
        const deadline = Number(m?.deadline);
        this.peers[ctx.peerId] = s === 'wait'
          ? {
            s,
            name: String(m?.name ?? '').slice(0, 10),
            room: isOpenCode(String(m?.room ?? '')) ? String(m?.room) : '',
            deadline: Number.isFinite(deadline) && deadline > 0 ? deadline : 0,
          }
          : { s };
        this.changed();
      },
    });
    room.onPeerJoin = peer => {
      // 状態が届くまでは「トップ画面にいる」扱い
      this.peers[peer] ??= { s: 'title' };
      void st.send(this.me as unknown as JsonValue, { target: peer });
      this.changed();
    };
    room.onPeerLeave = () => { this.prune(); this.changed(); };
    this.rooms.set(id, { room, st });
  }

  /** 状態に合わせて部屋に出入りする */
  private sync(): void {
    const want = new Set(presenceRooms(this.me.s, this.home));
    for (const id of want) this.join(id);
    for (const [id, r] of this.rooms) {
      if (want.has(id)) continue;
      this.rooms.delete(id);
      void r.room.leave().catch(() => { /* 切断済み */ });
    }
    this.prune();
  }

  /** どの部屋でも見えなくなった人の状態を捨てる */
  private prune(): void {
    const here = this.ids();
    for (const id of Object.keys(this.peers)) if (!here.has(id)) delete this.peers[id];
  }

  private changed(): void {
    const first = this.rooms.get(PRESENCE_ROOM);
    if (first && shouldSplit(this.me.s, this.home, Object.keys(first.room.getPeers()).length)) {
      this.home = shardRoom(shardOf(selfId));
      this.sync();
    }
    this.onChange?.();
  }

  /** 入っている部屋のどこかで見えている人 (自分以外) */
  private ids(): Set<string> {
    const out = new Set<string>();
    for (const { room } of this.rooms.values()) for (const id of Object.keys(room.getPeers())) out.add(id);
    return out;
  }

  /** 自分の状態を全員へ知らせる */
  set(info: PresenceInfo): void {
    this.me = info;
    this.sync();
    for (const { st } of this.rooms.values()) void st.send(info as unknown as JsonValue);
    this.changed();
  }

  summary(now = Date.now()): PresenceSummary {
    const rooms: Record<string, WaitingRoom> = {};
    let title = 0, racing = 0, others = 0;
    for (const id of this.ids()) {
      const p = this.peers[id] ?? { s: 'title' };
      others++;
      if (p.s === 'wait' && p.room && (!p.deadline || p.deadline > now)) {
        const r = rooms[p.room] ??= { code: p.room, deadline: p.deadline ?? 0, names: [] };
        r.names.push(p.name || '???');
        // 同じ部屋の人から違う締切が届いたら、決まっているほうを採る
        if (p.deadline && !r.deadline) r.deadline = p.deadline;
      } else if (p.s === 'wait' || p.s === 'race') {
        racing++;   // 締切を過ぎた「対戦待ち」は走り出している
      } else {
        title++;
      }
    }
    const waiting = Object.values(rooms).sort((a, b) => b.names.length - a.names.length || (a.code < b.code ? -1 : 1));
    return { others, title, racing, waiting };
  }

  /** いま押せば入れる対戦待ちの部屋 (相手待ち、またはカウントダウンが JOIN_MIN_WAIT 秒以上残っている)。合流先の優先順 */
  joinable(now = Date.now()): WaitingRoom[] {
    return this.summary(now).waiting.filter(r => !r.deadline || r.deadline - now >= JOIN_MIN_WAIT * 1000);
  }

  leave(): void {
    for (const { room } of this.rooms.values()) void room.leave().catch(() => { /* 切断済み */ });
    this.rooms.clear();
  }
}
