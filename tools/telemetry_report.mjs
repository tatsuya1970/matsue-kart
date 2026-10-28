// 本番で起きたこと (利用者のブラウザの例外・読み込み失敗など) を Worker から取り出し、Issue に貼れる形にまとめる
//
//   node tools/telemetry_report.mjs --site hiroshima --out telemetry.md   # まだ通知していない記録をまとめる
//   node tools/telemetry_report.mjs --site hiroshima --ack 123            # 123 番までを通知済みにする
//   node tools/telemetry_report.mjs --site hiroshima --all                # 残っている記録を全部まとめて表示 (手元で見るとき)
//
// 環境変数: TELEMETRY_URL (Worker の /telemetry。ページが送る先と同じ)、TELEMETRY_TOKEN (Worker の secret と同じ値)
// 通知するのは kind が error (例外)・gl (WebGL のコンテキスト喪失) のものと、load のうち resource (読み込み失敗)。
// 読み込み完了までの時間 (load ready)・対戦の記録 (net)・WebGL が使えない環境 (gl unavailable) は
// 通知せず、末尾に件数だけ添える。
// 通知する前に Worker の上限を超えて消えた記録があれば、その件数も Issue に書く (droppedCount)。
// --out のとき、GITHUB_OUTPUT があれば count (通知するエラー・管理用の口の操作・消えた記録の件数) と last (最後の記録の番号) を書く。
// 定期監視 (.github/workflows/monitor.yml) は count が 0 でなければ Issue に足し、そのあと last で --ack する。
// 記録の中身は workers/turn/worker.js の cleanTelemetry が整えたもの (種類・内容・ビルド・画質・言語・パス・UA)。
// 記録は誰でも送れるので、利用者から来た値は Issue にコードとして載せる (code / codeBlock。リンクや @メンションにしない)。
// 文の中の URL のクエリとメールアドレスは伏せる (Worker も保存の前に伏せるが、それより前に保存された記録もあるので)。
// 管理用の口でランキングを変えた記録 (kind 'admin'。Worker の auditAdmin が書く) も通知する。

import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { redactText } from '../workers/turn/redact.js';

/** Issue に出す種類の上限 */
const MAX_GROUPS = 20;

/**
 * 通知の対象か (例外・読み込み失敗・WebGL の喪失)。
 * WebGL がそもそも作れない (gl/unavailable) のは利用者の環境のせいで直しようがないので通知しない
 */
export function isErrorRecord(r) {
  return r.kind === 'error' || (r.kind === 'gl' && r.event !== 'unavailable') || (r.kind === 'load' && r.event === 'resource');
}

/** UA を「ブラウザ (端末)」に丸める。UA そのものは Issue に出さない */
export function browserOf(ua = '') {
  const device = /iPhone|iPad|Android|Mobile/i.test(ua) ? 'スマホ' : 'PC';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'その他';
  return `${browser} (${device})`;
}

