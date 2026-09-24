// vite.config.ts の define で埋め込むビルドの識別 (コミットとビルド時刻)
declare const __BUILD__: { commit: string; time: string };

// ビルド時に渡す設定 (src/telemetry.ts)
interface ImportMetaEnv {
  readonly VITE_TELEMETRY_URL?: string;
}
