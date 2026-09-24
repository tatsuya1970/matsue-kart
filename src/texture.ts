import * as THREE from 'three';
import { fetchBlob, type FetchOptions, FetchError } from './fetch';

export interface TextureLoadOptions extends FetchOptions {
  /** Blob 取得後の画像デコード上限。Object URL の読み込みも無期限には待たない。 */
  decodeTimeoutMs?: number;
}

/**
 * THREE.TextureLoader は通信タイムアウトを持たないため、先に fetch で全本文を取得する。
 * Blob のデコードにも別の上限を設け、壊れた画像やブラウザの停止でロード全体が
 * 永久に待たされないようにする。
 */
export async function loadTexture(url: string, opt: TextureLoadOptions = {}): Promise<THREE.Texture> {
  const { decodeTimeoutMs = 15000, ...fetchOpt } = opt;
  const blob = await fetchBlob(url, { timeoutMs: 30000, retries: 1, ...fetchOpt });
  const objectUrl = URL.createObjectURL(blob);
  const loader = new THREE.TextureLoader();
  let timer = 0;
  try {
    return await new Promise<THREE.Texture>((resolve, reject) => {
      timer = globalThis.setTimeout(
        () => reject(new FetchError(`image decode timeout ${decodeTimeoutMs}ms: ${url}`, url)),
        decodeTimeoutMs,
      );
      loader.load(objectUrl, resolve, undefined, reject);
    });
  } finally {
    clearTimeout(timer);
    URL.revokeObjectURL(objectUrl);
  }
}
