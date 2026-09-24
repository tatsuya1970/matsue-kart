# Matsue Kart — 松江グランプリ

国土交通省 **PLATEAU** の 3D 都市モデル（松江市 2024 年度, CityGML）を使った、実在の松江の街を走るカートレースゲームです。ブラウザ (three.js) で動作します。[Hiroshima Kart](https://github.com/tatsuya1970/hiroshima-kart)（広島グランプリ）の松江市版です。

## コース

松江駅 → くにびき大橋 → 島根県庁 → 松江城 → 塩見縄手 → 松江市役所 → 宍道湖大橋 → 宍道湖夕日スポット → 浜乃木 → 松江駅

1 周 9.6 km、2 周勝負。

| 必ず通る地点 | どう通るか |
| --- | --- |
| 松江駅 | 駅北口の駅前通りがスタート / ゴール。JR の高架をくぐって帰ってくる |
| 島根県庁 | 県道37号で県庁の東側（東庁舎の前）を北上する |
| 松江城 | 県道37号で城山の東・北（塩見縄手）を回り、城の西側を南へ下りる。天守は **PLATEAU の LOD3 モデル**（下記） |
| 松江市役所 | 国道431号で市役所の南側を東へ |
| 宍道湖大橋 | 県道37号で北から南へ渡る |
| 宍道湖夕日スポット | 国道9号の湖岸（とるぱ）。沖に嫁ヶ島が見える |

最初の版は松江高専・一畑電車の並走区間まで回る 16.8km の 1 周勝負でしたが、半分ほどの距離で 2 周にしました。一畑電車は松江しんじ湖温泉の付近だけ残っています。

**走行線は PLATEAU の道路データ (tran) の上を通ります**（道路上 99.6%）。作り方は 2 段です。

1. **経由地を OSM の道路網でつなぐ**（`tools/plan_route_osm.mjs`）。`tools/route_vias.json` の経由地どうしを OpenStreetMap の道路網の最短路でつなぎ、案内線 `data/drawn_route.json` を作ります。経由地には道路の絞り込み（`"^37[|]"` なら県道37号）を付けられ、同じ道を往復しないよう一度通った道には割増を掛けます。浜乃木の踏切は OSM で道がつながっていないので `links` で手でつないでいます。
2. **PLATEAU の道路面の上で A* 探索**（`tools/build_course.mjs`）。道路面を 2m グリッドにラスタライズし、道路の中央寄り・案内線寄りを通るように重みを付けて探索します。結果は `data/course_path.json`（2m 間隔の閉ループ）で、ゲームはこれをそのまま走行線に使います。

コースを変えるときは `tools/route_vias.json` を直して次を順に実行します。

```bash
node tools/plan_route_osm.mjs      # data/drawn_route.json
node tools/build_course.mjs        # data/course_path.json と data/course_map.png
node tools/convert_lod2.mjs        # コース沿い 150m の LOD2 を選び直す (テクスチャが増えたら download → atlas も)
node tools/convert_citygml.mjs     # LOD2 で描く建物を LOD1 から除く
node tools/export_course_geo.mjs   # 地図用の書き出し
```

地名の看板は `data/course.json` の `waypoints`（`label: true` のもの）から作ります。英語名は `en`、地図用の短い名前は `short` です。

## コースを地図で見る

`tools/export_course_geo.mjs` が完成したコースを地図用に書き出します。

| ファイル | 用途 |
| --- | --- |
| `public/course-map.html` | OpenStreetMap / 地理院地図 / 空中写真に重ねて表示する単体ページ |
| `public/course.geojson` | geojson.io、QGIS など |
| `public/course.kml` | Google マイマップ、Google Earth |
| `public/course.gpx` | GPX トラック |

開発サーバー起動中なら http://localhost:5182/course-map.html で見られます。

## 使用している PLATEAU データ

| 地物 | 用途 |
| --- | --- |
| 建築物モデル `bldg` (LOD3) | **松江城天守**。壁・屋根・破風・窓・扉を面ごとに持つ 43,104 面をそのまま描く |
| 建築物モデル `bldg` (LOD2) | コース沿い 150m の 3,080 棟。**PLATEAU の実写テクスチャ**（航空写真由来）をそのまま使用 |
| 建築物モデル `bldg` (LOD1 Solid) | LOD2 の範囲外（18,406 棟）。高さ・用途からプロシージャル生成した壁面テクスチャを貼付 |
| 交通（道路）モデル `tran` (LOD1) | 走行線の探索と地面テクスチャの道路面 |
| 地形モデル `dem` (LOD1 TIN) | 5m グリッドの標高マップ。宍道湖・大橋川・堀川を水面として判定し、橋を自動生成 |

出典: 国土交通省 PLATEAU「3D都市モデル（Project PLATEAU）松江市（2024年度）」(CC BY 4.0)

### 松江城天守（LOD3）

松江市のデータには、天守の LOD3 モデルが 1 棟だけ入っています（`53331074_bldg_6697_op.gml` の「松江城」、XML で 29MB）。`tools/convert_castle.mjs` が次のように変換します。

- `lod3MultiSurface` / `lod3Geometry` の面を耳刈りで三角形に分割（43,104 面 → 43,104 三角形。穴あき面は無い）
- 見た目は部位ごとのテクスチャ 8 枚（壁・屋根・軒裏・窓・扉など）と、`X3DMaterial` の単色（約 1.6 万面）。単色の面は頂点色にまとめて 1 回で描く
- 座標は標高 (T.P.) のまま。石垣の下端 26.9m〜屋根 58.5m で、DEM の城山の頂（27.2m）にそのまま載る
- 屋根と壁のテクスチャは 4096px（計 8MB）あるので 2048px に縮める（元画像は `data/castle_tex_orig/`）
- 面の巻き順がそろっていないので両面で描く

同じ天守は LOD1・LOD2 にも入っているので、`data/rail.json` の `landmarks.matsueCastle.excludeRadius`（30m）で除いています。

### LOD2 の実写テクスチャについて

松江市の LOD2 は小さな建物が多く、コース沿い 150m だけでもテクスチャが 6,160 枚あります。広島版と同じ 224px のタイルでは 4096px のアトラスが 25 枚ほどになるので、**1 タイル 112px** にして 7 枚（高画質 20MB / 低画質 4.7MB）に収めています（`tools/convert_lod2.mjs` の `CELL`）。採用範囲はコースから 150m（`LOD2_CORRIDOR`）で、200m だとアトラスが 8 枚になりました。

松江市のファイルは appearance（テクスチャの対応）がファイルの**末尾**にあります（広島市は先頭）。`convert_lod2.mjs` はどちらでも読めるようにしてあります。

航空写真に写らない壁面が単色のベタ塗りで入っているのは広島と同じで、アトラス生成時に合成テクスチャへ差し替えています。

### 地形と水面

DEM は 2 次メッシュ 533310 を 4 分割した 4 ファイル（計 3GB）です。読むのに数分かかるので、格子に落とした結果を `data/dem_grid.bin` にキャッシュし、`ONLY_TERRAIN=1 node tools/convert_citygml.mjs` で水面判定だけやり直せます。

松江は低い街なので、広島版の「標高 1m 未満で水面に連結していれば水面」では湖の北岸の水田（0.9〜1.1m）と市街地（1.4m 前後）が水没しました。実測すると宍道湖は DEM が欠測、大橋川・堀川の水面は標高 0m 前後で入っていたので、次のようにしています。

| 条件 | 判定 |
| --- | --- |
| DEM 欠測、または標高 0.3m 未満 | 水面 |
| 標高 0.3〜0.6m で水面から 10m 以内 | 水面（護岸の縁） |
| 湖の中に残った小さな陸で最高点 1.5m 未満 | 水面（浅瀬のノイズ） |

コースが丘を切り通す所（最初の版の松江高専の前など）は DEM の斜面が路面より高く、地形が路面にはみ出します。`Terrain.flattenAlong` が走行線沿いの地形を路面の下まで削り、外側を 0.8 の勾配で元の斜面へ戻しています。

宍道湖は西へ 17km 続くので、水面は遠景の山並みの外まで広げてあります。宍道湖は夕日の名所なので、空は西日の差す夕方寄りにし、西の空に太陽を置いています（`src/main.ts` の `SUN_DIR`）。

## 日本語 / 英語

**言語ごとに URL が分かれています。** 日本語は `/`、英語は `/en/` です。英語に実体のある URL を与えているのは検索と SNS のためで、理由は後述の「SEO」に書いてあります。判定は `/en/` → `?lang=ja|en` → `localStorage` → `navigator.language` の順です（`src/i18n.ts`）。IP から国を見るにはサーバーが要るので、GitHub Pages の静的配信では使えません。日本語環境から英語で見たい人（その逆も）がいるので、画質ボタンの隣に手動の切り替えを必ず出しています。切り替えは看板やラベルを作り直す必要があるため、その言語の URL へ移動して読み込み直します。開発サーバーには `/en/` が無いので、そこでは `?lang=en` を使います。

差し替えの場所は 2 つに分けています。

| 対象 | 持たせ方 |
| --- | --- |
| `index.html` の固定文言 | 日本語をそのまま置き、英語を `data-en` / `data-en-html` / `data-en-placeholder` 属性に持たせる。`applyDomLang()` がまとめて差し替える |
| TypeScript 側の文言 | `src/i18n.ts` の辞書を `t('key', ...)` で引く |

日本語をソースに残す形にしたのは、読んで意味が分かるほうが直しやすいためです。

**コースの看板は常に二か国語です。** 選んだ言語を大きく、もう一方を副題に出します（看板の副題行はもともと空いていたので、切り替えずに両方出せます）。地名の英語は `data/course.json` の `en` に持たせ、`tools/build_course.mjs` が `course_path.json` へ書き出します。

```
松江駅 → Matsue Sta. / 宍道湖夕日スポット → Lake Shinji Sunset Spot / 島根県庁 → Shimane Pref. Office
```

`?lang=en` を付ければ日本語環境でも英語で確認できます。

## SEO

検索と SNS のカードのために、次を入れてあります。**日本語と英語で別々の URL** を持たせているのが要です。

| URL | 言語 | 中身 |
| --- | --- | --- |
| `https://matsue.citykart.jp/` | 日本語 | `dist/index.html` |
| `https://matsue.citykart.jp/en/` | 英語 | `dist/en/index.html`（中身は同じで head だけ英語） |

**なぜ URL を分けるのか。** X や Facebook のカードを作るクローラは JavaScript を実行しません。1 つの URL で実行時に英語へ差し替えても、共有カードは日本語のままになります。検索も、1 つの URL に 2 言語が同居していると、どちらの言語のページとして出すか決めきれません。

**英語ページの作り方。** ページを二重管理しないよう、`index.html` は 1 つだけです。head の言語依存部分を `<!-- ==== SEO:ja ==== -->` と `<!-- ==== /SEO:ja ==== -->` で囲んであり、ビルド後に `tools/build_en_page.mjs` がそこを `tools/seo-en.html` の中身へ差し替え、`<html lang>` を `en` にして `dist/en/index.html` として書き出します（`npm run build` に組み込み済み）。**目印のコメントを消さないでください。** 画面の文言は `applyDomLang()` が `/en/` を見て英語にします。

**紹介文（本文）。** 検索の順位に効くのは meta description ではなく本文です。タイトル画面の下に、ゲームの説明・コースの通過地点・遊び方を日本語と英語で置いてあります（`#about`）。クローラは JavaScript を実行しないので、`tools/build_en_page.mjs` が`/en/` 側では日本語を取り除き、`data-en` を持つ要素の文言も静的に英語へ置き換えます。AI の検索に引用されやすいよう、距離・地名・人数などの事実をそのまま書いています。

入れてあるもの。

| 項目 | 場所 |
| --- | --- |
| 見出しと説明（言語別） | `index.html` の SEO ブロック / `tools/seo-en.html` |
| canonical と hreflang（ja / en / x-default） | 同上。各ページが自分を canonical に指す |
| OGP と Twitter カード（`summary_large_image`） | 同上 |
| 構造化データ（schema.org の `VideoGame`） | 同上。JSON-LD |
| カード画像 1200x630 | `public/ogp.png`（日本語）/ `public/ogp-en.png`（英語） |
| サイトマップ | `public/sitemap.xml`。2 言語を hreflang で結んである |
| 紹介文（本文、言語別） | `index.html` の `#about`（ABOUT ブロック） |
| 構造化データ（`BreadcrumbList`、`isPartOf`） | 入口サイト citykart.jp の一部であることを示す |
| 相互リンク | `index.html` の `.sites`。ほかの 2 作と citykart.jp へ |

カード画像は `PORT=5182 node tools/make_ogp.mjs` で作り直せます。松江城天守を上空から撮り、HUD を消してタイトル帯を重ねたものです。文字はブラウザに描かせているので日本語のフォントも崩れません。背景を変えたいときは `QUERY` の `photo=緯度,経度,注視高さ,距離,方位角` を差し替えてください。

**robots.txt と AI のクローラー。** 独自ドメインに移したので `/robots.txt` は読まれます。検索エンジンに加えて、生成AI・AI検索のクローラー (GPTBot、OAI-SearchBot、ClaudeBot、PerplexityBot、Google-Extended、Applebot-Extended、CCBot ほか) も明示的に許可しています。拒否したくなったら `public/robots.txt` のその行を `Disallow: /` に変えてください。サイトマップは Search Console にも登録します (このドメインでの所有権確認が要ります)。

**ドメインを変えるとき。** URL は `index.html` の SEO ブロック、`tools/seo-en.html`、`public/sitemap.xml`、`public/robots.txt` の 4 か所に書いてあります。GitHub Pages で独自ドメインを設定すると `github.io` 側は 301 で転送されるので、リンクの評価は引き継がれます。

## オンライン対戦

タイトル画面で「対戦PLAY」を押すと公開ロビーに入り、**2 人そろった時点で 30 秒のカウントダウン**が始まって自動的に発走します。集まった人どうしで最大 8 人、空いた枠は AI が走ります。1 人のあいだは相手が来るまで待ち、待たずに走りたければ「すぐ始める」で AI と走れます。相手が入ると短いジングルが鳴り、別のタブを見ていればタブの見出しが点滅します（トップ画面にいるときに待ち人が現れた場合も同じ）。

部屋は押した人が作ります（`OPEN` + 5 文字）。同じ部屋に集まる手段は後述の presence で、待っている人の部屋が見えていればそこへ入り、見えていなければ新しい部屋を作ります。お互いに見えないまま部屋が 2 つできたときは、1 人で待っている側が部屋名の小さいほうへ移って合流します（`src/main.ts` の `maybeMergeLobby`）。以前は壁時計を 30 秒で区切った部屋名にしていましたが、「2 人そろってから」にするには締切を人数で決める必要があり、時刻から決まる部屋名とは相容れないので変えました。

締切はホストが 2 人目の席を配るときに決めて座席表に載せます（`LobbyInfo.deadline`）。1 人に戻ったら締切を消し、相手が抜けたのに 1 人で発走することはありません。発走の合図はホストが出して足並みを揃え、締切を 2 秒過ぎても合図が来なければ（ホストが落ちた等）各自で始めます。席が無いまま発走したら 1 人で走ります（席が無いのに 0 番を名乗ると、ホストとカートを奪い合うため）。レース中の部屋に入ってしまった人には `busy` を返し、新しい部屋で待ち直してもらいます。

**トップ画面に「対戦待ち」の状況を出します。** 対戦PLAY を押す前から、レースの部屋とは別の常設の部屋（`mk-presence`）に全員が入り、「トップ画面にいる / 対戦待ち / レース中」を伝え合います（`src/net.ts` の `Presence`）。誰かが待っていれば「いま 1 人が対戦待ち（たろう）対戦相手を待っています」、カウントダウン中なら「発走まで 18 秒」と緑で光り、ロビーで待っている側にも「トップ画面に 1 人います」と出ます。

**presence は人が増えたら分室に分かれます。** WebRTC は全員どうしで張るので、1 つの部屋に N 人いると 1 台あたり N-1 本の接続になり、人が集まった瞬間にスマホの CPU と回線が先に尽きます。最初の部屋（`mk-presence`）が 12 人（`PRESENCE_SPLIT_AT`）を超えたら、トップ画面の人は ID で決まる 4 つの分室（`mk-presence-0`〜`3`）のどれかへ移ります。対戦待ちの人は最初の部屋と全分室に入るので、どこにいる人からも見え、待っている人どうしも互いに見えます。代わりに、分かれた後のトップ画面の人数は自分の部屋の分だけです。分室を増やすと、対戦待ちの人が入る部屋ごとにリレーへの告知が増えるので、流量制限に掛からないよう 4 にしてあります。

**座席表と発走の合図は、自分から見たホストからだけ受け取ります**（`src/net.ts` の `acceptLobby`）。直結できない組（対称型 NAT どうしで TURN が無い等）がいると、ホストの見え方が人によって食い違います。誰からでも受け取ると、自分がホストだと思い込んだ 2 人の座席表が交互に届いて席が揺れるので、食い違った相手の座席表は捨てます。ホストとつながっていない人は席をもらえないまま発走し、1 人で走ります。

trystero 0.25 は同じ appId なら部屋をまたいで WebRTC 接続を共有します（`@trystero-p2p/core` の SharedPeerManager）。そのため、トップ画面でつながった相手とは、対戦PLAY を押した瞬間にリレーの往復なしで同じ部屋に入れます。相手とつながるまでの 8〜19 秒はページの読み込み中に済み、カウントダウン中の部屋にも締切の 3 秒前（`JOIN_MIN_WAIT`）まで入れます。

合言葉で部屋を作る方式はコメントアウトしてあります（同時に遊ぶ人が少ないうちは、待ち時間が読めるほうが遊びやすいため）。`index.html` と `src/main.ts` の「合言葉」の箇所を戻せば復活します。URL に `?room=XXXXX` を付けると、今でも合言葉の部屋へ直接入れます。

**サーバーはありません。** GitHub Pages で配信しているので常駐サーバーを置けず、[trystero](https://github.com/dmotz/trystero) で WebRTC のブラウザ直結にしています。公開リレーを通るのは「どの部屋に誰がいるか」のシグナリングだけで、レース中の通信はブラウザ同士を直接流れます（`src/net.ts`）。

同期の考え方は次のとおりです。

| 対象 | 誰が決めるか |
| --- | --- |
| 自分のカート | 自分だけが物理計算する。他の人のカートは受信位置へ寄せるだけで、物理は回さない |
| 空き枠の AI | ホストだけが計算して位置を配る |
| アイテムボックスの取得・被弾 | そのカートを持っている側だけが判定し、結果をイベントで配る |
| アイテムの発射 | 使った人が位置とともに配り、各自の画面で同じものを出す |
| ホスト | 合言葉の部屋では作った人。公開ロビーには作成者がいないので ID が最小の人。抜けたら次の人へ移る |

位置は 15Hz で送り、受信側は速度で前へ進めながら（デッドレコニング）表示位置を寄せます。取得と被弾を持ち主の側に寄せていないと、各自の画面で別々に当たったことになります。

送信間隔は `dt` ではなく実時間で測ります。`dt` は 0.05 秒で頭打ちにしてあるので、fps が落ちた端末では送信間隔まで一緒に間延びし、相手の画面で 100m 以上ずれます（検証環境で実測）。

**待っている人がいるのに「見当たりません」と出るとき。** 次の順に疑ってください。

1. **どちらかが古いページのまま。** 配信後もブラウザのキャッシュに前の版が残ることがあり、古い版は新しい版の「対戦待ち」を読めません（「1 人がレース中」と出ます）。タイトル画面の一番下に `build <コミット> (<時刻>)` を出しているので、両方の端末で同じか見てください。違えば再読み込み（スマホは一度タブを閉じて開き直す）です。
2. **見つかるまで 1 分近くかかる。** trystero の nostr 戦略は「自分の告知を受け取った相手が接続してくる」仕組みで、相手の再告知は 60 秒おきです。リレーは購読した時刻より新しい出来事しか流さないため、端末の時計が数秒ずれていると相手からの応答が捨てられ、相手の次の再告知まで待ちます。そのためトップ画面の「確認しています...」は 70 秒続けます。相手が現れれば音で知らせるので、待っていて構いません。
3. **リレーにつながっていない。** 誰も見えないあいだは「リレー 4/8 に接続中」のように接続数を添えています。0 なら回線か、社内ネットワーク等で WebSocket が塞がれています。trystero が既定で選ぶリレーのうち 1 つは落ちていたので（`nostr.data.haus`、実測）、使うリレーを 5 から 8 に増やしてあります（`src/net.ts` の `RELAY_CONFIG`。全員が同じ組になるよう appId から順が決まります）。
4. **開発サーバーと本番は別の世界。** `vite` の開発サーバーでは appId を `matsue-kart-dev` にして本番の利用者と切り離しています（テスト用のブラウザが本番の画面に映っていたため）。PC の開発サーバーとスマホの本番ページでは互いに見えません。開発サーバーから本番の相手と試すときは `?net=prod` を付けてください。
5. **待っている側の画面が消えている。** スマホで画面を消したりタブを裏にしたりすると、ブラウザが接続を止めるので相手から見えなくなります。画面に戻れば数秒で復帰します。
6. **携帯回線 (5G / 4G) と家庭の回線の組み合わせ。** リレーにつながっていて告知も届いているのに相手が見えないときは、ここがいちばん怪しいです。WebRTC の直結は STUN で自分の外側の住所を相手に伝える方式で、携帯回線の CGNAT（対称型 NAT）と家庭のルータ（ポート制限コーン）の組み合わせでは直結できません。これを中継するのが TURN で、サーバーが要ります。トップ画面では STUN サーバー 2 つに聞いて NAT の種類を推定し、対称型なら「相手と直結しにくい種類の NAT です」と出します（`src/net.ts` の `natProbe`）。対処は下の「TURN の設定」です。
7. **アプリ内ブラウザ (Facebook / Instagram / LINE / X)。** WebView は WebRTC が制限されていたり、裏に回ると接続が切れたりします。検出したら「Safari / Chrome で開いてください」と出します（`inAppBrowser`）。

**TURN の設定。** 誰でも使える無料の公開 TURN（Open Relay）は候補が取れなくなっていた（2026-09 実測）ので、サイトの持ち主が用意します。`public/turn.json` を置くと、ページ読み込み時に読んで trystero の `turnConfig` に渡します。無ければ STUN だけで動きます（直結できる相手とだけつながる）。

本番デプロイでは TURN を必須にしています。GitHub Actions の repository variable `TURN_CONFIG_URL` に、短期の資格情報を返す HTTPS API を設定してください。**`turn.json` は配信されて誰でも読めるので、固定の資格情報（`username` / `credential`）も、`?apiKey=...` のように鍵を付けた URL も入れられません。** `npm run turn:prepare` と配信物の点検（`tools/check_site.mjs`）は、資格情報を直接書いた設定や鍵付きの URL を見つけるとデプロイを止めます。以前の secret `TURN_CONFIG_JSON` は同じ理由で廃止しました（残っているとデプロイが止まるので削除してください）。`npm run turn:prepare` は設定 API を呼び、応答に `turn:` または `turns:` が無ければデプロイを停止します。ローカルで本番相当のビルドを確認するときも、先に同じコマンドを実行してください。

中継は [metered.ca](https://www.metered.ca/stun-turn) の無料プラン（月 500 MB、上りと下りの合計）を使います。カード登録が無いので枠を超えても請求は発生せず、費用の上限がはっきりします（枠を超えたときに中継が止まるかどうかは公式には明記されていません）。代わりに、枠が尽きた月は直結できない組（携帯回線どうしなど）が翌月まで対戦できないと考えてください。中継 1 組の 5 分レースが 4〜8 MB なので、月に 60〜120 組ぶんです。使用量は metered.ca のダッシュボードで見られます。

登録してアプリを作り、TURN Server の画面で資格情報（credential）を 1 つ作ると、その行の「Show API Key」に資格情報用の API キーが出ます。ドメイン（`<アプリ名>.metered.live`）は左メニューの Developers にあります。`https://<アプリ名>.metered.live/api/v1/turn/credentials?apiKey=<資格情報の API キー>` が資格情報を返す URL です。Developers にある Secret key はアカウント全体の鍵なので、この URL には使いません。この URL が鍵そのものなので `turn.json` には書かず、`workers/turn/` の Cloudflare Worker に持たせます。資格情報は既定では期限切れにならないので、漏れたと思ったらダッシュボードで無効化して作り直し、Worker の secret を入れ替えます。Worker はサイトの Origin からの GET だけを metered.ca へ通し、1 つの IP からの回数と 1 日の発行回数を制限し、応答を 60 秒使い回します（`worker.js` の冒頭に、守れることと守れないことを書いてあります）。松江・広島・福山で 1 つを共有し、どのリポジトリからデプロイしても同じ Worker が更新されます。

1. metered.ca でアプリと資格情報を 1 つ作り、資格情報の API キーで上の URL を組み立てます。`curl` で開いて `turn:` を含む JSON が返れば正しい URL です。
2. Worker に secret を入れてデプロイします。

   ```sh
   cd workers/turn
   npx wrangler login
   npx wrangler secret put TURN_API_URL      # metered.ca の ?apiKey=... 付きの URL
   npx wrangler deploy                       # 出てきた URL を各リポジトリの TURN_CONFIG_URL に設定する
   ```

3. 表示された Worker の URL を、松江・広島・福山それぞれの repository variable `TURN_CONFIG_URL` に同じ値で設定します。

1 日に発行する回数の上限は `wrangler.toml` の `DAILY_CAP`（既定 500、日本時間の日付で数える）です。達した日は Worker が 503 と `{ "error": "daily_cap" }` を返し、ページ側は対戦PLAY を出さず、その下に「今日は対戦はできません。午前 0 時にリセットします」と出します（`src/net.ts` の `turnState`、`src/main.ts` の `updateOnlineAvailability`）。資格情報 API がそれ以外の理由で応答しないときは「中継サーバーの設定を取得できないため、いまは対戦できません」と出します。定期監視（`monitor.yml`）も同じ API を呼ぶので、止まっている間は監視が失敗して GitHub から通知が届きます。翌日 0 時に戻ります。通常は、通信を許可した人のページ表示 1 回が 1 回にあたります（独自ドメインでキャッシュが効いていれば 1 分に 1 回まで）。いまの数は `https://<Worker の URL>/status` で見られます。この上限は資格情報を大量に取られて月の枠が一気に尽きるのを防ぐためのもので、転送量そのものの上限は metered.ca のプランで決まります。数は Durable Object（`worker.js` の `DailyCounter`）で数えており、無料プランで使える SQLite 方式にしてあります。

`npm run turn:prepare` と `tools/check_site.mjs` は `public/CNAME` のドメインを Origin として名乗って Worker を呼ぶので、CI と定期監視からも検査できます。Worker を `*.workers.dev` のまま使うと Cache API は効かず、発行 API を守るのは回数制限だけになります。`citykart.jp` の DNS が Cloudflare にあるなら、`turn.citykart.jp` のような独自ドメインに載せるとキャッシュも効きます。

別の上流に切り替えるとき:

- [Cloudflare の TURN](https://developers.cloudflare.com/realtime/turn/) は月 1,000 GB まで無料ですが、超過分は 1 GB あたり 0.05 ドルの従量課金で、上限を設定する仕組みがありません。Bearer 認証の POST で資格情報を発行するので、`TURN_API_URL` に `https://rtc.live.cloudflare.com/v1/turn/keys/<Key ID>/credentials/generate-ice-servers`、`TURN_API_TOKEN` に TURN Key の API トークンを入れ、`wrangler.toml` の `TURN_API_METHOD = "POST"` と `TURN_API_BODY` のコメントを外します。本文の `ttl` が資格情報の有効期間（秒）です。応答の `iceServers` が配列でなくても Worker が配列にそろえます。

- 自前の TURN（coturn 等）なら、TURN の REST API 方式（共有鍵から期限付きの資格情報を作る）で資格情報を発行する小さな API を用意し、その URL を `TURN_API_URL` に入れます。**固定の資格情報を ICE サーバーの一覧に直接書くのはやめてください。** `turn.json` は配信されるので誰でも読め、第三者に中継を使われます（転送量の課金や上限の枯渇、踏み台）。

中継が通っているかは、対称型 NAT の端末でトップ画面に「TURN で中継できます」と出るかで分かります。レースの位置情報は 1 組あたり毎秒 10 KB ほどなので、5 分のレースで 3〜4 MB です。

**相手と初めてつながるまでに 8〜19 秒かかります**（公開リレー経由の WebRTC ハンドシェイク。実測値）。ただし上記の presence でページ読み込み中につながっていれば、ロビーでの合流は 2 秒ほどです（`tools/nettest.mjs` で実測 1.9 秒）。それでも人が集まらないようなら `src/net.ts` の `OPEN_PERIOD` を延ばしてください。

参加した直後は相手の挨拶がまだ届かず、作成者が誰か分かりません。そのまま ID 順でホストを決めると、参加した側が一瞬ホストだと思い込んで座席表を配ってしまい、席が入れ替わります。そのため作成者でない場合は 5 秒待ってからホストを名乗ります。

`PORT=5183 node tools/nettest.mjs` でブラウザを 2 つ立ち上げ、同時に押して合流・カウントダウン・発走・位置の一致まで通しで確認できます。`PORT=5183 node tools/presencetest.mjs` は、トップ画面に対戦待ちが出るか、押すと同じ部屋に入って 2 人でカウントダウンが始まるかを確認します。

## 実在の鉄道（走行します）

| 路線 | 表現 |
| --- | --- |
| 一畑電車 北松江線 | 松江しんじ湖温泉（終端）から西へ単線。バラスト・架線柱・トロリ線つき。2 両編成が 2 本走る |
| JR 山陰本線 | 松江駅の前後は高さ 7m の高架、浜乃木の南は地上。気動車（2 両）が 2 本走る |

線形は OpenStreetMap の way をつないだもの（`data/rail.json`、JR は `bridge=yes` の区間に高さを付けた）。**地上を走る車両に接触するとスピン**します（JR は浜乃木の踏切でコースと交わる。一畑電車は今のコースとは交わらない）。高架の上の車両には当たりません。

JR は県道24号の、一畑電車は国道431号のすぐ脇を走ります（一畑電車の並走は最初の版のコース）。コースは幅 18m で道路の中央に敷いているため、OSM の線形のままだと線路が路面に乗ってしまいます（実測で中心から 7〜10m が約 1.5km）。コースと平行な区間だけ、線路を中心から 15.5m まで横へずらしています（`src/rail.ts` の `keepOffCourse`）。踏切（交差角が大きい所）は動かしません。

車両は終端で折り返さず、反対の端へ回して同じ向きに走り続けます（広島版と同じ。接触したカートが電車を押し戻したように見えないようにするため）。

## 実在ランドマーク

| ランドマーク | 作り方 |
| --- | --- |
| 松江城天守 | PLATEAU の LOD3（上記） |
| 嫁ヶ島 | 独自モデル。低い盛り土に松 16 本と石の鳥居。DEM では島の形が崩れているため |
| 宍道湖夕日スポット（とるぱ） | 独自モデル。国道9号の湖側に張り出した展望デッキ・柵・ベンチ・案内板 |

位置は `data/rail.json` の `landmarks` にあります。

## 公園

松江城山公園・白潟公園・袖師公園・千鳥南公園・岸公園を芝生と樹木で再現しています（`src/parks.ts` と `data/parks.json`）。PLATEAU には公園の輪郭が無いので、OpenStreetMap の輪郭を間引いて使っています。松江城の内堀（堀川）は DEM に水面として入っているので、広島版のように濠を掘り直す処理は使っていません（`moat: null`）。

## セットアップ

```bash
npm install
npm run data:download                 # PLATEAU CityGML を data/citygml/ に (建物・道路 約 900MB + DEM 3GB)
npm run data:convert                  # 地形・道路・LOD1 建物 (初回は DEM の読み込みに数分)
node tools/build_course.mjs           # 走行線
node tools/convert_lod2.mjs           # LOD2 (コース沿い)
node tools/download_lod2_tex.mjs      # LOD2 テクスチャ (5,568 枚)
node tools/build_lod2_atlas.mjs       # アトラス
npm run data:lq                       # 低画質用アトラス
npm run data:convert                  # LOD2 で描く建物を LOD1 から除く (DEM はキャッシュ)
npm run data:castle                   # 松江城天守 (LOD3)
npm run dev             # http://localhost:5182/
```

`public/data/` に生成済みデータが含まれていれば、`npm run dev` だけで遊べます。

## デプロイ

`main` に push すると GitHub Actions が GitHub Pages へ公開します（`.github/workflows/deploy.yml`）。

公開先: **https://matsue.citykart.jp/**

デプロイの流れは次のとおりです。どこかで失敗すると GitHub から通知が届きます。

1. **テスト**（`npm test`。`tests/` の vitest）
2. **ビルド**
3. **配信物の点検**（`npm run check:dist` = `tools/check_site.mjs dist`）。index.html から読む JS があるか、地形・LOD2・天守の `.bin` が `.json` の頂点数と同じ長さか、アトラスとテクスチャが揃っているかを見ます。欠けていれば配信しません。
4. **配信**
5. **配信後の確認**（`smoke` ジョブ）。本番の URL を同じ点検にかけ、バンドルに埋め込んだコミットがいま配信されている版と一致するまで最大 10 分待ちます。

**切り戻し。** GitHub の Actions → Deploy to GitHub Pages → Run workflow で、`ref` に戻したいコミットの SHA（かタグ）を入れて実行すると、その版を配信し直します。次に `main` へ push すると `main` の先頭が配信されるので、原因を直すまでは `git revert` で `main` 自体を戻しておくのが確実です。

**外形監視。** `.github/workflows/monitor.yml` が 3 時間おきに本番を点検し、対戦のシグナリングに使う nostr リレー 8 つのうち 3 つ以上につながるかも見ます（`node tools/check_site.mjs https://matsue.citykart.jp/ --relays` で手元でも実行できます）。本番のトップ画面をブラウザで開くと利用者の「対戦待ち」表示に監視が映ってしまうので、HTTP とリレーの口だけを見ています。リポジトリに 60 日動きが無いと、GitHub は定期実行を自動で止めます。

**本番で起きたことの記録。** 捕まえ損ねた例外、読み込みの失敗、WebGL のコンテキスト喪失、読み込み完了までの時間、presence で誰かとつながるまでの時間、対戦の発走人数を `src/telemetry.ts` が記録します。送り先はリポジトリ変数 `TELEMETRY_URL`（ビルド時に `VITE_TELEMETRY_URL` として埋め込む）で、未設定なら送らずにページ内に残すだけです（コンソールで `__telemetry()`）。受け口は `text/plain` の POST を受けて保存するだけのもの（Cloudflare Workers の無料枠など）で足ります。送るのは種類・内容・ビルド・画質・言語・パス・UA だけで、名前や peer ID は送りません。

プロジェクトページはサブパス配信なので `base` が要ります。`vite preview` は `command` が `'serve'` 扱いになり、`command === 'build'` で分岐するとビルド成果物を root で配信してしまって検証にならないため、環境変数で渡しています。

```bash
BASE_PATH=/matsue-kart/ npm run build
BASE_PATH=/matsue-kart/ npm run preview   # http://127.0.0.1:4173/matsue-kart/
```

`npm run build` は最後に `tools/build_en_page.mjs` を呼び、英語版 `dist/en/index.html` を書き出します（「SEO」の項）。Git Bash から実行するときは `MSYS_NO_PATHCONV=1` を付けてください。付けないと `/matsue-kart/` が Windows のパスへ変換され、`base` が `/Program Files/Git/matsue-kart/` になります。

`public/` 配下のアセットは絶対パスで直書きせず、`src/geo.ts` の `assetUrl()` が `import.meta.env.BASE_URL` を基準に解決します。新しくデータを読む箇所を足すときはこれを使ってください。

初回ロードは「中」画質で約 22MB（2048px アトラス 4.4MB ＋ 松江城天守 7.5MB ＋ 建物・地形・道路）。GitHub Pages の帯域ソフト制限は月 100GB です。

## 操作

| キー | 操作 |
| --- | --- |
| ↑ / W | アクセル |
| ↓ / S | ブレーキ・バック |
| ← → / A D | ハンドル |
| Shift / Space | ドリフト（離すとミニターボ） |
| Ctrl / Enter / X | アイテム使用 |
| B | 後方視点 |
| C | カメラ切替 |
| M | ミュート |

アイテム: キノコ（加速）、バナナ（後方に設置）、ミドリこうら（前方に発射・壁で反射）、スター（無敵）。コインを取ると最高速が少し上がります。

### スマホ / タブレット

タッチ操作に対応しています。**横向き推奨**ですが、縦向きでも遊べます（Facebook などアプリ内ブラウザは縦に固定されていることがあるため）。

| ボタン | 操作 |
| --- | --- |
| ◀ ▶（左下） | ハンドル |
| D（右下） | ドリフト（離すとミニターボ） |
| ▼ | ブレーキ・バック |
| ★ | アイテム使用 |

**アクセルは自動です。** 親指 2 本でハンドル・ドリフト・アイテムを賄うので、アクセルを押しっぱなしにする指がありません。ブレーキを押している間だけアクセルが離れます。

タッチは各ボタンではなく画面全面（`#touch`）で受け、指ごとに座標からボタンを引き直します（`src/input.ts`）。ボタンに `touchstart` を付ける方式だと、◀ に置いた指を ▶ へ滑らせても ◀ が押されたままになるためです。

Android の Chrome では PLAY を押すと全画面にして横向きに固定します。iPhone は全画面 API も向きの固定も無いので、縦向きのときはタイトル画面に「横向きにすると見やすくなります」と出すだけです。HUD とボタンはノッチ・ホームバーを避けて置きます（`viewport-fit=cover` と `env(safe-area-inset-*)`）。ミニマップはスマホでは出しません。

## 画質プリセット

公開環境では GPU を選べないため、タイトル画面に画質切り替えを置いています。初回は WebGL の `WEBGL_debug_renderer_info` から GPU 名を読んで自動選択し、以後は localStorage に保存します（`src/quality.ts`）。アトラスの解像度が変わるので、切り替えはページ再読み込みで反映されます。

| プリセット | アトラス | 影 | 解像度上限 | 描画距離 |
| --- | --- | --- | --- | --- |
| 高（専用GPU向け） | 4096px | 2048 シャドウマップ | DPR 1.5 | 4200m |
| 中（内蔵GPU向け） | 2048px | 1024 シャドウマップ | DPR 1.0 | 3000m |
| 低（最軽量） | 2048px | なし | DPR 1.0 | 2000m |

自動判定は、ソフトウェアラスタライザとモバイルを「低」、Intel UHD/Iris など内蔵 GPU を「中」、GeForce/Radeon RX/Apple M 系を「高」に割り当てます。

**最大のコストは三角形数ではなくテクスチャ VRAM です。** LOD2 は 115,270 三角形、松江城天守は 43,104 三角形で、ジオメトリはまとめてあるのでドローコールも少ない一方、4096px のアトラス 6 枚は非圧縮 RGBA + ミップで約 511MB を占めます。2048px 版に落とすと約 128MB になり、転送量も 18.2MB → 4.4MB に減ります。

低画質用のアトラスは既存の 4096px 版から生成します（PLATEAU の元データは不要）。UV はアトラス内の正規化座標なので、画像を縮小しても `lod2.bin` 側は変更不要です。

```bash
npm run data:lq            # public/data/lod2_atlas_N_2k.jpg を生成
```

### 実測値（広島版での値）

Intel UHD Graphics（内蔵 GPU）/ 1920×1080 / DPR 1.5 / 本番ビルド / 全 AI 走行時の中央値:

| プリセット | fps | 読み込み |
| --- | --- | --- |
| 高 | 16 | 4.6s |
| 中 | 28 | 4.7s |
| 低 | 35 | 3.9s |

同じシーンを GeForce RTX 3070 Laptop で動かすと「高」でも 93fps 出ます。内蔵 GPU との差が大きいので、公開時は自動判定に任せるのが前提です。なお連続計測すると熱で 3 割ほど落ちるため、上表は各プリセットを冷えた状態で 1 番目に測った値です。

## 開発用デバッグ

URL パラメータでカウントダウン無しに任意地点から開始できます。

```
http://localhost:5182/?debug=1&wp=7&cam=3      # 経由地 7 から俯瞰カメラで開始
http://localhost:5182/?debug=1&idx=2000&cam=0  # スプラインのサンプル番号 2000 から
http://localhost:5182/?debug=1&ai=1&steps=60   # プレイヤーも AI 操作 + 物理を 60 倍速 (低速環境での検証用)
http://localhost:5182/?debug=1&photo=35.4752,133.0506,12,95,160  # 指定した緯度経度を撮影 (注視高さ, 距離, 方位角)
```

`norail=1` `nolod2=1` `nobldg=1` `nodome=1` `nopark=1` `noshadow=1` `lod2basic=1` で要素を切り分けられます。

ポート 5182 が別プロジェクトに使われている場合は `npx vite --port 5183 --strictPort` で起動し、`PORT=5183 node tools/shots.mjs ...` のように `PORT` を渡します（`shots.mjs` と `airace.mjs` が対応しています）。

画面左上（タイマーの下）に FPS を常時表示します。50 以上で緑、30 以上で黄、それ未満は赤。`nofps=1` で非表示にできます。

`?q=low` `?q=medium` `?q=high` で画質プリセットを固定できます（自動判定と localStorage より優先）。

`cam` は 0: 追従, 1: 遠め, 2: ボンネット, 3: 俯瞰。`tools/shots.mjs` と `tools/airace.mjs` は Playwright (SwiftShader) でこれらを自動実行します。

## 構成

```
data/course.json           地点名・看板 (緯度経度・英語名)
data/drawn_route.json      走行線探索の案内線 (plan_route_osm.mjs が生成)
data/course_path.json      道路上を通る走行線 (build_course.mjs が生成)
data/rail.json             鉄道・軌道・ランドマークの実在位置
data/parks.json            公園の輪郭 (OSM)
data/osm/matsue.json       ルート計画用の OSM 道路・鉄道 (tools/fetch_osm.mjs)
tools/download_plateau.mjs PLATEAU CityGML ダウンロード
tools/fetch_osm.mjs        ルート計画用の OSM 道路・鉄道を取得
tools/route_vias.json      コースの経由地 (道路の絞り込み・踏切の手動接続つき)
tools/plan_route_osm.mjs   経由地を OSM の道路網でつなぎ data/drawn_route.json を作る
tools/convert_castle.mjs   松江城天守 (LOD3) → castle.bin / castle.json / テクスチャ
tools/triangulate.mjs      多角形の三角形分割 (LOD2 / LOD3 で共用)
tools/convert_citygml.mjs  CityGML → buildings.json / roads.json / terrain.bin (LOD1)
tools/convert_lod2.mjs     CityGML → lod2.bin / lod2.json (LOD2 実写テクスチャ)
tools/download_lod2_tex.mjs LOD2 テクスチャ画像のダウンロード
tools/build_lod2_atlas.mjs テクスチャアトラス生成 (ベタ塗り面の補正込み)
tools/build_lod2_atlas_lq.mjs 低画質用 2048px アトラス生成 (既存アトラスから)
tools/build_course.mjs     走行線を PLATEAU の道路面の上に載せる (A* 探索)
tools/export_course_geo.mjs コースを GeoJSON / KML / GPX / OSM 地図ページへ書き出す
tools/screenshot.mjs       Playwright による動作確認スクリーンショット
tools/mobile_check.mjs     スマホ表示 (横持ち / 縦持ち) とタッチ操作の確認
tools/shots.mjs            任意地点のスクリーンショット
tools/airace.mjs           全 AI による高速レース検証
tools/nettest.mjs          オンライン対戦の疎通確認 (ブラウザ 2 つ)
tools/presencetest.mjs     トップ画面の「対戦待ち」表示と、待っている人の部屋へ即座に入れるかの確認
tools/make_ogp.mjs         SNS のカード画像 (1200x630, 日本語 / 英語) を作る
tools/build_en_page.mjs    ビルド後に英語版 dist/en/index.html を書き出す (head だけ差し替え)
tools/probe_scene.mjs      画面前方の物体をレイキャストで特定
tools/probe_uv.mjs         UV とアトラス参照先の特定
tools/check_trains.mjs     車両が走行しているかの確認
tools/check_site.mjs       配信物の点検 (dist/ か本番 URL。.bin と .json の食い違い・JS の参照切れ・リレー)
tests/                     vitest の単体テスト (npm test)
src/fetch.ts      アセットの取得 (状態の確認・時間切れ・再試行・長さの検証)
src/telemetry.ts  本番で起きた例外・読み込み失敗・対戦の成否の記録
src/geo.ts        座標変換 (等距円筒近似, 原点 = 松江駅北口の駅前通り)
src/terrain.ts    地形メッシュ + 地面テクスチャ (道路・河川)
src/buildings.ts  LOD1 建物メッシュ (テクスチャ 6 種)
src/textures.ts   プロシージャルテクスチャ
src/track.ts      スプライン・路面・高架・欄干・看板・最寄点検索
src/lod2.ts       LOD2 実写テクスチャ建物の読み込み
src/quality.ts    画質プリセット (GPU 自動判定・localStorage 保存)
src/rail.ts       一畑電車・JR 山陰本線の線路と走行車両
src/landmarks.ts  松江城天守 (PLATEAU LOD3)・嫁ヶ島・夕日スポット
src/parks.ts      公園の芝・樹木 (濠を持つ公園にも対応)
src/net.ts        オンライン対戦 (サーバー無しの P2P, WebRTC) と「対戦待ち」の伝え合い (presence)
src/i18n.ts       日本語 / 英語の切り替え
src/kart.ts       カート物理・モデル・AI
src/items.ts      アイテムボックス・コイン・バナナ・甲羅
src/hud.ts        HUD・ミニマップ
src/audio.ts      WebAudio 効果音
src/main.ts       シーン構築・レース進行
```

## ライセンス

| 対象 | ライセンス |
| --- | --- |
| ソースコード (`src/`, `tools/`, `index.html`) | MIT — [LICENSE](LICENSE) |
| 3D 都市データ (`public/data/`, `data/`) | CC BY 4.0 — [DATA_LICENSE.md](DATA_LICENSE.md) |

データの出典は国土交通省「3D都市モデル（Project PLATEAU）松江市（2024年度）」、ルート計画・鉄道の線形・公園の輪郭は © OpenStreetMap contributors (ODbL) です。加工内容の一覧は [DATA_LICENSE.md](DATA_LICENSE.md) にあります。

本作品は任天堂株式会社とは一切関係がなく、同社が承認・後援するものでもありません。
