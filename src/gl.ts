// WebGL を作れないとき・失ったときの見立て (Issue #3)。DOM に触るのは呼ばれたときだけ (試験から読み込めるように)

/** 端末のメモリ (GB)。Chrome 系だけが出す。原因の手がかりとして記録に添える */
export function deviceMemory(): number | undefined {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof mem === 'number' ? mem : undefined;
}

/**
 * WebGL1 なら作れるか。three.js は WebGL2 しか使わないので、WebGL2 を作れなかったときに
 * 「端末かブラウザが WebGL2 だけを止めている」のか「WebGL 自体が使えない」のかを見分ける。
 * ゲームの canvas に触らないよう別の canvas で試し、作れたらすぐ手放す
 */
export function canCreateWebGL1(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export interface GlEnv {
  /** WebGL2RenderingContext があるか (無ければブラウザが古い) */
  webgl2Api: boolean;
  /** タッチが主の端末か (スマホ・タブレット) */
  mobile: boolean;
  /** アプリ内ブラウザか (src/net.ts の inAppBrowser) */
  inApp: boolean;
}

/**
 * WebGL を作れなかったときの直し方 (i18n のキー)。試してほしい順に並べる。
 * 読み込み直すだけでは直らないことが多い: スマホはメモリ不足か、GPU の不調でブラウザが
 * このサイトの WebGL を止めている (ブラウザを開き直すまで続く)。PC はハードウェア
 * アクセラレーションが切れているか、ドライバが古くてブラウザが GPU を使わない
 */
export function glUnavailableTips(env: GlEnv): string[] {
  if (!env.webgl2Api) return ['gl.tip.oldBrowser'];
  if (env.mobile) return ['gl.tip.closeApps', 'gl.tip.restartMobile', env.inApp ? 'gl.tip.openInBrowser' : 'gl.tip.update'];
  return ['gl.tip.hwAccel', 'gl.tip.driver', 'gl.tip.otherBrowser'];
}
