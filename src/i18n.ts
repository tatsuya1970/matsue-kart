// 日本語 / 英語の切り替え。
//
// 言語ごとに URL を分けてある。日本語は配信の根 (/)、英語はその下の /en/。
// 英語に実体のある URL を与えているのは SEO と SNS のため: X や Facebook の
// カードを作るクローラは JavaScript を実行しないので、1 つの URL で実行時に
// 差し替えるだけでは共有カードが日本語のままになる。検索も、1 つの URL に
// 2 言語が同居していると、どちらの言語として出すか決めきれない。
// /en/ の中身は dist/index.html と同じで、head だけ英語に差し替えたもの
// (tools/build_en_page.mjs がビルド後に書き出す)。
//
// 判定は /en/ → ?lang= → localStorage → navigator.language の順。IP から国を
// 見るにはサーバーが要るので、この構成 (GitHub Pages の静的配信) では使えない。
// 日本語環境から英語で見たい人もいるので、手動の切り替えも必ず出す。
//
// index.html の固定文言は data-en / data-en-html 属性に英語を持たせ、
// applyDomLang() がまとめて差し替える。日本語がソースに残るので読みやすい。

import { storageGet, storageSet } from './storage';

export type Lang = 'ja' | 'en';

const STORAGE_KEY = 'mk.lang';
/** 英語版の置き場所。配信の根からの相対 (GitHub Pages では /matsue-kart/en/) */
const EN_PATH = import.meta.env.BASE_URL + 'en/';

/** いま英語版の URL にいるか */
function onEnPath(): boolean {
  return location.pathname.replace(/\/?$/, '/').endsWith('/en/');
}

