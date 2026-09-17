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
//   - ホストは部屋を作った人。抜けたら残った中で ID が最小の人へ自動的に移る。
import { joinRoom, selfId, getRelaySockets } from 'trystero/nostr';
import type { JsonValue, MessageAction, Room } from 'trystero/nostr';
import { assetUrl } from './geo';

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

export async function loadTurn(): Promise<number> {
  try {
    const res = await fetch(assetUrl('turn.json'), { cache: 'no-store' });
    if (!res.ok) return 0;
    let cfg: unknown = await res.json();
    const asObj = cfg as { url?: unknown; iceServers?: unknown } | null;
    if (asObj && typeof asObj.url === 'string') cfg = await (await fetch(asObj.url)).json();
    const list = Array.isArray(cfg) ? cfg : Array.isArray((cfg as { iceServers?: unknown })?.iceServers) ? (cfg as { iceServers: unknown[] }).iceServers : [];
    turnConfig = (list as IceServer[]).filter(s => s && s.urls);
    return turnConfig.length;
  } catch {
    return 0;
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

/** create=合言葉で部屋を作った / join=合言葉で参加した / open=公開ロビー */
export type RoomKind = 'create' | 'join' | 'open';

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
        const msg = d as { name?: string; creator?: boolean };
        this.names[ctx.peerId] = String(msg?.name ?? '???').slice(0, 10);
        this.creators[ctx.peerId] = !!msg?.creator;
        // レース中に来た人には席を用意できない。そう伝えて別の部屋へ行ってもらう
        // (伝えないと、相手は誰も来ないロビーで待ち続ける)
        if (this.started) { void this.busy.send({}, { target: ctx.peerId }); return; }
        handlers.onPeers();
        // 座席順を決めて配るのはホストだけ
        if (this.isHost) this.publishLobby();
      },
    });
    this.lobby = this.room.makeAction<JsonValue>('lobby', {
      onMessage: d => {
        const info = d as unknown as LobbyInfo;
        if (!info || !Array.isArray(info.order)) return;
        this.order = info.order;
        this.names = { ...this.names, ...info.names };
        this.seed = info.seed;
        this.deadline = Number(info.deadline) || 0;
        handlers.onLobby(info);
      },
    });
    this.go = this.room.makeAction<JsonValue>('go', {
      onMessage: () => { if (!this.started) { this.started = true; handlers.onStart(); } },
    });
    this.busy = this.room.makeAction<JsonValue>('busy', {
      onMessage: () => { if (!this.started && this.mySlot < 0) handlers.onBusy(); },
    });
    this.pose = this.room.makeAction<JsonValue>('pose', {
      onMessage: d => {
        if (!Array.isArray(d)) return;
        const a = d as number[];
        const out: Pose[] = [];
        for (let i = 0; i + POSE_LEN <= a.length; i += POSE_LEN) out.push(unpackPose(a, i));
        if (out.length) handlers.onPose(out);
      },
    });
    this.ev = this.room.makeAction<JsonValue>('ev', {
      onMessage: d => {
        const e = d as unknown as NetEvent;
        if (e && typeof e.t === 'string') handlers.onEvent(e);
      },
    });

    this.room.onPeerJoin = peer => {
      // 新しく来た人へ自分の名前を渡す。名簿はホストがまとめて配る。
      void this.hi.send({ name: this.myName, creator: !!this.creators[selfId] }, { target: peer });
      handlers.onPeers();
      if (this.isHost) this.publishLobby();
    };
    this.room.onPeerLeave = () => {
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
   * ID 順だけで決めると「部屋を作ったのに開始ボタンを押せない」ことになる。
   *
   * 参加した直後は、まだ相手の挨拶が届いておらず作成者が誰か分からない。
   * そのまま ID 順で決めると、参加した側が一瞬ホストだと思い込んで座席表を
   * 配ってしまい、席が入れ替わる。作成者でない場合は少し待つ。
   */
  get host(): string {
    const here = this.peerIds();
    const made = here.filter(id => this.creators[id]);
    if (made.length) return made[0];
    // 公開ロビーには作成者がいないので待つ意味がない
    if (this.kind === 'join' && Date.now() - this.joinedAt < HOST_GRACE_MS) return '';
    return here[0];
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

export class Presence {
  private room: Room;
  private peers: Record<string, PresenceInfo> = {};
  private me: PresenceInfo = { s: 'title' };
  private st: MessageAction<JsonValue>;
  /** 誰かの状態が変わった (表示の更新用) */
  onChange: (() => void) | null = null;

  constructor() {
    this.room = joinRoom({ appId: APP_ID, relayConfig: RELAY_CONFIG, turnConfig }, 'mk-presence');
    this.st = this.room.makeAction<JsonValue>('st', {
      onMessage: (d, ctx) => {
        const m = d as { s?: string; name?: string; room?: string; deadline?: number } | null;
        const s: PresenceState = m?.s === 'wait' || m?.s === 'race' ? m.s : 'title';
        this.peers[ctx.peerId] = s === 'wait'
          ? { s, name: String(m?.name ?? '').slice(0, 10), room: String(m?.room ?? ''), deadline: Number(m?.deadline) || 0 }
          : { s };
        this.onChange?.();
      },
    });
    this.room.onPeerJoin = peer => {
      // 状態が届くまでは「トップ画面にいる」扱い
      this.peers[peer] ??= { s: 'title' };
      void this.st.send(this.me as unknown as JsonValue, { target: peer });
      this.onChange?.();
    };
    this.room.onPeerLeave = peer => { delete this.peers[peer]; this.onChange?.(); };
  }

  /** 自分の状態を全員へ知らせる */
  set(info: PresenceInfo): void {
    this.me = info;
    void this.st.send(info as unknown as JsonValue);
    this.onChange?.();
  }

  summary(now = Date.now()): PresenceSummary {
    const rooms: Record<string, WaitingRoom> = {};
    let title = 0, racing = 0, others = 0;
    for (const id of Object.keys(this.room.getPeers())) {
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
    void this.room.leave().catch(() => { /* 切断済み */ });
  }
}
