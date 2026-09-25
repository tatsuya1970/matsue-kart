---
workflow: product-launch-video
flow: automation
storyboard: no
message: "この街、全部走れる。— 実在の松江を全開で走るブラウザカートレース"
destination: x-feed
aspect: 1920x1080
language: ja
length: 30s
angle: sell
---

## Intent

SNS (X) に投稿する 30 秒・16:9 のかっこいいプロモ。題材はブラウザカートレース
「MATSUE KART 松江グランプリ」(https://tatsuya1970.github.io/matsue-kart/)。
選んだ案は「実在の松江を全開で走る」: ゲームの実走行映像をハイテンポでつなぎ、
地名看板 (松江駅 → 島根県庁 → 松江城 → 宍道湖大橋 → 宍道湖夕日スポット) ごとに
大きなキネティックタイポを重ねる。冒頭のフックは「この街、全部走れる。」。
締めは URL と「ブラウザで今すぐ・無料」。

## Assets

- ゲームの実走行クリップ — ローカルの開発サーバーを tools/record_clip.mjs で撮影 (1920x1080 / 30fps, HUD なし)
- 松江城天守 (PLATEAU LOD3) の空撮周回クリップ
- 宍道湖・嫁ヶ島・夕日の空撮クリップ
- public/ogp.png — タイトルの参考

## Customizations

- BGM のみ (ナレーションなし)。無音再生でも伝わるよう文字で見せる。

## Notes

- 事実として出してよい数字: 1 周 9.6km × 2 周 / 最大 8 人のオンライン対戦 / インストール不要 / PLATEAU 松江市 (2024) の 3D 都市モデル / 松江城天守は LOD3。
- 任天堂とは無関係。マリオカートの名前やロゴは出さない。
- 投稿文は X 向けに別途作る。
