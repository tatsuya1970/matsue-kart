/** TURN 設定の構造を検査し、STUN だけの設定を誤って本番へ出さない。 */
export function iceServersFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.iceServers)) return value.iceServers;
  return [];
}

export function hasTurnServer(value) {
  return iceServersFrom(value).some(server => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some(url => typeof url === 'string' && /^turns?:/i.test(url));
  });
}

export function validateTurnServers(value) {
  if (!hasTurnServer(value)) throw new Error('TURN 設定に turn: または turns: の ICE server がありません');
  return value;
}

/** クエリの名前がこれに当たれば鍵とみなす (apiKey, api_key, token, secret, ...) */
const SECRET_PARAM = /key|token|secret|credential|password|auth/i;

/**
 * URL のクエリに鍵らしきものが入っていればその名前を返す。
 * turn.json は配信されて誰でも読めるので、URL に鍵を付けると鍵ごと公開される
 * (metered.ca の ?apiKey=... がこの形)。鍵は workers/turn/ の Worker に持たせる。
 */
export function secretParamIn(value) {
  for (const name of new URL(value).searchParams.keys()) if (SECRET_PARAM.test(name)) return name;
  return '';
}

export function validateConfigUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('TURN 設定 API は https: でなければなりません');
  const param = secretParamIn(url);
  if (param) {
    throw new Error(`TURN 設定 API の URL にクエリ ${param} が付いています。turn.json は配信されて誰でも読めるので、URL に入れた鍵も公開されます。鍵は workers/turn/ の Worker に持たせ、その URL を TURN_CONFIG_URL に設定してください`);
  }
  return url.toString();
}

/** public/CNAME の中身 (例: matsue.citykart.jp) からサイトの Origin を作る。無ければ '' */
export function originFromCname(text) {
  const host = String(text ?? '').trim().split(/\s+/)[0];
  return host ? `https://${host}` : '';
}

/**
 * 資格情報 API を呼ぶときのヘッダー。Worker は Origin を見て許可するので、
 * デプロイ前の検査や定期監視 (ブラウザではない) からもサイトの Origin を名乗る。
 */
export function apiHeaders(origin) {
  const headers = { accept: 'application/json' };
  if (origin) headers.origin = origin;
  return headers;
}

/**
 * 資格情報 (username / credential) を直接書いた設定か。turn.json は静的サイトに置かれ
 * 誰でも読めるので、固定の資格情報を入れると第三者に TURN を使われてしまう。
 */
export function hasStaticCredential(value) {
  return iceServersFrom(value).some(server => server && (server.username !== undefined || server.credential !== undefined));
}

export function rejectStaticCredential(value) {
  if (hasStaticCredential(value)) {
    throw new Error('turn.json に TURN の資格情報 (username / credential) を直接書くと、配信先で誰でも読めます。短期の資格情報を返す HTTPS API を TURN_CONFIG_URL に設定してください');
  }
  return value;
}
