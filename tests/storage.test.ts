import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageGet, storageSet } from '../src/storage';

afterEach(() => vi.unstubAllGlobals());

describe('safe storage', () => {
  it('Storage へのアクセスが拒否されても既定値へ退避する', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('denied', 'SecurityError'); },
      setItem: () => { throw new DOMException('denied', 'SecurityError'); },
    });
    expect(storageGet('x')).toBeNull();
    expect(storageSet('x', '1')).toBe(false);
  });

  it('読み書きできる場合は値を保存する', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    expect(storageSet('x', '1')).toBe(true);
    expect(storageGet('x')).toBe('1');
  });
});
