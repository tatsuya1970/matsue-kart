#!/usr/bin/env bash
# プロモ動画用のゲーム走行クリップをまとめて撮る (kart-matsue のルートで実行)
#   bash videos/matsue-kart-promo/capture/record_all.sh
# 開発サーバー (PORT=5182) が起動している必要がある。
# 看板の位置 (data/course_path.json の labels.idx) から、助走 4 秒 (約 62 サンプル) +
# 1.2 秒 (約 35 サンプル) 手前に置いて、クリップの序盤で看板の下を通るようにする。
set -e
OUT=videos/matsue-kart-promo/capture/assets/videos
C="debug=1&ai=1&camk=3"
rec() { node tools/record_clip.mjs "$OUT/$1.mp4" "$2" "$3" "$4"; }

rec start      "$C&idx=4812&cam=0&ahead=1"                      3.5 0
rec kunibiki   "$C&idx=161&cam=0"                               3   4
rec pref       "$C&idx=1022&cam=0&ahead=1"                      3   4
rec castle     "debug=1&wp=3&photo=35.4752,133.0506,10,85,150&orbit=14" 5 0
rec shiomi     "$C&idx=1653&cam=1"                              3   4
rec cityhall   "$C&idx=2512&cam=0"                              3   4
rec bridge     "$C&idx=2759&cam=1"                              3   4
rec bridge_top "$C&idx=2800&cam=3"                              3   4
rec sunset     "$C&idx=3452&cam=0"                              3   4
rec lake       "debug=1&wp=7&photo=35.45617,133.04671,3,150,70&orbit=-6" 4 0
rec pack       "$C&idx=2380&cam=1&ahead=1"                      4   1.5
rec station    "$C&idx=4700&cam=1&ahead=1"                      3   4
