// 本番で起きたことの記録 (telemetry) に入る文から、鍵・トークン・個人の情報になりうる部分を伏せる。
// ページ (src/telemetry.ts) と Worker (worker.js の cleanTelemetry) が同じものを使う。
// 送り主はブラウザなので、ページで伏せても改造したページは伏せずに送れる。Worker でも伏せて、
// 保存する記録と、定期監視が公開の Issue に貼る文 (tools/telemetry_report.mjs) に残さない。

/**
 * URL のクエリとフラグメント (?apiKey=... #token=...)、URL に書いた利用者名とパスワード、
 * メールアドレスらしきものを伏せる。スタックの「関数名@https://...」(Firefox・Safari) は
 * @ の後ろが URL なので、メールアドレスとはみなさない
 */
export function redactText(s) {
  return String(s)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#'"<>]*)[?#][^\s'"<>)]*/gi, '$1?…')
    .replace(/\/\/[^\s/@'"<>]+@/g, '//…@')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>');
}