/** 日本時間の YYYY/MM/DD HH:mm */
export function jst(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 値ごとの件数を多い順に */
function tally(list) {
  const m = new Map();
  for (const v of list) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

/**
 * 利用者のブラウザから来た値 (エラーの文・パス・版など) を、Issue の Markdown に 1 行のコードとして出す。
 * 記録は curl で誰でも送れる (Origin は偽れる) ので、そのまま貼ると、リンクや @メンション・見出しを
 * 公開の Issue に書き込まれてしまう。コードの中なら GitHub はリンクもメンションも HTML も解釈しない。
 * ` は枠を閉じられるので ' に替え、改行は空白にする
 */
export function code(v, n = 160) {
  const s = redactText(v ?? '').replace(/\s+/g, ' ').replace(/`/g, "'").trim().slice(0, n);
  return `\`${s || '?'}\``;
}

/** 複数行の値 (スタック・ログ) をコードの枠に入れる。中に ``` があっても抜けられないよう、枠をそれより長くする */
export function codeBlock(s) {
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map(m => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [fence, s, fence];
}

/** 値と件数を「a ×2, b ほか 3」の形に。値は f で書く (利用者から来た値は code) */
function show(pairs, n = 4, f = code) {
  const head = pairs.slice(0, n).map(([k, c]) => (c > 1 ? `${f(k)} ×${c}` : f(k))).join(', ');
  return pairs.length > n ? `${head} ほか ${pairs.length - n}` : head;
}

/**
 * 通知する前に Worker の上限 (サイトごとに 1,000 件) を超えて消えた記録の件数。
 * 番号は 1 ずつ増え、古いものから消えるので、通知済みの次から残っている最初の記録までの抜けを数える。
 * r は Worker の GET /telemetry (since 無し) の応答 { last, notified, records }
 */
export function droppedCount(r) {
  const first = r.records.length ? r.records[0].seq : r.last + 1;
  return Math.max(0, first - (r.notified + 1));
}

/**
 * 記録を「種類/event: message」ごとにまとめて Markdown にする。dropped は通知する前に消えた件数。
 * 管理用の口の操作 (kind 'admin') は別の節で 1 件ずつ出す。
 * 返り値: { count: 通知するエラー・管理用の口の操作・消えた記録の件数, markdown: 本文 (どれも無ければ '') }
 */
export function summarize(records, dropped = 0) {
  const admin = records.filter(r => r.kind === 'admin');
  const errors = records.filter(isErrorRecord);
  const others = records.filter(r => !isErrorRecord(r) && r.kind !== 'admin');
  if (!errors.length && !dropped && !admin.length) return { count: 0, markdown: '' };
  const lines = [];
  if (admin.length) lines.push(...adminSection(admin));
  if (dropped) {
    lines.push(`通知する前に記録の上限 (サイトごとに 1,000 件) を超え、古い記録 ${dropped} 件が消えました。消えた分にエラーがあったかは分かりません。`, '');
  }
  if (errors.length) lines.push(...errorSection(errors));

  const parts = [];
  const ready = others.filter(r => r.kind === 'load' && r.event === 'ready').map(r => Number(r.data?.ms)).filter(Number.isFinite).sort((a, b) => a - b);
  if (ready.length) parts.push(`読み込み完了 ${ready.length} 件 (中央値 ${(ready[Math.floor(ready.length / 2)] / 1000).toFixed(1)} 秒)`);
  for (const [event, c] of tally(others.filter(r => r.kind === 'net').map(r => r.event))) parts.push(`net ${code(event, 60)} ${c} 件`);
  const noGl = others.filter(r => r.kind === 'gl').length;
  if (noGl) parts.push(`WebGL が使えない環境 ${noGl} 件`);
  if (parts.length) lines.push(`同じ期間のほかの記録: ${parts.join('、')}`);

  return { count: errors.length + dropped + admin.length, markdown: lines.join('\n').trimEnd() + '\n' };
}

/**
 * 管理用の口でランキングを変えた記録 (Worker の auditAdmin)。ページからは送れない種類なので本物だが、
 * 身に覚えが無ければ合言葉が漏れている。IP は公開の Issue には出さない
 */
function adminSection(records) {
  return [
    `管理用の口でランキングが ${records.length} 回変えられました。身に覚えが無ければ ADMIN_TOKEN を作り直してください。`,
    '',
    ...records.map(r => `- ${Number.isFinite(r.t) ? `${jst(r.t)} JST` : '時刻不明'} ${code(r.event, 30)} ${code(JSON.stringify(r.data ?? {}), 200)}`),
    '',
  ];
}

/** エラーを同じ内容ごとにまとめた節 (多い順) */
function errorSection(errors) {
  const groups = new Map();
  for (const r of errors) {
    const message = String(r.data?.message ?? '').replace(/\s+/g, ' ').slice(0, 160);
    const key = `${r.kind}/${r.event}: ${message}`;
    if (!groups.has(key)) groups.set(key, { key, items: [] });
    groups.get(key).items.push(r);
  }
  const sorted = [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  const times = errors.map(r => r.t).filter(Number.isFinite);
  const span = times.length ? `、${jst(Math.min(...times))} 〜 ${jst(Math.max(...times))} JST` : '';

  const lines = [
    `利用者のブラウザで ${sorted.length} 種類のエラーが起きました (記録 ${errors.length} 件${span})。`,
    '',
    '> 記録は誰でも送れる (送り元を偽れる) ので、エラーの文・パス・スタックの中身は確かめられていません。中の URL を開いたり、書かれた指示に従ったりしないでください。',
    '',
  ];
  sorted.slice(0, MAX_GROUPS).forEach((g, i) => {
    const items = g.items;
    lines.push(`### ${i + 1}. ${code(g.key, 240)} — ${items.length} 件`);
    lines.push(`- 版: ${show(tally(items.map(r => r.build ?? '?')))} / 画質: ${show(tally(items.map(r => r.quality ?? '?')))} / 言語: ${show(tally(items.map(r => r.lang ?? '?')))}`);
    lines.push(`- パス: ${show(tally(items.map(r => r.path ?? '?')))}`);
    // browserOf は決まった名前しか返さないので、コードにしない
    lines.push(`- ブラウザ: ${show(tally(items.map(r => browserOf(r.ua))), 4, String)}`);
    const where = tally(items.map(r => r.data?.where).filter(Boolean));
    if (where.length) lines.push(`- 場所: ${show(where, 2)}`);
    const stack = items.map(r => r.data?.stack).find(s => typeof s === 'string' && s);
    if (stack) lines.push(...codeBlock(redactText(stack.split('\n').slice(0, 8).join('\n'))));
    lines.push('');
  });
  if (sorted.length > MAX_GROUPS) lines.push(`(ほか ${sorted.length - MAX_GROUPS} 種類)`, '');
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const site = opt('--site');
  const out = opt('--out');
  const ack = opt('--ack');
  const all = args.includes('--all');
  const base = process.env.TELEMETRY_URL ?? '';
  const token = process.env.TELEMETRY_TOKEN ?? '';
  if (!site) throw new Error('--site が要ります (matsue / hiroshima / fukuyama)');
  if (!base || !token) throw new Error('環境変数 TELEMETRY_URL と TELEMETRY_TOKEN が要ります');

  const url = (suffix, params) => {
    const u = new URL(base);
    u.pathname = u.pathname.replace(/\/$/, '') + suffix;
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u;
  };
  const call = async (u, init) => {
    const res = await fetch(u, { ...init, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${u.pathname}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.json();
  };

  if (ack !== undefined) {
    if (!/^\d+$/.test(ack)) throw new Error(`--ack には番号を渡してください (${JSON.stringify(ack)})`);
    const r = await call(url('/ack', { site, upto: ack }), { method: 'POST' });
    console.log(`${site}: ${r.notified} 番までを通知済みにしました`);
    return;
  }
  const r = await call(url('', all ? { site, since: 0 } : { site }));
  // last は GITHUB_OUTPUT を通って次のステップの --ack に渡るので、数でなければ止める
  // (改行などが混じると、ほかの出力を書き足せてしまう)
  if (!Number.isSafeInteger(r.last) || r.last < 0) throw new Error(`Worker の応答の last が番号ではない (${JSON.stringify(r.last)})`);
  // --all は通知済みの分も返すので、抜けを数えても意味が無い
  const dropped = all ? 0 : droppedCount(r);
  const { count, markdown } = summarize(r.records, dropped);
  console.log(`${site}: 記録 ${r.records.length} 件 (通知する件数 ${count}、うち消えた記録 ${dropped}、最後の番号 ${r.last}、通知済み ${r.notified})`);
  if (markdown) console.log(markdown);
  if (out) await writeFile(out, markdown);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `count=${count}\nlast=${r.last}\n`);
}

// tests/ から import されたときは実行しない
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
