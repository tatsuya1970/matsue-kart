// 言語別のページを仕上げる (ビルド後に実行)
//   node tools/build_en_page.mjs [distDir]
//
// なぜ要るか:
//   X や Facebook のカードを作るクローラは JavaScript を実行しない。i18n.ts が
//   実行時に英語へ差し替えても、共有カードは日本語のままになる。検索も 1 つの URL に
//   2 言語が同居していると、どちらの言語のページとして出すか決めきれない。
//   そこで英語には実体のある URL (/en/) を与え、head と本文の一部を英語にして置く。
//
// やっていること:
//   - dist/index.html (日本語) から、英語の紹介文 (ABOUT:en) を取り除いて書き戻す。
//   - dist/en/index.html (英語) を書き出す。<html lang> を en にし、SEO:ja のブロックを
//     tools/seo-en.html の中身に差し替え、日本語の紹介文 (ABOUT:ja) を取り除き、
//     data-en を持つ単純な要素 (中に子要素が無いもの) の文言を英語にしておく。
// 中身 (ゲーム本体) は同じファイルなので、二重管理にはならない。
// 残りの画面の文言は src/i18n.ts の applyDomLang() が /en/ を見て英語にする。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(root, process.argv[2] ?? 'dist');
const src = path.join(dist, 'index.html');
const outDir = path.join(dist, 'en');
const out = path.join(outDir, 'index.html');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/** `<!-- ==== NAME ====` から `<!-- ==== /NAME ==== -->` までを replacement に置き換える */
function replaceBlock(html, name, replacement, { optional = false } = {}) {
  const begin = `<!-- ==== ${name} ====`;
  const end = `<!-- ==== /${name} ==== -->`;
  const from = html.indexOf(begin);
  const to = html.indexOf(end);
  if (from < 0 && to < 0 && optional) return html;
  if (from < 0 || to < 0) fail(`${src} に ${name} のブロックが見つかりません。index.html の目印コメントを消していませんか`);
  return html.slice(0, from) + replacement + html.slice(to + end.length);
}

const html = readFileSync(src, 'utf8');

// 日本語版。2 回実行しても壊れないよう、すでに取り除いてあれば何もしない
writeFileSync(src, replaceBlock(html, 'ABOUT:en', '', { optional: true }));

// 英語版
const seoEn = readFileSync(path.join(root, 'tools', 'seo-en.html'), 'utf8').trim();
let en = replaceBlock(html, 'SEO:ja', seoEn);
en = replaceBlock(en, 'ABOUT:ja', '');
en = en.replace(/<html lang="ja"/, '<html lang="en"');
if (!/<html lang="en"/.test(en)) fail('<html lang="ja"> が見つかりません');
// 見出し (h2) など、中に子要素を持たない data-en の要素だけを静的に英語へ。
// 属性値はエスケープ済みなので、そのまま本文に入れてよい
en = en.replace(/(<(\w+)\b[^>]*\sdata-en="([^"]*)"[^>]*>)[^<]*(<\/\2>)/g, (_, open, _tag, text, close) => open + text + close);

mkdirSync(outDir, { recursive: true });
writeFileSync(out, en);
console.log(`言語別のページを書き出しました: ${path.relative(root, src)} / ${path.relative(root, out)}`);
