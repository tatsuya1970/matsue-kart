---
format: 1920x1080
duration: 30s
message: "この街、全部走れる。— 実在の松江を全開で走るブラウザカートレース"
arc: Feature-Benefit Cascade (hook → name → places ×5 → value → proof → CTA)
audience: X (Twitter) のタイムラインを流し見する人。ゲーム好き・松江/島根ゆかりの人・PLATEAU/3D 都市データに関心のある人
mode: autonomous
music: none
captions: skipped (no narration — on-screen type carries the message; custom BGM is mounted at assembly)
---

## Video direction

- **palette** — frame.md dark register: navy `ink-black` ground/scrims, white `cream` type, brand yellow `fire-orange` as the ONE accent (kickers, rule stubs, the one highlighted word per frame, the stat numerals). The yellow register (yellow slab + navy ink) is used for place-name tags and the CTA slab. No other hues; the game footage supplies the rest of the color (sunset sky, lake blue).
- **type** — display role (Noto Sans JP 900, tight tracking) for Japanese statements and place names; label role (IBM Plex Mono, uppercase, tracked) for kickers like `SPOT 01`; Latin wordmark "MATSUE KART" is heavy italic uppercase, echoing the game's start banner.
- **footage** — every frame except the end card sits on a full-bleed game clip (`class="clip"` background layer, muted, playing from its start). Footage stays full-bright; legibility comes from a navy gradient scrim on the text side only (left or bottom-left), never a full dim.
- **motion grammar** — no narration, so reveals are paced to the **music beat grid (120 BPM → one beat = 0.5s)**: each text piece lands on a beat, never all at t=0. Long-tail `power3` settles; hard, fast arrivals (`expo.out`) for slams. Place tags use one consistent move across frames 03–07 (yellow slab wipes in from the left, then the name slides up inside it) so the run reads as one rhythmic series.
- **rhythm / holds** — frames 01–02 are loud (slams); 03–07 are a fast, uniform "spot" cadence; **frame 08 is the deliberate breather** (slow, calm title over the lake); 09 re-energizes with the stat cascade; 10 lands and holds on the end card for the last ~2s.
- **caption band** — nothing load-bearing in the bottom ~17%.
- **negative list** — no bounce/elastic, no breathing loops, no slow back-half pans or pushes on type, no infinite/repeat motion, no randomness; no second accent color; no Nintendo/"マリオカート" names or look-alike marks; no invented numbers (only: 9.6km, 2周, 最大8人, 無料, インストール不要, PLATEAU 松江市, LOD3); no slideshow (front-load then freeze) and no screensaver (everything floating).

## Frame 1 — この街、全部走れる。

- scene: スタートゲートをくぐって発進するカートの上に「この街、」「全部走れる。」が拍に合わせて叩き込まれる
- voiceover: ""
- duration: 3s
- transition_in: cut
- status: animated
- src: compositions/frames/01-hook.html
- type: hook
- persuasion: Visual spectacle + direct claim
- beat: excitement + curiosity
- blueprint: kinetic-type-beats (Adapt)
- asset_candidates: assets/start.mp4 — スタートゲート「MATSUE KART 松江グランプリ START/FINISH」をくぐって発進、前にライバル
- focal: assets/start.mp4
- roles: start.mp4 = background (full-bright, navy scrim bottom-left only)

narrativeRole: 最初の 1 秒で「実在の街がそのままコース」という約束を突きつける。
keyMessage: この街、全部走れる。

Adapt: keep the kinetic beat-slam signature (short phrases slam in on a shared percussive beat array, resolving on a locked finale); over live footage instead of a flat field, two phrases not five.
Scene 1 (0.0–0.5s): footage only — the kart launches toward the gate; no type yet (the first beat is the engine).
Scene 2 (0.5–1.5s): 「この街、」 slams in on beat 2 at display size, left-aligned in the upper-left third, white on a navy scrim → `kinetic-beat-slam`; a short yellow rule stub snaps in under it.
Scene 3 (1.5–2.5s): 「全部走れる。」 slams in on beat 4 directly below, larger, with 「全部」 inked yellow (the one accent) → `kinetic-beat-slam`; both lines lock.
Scene 4 (2.5–3.0s): held read over the moving footage; subtle jitter only (`sine-wave-loop`, low amplitude). Asymmetric 60/40, type left, road/kart right.
- sfx: impact-hard

## Frame 2 — MATSUE KART

