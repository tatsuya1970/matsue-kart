import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

/**
 * ビルドの識別 (タイトル画面の隅に出す)。
 * 配信後も古いページがキャッシュに残ることがあり、古い側は新しい側の「対戦待ち」を
 * 読めない。どの版が動いているかを画面で見分けられるようにしておく。
 */
function buildInfo(): { commit: string; time: string } {
  let commit = 'dev';
  try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* git が無い環境 */ }
  return { commit, time: new Date().toISOString() };
}

// GitHub Pages のプロジェクトページは /matsue-kart/ 配下で配信されるため
// base が要る。command で分岐すると `vite preview` が 'serve' 扱いになり、
// ビルド成果物を root で配信してしまって検証にならないので環境変数で渡す。
//   BASE_PATH=/matsue-kart/ npm run build && BASE_PATH=/matsue-kart/ npm run preview
// 開発サーバーは既定 (/) のまま。
// public/ 配下のアセットは src/geo.ts の assetUrl() が BASE_URL を見て解決する。
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  define: { __BUILD__: JSON.stringify(buildInfo()) },
  server: { port: 5182, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
