// アセットの取得 — 状態の確認・時間切れ・再試行をまとめる
//
// fetch() は 404 でも例外にならない。GitHub Pages の 404 は HTML なので、そのまま
// .json() に渡すと SyntaxError、.arrayBuffer() だと HTML のバイト列を地形として
// 読んでしまう。モバイル回線で途中で止まった通信も、時間切れが無いと永遠に待つ。
// 時間切れは本文を読み終えるまでに掛ける (ヘッダーが届いた後で止まることもある)。

export interface FetchOptions {
  /** 1 回の試行の上限 (本文を読み終えるまで)。既定 60 秒: 低速回線で 3MB 級のアトラスを読む想定 */
  timeoutMs?: number;
  /** 失敗したときの再試行回数 (初回を含まない) */
  retries?: number;
  /** 再試行の待ち時間の基準 (ミリ秒)。1 回目はこの値、以降 2 倍ずつ */
  backoffMs?: number;
  cache?: RequestCache;
}

export class FetchError extends Error {
  /**
   * @param status HTTP の状態コード (時間切れなどは 0)
   * @param body HTTP エラーのときの本文の先頭。API が返す理由を読むため
   *   (workers/turn/ が 1 日の上限で返す { "error": "daily_cap" } など)
   */
  constructor(message: string, readonly url: string, readonly status = 0, readonly body = '') {
    super(message);
    this.name = 'FetchError';
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * 取得して read で読み、validate で中身を確かめる。どこで失敗しても再試行する。
 * 再試行ではブラウザのキャッシュを通さない (壊れた・古い組み合わせをキャッシュから
 * 読み直しても直らないため)。
 */
export async function fetchWith<T>(
  url: string,
  read: (res: Response) => Promise<T>,
  opt: FetchOptions & { validate?: (v: T) => void } = {},
): Promise<T> {
  const { timeoutMs = 60000, retries = 2, backoffMs = 800, validate } = opt;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: attempt > 0 ? 'reload' : opt.cache });
      if (!res.ok) throw new FetchError(`HTTP ${res.status}: ${url}`, url, res.status, (await res.text().catch(() => '')).slice(0, 1000));
      const v = await read(res);
      validate?.(v);
      return v;
    } catch (e) {
      lastErr = ctrl.signal.aborted ? new FetchError(`timeout ${timeoutMs}ms: ${url}`, url) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export function fetchJson<T>(url: string, opt: FetchOptions & { validate?: (v: T) => void } = {}): Promise<T> {
  return fetchWith(url, res => res.json() as Promise<T>, opt);
}

/** 画像などの Blob を、JSON・バイナリと同じタイムアウト/再試行方針で取得する。 */
export function fetchBlob(url: string, opt: FetchOptions = {}): Promise<Blob> {
  return fetchWith(url, res => res.blob(), opt);
}

/** バイナリを取る。minBytes に満たなければ壊れている (途中で切れた・版の違う組) とみなして再試行する */
export function fetchBuffer(url: string, minBytes = 0, opt: FetchOptions = {}): Promise<ArrayBuffer> {
  return fetchWith(url, res => res.arrayBuffer(), {
    ...opt,
    validate: buf => {
      if (buf.byteLength < minBytes) throw new FetchError(`short body ${buf.byteLength} < ${minBytes}: ${url}`, url);
    },
  });
}