- scene: 真上から見た宍道湖大橋と湖岸の街（地図のような俯瞰）の上に MATSUE KART のワードマークが組み上がる
- voiceover: ""
- duration: 3s
- transition_in: zoom-through
- status: animated
- src: compositions/frames/02-title.html
- type: product_intro
- persuasion: Name the product on a proof-of-reality image
- beat: awe + clarity
- blueprint: logo-assemble-lockup (Adapt)
- asset_candidates: assets/bridge_top.mp4 — 真上からの俯瞰、宍道湖大橋を渡るコースと湖岸の街
- focal: assets/bridge_top.mp4
- roles: bridge_top.mp4 = background (full-bright; centered navy vignette behind the lockup)

narrativeRole: 製品名を「本物の地図のような街」の上で名乗る。約束 (message) の主語を確定させる。
keyMessage: MATSUE KART — 松江グランプリ。

Adapt: keep the lockup-comes-to-exist signature (letters cascade into a centered wordmark); built over the top-down city footage, no separate mark.
Scene 1 (0.0–1.0s): footage with a soft centered navy vignette; the wordmark 「MATSUE KART」 cascades in letter by letter from a slight depth scatter to a heavy italic uppercase lockup, centered, ~55% frame width → `depth-scatter-assemble`.
Scene 2 (1.0–2.0s): on beat 3, the Japanese subtitle 「松江グランプリ」 rises in beneath the wordmark in yellow display → `dynamic-content-sequencing`.
Scene 3 (2.0–3.0s): on beat 5, a mono kicker 「PLATEAU 3D CITY MODEL × MATSUE」 types in above the wordmark with thin yellow rule stubs either side; the lockup holds still. Centered, 3 depth layers (footage / vignette / type).
- sfx: whoosh

## Frame 3 — 島根県庁

- scene: 県庁の看板をくぐって北上、左奥に城山と天守。黄色い地名タグ「島根県庁」
- voiceover: ""
- duration: 2s
- transition_in: cut
- status: animated
- src: compositions/frames/03-pref.html
- type: feature_showcase
- persuasion: Show-don't-tell proof (real landmark 1)
- beat: recognition
- blueprint: compose
- asset_candidates: assets/pref.mp4 — 県道37号を北上し「島根県庁」看板をくぐる、左奥に松江城、ライバル並走
- focal: assets/pref.mp4
- roles: pref.mp4 = background (full-bright)

narrativeRole: 実在スポット 1 つ目。地元の人が「ここ知ってる」と反応する。
keyMessage: 島根県庁の前も走れる。

Compose (the SPOT tag series, shared by frames 3–7): a place-name tag in the lower-left third (above the caption band) — a yellow slab wipes in from the left, then the name rises inside it in navy display; a mono kicker sits above the slab.
Scene 1 (0.0–0.5s): footage only.
Scene 2 (0.5–1.0s): on beat 2, mono kicker 「SPOT 01」 in yellow and the yellow slab wipes in from the left edge → `css-marker-patterns` (highlight sweep).
Scene 3 (1.0–2.0s): on beat 3, 「島根県庁」 rises into the slab in navy display (h1 size) → `dynamic-content-sequencing`; holds.

## Frame 4 — 松江城

- scene: 松江城天守（PLATEAU LOD3）の周りをゆっくり回る空撮。大きく「松江城」、補足に LOD3
- voiceover: ""
- duration: 3s
- transition_in: blur-crossfade
- status: animated
- src: compositions/frames/04-castle.html
- type: feature_showcase
- persuasion: Authority by association (national treasure, official 3D data)
- beat: awe
- blueprint: compose
- asset_candidates: assets/castle.mp4 — 松江城天守 (PLATEAU LOD3) の周回空撮、城山の緑と街並み、奥に宍道湖
- focal: assets/castle.mp4
- roles: castle.mp4 = background (full-bright, the keep stays unobstructed at center-left)

narrativeRole: 最大の見せ場。国宝の天守が PLATEAU の本物の 3D データで立っていることを示す。
keyMessage: 松江城の天守は PLATEAU の LOD3 モデル。

Compose (SPOT tag series, larger variant): the castle is the hero, so type sits right and stays small enough to leave the keep clear.
Scene 1 (0.0–1.0s): footage only — let the orbit read.
Scene 2 (1.0–1.5s): on beat 3, 「SPOT 02」 kicker + yellow slab wipe in, right third, upper-middle → `css-marker-patterns`.
Scene 3 (1.5–2.0s): 「松江城」 rises into the slab (h1) → `dynamic-content-sequencing`.
Scene 4 (2.0–3.0s): on beat 5, a white body-size line 「天守は PLATEAU の LOD3 モデル」 fades up beneath the slab with a yellow `/` marker → `dynamic-content-sequencing`; holds. Asymmetric 40/60 (keep left, type right).

## Frame 5 — 松江市役所

