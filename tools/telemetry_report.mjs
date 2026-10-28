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
// --out のとき、GITHUB_OUTPUT があれば count (通知するエラーと消えた記録の件数) と last (最後の記録の番号) を書く。
// 定期監視 (.github/workflows/monitor.yml) は count が 0 でなければ Issue に足し、そのあと last で --ack する。
// 記録の中身は workers/turn/worker.js の cleanTelemetry が整えたもの (種類・内容・ビルド・画質・言語・パス・UA)。

import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

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

function show(pairs, n = 4) {
  const head = pairs.slice(0, n).map(([k, c]) => (c > 1 ? `${k} ×${c}` : String(k))).join(', ');
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
 * 返り値: { count: 通知するエラーと消えた記録の件数, markdown: 本文 (どちらも無ければ '') }
 */
export function summarize(records, dropped = 0) {
  const errors = records.filter(isErrorRecord);
  const others = records.filter(r => !isErrorRecord(r));
  if (!errors.length && !dropped) return { count: 0, markdown: '' };
  const lines = [];
  if (dropped) {
    lines.push(`通知する前に記録の上限 (サイトごとに 1,000 件) を超え、古い記録 ${dropped} 件が消えました。消えた分にエラーがあったかは分かりません。`, '');
  }
  if (errors.length) lines.push(...errorSection(errors));

  const parts = [];
  const ready = others.filter(r => r.kind === 'load' && r.event === 'ready').map(r => Number(r.data?.ms)).filter(Number.isFinite).sort((a, b) => a - b);
  if (ready.length) parts.push(`読み込み完了 ${ready.length} 件 (中央値 ${(ready[Math.floor(ready.length / 2)] / 1000).toFixed(1)} 秒)`);
  for (const [event, c] of tally(others.filter(r => r.kind === 'net').map(r => r.event))) parts.push(`net ${event} ${c} 件`);
  const noGl = others.filter(r => r.kind === 'gl').length;
  if (noGl) parts.push(`WebGL が使えない環境 ${noGl} 件`);
  if (parts.length) lines.push(`同じ期間のほかの記録: ${parts.join('、')}`);

  return { count: errors.length + dropped, markdown: lines.join('\n').trimEnd() + '\n' };
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

  const lines = [`利用者のブラウザで ${sorted.length} 種類のエラーが起きました (記録 ${errors.length} 件${span})。`, ''];
  sorted.slice(0, MAX_GROUPS).forEach((g, i) => {
    const items = g.items;
    lines.push(`### ${i + 1}. ${g.key} — ${items.length} 件`);
    lines.push(`- 版: ${show(tally(items.map(r => r.build ?? '?')))} / 画質: ${show(tally(items.map(r => r.quality ?? '?')))} / 言語: ${show(tally(items.map(r => r.lang ?? '?')))}`);
    lines.push(`- パス: ${show(tally(items.map(r => r.path ?? '?')))}`);
    lines.push(`- ブラウザ: ${show(tally(items.map(r => browserOf(r.ua))))}`);
    const where = tally(items.map(r => r.data?.where).filter(Boolean));
    if (where.length) lines.push(`- 場所: ${show(where, 2)}`);
    const stack = items.map(r => r.data?.stack).find(s => typeof s === 'string' && s);
    if (stack) lines.push('```', stack.split('\n').slice(0, 8).join('\n'), '```');
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
    const r = await call(url('/ack', { site, upto: ack }), { method: 'POST' });
    console.log(`${site}: ${r.notified} 番までを通知済みにしました`);
    return;
  }
  const r = await call(url('', all ? { site, since: 0 } : { site }));
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
