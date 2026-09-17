// 英語版のページ dist/en/index.html を書き出す (ビルド後に実行)
//   node tools/build_en_page.mjs [distDir]
//
// なぜ要るか:
//   X や Facebook のカードを作るクローラは JavaScript を実行しない。i18n.ts が
//   実行時に英語へ差し替えても、共有カードは日本語のままになる。検索も 1 つの URL に
//   2 言語が同居していると、どちらの言語のページとして出すか決めきれない。
//   そこで英語には実体のある URL (/en/) を与え、head だけ英語に差し替えて置く。
//
// やっていること: dist/index.html の <html lang> を en にして、SEO:ja のブロックを
// tools/seo-en.html の中身に差し替え、dist/en/index.html として書き出すだけ。
// 中身 (ゲーム本体) は同じファイルなので、二重管理にはならない。
// 画面の文言は src/i18n.ts の applyDomLang() が /en/ を見て英語にする。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(root, process.argv[2] ?? 'dist');
const src = path.join(dist, 'index.html');
const outDir = path.join(dist, 'en');
const out = path.join(outDir, 'index.html');

const BEGIN = '<!-- ==== SEO:ja ====';
const END = '<!-- ==== /SEO:ja ==== -->';

let html = readFileSync(src, 'utf8');
const en = readFileSync(path.join(root, 'tools', 'seo-en.html'), 'utf8').trimEnd();

const from = html.indexOf(BEGIN);
const to = html.indexOf(END);
if (from < 0 || to < 0) {
  console.error(`${src} に SEO:ja のブロックが見つかりません。index.html の目印コメントを消していませんか`);
  process.exit(1);
}
html = html.slice(0, from) + en.replace(/^\s+/, '') + html.slice(to + END.length);
html = html.replace(/<html lang="ja"/, '<html lang="en"');
if (!/<html lang="en"/.test(html)) {
  console.error('<html lang="ja"> が見つかりません');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(out, html);
console.log(`英語版を書き出しました: ${path.relative(root, out)}`);
