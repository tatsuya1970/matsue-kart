// ゴールタイムのランキング — ゴール後のリザルト画面で名前を入れて登録する
//
// 記録は workers/turn/ の Worker (/ranking) がサイトごとに保存する。送り先はビルド時の
// VITE_RANKING_URL (GitHub Actions ではリポジトリ変数 RANKING_URL)。未設定ならランキングは出さない。
// サイト (松江・広島・福山) は Worker が Origin から決めるので、ここでは送らない。
//
// タイムはブラウザで計算しているので、改造すれば速いタイムを送れてしまう。Worker は
// ありえない速さを拒否するだけで、正しさまでは確かめられない (worker.js の説明)。
// デバッグ用の URL (?debug=1, ?steps=, ?ai=1 など) で走ったときは登録させない。

import { t } from './i18n';

const ENDPOINT: string = import.meta.env.VITE_RANKING_URL ?? '';
/** リザルト画面に出す件数 */
const SHOW = 10;

export interface RankEntry { id: string; name: string; time: number; at: number }
export interface SubmitResult { id: string; rank: number | null; entries: RankEntry[] }

export function rankingEnabled(): boolean {
  return !!ENDPOINT;
}

/** 普通に走った記録か (デバッグ・撮影用の URL で走ったものは登録しない) */
export function eligibleRun(search: string): boolean {
  const q = new URLSearchParams(search);
  return !['debug', 'steps', 'ai', 'rec', 'photo', 'idx', 'wp'].some(k => q.has(k));
}

/** 画面に出す前に名前を整える (Worker と同じ規則: 制御文字を除き、10 文字に切る) */
export function cleanName(v: string): string {
  const bad = (c: number) => c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
  const s = [...v.normalize('NFC')].filter(ch => !bad(ch.codePointAt(0)!)).join('').trim();
  return [...s].slice(0, 10).join('');
}

export function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(2).padStart(5, '0')}`;
}

async function call(init?: RequestInit): Promise<unknown> {
  const res = await fetch(ENDPOINT, { ...init, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchTop(): Promise<RankEntry[]> {
  const r = await call() as { entries?: RankEntry[] };
  return Array.isArray(r.entries) ? r.entries : [];
}

export async function submitTime(name: string, time: number): Promise<SubmitResult> {
  return await call({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, time }) }) as SubmitResult;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** 一覧を描く。名前は textContent で入れる (HTML として解釈させない) */
function renderList(entries: RankEntry[], mine: string | null): void {
  const list = byId<HTMLOListElement>('rankList');
  list.replaceChildren();
  for (const [i, e] of entries.slice(0, SHOW).entries()) {
    const li = document.createElement('li');
    if (e.id === mine) li.className = 'mine';
    const rank = document.createElement('span'); rank.className = 'rk'; rank.textContent = String(i + 1);
    const name = document.createElement('span'); name.className = 'nm'; name.textContent = e.name;
    const time = document.createElement('span'); time.className = 'tm'; time.textContent = formatTime(e.time);
    li.append(rank, name, time);
    list.append(li);
  }
  byId('rankEmpty').style.display = entries.length ? 'none' : '';
}

/**
 * リザルト画面にランキングを出す。登録できる記録なら名前の入力欄も出す。
 * @param time 自分のゴールタイム (秒)
 * @param name 入力欄の初期値 (対戦で使っている名前)
 * @param canSubmit 登録してよい記録か (eligibleRun)
 * @param onName 登録した名前を覚えておく (次回の初期値・対戦の名前)
 */
export function showRanking(opts: { time: number; name: string; canSubmit: boolean; onName(name: string): void }): void {
  if (!rankingEnabled()) return;
  const box = byId('rankBox');
  const form = byId('rankForm');
  const input = byId<HTMLInputElement>('rankName');
  const button = byId<HTMLButtonElement>('rankSubmit');
  const msg = byId('rankMsg');
  box.style.display = '';
  form.style.display = opts.canSubmit ? '' : 'none';
  input.value = opts.name;
  msg.textContent = opts.canSubmit ? t('rank.prompt', formatTime(opts.time)) : '';
  void fetchTop().then(e => renderList(e, null)).catch(() => { msg.textContent = t('rank.loadFailed'); });

  let sent = false;
  const send = async () => {
    if (sent) return;
    const name = cleanName(input.value);
    if (!name) { input.focus(); return; }
    sent = true;
    button.disabled = true; input.disabled = true;
    msg.textContent = t('rank.sending');
    try {
      const r = await submitTime(name, opts.time);
      opts.onName(name);
      renderList(r.entries, r.id);
      form.style.display = 'none';
      msg.textContent = r.rank ? t('rank.done', r.rank) : t('rank.doneOut');
    } catch {
      sent = false;
      button.disabled = false; input.disabled = false;
      msg.textContent = t('rank.failed');
    }
  };
  button.onclick = () => void send();
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); void send(); } };
}
