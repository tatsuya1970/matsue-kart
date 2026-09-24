// ランキングの名前に使えない言葉。ページ (src/ranking.ts) と Worker (worker.js) の両方が使う。
//
// 比べる前に名前をそろえる (normalizeForNg): 全角→半角 (NFKC)、大文字→小文字、カタカナ→ひらがな、
// 空白・記号を除く、よくある当て字 (0→o, 1→i, 3→e, 4→a, 5→s, @→a, $→s) を戻す。
// これで「ＳＥＸ」「s e x」「セックス」「s3x」なども同じに扱える。
//
// 限界: 一覧に無い言い換えや、ひらがなとカタカナ以外の当て字はすり抜ける。
// すり抜けたものは管理用の削除 (README のランキングの節) で消す。
// 短い語や普通の言葉の一部になりうる語は、名前全体が一致したときだけ弾く (EXACT)。
// たとえば "rape" を部分一致にすると "grape" まで弾いてしまう。

/** 名前のどこかに含まれていたら弾く (そろえた後の形で書く) */
const CONTAINS = [
  // 暴力・脅し
  '死ね', '殺す', 'ころす', 'ぶっころ', '殺害',
  // 差別・侮辱
  'きちがい', '基地外', '気違い', 'がいじ', 'かたわ', 'めくら', 'つんぼ', '部落民', 'ちょんこ', 'ちゃんころ',
  // 性的な言葉
  'ちんこ', 'ちんぽ', 'まんこ', 'せっくす', '性交', '強姦', 'れいぷ', 'おっぱい', 'ふぇら', 'ぱいずり', 'ぱいぱん',
  'なかだし', '中出し', '援交', '売春', '痴漢', '精子', 'あなる', 'おなに', '自慰', 'えろ動画', 'av女優', 'ぽるの',
  // 英語
  'fuck', 'shit', 'bitch', 'cunt', 'nigg', 'fagg', 'penis', 'vagina', 'porn', 'whore', 'slut', 'hitler', 'rapist', 'pussy', 'dildo', 'blowjob', 'motherf',
];

/** 名前全体がこれと一致したときだけ弾く */
const EXACT = [
  'しね', 'ばか', 'あほ', 'かす', 'ぶす', 'でぶ', 'くず', 'ごみ', 'ちょん', 'えろ', 'うんこ', 'ちんちん',
  'sex', 'ass', 'dick', 'cock', 'rape', 'kill', 'die', 'fag', 'tits', 'boobs', 'anal', 'cum', 'nazi', 'nazis',
];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

/** 比べるための形にそろえる */
export function normalizeForNg(name) {
  const s = String(name ?? '').normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    // カタカナ (ァ〜ヶ) をひらがなへ
    if (c >= 0x30a1 && c <= 0x30f6) { out += String.fromCodePoint(c - 0x60); continue; }
    if (ch in LEET) { out += LEET[ch]; continue; }
    // 文字 (かな・漢字・英字) と数字だけ残す。空白・記号・長音 (ー) は捨てる
    if (/[\p{L}\p{N}]/u.test(ch)) out += ch;
  }
  return out;
}

/** 使えない名前か */
export function isNgName(name) {
  const n = normalizeForNg(name);
  if (!n) return false;
  if (EXACT.includes(n)) return true;
  return CONTAINS.some(w => n.includes(w));
}
