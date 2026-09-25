// 各フレームの Google Fonts 読み込みを、assets/fonts/ のローカルフォントの @font-face に置き換える
//   node audio/localize_fonts.mjs
// レンダリング環境にネットワークや日本語フォントが無くても、同じ書体で描かれるようにする。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const FACES = `
      @font-face { font-family: "Noto Sans JP"; src: url("assets/fonts/NotoSansJP-VF.ttf") format("truetype"); font-weight: 100 900; font-style: normal; font-display: block; }
      @font-face { font-family: "IBM Plex Mono"; src: url("assets/fonts/IBMPlexMono-Medium.ttf") format("truetype"); font-weight: 500; font-style: normal; font-display: block; }
      @font-face { font-family: "IBM Plex Mono"; src: url("assets/fonts/IBMPlexMono-SemiBold.ttf") format("truetype"); font-weight: 600; font-style: normal; font-display: block; }
      @font-face { font-family: "Barlow"; src: url("assets/fonts/Barlow-BlackItalic.ttf") format("truetype"); font-weight: 900; font-style: italic; font-display: block; }
      @font-face { font-family: "Barlow"; src: url("assets/fonts/Barlow-Bold.ttf") format("truetype"); font-weight: 700; font-style: normal; font-display: block; }
`;

const dir = 'compositions/frames';
for (const f of readdirSync(dir).filter(n => n.endsWith('.html'))) {
  const p = `${dir}/${f}`;
  let s = readFileSync(p, 'utf8');
  const before = s;
  // <link rel="preconnect" ...> と Google Fonts の <link rel="stylesheet" ...> (複数行も) を消す
  s = s.replace(/[ \t]*<link\b[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>\s*\n?/g, '');
  s = s.replace(/[ \t]*<link\b(?:[^>](?!fonts\.))*?[^>]*?href="https:\/\/fonts\.googleapis\.com[^"]*"[^>]*>\s*\n?/gs, '');
  // @import url("https://fonts.googleapis.com/...");
  s = s.replace(/[ \t]*@import url\(["']?https:\/\/fonts\.googleapis\.com[^)]*\)\s*;\s*\n?/g, '');
  if (!s.includes('assets/fonts/NotoSansJP-VF.ttf')) {
    s = s.replace(/<style([^>]*)>/, (m) => `${m}${FACES}`);
  }
  if (s.includes('fonts.googleapis.com')) console.log(`!! ${f}: Google Fonts の参照が残っています`);
  if (s !== before) { writeFileSync(p, s); console.log(`${f}: ローカルフォントに置き換えました`); }
}
