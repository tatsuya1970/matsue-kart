# データのライセンス

このリポジトリは、**コード**と**データ**で異なるライセンスが適用されます。

| 対象 | ライセンス |
| --- | --- |
| ソースコード（`src/`, `tools/`, `index.html`, 設定ファイル） | MIT（[LICENSE](LICENSE)） |
| 3D 都市データ（`public/data/`, `data/` の PLATEAU 由来のもの） | CC BY 4.0（下記） |
| OpenStreetMap 由来のデータ（`data/osm/`, `data/drawn_route.json`, `data/rail.json` の線形, `data/parks.json` の輪郭） | ODbL 1.0（下記） |

## 3D 都市データ（PLATEAU）

`public/data/` および `data/` に含まれる 3D 都市データは、以下を加工して作成したものです。

> 出典: 国土交通省「3D都市モデル（Project PLATEAU）松江市（2024年度）」
> https://www.mlit.go.jp/plateau/
> ライセンス: クリエイティブ・コモンズ 表示 4.0 国際 (CC BY 4.0)
> https://creativecommons.org/licenses/by/4.0/deed.ja

加工内容:

| ファイル | 元データ | 加工 |
| --- | --- | --- |
| `public/data/castle.bin`, `castle.json` | 建築物モデル `bldg` (LOD3)「松江城」 | CityGML の LOD3 面を三角形に分割し、頂点・UV・色を抽出 |
| `public/data/castle/*.jpg` | 同上のテクスチャ | 4096px の屋根・壁を 2048px に縮小。ほかはそのまま |
| `public/data/lod2.bin`, `lod2.json` | 建築物モデル `bldg` (LOD2) | CityGML から頂点・UV を抽出し、テクスチャアトラスの座標系へ変換 |
| `public/data/lod2_atlas_*.jpg` | 建築物モデル `bldg` (LOD2) のテクスチャ | 3,080 棟分の個別画像を 112px に縮めて 4096px のアトラス 7 枚へ再配置。航空写真に写らずベタ塗りになっている壁面のみ合成テクスチャへ差し替え |
| `public/data/buildings.json` | 建築物モデル `bldg` (LOD1 Solid) | フットプリントと高さを抽出 |
| `public/data/roads.json` | 交通（道路）モデル `tran` (LOD1) | 道路面ポリゴンを抽出 |
| `public/data/terrain.bin`, `terrain.json` | 地形モデル `dem` (LOD1 TIN) | 5m グリッドの標高マップへリサンプル。水面を判定 |
| `data/course_path.json` | 交通（道路）モデル `tran` (LOD1) | 道路面上を A* 探索して得た走行線 |
| `public/course.geojson`, `.kml`, `.gpx` | 同上 | 走行線を地図用フォーマットへ書き出し |

CC BY 4.0 は再配布・改変・商用利用を許諾しています。本リポジトリのデータを利用する場合は、上記の出典表示を継承してください。

## OpenStreetMap 由来のデータ

> © OpenStreetMap contributors
> https://www.openstreetmap.org/copyright
> ライセンス: Open Data Commons Open Database License (ODbL) 1.0

| ファイル | 使い方 |
| --- | --- |
| `data/osm/matsue.json` | 道路・鉄道の取得結果（`tools/fetch_osm.mjs`） |
| `data/drawn_route.json` | 経由地を OSM の道路網でつないだ案内線。走行線の探索（A*）の重みにだけ使い、走行線そのものは PLATEAU の道路面の上にある |
| `data/rail.json` | 一畑電車 北松江線・JR 山陰本線の線形 |
| `data/parks.json` | 公園の輪郭（間引き済み） |

## PLATEAU・OSM 由来ではない要素

以下はこのリポジトリの独自実装であり、MIT ライセンスの対象です。

- 嫁ヶ島・宍道湖夕日スポットの展望デッキ・松江高専の校名碑のモデル（`src/landmarks.ts`）
- 車両・高架橋・駅のモデル（`src/rail.ts`）
- プロシージャルテクスチャ（`src/textures.ts`）
- カート物理・アイテム・HUD・効果音
