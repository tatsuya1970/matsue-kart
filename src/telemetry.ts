// 本番で起きたことを知るための最小限の記録 (例外・読み込みの失敗・対戦の成否)
//
// サーバーが無いので、送り先はビルド時の VITE_TELEMETRY_URL で渡す
// (GitHub Actions ではリポジトリ変数 TELEMETRY_URL)。未設定なら送らず、
// ページ内に直近の記録を残すだけ (window.__telemetry() で見られる)。
// 送るのは種類・内容・ビルド・画質・言語・パス・UA だけで、名前や peer ID は送らない。

type Kind = 'error' | 'load' | 'net' | 'gl';

export interface TelemetryRecord {
  kind: Kind;
  event: string;
  data: Record<string, unknown>;
  /** ページを開いてからのミリ秒 */
  at: number;
}

const ENDPOINT: string = import.meta.env.VITE_TELEMETRY_URL ?? '';
/** 1 ページあたりの送信上限 (同じ例外が毎フレーム出ても送り続けないように) */
const MAX_SENDS = 30;
const KEEP = 50;

const records: TelemetryRecord[] = [];
const seen = new Set<string>();
let sends = 0;
const context: Record<string, unknown> = {};

/** すべての記録に添える情報 (画質など、決まった時点で足す) */
export function setTelemetryContext(extra: Record<string, unknown>): void {
  Object.assign(context, extra);
}

export function report(kind: Kind, event: string, data: Record<string, unknown> = {}): void {
  const rec: TelemetryRecord = { kind, event, data, at: Math.round(performance.now()) };
  records.push(rec);
  if (records.length > KEEP) records.shift();
  if (!ENDPOINT || sends >= MAX_SENDS) return;
  // 同じ内容は 1 回だけ送る
  const key = `${kind}:${event}:${String(data.message ?? '')}`;
  if (seen.has(key)) return;
  seen.add(key);
  sends++;
  const body = JSON.stringify({
    ...rec,
    build: __BUILD__.commit,
    path: location.pathname,
    ua: navigator.userAgent,
    ...context,
  });
  try {
    const blob = new Blob([body], { type: 'text/plain' });   // text/plain なら CORS の事前確認が要らない
    if (!navigator.sendBeacon?.(ENDPOINT, blob)) void fetch(ENDPOINT, { method: 'POST', body, keepalive: true, mode: 'no-cors' }).catch(() => {});
  } catch { /* 記録の失敗でゲームを止めない */ }
}

/** URL からクエリとフラグメントを除く (URL でなければそのまま) */
export function stripQuery(u: string): string {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname}`;
  } catch {
    return u.replace(/[?#].*$/, '');
  }
}

const errorData = (e: unknown): Record<string, unknown> => {
  if (e instanceof Error) return { message: e.message.slice(0, 300), name: e.name, stack: (e.stack ?? '').slice(0, 1500) };
  return { message: String(e).slice(0, 300) };
};

export function reportError(event: string, e: unknown): void {
  report('error', event, errorData(e));
}

/** 捕まえ損ねた例外も拾う。できるだけ早く (main の前に) 呼ぶ */
export function installErrorHandlers(): void {
  addEventListener('error', e => {
    // スクリプトや画像の読み込み失敗は ErrorEvent ではなく、target が要素になる
    const target = e.target as HTMLElement | null;
    if (target && target !== (window as unknown as HTMLElement) && 'src' in target) {
      // 送るのは場所 (オリジン + パス) だけ。クエリやフラグメントに鍵が付いていても送らない
      report('load', 'resource', { message: stripQuery(String((target as HTMLScriptElement).src)) });
      return;
    }
    report('error', 'uncaught', { ...errorData(e.error ?? e.message), where: `${e.filename}:${e.lineno}:${e.colno}` });
  }, true);
  addEventListener('unhandledrejection', e => reportError('unhandledrejection', e.reason));
  (window as unknown as Record<string, unknown>).__telemetry = () => records.slice();
}