- scene: 国道431号を東へ、宍道湖を右に見ながら市役所の看板を通過
- voiceover: ""
- duration: 2s
- transition_in: cut
- status: animated
- src: compositions/frames/05-cityhall.html
- type: feature_showcase
- persuasion: Show-don't-tell proof (real landmark 3)
- beat: momentum
- blueprint: compose
- asset_candidates: assets/cityhall.mp4 — 国道431号を東へ「松江市役所」看板を通過、右に宍道湖、コイン
- focal: assets/cityhall.mp4
- roles: cityhall.mp4 = background (full-bright)

narrativeRole: スポットの連打でテンポを作る。
keyMessage: 市役所の前も。

Compose (SPOT tag series): identical placement and moves to frame 3.
Scene 1 (0.0–0.5s): footage only.
Scene 2 (0.5–1.0s): 「SPOT 03」 kicker + yellow slab wipe in, lower-left third → `css-marker-patterns`.
Scene 3 (1.0–2.0s): 「松江市役所」 rises into the slab → `dynamic-content-sequencing`; holds.

## Frame 6 — 宍道湖大橋

- scene: 宍道湖大橋の上でライバル 4 台と競り合う
- voiceover: ""
- duration: 2.5s
- transition_in: cut
- status: animated
- src: compositions/frames/06-bridge.html
- type: feature_showcase
- persuasion: Show-don't-tell proof (real landmark 4 + racing)
- beat: excitement
- blueprint: compose
- asset_candidates: assets/bridge.mp4 — 宍道湖大橋の上でライバル 4 台と競り合う、両側に宍道湖
- focal: assets/bridge.mp4
- roles: bridge.mp4 = background (full-bright)

narrativeRole: 景色の中で「レース」をしていることを見せる。
keyMessage: 宍道湖大橋でバトル。

Compose (SPOT tag series) + one extra beat word.
Scene 1 (0.0–0.5s): footage only.
Scene 2 (0.5–1.0s): 「SPOT 04」 kicker + yellow slab wipe in, lower-left third → `css-marker-patterns`.
Scene 3 (1.0–1.5s): 「宍道湖大橋」 rises into the slab → `dynamic-content-sequencing`.
Scene 4 (1.5–2.5s): on beat 4, a small white italic 「BATTLE!」 stamps in at the slab's upper-right corner with a yellow outline → `kinetic-beat-slam`; holds.
- sfx: impact-soft

## Frame 7 — 宍道湖夕日スポット

- scene: 国道9号の湖岸「宍道湖夕日スポット」の看板へ、右に湖と展望デッキ
- voiceover: ""
- duration: 2.5s
- transition_in: cut
- status: animated
- src: compositions/frames/07-sunset.html
- type: feature_showcase
- persuasion: Show-don't-tell proof (real landmark 5)
- beat: aspiration
- blueprint: compose
- asset_candidates: assets/sunset.mp4 — 国道9号の湖岸「宍道湖夕日スポット」看板へ、右に宍道湖と展望デッキ
- focal: assets/sunset.mp4
- roles: sunset.mp4 = background (full-bright)

narrativeRole: 松江を代表する景色でスポット連打を締める。
keyMessage: 夕日スポットまで走る。

Compose (SPOT tag series): the name is long, so the slab is wider; same moves.
Scene 1 (0.0–0.5s): footage only.
Scene 2 (0.5–1.0s): 「SPOT 05」 kicker + yellow slab wipe in, lower-left third → `css-marker-patterns`.
Scene 3 (1.0–2.5s): 「宍道湖夕日スポット」 rises into the slab (h1, fit to ≤ 60% width) → `dynamic-content-sequencing`; holds.

## Frame 8 — 夕日の宍道湖を、全開で。

- scene: 宍道湖に浮かぶ嫁ヶ島の空撮。静かに一文だけ
- voiceover: ""
- duration: 2.5s
- transition_in: crossfade
- status: animated
- src: compositions/frames/08-lake.html
- type: benefit_highlight
- persuasion: Future pacing (imagine driving here)
- beat: peace → anticipation
- blueprint: titlecard-reveal (Reproduce)
- asset_candidates: assets/lake.mp4 — 宍道湖に浮かぶ嫁ヶ島 (松と鳥居) の空撮、夕方の空
- focal: assets/lake.mp4
- roles: lake.mp4 = background (full-bright; soft navy gradient at the top for the title)

narrativeRole: 息継ぎ。速さの連打のあとに景色の美しさを一瞬だけ見せ、次の盛り上がりに備える。
keyMessage: 夕日の宍道湖を、全開で。

