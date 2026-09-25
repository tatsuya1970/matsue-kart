// 監視の結果を GitHub の Issue で知らせる (作る・開いている Issue に足す・復旧で閉じる)
//
//   node tools/alert_issue.mjs open  --title "本番の外形監視が失敗しています" --text "…" [--body-file x.md] [--log site.log] [--run <実行の URL>]
//        # 同じ題の Issue が開いていればコメントを足し、無ければ作る
//   node tools/alert_issue.mjs close --title "本番の外形監視が失敗しています" --text "復旧しました" [--run <実行の URL>]
//        # 同じ題の Issue が開いていればコメントして閉じる (無ければ何もしない)
//
// 環境変数: GITHUB_TOKEN、GITHUB_REPOSITORY (GitHub Actions が渡す。permissions に issues: write が要る)
// Issue はリポジトリの持ち主を担当者にし、本文の先頭で @メンションする。持ち主がリポジトリを Watch して
// いなくても、担当とメンションの通知は届く (GitHub の通知設定「Participating」がメールなら、メールで)。
// 通知の Issue には LABEL を付けて、ほかの Issue と区別する (無ければ作る)。

import { readFile } from 'node:fs/promises';
import { jst } from './telemetry_report.mjs';

const LABEL = 'monitor';
const LABEL_COLOR = 'd93f0b';
/** --log で添えるログの末尾の行数 */
const LOG_TAIL = 60;
/** 本文の上限 (GitHub は 65536 文字まで) */
const MAX_BODY = 60000;

const args = process.argv.slice(2);
const command = args[0];
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const title = opt('--title');
const text = opt('--text') ?? '';
const bodyFile = opt('--body-file');
const logFile = opt('--log');
const run = opt('--run');

const repo = process.env.GITHUB_REPOSITORY ?? '';
const token = process.env.GITHUB_TOKEN ?? '';
const owner = repo.split('/')[0];

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

/** 同じ題で開いている通知の Issue */
async function findOpen() {
  const list = await api('GET', `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100`);
  return list.find(i => i.title === title && !i.pull_request);
}

async function ensureLabel() {
  try {
    await api('POST', `/repos/${repo}/labels`, { name: LABEL, color: LABEL_COLOR, description: '本番の監視からの通知' });
  } catch (e) {
    if (!/HTTP 422/.test(String(e))) throw e;   // 422 = もうある
  }
}

async function buildBody() {
  const parts = [`@${owner} ${text}`.trim()];
  if (bodyFile) parts.push((await readFile(bodyFile, 'utf8')).trim());
  if (logFile) {
    const lines = (await readFile(logFile, 'utf8')).trimEnd().split('\n');
    parts.push(['```', ...lines.slice(-LOG_TAIL), '```'].join('\n'));
  }
  if (run) parts.push(`実行: ${run}`);
  parts.push(`(${jst(Date.now())} JST)`);
  return parts.filter(Boolean).join('\n\n').slice(0, MAX_BODY);
}

async function main() {
  if (!['open', 'close'].includes(command)) throw new Error('使い方: alert_issue.mjs open|close --title <題> [--text …] [--body-file …] [--log …] [--run …]');
  if (!title) throw new Error('--title が要ります');
  if (!repo || !token) throw new Error('環境変数 GITHUB_REPOSITORY と GITHUB_TOKEN が要ります');

  if (command === 'open') {
    await ensureLabel();
    const body = await buildBody();
    const open = await findOpen();
    if (open) {
      await api('POST', `/repos/${repo}/issues/${open.number}/comments`, { body });
      console.log(`コメントを足しました: ${open.html_url}`);
    } else {
      const created = await api('POST', `/repos/${repo}/issues`, { title, body, labels: [LABEL], assignees: [owner] });
      console.log(`Issue を作りました: ${created.html_url}`);
    }
    return;
  }
  const open = await findOpen();
  if (!open) { console.log(`開いている Issue「${title}」は無いので何もしません`); return; }
  await api('POST', `/repos/${repo}/issues/${open.number}/comments`, { body: await buildBody() });
  await api('PATCH', `/repos/${repo}/issues/${open.number}`, { state: 'closed', state_reason: 'completed' });
  console.log(`閉じました: ${open.html_url}`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
