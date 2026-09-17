// 画質プリセット — 公開環境では GPU が選べないので、自動判定 + 手動切り替えを持つ。
//
// 最大のコストは三角形数ではなくテクスチャ VRAM。4096px のアトラス 6 枚は
// 非圧縮 RGBA + ミップで約 511MB あり、内蔵 GPU や共有メモリ環境では破綻する。
// 2048px 版 (`*_2k.jpg`) に落とすと約 128MB、転送量も 15.3MB -> 3.2MB になる。

import { t } from './i18n';

export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityPreset {
  level: QualityLevel;
  label: string;
  /** アトラスを 2048px 版 (`_2k`) にする */
  halfAtlas: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** devicePixelRatio の上限 */
  maxPixelRatio: number;
  lod2: boolean;
  /** 霧・カメラの描画距離 */
  drawDistance: number;
}

const PRESETS: Record<QualityLevel, QualityPreset> = {
  high: {
    level: 'high', label: t('q.high'),
    halfAtlas: false, shadows: true, shadowMapSize: 2048,
    maxPixelRatio: 1.5, lod2: true, drawDistance: 4200,
  },
  medium: {
    level: 'medium', label: t('q.medium'),
    halfAtlas: true, shadows: true, shadowMapSize: 1024,
    maxPixelRatio: 1.0, lod2: true, drawDistance: 3000,
  },
  low: {
    level: 'low', label: t('q.low'),
    halfAtlas: true, shadows: false, shadowMapSize: 512,
    maxPixelRatio: 1.0, lod2: true, drawDistance: 2000,
  },
};

const STORAGE_KEY = 'mk.quality';

function isLevel(v: unknown): v is QualityLevel {
  return v === 'low' || v === 'medium' || v === 'high';
}

/**
 * GPU 名から妥当な既定値を推定する。判定できないときは medium。
 * 誤判定しても手動で変えられるので、迷ったら軽い側に倒す。
 */
export function detectLevel(): QualityLevel {
  // モバイルは VRAM も帯域も厳しい
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile) return 'low';

  let renderer = '';
  try {
    const cv = document.createElement('canvas');
    const gl = (cv.getContext('webgl2') || cv.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
      const lose = gl.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    }
  } catch {
    // WebGL が取れない環境ではどのみち動かないが、判定だけは落とさない
  }

  if (!renderer) return 'medium';
  const r = renderer.toLowerCase();
  // ソフトウェアラスタライザ
  if (/swiftshader|llvmpipe|software|basic render/.test(r)) return 'low';
  // 内蔵 GPU (Intel UHD/Iris/HD, AMD Vega 内蔵)
  if (/intel|uhd|iris|hd graphics|vega \d|radeon\(tm\) graphics/.test(r)) return 'medium';
  // 専用 GPU
  if (/nvidia|geforce|rtx|gtx|radeon (rx|pro)|apple m\d/.test(r)) return 'high';
  return 'medium';
}

/** URL パラメータ > localStorage > 自動判定 の順で決める */
export function resolveQuality(params: URLSearchParams): QualityPreset {
  const q = params.get('q');
  if (isLevel(q)) return PRESETS[q];

  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* プライベートモード等 */ }
  if (isLevel(saved)) return PRESETS[saved];

  return PRESETS[detectLevel()];
}

export function saveQuality(level: QualityLevel): void {
  try { localStorage.setItem(STORAGE_KEY, level); } catch { /* 保存できなくても動作は続く */ }
}

export function allPresets(): QualityPreset[] {
  return [PRESETS.high, PRESETS.medium, PRESETS.low];
}

/** アトラスのファイル名を画質に合わせて差し替える */
export function atlasFile(name: string, preset: QualityPreset): string {
  return preset.halfAtlas ? name.replace(/\.jpg$/, '_2k.jpg') : name;
}