Reproduce: one clean two-part title, one slide-up crossfade, then held still — low motion is the point.
Scene 1 (0.0–0.5s): footage only (the island drifts slowly with the orbit).
Scene 2 (0.5–1.5s): 「夕日の宍道湖を、」 slides up and fades in, centered in the upper third, white display (h2) → `dynamic-content-sequencing` (single slow move).
Scene 3 (1.5–2.5s): on beat 4, 「全開で。」 slides up beneath it in yellow; both hold completely still.

## Frame 9 — 数字で見る

- scene: 集団を追う走行映像を暗めに敷き、3 枚の数字カードが順に組み上がる
- voiceover: ""
- duration: 4.5s
- transition_in: zoom-through
- status: animated
- src: compositions/frames/09-stats.html
- type: benefit_highlight
- persuasion: Value stacking (rule of three)
- beat: excitement → confidence
- blueprint: grid-card-assemble (Adapt)
- asset_candidates: assets/pack.mp4 — 街中の直線で前を走る集団 (最大 8 台) を追う、引きのカメラ
- focal: assets/pack.mp4
- roles: pack.mp4 = background (dim ~45% under a navy wash so the cards read)

narrativeRole: 遊ぶ理由を 3 つの事実で積む。
keyMessage: 9.6km × 2周 / 最大 8人でオンライン対戦 / インストール不要。

Adapt: keep the staggered-cascade signature (items self-assemble one by one into a row and hold); three top-border stat cards (frame.md `stat-card`) instead of a tile grid, one per beat.
Scene 1 (0.0–0.5s): the footage dims under a navy wash; a mono kicker 「MATSUE GRAND PRIX」 types in top-left → `dynamic-content-sequencing`.
Scene 2 (0.5–1.5s): card 1 rises into the left slot — numeral 「9.6km」 in yellow stat-value (counts up 0.0 → 9.6 → `counting-dynamic-scale`) with label 「× 2周」 beside it and a white body line 「実在の道路で 1 周」.
Scene 3 (1.5–2.5s): on beat 4, card 2 rises into the center slot — 「8人」 (counts 1 → 8) + 「オンライン対戦」.
Scene 4 (2.5–3.5s): on beat 6, card 3 rises into the right slot — 「0円」 in yellow + 「インストール不要・ブラウザで遊べる」.
Scene 5 (3.5–4.5s): the three cards hold in a triptych across the upper 60% of the frame, top hairlines drawn → `svg-path-draw`; still.
- sfx: tick

## Frame 10 — ブラウザで、今すぐ。

- scene: 紺の地に黄色いスラブ。MATSUE KART のロックアップ、URL、「ブラウザで今すぐ・無料」、PLATEAU のクレジット
- voiceover: ""
- duration: 5s
- transition_in: crossfade
- status: animated
- src: compositions/frames/10-cta.html
- type: cta
- persuasion: Friction reduction (free, no install, one URL)
- beat: urgency-to-act
- blueprint: logo-assemble-lockup (Adapt)
- asset_candidates: assets/station.mp4 — 松江駅前へ戻る直線、スタートゲートとライバル
- focal: assets/station.mp4
- roles: station.mp4 = background (plays full-bright for the first beats, then the navy end card wipes over it)

narrativeRole: 行動に変える。URL を読める時間だけ止める。
keyMessage: tatsuya1970.github.io/matsue-kart — 無料・インストール不要。

Adapt: keep the lockup-then-URL signature (the wordmark builds, a push resolves on the URL/CTA); the footage is wiped away by the navy ground first.
Scene 1 (0.0–1.0s): station footage (the kart heads back to the start gate); on beat 2 a full-frame navy panel wipes across from the right, covering the footage (a plain transform wipe on the panel).
Scene 2 (1.0–2.0s): 「MATSUE KART」 heavy italic wordmark assembles center-upper letter by letter with 「松江グランプリ」 beneath in yellow → `dynamic-content-sequencing`.
Scene 3 (2.0–3.0s): on beat 5, a yellow slab springs open below the lockup carrying the URL 「tatsuya1970.github.io/matsue-kart」 in navy (mono-free display, ≥ 3cqw) → `spring-pop-entrance` (smooth settle, no overshoot).
Scene 4 (3.0–3.5s): on beat 7, white line 「ブラウザで今すぐ・無料・インストール不要」 rises beneath the slab → `dynamic-content-sequencing`.
Scene 5 (3.5–5.0s): small credit line 「3D都市モデル: 国土交通省 PLATEAU（松江市 2024）」 fades in at the bottom of the top-83% area; everything holds still to the end (the final frame may fade to navy in the last 0.3s).
- sfx: impact-soft