function resolve(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'ja' || q === 'en') return q;
  if (onEnPath()) return 'en';
  const saved = storageGet(STORAGE_KEY);
  if (saved === 'ja' || saved === 'en') return saved;
  return (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export const lang: Lang = resolve();
export const isJa = lang === 'ja';

/**
 * 言語を変えて読み込み直す (アトラスや地名の描き直しが要るため)。
 * 本番はその言語の URL へ移る。開発サーバーには /en/ が無いので ?lang= を使う。
 */
export function setLang(l: Lang): void {
  storageSet(STORAGE_KEY, l);
  const params = new URLSearchParams(location.search);
  params.delete('lang');
  if (import.meta.env.DEV) {
    if (l === 'en') params.set('lang', 'en');
    const url = new URL(location.pathname, location.origin);
    url.search = params.toString();
    location.replace(url.toString());
    return;
  }
  const url = new URL(l === 'en' ? EN_PATH : import.meta.env.BASE_URL, location.origin);
  url.search = params.toString();
  location.replace(url.toString());
}

type Dict = Record<string, string>;

const JA: Dict = {
  'load.terrain': '地形データ読み込み中...',
  'load.buildings': '建物データ読み込み中...',
  'load.parks': '公園を整地中...',
  'load.course': 'コース生成中...',
  'load.ground': '地形生成中...',
  'load.rail': '一畑電車・JR を敷設中...',
  'load.bldg': '建物 {0} 棟を生成中...',
  'load.bldgDone': '建物 {0} 棟を配置 (コース上 {1} 棟を除去)',
  'load.landmarks': '松江城天守 (PLATEAU LOD3)・嫁ヶ島を配置中...',
  'load.lod2Shape': 'LOD2 形状を読み込み中...',
  'load.lod2Tex': 'LOD2 テクスチャ {0}/{1}',
  'load.error': 'エラー: {0}（押すと再読み込み）',
  'gl.lost': '画面の描画が止まりました（GPU のメモリ不足など）。画質を下げると起きにくくなります。',
  'gl.reload': '再読み込み',

  'btn.solo': '1人PLAY',
  'btn.online': '対戦PLAY',
  'btn.onlineUnavailable': '対戦（現在利用不可）',
  'btn.again': 'もう一度走る',
  'btn.startNow': 'すぐ始める',
  'btn.leave': 'やめる',

  'lobby.countLabel': '発走まで',
  'lobby.connecting': '接続中...',
  'lobby.you': 'あなた',
  'lobby.host': 'ホスト',
  'lobby.status': 'いま {0} 人。空いた {1} 台は AI が走ります。',
  'lobby.anon': 'プレイヤー',
  'lobby.waitHost': ' 発走はホストの合図で揃えます。',
  'lobby.waitingPeople': '対戦相手を待っています...',
  'lobby.alone': 'だれか来ると {0} 秒のカウントダウンが始まります。1 人で走るなら「すぐ始める」を押してください。',
  'lobby.arrived': '🎉 対戦相手が来ました!',
  'net.failed': '接続できませんでした: {0}',
  'net.busy': 'この部屋はレース中です',
  'pres.optInLead': '対戦待ちの人がいるかは、通信を許可すると表示されます。',
  'net.confirmLink': '部屋 {0} に入りますか？\n\n他のプレイヤーのブラウザと直接接続するため、あなたの IP アドレスが相手と接続用の公開サーバーに伝わります。',
  'net.turnRequired': '安全に接続できる TURN 中継を確認できないため、対戦は現在利用できません',
  'net.turnCapped': '今日は対戦はできません。午前 0 時にリセットします（中継サーバーの 1 日の利用上限に達したため）',
  'net.turnError': '中継サーバーの設定を取得できないため、いまは対戦できません。しばらくしてからページを読み込み直してください',

  'pres.checking': '対戦待ちの人がいるか確認しています...',
  'pres.none': 'いま対戦待ちの人は見当たりません',
  'pres.relays': 'リレー {0}/{1} に接続中',
  'pres.relayConnecting': 'リレーに接続しています...',
  'pres.natSym': 'この回線 (携帯回線など) は相手と直結しにくい種類の NAT です。相手が見えない原因になります (TURN 未設定)',
  'pres.natSymTurn': 'この回線は直結しにくい NAT ですが、TURN で中継できます',
  'pres.natSymTurnNg': 'この回線は直結しにくい NAT で、TURN にもつながりません',
  'pres.natBlocked': 'STUN が通りません (社内ネットワーク等)。相手が見えない原因になります',
  'pres.turnNg': 'TURN にはつながりません',
  'pres.inApp': '{0} のアプリ内ブラウザでは対戦がつながらないことがあります。右上のメニューから Safari / Chrome で開いてください',
  'pres.noRelay': 'リレーに接続できていません（回線を確認してください）',
  'pres.waiting': 'いま {0} 人が対戦待ち（{1}）',
  'pres.waitingPeople': '対戦相手を待っています',
  'pres.joinStart': '対戦PLAY を押すと 2 人になり、カウントダウンが始まります',
  'pres.appeared': '対戦待ちの人がいます!',
  'pres.startsIn': '発走まで {0} 秒',
  'pres.joinNow': '対戦PLAY を押すと同じレースに入れます',
  'pres.soon': 'まもなく発走（今から押すと新しいロビーで待つことになります）',
  'pres.title': 'ほかに {0} 人がこの画面を見ています',
  'pres.racing': '{0} 人がレース中',
  'pres.nobody': 'ほかに見ている人はいません',
  'pres.lobbyTitle': 'トップ画面に {0} 人います（来るかもしれません）',

  'race.finalLap': 'ファイナルラップ!',
  'race.finish': 'FINISH!',
  'race.go': 'GO!',
  'race.tram': '踏切に注意!',
  'race.soloFallback': '接続が間に合わないので 1 人で走ります',

  'q.high': '高 (専用GPU向け)',
  'q.medium': '中 (内蔵GPU向け)',
  'q.low': '低 (最軽量)',

  'item.mushroom': 'ダッシュ',
  'item.banana': 'オイル',
  'item.shell': 'ボール',
  'item.star': 'むてき',
  'rank.prompt': 'タイム {0}。なまえを入れてランキングに登録できます',
  'rank.sending': '登録しています...',
  'rank.done': '{0} 位に登録しました!',
  'rank.doneOut': '登録しました (上位 100 位には入りませんでした)',
  'rank.failed': '登録できませんでした。もう一度押してください',
  'rank.loadFailed': 'ランキングを読み込めませんでした',
  'rank.loading': '読み込み中...',
  'rank.ngName': 'その名前は使えません。別の名前を入れてください',

  'lang.other': 'English',
};

const EN: Dict = {
  'load.terrain': 'Loading terrain data...',
  'load.buildings': 'Loading building data...',
  'load.parks': 'Shaping the parks...',
  'load.course': 'Building the course...',
  'load.ground': 'Building the ground...',
  'load.rail': 'Laying the Ichibata and JR lines...',
  'load.bldg': 'Building {0} structures...',
  'load.bldgDone': 'Placed {0} buildings ({1} removed from the course)',
  'load.landmarks': 'Placing Matsue Castle (PLATEAU LOD3) and Yomegashima...',
  'load.lod2Shape': 'Loading LOD2 geometry...',
  'load.lod2Tex': 'LOD2 textures {0}/{1}',
  'load.error': 'Error: {0} (tap to reload)',
  'gl.lost': 'Rendering stopped (the GPU may have run out of memory). A lower graphics setting makes this less likely.',
  'gl.reload': 'Reload',

  'btn.solo': 'SOLO PLAY',
  'btn.online': 'ONLINE PLAY',
  'btn.onlineUnavailable': 'ONLINE UNAVAILABLE',
  'btn.again': 'Race again',
  'btn.startNow': 'Start now',
  'btn.leave': 'Leave',

  'lobby.countLabel': 'Starts in',
  'lobby.connecting': 'connecting...',
  'lobby.you': 'you',
  'lobby.host': 'host',
  'lobby.status': '{0} here. The other {1} karts are AI.',
  'lobby.anon': 'Player',
  'lobby.waitHost': ' The host gives the start signal.',
  'lobby.waitingPeople': 'Waiting for another player...',
  'lobby.alone': 'A {0}-second countdown starts when someone joins. Press "Start now" to race the AI by yourself.',
  'lobby.arrived': '🎉 An opponent has arrived!',
  'net.failed': 'Could not connect: {0}',
  'net.busy': 'This room is mid-race',
  'pres.optInLead': 'Allow the connection to see whether anyone is waiting to race.',
  'net.confirmLink': 'Join room {0}?\n\nYou will connect directly to other players\' browsers, so your IP address will be visible to them and to the public servers used to connect.',
  'net.turnRequired': 'Online play is unavailable because a working TURN relay could not be verified',
  'net.turnCapped': 'Online play is unavailable today. It resets at midnight (Japan time) because the relay server reached its daily limit',
  'net.turnError': 'Online play is unavailable right now because the relay settings could not be loaded. Reload the page later',

  'pres.checking': 'Checking whether anyone is waiting...',
  'pres.none': 'No one seems to be waiting right now',
  'pres.relays': 'connected to {0}/{1} relays',
  'pres.relayConnecting': 'connecting to relays...',
  'pres.natSym': 'This connection (e.g. mobile data) is behind a NAT that rarely allows direct peer links, which can hide other players (no TURN configured)',
  'pres.natSymTurn': 'This connection is behind a restrictive NAT, but TURN can relay it',
  'pres.natSymTurnNg': 'This connection is behind a restrictive NAT and TURN is unreachable',
  'pres.natBlocked': 'STUN is blocked (e.g. corporate network), which can hide other players',
  'pres.turnNg': 'TURN is unreachable',
  'pres.inApp': 'The {0} in-app browser often cannot connect to other players. Open this page in Safari / Chrome from the menu',
  'pres.noRelay': 'Not connected to any relay (check your connection)',
  'pres.waiting': '{0} waiting for a race ({1})',
  'pres.waitingPeople': 'waiting for an opponent',
  'pres.joinStart': 'Press ONLINE PLAY to make it two and start the countdown',
  'pres.appeared': 'Someone is waiting to race!',
  'pres.startsIn': 'starts in {0}s',
  'pres.joinNow': 'Press ONLINE PLAY to join their race',
  'pres.soon': 'starting now (pressing would open a new lobby)',
  'pres.title': '{0} more on this screen',
  'pres.racing': '{0} racing',
  'pres.nobody': 'No one else is here right now',
  'pres.lobbyTitle': '{0} on the title screen (they may join)',

  'race.finalLap': 'FINAL LAP!',
  'race.finish': 'FINISH!',
  'race.go': 'GO!',
  'race.tram': 'Watch the level crossing!',
  'race.soloFallback': 'Could not connect in time. Racing solo.',

  'q.high': 'High (discrete GPU)',
  'q.medium': 'Medium (integrated GPU)',
  'q.low': 'Low (lightest)',

  'item.mushroom': 'Dash',
  'item.banana': 'Oil',
  'item.shell': 'Ball',
  'item.star': 'Shield',
  'rank.prompt': 'Your time: {0}. Enter your name to join the ranking',
  'rank.sending': 'Submitting...',
  'rank.done': 'You placed #{0}!',
  'rank.doneOut': 'Submitted (outside the top 100)',
  'rank.failed': 'Could not submit. Please try again',
  'rank.loadFailed': 'Could not load the ranking',
  'rank.loading': 'Loading...',
  'rank.ngName': 'That name is not allowed. Please choose another',

  'lang.other': '日本語',
};

const DICT = isJa ? JA : EN;

/** {0} {1} ... を差し替える */
export function t(key: string, ...args: (string | number)[]): string {
  const s = DICT[key] ?? JA[key] ?? key;
  return s.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
}

/**
 * index.html の固定文言を差し替える。日本語をそのまま置き、英語は
 * data-en (テキスト) / data-en-html (HTML) に持たせておく。
 * placeholder は data-en-placeholder。
 */
export function applyDomLang(): void {
  if (isJa) return;
  document.documentElement.lang = 'en';
  // /en/ の head はもともと英語なので触らない。?lang=en で見ているときだけ、
  // タブの見出しを英語にする (検索向けの見出しは URL ごとに静的に持たせてある)
  if (!onEnPath()) document.title = 'Matsue Kart — a browser kart racer on real PLATEAU 3D city data';
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-en]'))) {
    el.textContent = el.dataset.en!;
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-en-html]'))) {
    el.innerHTML = el.dataset.enHtml!;
  }
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement>('[data-en-placeholder]'))) {
    el.placeholder = el.dataset.enPlaceholder!;
  }
}
