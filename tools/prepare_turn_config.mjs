// 本番デプロイ用。TURN 設定を生成し、資格情報 API が実際に TURN server を返すか検査する。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apiHeaders, originFromCname, rejectStaticCredential, validateConfigUrl, validateTurnServers } from './turn_config.mjs';

const output = process.argv[2] ?? 'public/turn.json';
const configuredUrl = process.env.TURN_CONFIG_URL?.trim();
// 資格情報 API (workers/turn/) はサイトの Origin からの呼び出しだけ許可するので、同じ Origin を名乗る
// (出力先の隣を先に見て、無ければ public/CNAME。出力先を変えて試すときも名乗れるように)
const readCname = p => readFile(p, 'utf8').catch(() => '');
const siteOrigin = originFromCname(await readCname(path.join(path.dirname(output), 'CNAME')) || await readCname('public/CNAME'));

// 以前は secret TURN_CONFIG_JSON の ICE server 一覧をそのまま turn.json に書き出していたが、
// turn.json は配信されるので secret の資格情報が誰でも読める状態になる。受け付けない。
// (中身は読まない。JSON の読み取りエラーの文に secret の一部が出て、ログに残るため)
if (process.env.TURN_CONFIG_JSON?.trim()) {
  throw new Error('TURN_CONFIG_JSON は使えません (中身が public/turn.json として公開されるため)。secret を削除し、短期の資格情報を返す HTTPS API を TURN_CONFIG_URL に設定してください');
}

let publicConfig;
if (configuredUrl) {
  publicConfig = { url: validateConfigUrl(configuredUrl) };
} else {
  try {
    publicConfig = JSON.parse(await readFile(output, 'utf8'));
  } catch {
    throw new Error('TURN が未設定です。GitHub variable TURN_CONFIG_URL または secret TURN_CONFIG_JSON を設定してください');
  }
}

if (publicConfig?.url) {
  const url = validateConfigUrl(publicConfig.url);
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: apiHeaders(siteOrigin) });
  // 念のためログには場所だけ出す (validateConfigUrl が鍵付きの URL を止めているが、見落とし対策)
  const where = `${new URL(url).origin}${new URL(url).pathname}`;
  if (!res.ok) throw new Error(`TURN 設定 API が HTTP ${res.status} を返しました: ${where}${res.status === 403 && !siteOrigin ? ' (public/CNAME が無く Origin を名乗れない)' : ''}`);
  validateTurnServers(await res.json());
} else {
  validateTurnServers(rejectStaticCredential(publicConfig));
}

await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, `${JSON.stringify(publicConfig, null, 2)}\n`);
console.log(`TURN 設定を検証しました: ${output}`);
