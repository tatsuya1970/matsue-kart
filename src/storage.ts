/**
 * Storage はブラウザ設定、sandbox iframe、容量超過などでプロパティ参照自体が
 * SecurityError を投げることがある。設定の保存に失敗してもゲームは止めない。
 */
export function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): boolean {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
