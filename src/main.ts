// Matsue Kart — メイン
import * as THREE from 'three';
import { loadTerrain, type Terrain } from './terrain';
import { Track } from './track';
import { buildBuildings, type BuildingsData } from './buildings';
import { Kart, type RacerDef, type ItemType } from './kart';
import { ItemSystem } from './items';
import { NetSession, Presence, turnConfigured, newOpenCode, normalizeRoomCode, relayStatus, loadTurn, hasTurn, turnState, natProbe, inAppBrowser, COUNTDOWN_SEC, type LobbyInfo, type NetEvent, type NatKind, type Pose, type RoomKind } from './net';
import { showRanking, eligibleRun, setupRankingButton } from './ranking';
import { Hud, drawCourseMap } from './hud';
import { InputManager } from './input';
import { AudioSystem } from './audio';
import { buildRail, type RailSystem } from './rail';
import { Parks } from './parks';
import { loadMatsueCastle, buildYomegashima, buildSunsetSpot, landmarkBlocksBuilding } from './landmarks';
import { loadLod2 } from './lod2';
import { rng, lerp, clamp, assetUrl, WAYPOINTS, llToXZ } from './geo';
import { resolveQuality, saveQuality, allPresets, type QualityLevel } from './quality';
import { t, lang, isJa, setLang, applyDomLang } from './i18n';
import { fetchJson } from './fetch';
import { installErrorHandlers, report, reportError, setTelemetryContext } from './telemetry';
import { storageGet, storageSet } from './storage';

installErrorHandlers();

// 1 周約 9km × 2 周 (広島版は 7.3km × 2 周)
const LAPS = 2;
// AI の名前は宍道湖七珍と松江城の別名 (千鳥城) から
const RACERS: RacerDef[] = [
  { name: isJa ? 'あなた' : 'You', color: 0xe63946, accent: 0xffffff, isPlayer: true, skill: 1 },
  { name: isJa ? 'しじみ' : 'Shijimi', color: 0x3d3b5c, accent: 0xffd166, isPlayer: false, skill: 0.95 },
  { name: isJa ? 'すずき' : 'Suzuki', color: 0x3a86ff, accent: 0xffffff, isPlayer: false, skill: 0.85 },
  { name: isJa ? 'しらうお' : 'Shirauo', color: 0xe9eef2, accent: 0x2b2d42, isPlayer: false, skill: 0.75 },
  { name: isJa ? 'うなぎ' : 'Unagi', color: 0x5b4a2f, accent: 0xffd60a, isPlayer: false, skill: 0.7 },
  { name: isJa ? 'ちどり' : 'Chidori', color: 0x1b1b1b, accent: 0xf1faee, isPlayer: false, skill: 0.6 },
  { name: isJa ? 'あまさぎ' : 'Amasagi', color: 0x2a9d8f, accent: 0xe9c46a, isPlayer: false, skill: 0.55 },
  { name: isJa ? 'もろげ' : 'Moroge', color: 0xf4845f, accent: 0x6c757d, isPlayer: false, skill: 0.45 },
];

type State = 'loading' | 'title' | 'countdown' | 'race' | 'finish';

/**
 * タイトル画面の画質ボタン。アトラスの解像度が変わるので、切り替えは再読み込みで反映する。
 * 読み込み中でも押せるようにしてある (遅い環境で待たされずに下げられる)。
 */
function setupQualityButtons(current: QualityLevel): void {
  const host = document.getElementById('qualityBtns');
  if (!host) return;
  for (const p of allPresets()) {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.setAttribute('aria-pressed', String(p.level === current));
    b.addEventListener('click', () => {
      if (p.level === current) return;
      saveQuality(p.level);
      // ?q= が付いていると localStorage より優先されるので外してから再読み込みする
      const url = new URL(location.href);
      url.searchParams.delete('q');
      location.replace(url.toString());
    });
    host.appendChild(b);
  }
}

/**
 * 言語の切り替えボタン。navigator.language で自動判定しているが、
 * 日本語環境から英語で見たい人 (その逆も) がいるので必ず出す。
 * 地名の看板やアトラスを作り直す必要があるので、切り替えは再読み込みで反映する。
 */
function setupLangButton(): void {
  const host = document.getElementById('langSwitch');
  if (!host) return;
  const b = document.createElement('button');
  b.textContent = t('lang.other');
  b.addEventListener('click', () => setLang(isJa ? 'en' : 'ja'));
  host.appendChild(b);
}

/**
 * スマホでは全画面にして横向きに固定する (Android の Chrome)。iPhone は全画面 API も
 * 向きの固定も無いので何も起きず、縦のときは CSS の #rotateHint で横向きを勧める。
 * どちらもユーザー操作の中でしか呼べないので PLAY ボタンの click から呼ぶ。
 */
function goLandscape(): void {
  if (!matchMedia('(pointer: coarse)').matches) return;
  const el = document.documentElement;
  const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  const fs = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : Promise.resolve();
  fs.then(() => orientation.lock?.('landscape')).catch(() => { /* 対応していない環境ではそのまま */ });
}

async function main() {
  applyDomLang();
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
  const openBtn = document.getElementById('openBtn') as HTMLButtonElement;
  const mainButtons = document.getElementById('mainButtons')!;
  const overlay = document.getElementById('overlay')!;
  const progressBar = document.getElementById('progressBar')!;
  const results = document.getElementById('results')!;
  const resultTable = document.getElementById('resultTable')!;
  const setProgress = (p: number, label?: string) => { progressBar.style.width = `${Math.round(p * 100)}%`; if (label) startBtn.textContent = label; };

  // ---- レンダラー / シーン ----
  const dbg = new URLSearchParams(location.search);
  const quality = resolveQuality(dbg);
  console.log(`画質: ${quality.level} (アトラス ${quality.halfAtlas ? '2048' : '4096'}px / 影 ${quality.shadows ? 'on' : 'off'})`);
  setTelemetryContext({ quality: quality.level, lang });
  setupQualityButtons(quality.level);
  setupLangButton();
  // ビルドの識別。古いページがキャッシュに残っていると新しい側の「対戦待ち」を読めないので、
  // どの版が動いているかを隅に出しておく (vite.config.ts の define)
  const buildInfo = document.getElementById('buildInfo');
  if (buildInfo) buildInfo.textContent = `build ${__BUILD__.commit} (${new Date(__BUILD__.time).toLocaleString()})`;
  // トップ画面の「対戦待ち」表示と対戦は、公開リレー (nostr) を通じて他のプレイヤーの
  // ブラウザと直接つなぐ。つなぐと IP アドレスが相手・リレーの運営者・STUN / TURN の
  // サーバーに伝わるので、利用者が許可するまで (「対戦待ちの人を表示する」か対戦PLAY を
  // 押すまで) presence・リレー・STUN・TURN の資格情報 API のどれにも接続しない。
  // 許可は覚えておき、次回からは読み込みの裏で先に探し始める (相手とつながるまで
  // 8〜19 秒かかるため)。?debug=1 はロビーを通らないので入らない。
  let presence: Presence | null = null;
  // startNet の中でだけ代入するので、null に絞り込まれないよう型を明示する
  let turnLoad = null as Promise<number> | null;
  /** TURN の資格情報を取り終えたか。取り終えるまでは turn.json があるかで対戦PLAY の可否を出す */
  let turnSettled = false;
  /** NAT の種類と TURN の可否 (診断表示用)。調べ終わるまで null */
  let netProbe: { nat: NatKind; relay: boolean } | null = null;
  const NET_CONSENT_KEY = 'mk.netConsent';
  let netConsent = storageGet(NET_CONSENT_KEY) === '1';
  let netReady: Promise<void> | null = null;
  /** presence に入ったときに表示側が差し込む処理 (表示の準備より先に入ることがあるため) */
  let onPresenceStart: (() => void) | null = null;
  /** 接続を始める (何度呼んでも 1 回だけ)。許可を得てから呼ぶ */
  function startNet(): Promise<void> {
    if (dbg.get('debug')) return Promise.resolve();
    return netReady ??= (async () => {
      // TURN の設定を先に読む。部屋に入るときに渡す必要があるため
      turnLoad = loadTurn();
      void turnLoad.then(() => { turnSettled = true; });
      await Promise.race([turnLoad, new Promise(r => setTimeout(r, 4000))]);
      try { presence = new Presence(); } catch (e) { console.warn('対戦待ちの確認に入れませんでした', e); }
      void natProbe().then(r => { netProbe = r; });
      onPresenceStart?.();
    })();
  }
  /** 通信を許可して接続を始める (ボタンを押したとき) */
  function grantNet(): Promise<void> {
    netConsent = true;
    storageSet(NET_CONSENT_KEY, '1');
    return startNet();
  }
  // 対戦PLAY を出せるか (TURN があるか) は、許可の前でも同じサイトの turn.json だけで見当がつく
  const turnListed = dbg.get('debug') ? false : await turnConfigured();
  if (netConsent) await startNet();
  // 低画質では MSAA も切る (内蔵 GPU では帯域を食う)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.level !== 'low', powerPreference: 'high-performance' });
  watchContextLoss(canvas);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = quality.shadows && !dbg.get('noshadow');
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  // 宍道湖は夕日の名所なので、西日の差す夕方寄りの空にする
  const skyColor = new THREE.Color(0xb9cde0);
  scene.background = skyColor;
  scene.fog = new THREE.Fog(0xe3d2bf, 400, quality.drawDistance);
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.5, quality.drawDistance * 1.45);
  const fit = () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); };
  window.addEventListener('resize', fit);
  // iOS は回転直後の resize で回転前の寸法を返すことがあるので、少し待ってもう一度合わせる
  window.addEventListener('orientationchange', () => setTimeout(fit, 300));

  const hemi = new THREE.HemisphereLight(0xd6e2f0, 0x8f7760, 0.9);
  scene.add(hemi);
  /** 太陽の向き (西南西の少し高いところ。影が東へ長く伸びる) */
  const SUN_DIR = new THREE.Vector3(-600, 330, 180).normalize();
  const sun = new THREE.DirectionalLight(0xffdcb4, 2.3);
  sun.position.copy(SUN_DIR).multiplyScalar(600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  sun.shadow.camera.near = 50; sun.shadow.camera.far = 1400;
  sun.shadow.camera.left = -160; sun.shadow.camera.right = 160; sun.shadow.camera.top = 160; sun.shadow.camera.bottom = -160;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.5;
  scene.add(sun); scene.add(sun.target);
  // 空 (グラデーションドーム)
  const skyGeo = new THREE.SphereGeometry(5000, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x4f7fbf) }, bottom: { value: new THREE.Color(0xf7d3a8) } },
    vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying float h; void main(){ float t = clamp(h*2.2, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, pow(t,0.7)),1.0); }',
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  // 西の空の太陽 (空と一緒にカメラへ追従させる)
  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(150, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff0c8, fog: false, depthWrite: false }),
  );
  sunDisc.position.copy(SUN_DIR).multiplyScalar(4600);
  sunDisc.lookAt(0, 0, 0);
  sky.renderOrder = -2;
  sunDisc.renderOrder = -1;
  sky.add(sunDisc);
  scene.add(sky);

  // ---- データ読み込み ----
  setProgress(0.05, t('load.terrain'));
  const terrain: Terrain = await loadTerrain(p => setProgress(0.05 + p * 0.15));
  setProgress(0.2, t('load.buildings'));
  const [bData, rData] = await Promise.all([
    fetchJson<BuildingsData>(assetUrl('data/buildings.json')),
    fetchJson<{ items: number[][] }>(assetUrl('data/roads.json')),
  ]);
  setProgress(0.38, t('load.parks'));
  await nextFrame();
  // 濠を掘り、公園内の誤った水面を埋める。走行線の標高にも効かせるため Track より先。
  const parks = new Parks(terrain);
  parks.carve();
  setProgress(0.4, t('load.course'));
  await nextFrame();
  const track = new Track(terrain);
  // 切り通しで路面にはみ出す斜面を削る (建物の接地高さにも効くので配置より先)
  terrain.flattenAlong(track);
  setProgress(0.44, t('load.ground'));
  await nextFrame();
  // 芝・濠 → 道路 → コース帯 の順に重ねる
  scene.add(terrain.build(
    rData.items,
    (ctx, sx, sz) => track.drawMask(ctx, sx, sz, terrain.xMin, terrain.zMin),
    (ctx, sx, sz) => parks.draw(ctx, sx, sz, terrain.xMin, terrain.zMin),
  ));
  scene.add(makeHills(terrain));
  // デバッグ用トグル: ?norail=1 / ?nolod2=1 / ?nodome=1 / ?nobldg=1
  const params = new URLSearchParams(location.search);
  setProgress(0.5, t('load.rail'));
  await nextFrame();
  const rail: RailSystem = buildRail(terrain, track);
  if (!params.get('norail')) scene.add(rail.group);
  setProgress(0.56, t('load.bldg', bData.count));
  await nextFrame();
  let stat = '';
  const bldgGroup = buildBuildings(bData, track, terrain, s => (stat = s), ring => rail.blocksBuilding(ring) || landmarkBlocksBuilding(ring) || parks.blocksBuilding(ring));
  if (!params.get('nobldg')) scene.add(bldgGroup);
  setProgress(0.68, stat);
  await nextFrame();
  // PLATEAU LOD2 (実写テクスチャ)
  if (quality.lod2 && !params.get('nolod2')) {
    try {
      const lod2 = await loadLod2(quality, (p, label) => setProgress(0.68 + p * 0.24, label));
      scene.add(lod2.group);
      console.log(`LOD2: ${lod2.triangles} 三角形 / アトラス ${lod2.meta.atlases.length} 枚`);
    } catch (e) {
      console.warn('LOD2 の読み込みに失敗しました', e);
      reportError('lod2', e);
    }
  }
  setProgress(0.94, t('load.landmarks'));
  await nextFrame();
  if (!params.get('nodome')) {
    try {
      scene.add(await loadMatsueCastle());
    } catch (e) {
      console.warn('松江城天守の読み込みに失敗しました', e);
      reportError('castle', e);
    }
    scene.add(buildYomegashima(terrain));
    scene.add(buildSunsetSpot(terrain, track));
  }
  if (!params.get('nopark')) scene.add(parks.build(bData, track));
  scene.add(track.buildMesh());

  // ---- カート / アイテム ----
  const rand = rng(20240803);
  // def は RACERS の要素そのものなので、オンライン対戦で名前を差し替える前に控える
  const DEFAULT_NAMES = RACERS.map(r => r.name);
  const karts = RACERS.map(d => new Kart(d));
  // オンライン対戦では自分の枠が 0 とは限らないので差し替える
  let player = karts[0];
  const startOrder = [3, 1, 0, 2, 4, 5, 6, 7]; // グリッド順 (index of karts)
  startOrder.forEach((ki, slot) => {
    const row = Math.floor(slot / 2), col = slot % 2;
    const idx = track.n - 8 - row * 5;
    karts[ki].placeAt(track, idx, col === 0 ? -3.5 : 3.5);
    scene.add(karts[ki].mesh);
  });
  const items = new ItemSystem(track, rand);
  scene.add(items.group);
  const hud = new Hud(track, LAPS);
  const titleMap = document.getElementById('titleMap') as HTMLCanvasElement;
  drawCourseMap(titleMap, track);
  const input = new InputManager();
  const audio = new AudioSystem();
  input.onMute = () => audio.toggleMute();
  let camMode = 0;
  input.onCamera = () => { camMode = (camMode + 1) % 4; };

  // ---- オンライン対戦 ----
  // 自分のカートだけ物理を回し、他人のカートは受信位置へ寄せる。
  // 空き枠の AI はホストが回して配る。
  let net: NetSession | null = null;
  let mySlot = 0;

  /** そのカートを自分の画面で動かしてよいか (自分のカート + ホストなら空き枠の AI) */
  function isLocal(k: Kart): boolean {
    if (!net) return true;
    const i = karts.indexOf(k);
    if (i === mySlot) return true;
    return net.isHost && i >= net.order.length;
  }

  // ---- イベント ----
  const kartEvents = {
    onLap: (k: Kart) => {
      if (!k.def.isPlayer) { if (k.lap > LAPS && !k.finished) { k.finished = true; k.finishTime = raceTime; } return; }
      if (k.lap > LAPS) { if (!k.finished) finishRace(); }
      else if (k.lap >= 2) { hud.showCenter(`LAP ${k.lap}`, 1.2); audio.lap(); if (k.lap === LAPS) hud.showLandmark(t('race.finalLap')); }
    },
    onBoost: (k: Kart) => { if (k.def.isPlayer) audio.boost(); },
    onBump: (k: Kart, f: number) => { if (k.def.isPlayer && f > 8) audio.bump(); },
    onRouletteDone: (k: Kart) => { k.item = items.roll(k.rank, karts.length); },
  };
  const itemEvents = {
    onPickup: (k: Kart) => { if (k.def.isPlayer) audio.pickup(); },
    onCoin: (k: Kart) => { if (k.def.isPlayer) audio.coin(); },
    onHit: (v: Kart, _by: Kart | null) => {
      if (v.def.isPlayer) { audio.hit(); v.coins = Math.max(0, v.coins - 2); }
      // 被弾は持ち主の画面だけで決めるので、結果を全員へ配る
      if (net?.started && isLocal(v)) net.emit({ t: 'hit', slot: karts.indexOf(v) });
    },
    onUse: (k: Kart) => { if (k.def.isPlayer) audio.useItem(); },
    onBoost: (k: Kart) => { if (k.def.isPlayer) audio.boost(); },
  };

  // ---- レース状態 ----
  let state: State = 'title';
  let raceTime = 0;
  let countdown = 0;
  let lastLabel = -1;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  let camFov = 70;

  function finishRace() {
    player.finished = true; player.finishTime = raceTime;
    if (net?.started) net.emit({ t: 'fin', slot: mySlot, time: raceTime });
    state = 'finish';
    audio.finish();
    hud.showCenter(t('race.finish'), 3);
    setTimeout(showResults, 2500);
  }
  function showResults() {
    const sorted = [...karts].sort((a, b) => (a.finished && b.finished) ? a.finishTime - b.finishTime : a.finished ? -1 : b.finished ? 1 : b.progress - a.progress);
    resultTable.innerHTML = sorted.map((k, i) => {
      const t = k.finished ? fmt(k.finishTime) : '--:--.--';
      return `<tr style="${k.def.isPlayer ? 'color:#ffd83d;font-weight:800' : ''}"><td>${i + 1}</td><td><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#${k.def.color.toString(16).padStart(6, '0')}"></span></td><td>${esc(k.def.name)}</td><td>${t}</td></tr>`;
    }).join('');
    results.style.display = 'block';
    // ゴールタイムのランキング (名前を入れて登録する。src/ranking.ts)
    if (player.finished) {
      showRanking({
        time: player.finishTime, name: nameInput.value, canSubmit: eligibleRun(location.search),
        onName: n => { nameInput.value = n; storageSet('mk.name', n); },
      });
    }
    titleMap.style.display = 'none';   // リザルトではコース図を隠す
    document.getElementById('online')!.style.display = 'none';
    overlay.style.display = 'flex';
    mainButtons.style.display = '';
    openBtn.style.display = 'none';   // リザルトでは「もう一度走る」だけ出す
    startBtn.style.display = '';
    startBtn.textContent = t('btn.again');
    startBtn.disabled = false;
    startBtn.onclick = () => location.reload();
    presence?.set({ s: 'title' });   // レースは終わったので「見ている人」に戻す
  }
  const fmt = (t: number) => { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`; };

  report('load', 'ready', { ms: Math.round(performance.now()) });
  startBtn.disabled = false;
  startBtn.textContent = t('btn.solo');
  setupRankingButton();   // トップ画面のランキングのボタン
  const turnAlert = document.getElementById('turnAlert')!;
  const updateOnlineAvailability = () => {
    const ready = turnSettled ? hasTurn() : turnListed;
    openBtn.disabled = !ready;
    openBtn.textContent = ready ? t('btn.online') : t('btn.onlineUnavailable');
    openBtn.title = ready ? '' : t('net.turnRequired');
    // 中継が止まっている理由を文で出す (1 日の上限に達した / 設定を取れない)。
    // ボタンの title はスマホでは見えないので、ボタンの近くの枠に出す
    const st = turnSettled ? turnState() : 'unknown';
    const why = st === 'capped' ? t('net.turnCapped') : st === 'error' ? t('net.turnError') : '';
    turnAlert.textContent = why;
    turnAlert.style.display = why ? '' : 'none';
  };
  updateOnlineAvailability();
  // 4 秒で画面のロードを先へ進めた後に TURN 設定 API が応答した場合も復帰させる。
  void turnLoad?.then(updateOnlineAvailability);
  startBtn.onclick = () => {
    goLandscape();
    presence?.set({ s: 'race' });
    overlay.style.display = 'none';
    audio.start();
    state = 'countdown'; countdown = 3.999;
    audio.countdown();
  };
  input.onAny = () => audio.start();

  // ---- オンライン対戦の UI と同期 ----
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const onlineHome = byId<HTMLDivElement>('onlineHome');
  const onlineRoom = byId<HTMLDivElement>('onlineRoom');
  const nameInput = byId<HTMLInputElement>('playerName');
  const playerList = byId<HTMLUListElement>('playerList');
  const goBtn = byId<HTMLButtonElement>('goBtn');
  const netNote2 = byId<HTMLDivElement>('netNote2');
  const countNum = byId<HTMLSpanElement>('countNum');
  const countLabel = byId<HTMLSpanElement>('countLabel');
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

  nameInput.value = storageGet('mk.name') ?? '';
  // ?room=XXXXX 付きのリンクなら合言葉の部屋へ (UI からは隠したが経路は残してある)
  const linkRoom = normalizeRoomCode(params.get('room') ?? '');
  /** 席に着いた人間の数。増えたら「対戦相手が来た」と知らせる */
  let lastHumans = 0;
  /** 対戦待ちで入ったときの名前 (presence に載せる) */
  let myName = '';

  /** 名前の吹き出し (誰がどのカートか分かるように) */
  const labels: (THREE.Sprite | null)[] = karts.map(() => null);
  function setLabel(i: number, text: string) {
    const old = labels[i];
    if (old) { karts[i].mesh.remove(old); old.material.map?.dispose(); old.material.dispose(); labels[i] = null; }
    if (!text) return;
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const c = cv.getContext('2d')!;
    c.fillStyle = 'rgba(0,0,0,.55)';
    c.beginPath(); c.roundRect(4, 8, 248, 48, 12); c.fill();
    c.font = 'bold 32px system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#fff';
    c.fillText(text, 128, 33, 232);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(5.2, 1.3, 1);
    sp.position.set(0, 3.1, 0);
    sp.renderOrder = 5;
    karts[i].mesh.add(sp);
    labels[i] = sp;
  }

  function renderLobby() {
    if (!net) return;
    const hostId = net.host;
    const ids = net.order.length ? net.order : net.peerIds();
    playerList.innerHTML = ids.map((id, i) => {
      const col = '#' + RACERS[i % RACERS.length].color.toString(16).padStart(6, '0');
      const tags = [id === net!.selfId ? t('lobby.you') : '', id === hostId ? t('lobby.host') : ''].filter(Boolean).join(' / ');
      return `<li><span class="dot" style="background:${col}"></span>${esc(net!.names[id] ?? t('lobby.connecting'))}<span class="tag">${tags}</span></li>`;
    }).join('');
    const ai = Math.max(0, RACERS.length - ids.length);
    // 公開ロビーで 1 人のときは「相手が来るまで待つ」ことを伝える
    netNote2.textContent = net.kind === 'open' && ids.length < 2
      ? t('lobby.alone', COUNTDOWN_SEC)
      : t('lobby.status', ids.length, ai) + (net.isHost ? '' : t('lobby.waitHost'));
    goBtn.disabled = !net.isHost || net.started;
  }

  /**
   * 公開ロビーのカウントダウン。2 人そろった時点でホストが締切を決めて座席表に載せる
   * (LobbyInfo.deadline)。1 人のあいだは締切が無く「対戦相手を待っています」と出す。
   * 発走の合図はホストが出して足並みを揃え、締切を 2 秒過ぎても合図が来なければ
   * 自分で始める (ホストが落ちたとき用)。合言葉の部屋にはカウントダウンが無い。
   */
  function tickCountdown() {
    if (!net || net.started) return;
    const dl = net.deadline;
    countLabel.style.display = net.kind === 'open' ? '' : 'none';
    countNum.style.display = net.kind === 'open' && dl ? '' : 'none';
    if (!dl) { countLabel.textContent = t('lobby.waitingPeople'); return; }
    countLabel.textContent = t('lobby.countLabel');
    const left = (dl - Date.now()) / 1000;
    countNum.textContent = String(Math.max(0, Math.ceil(left)));
    countNum.classList.toggle('soon', left <= 5);
    if (left <= 0 && net.isHost) net.startRace();
    else if (left <= -2) net.startLocally();
  }
  setInterval(tickCountdown, 200);

  // ---- 「対戦相手が来た」の通知 ----
  // ロビーで待っているとき (別のタブを見ていることも多い) に相手が入ったら、短い
  // ジングルを鳴らし、タブが裏ならタブの見出しを点滅させる。トップ画面にいるあいだに
  // 待ち人が現れたときも同じように知らせる。音はページを一度でも触っていないと出せない
  // (ブラウザの自動再生制限) ので、クリックやキー入力のたびに AudioContext を起こす。
  document.addEventListener('pointerdown', () => audio.start());
  const baseTitle = document.title;
  let flashTimer = 0;
  const stopFlash = () => { clearInterval(flashTimer); flashTimer = 0; document.title = baseTitle; };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) stopFlash(); });
  function notify(text: string) {
    audio.opponent();
    if (!document.hidden) return;
    stopFlash();
    let on = false;
    flashTimer = window.setInterval(() => { on = !on; document.title = on ? `★ ${text}` : baseTitle; }, 800);
  }
  const lobbyToast = byId<HTMLDivElement>('lobbyToast');
  let toastTimer = 0;
  function showToast(text: string) {
    lobbyToast.textContent = text;
    lobbyToast.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { lobbyToast.style.display = 'none'; }, 4000);
  }

  /** 部屋を移る (合流、またはレース中の部屋に入ってしまったとき)。ロビー画面はそのまま */
  function switchRoom(code: string) {
    net?.leave();
    net = null;
    connect(code, 'open');
  }
  let lastMerge = 0;
  /**
   * 1 人で待っているとき、別の部屋で待っている人が見えたらそちらへ移る。
   * お互いの presence が届く前に押すと部屋が 2 つできるので、その合流用。
   * 2 人以上いる部屋か、部屋名の小さいほうへ移る。1 人どうしなら名前の大きい側だけが
   * 動くので、両方が同時に移ってすれ違うことはない。
   */
  function maybeMergeLobby() {
    if (!net || !presence || net.kind !== 'open' || net.started) return;
    if (net.peerIds().length > 1) return;   // 誰かがつながりかけているなら動かない
    if (Date.now() - lastMerge < 3000) return;
    const mine = net.code;
    const other = presence.joinable().find(r => r.code !== mine && (r.names.length >= 2 || r.code < mine));
    if (!other) return;
    lastMerge = Date.now();
    switchRoom(other.code);
  }

  // ---- トップ画面の「対戦待ち」表示 ----
  // presence (src/net.ts) で集めた状態を、対戦PLAY の下に出す。
  // 誰かが待っていれば「いま 1 人が対戦待ち (名前) 発走まで N 秒」と緑で光らせる。
  const presenceBox = byId<HTMLDivElement>('presence');
  const presenceMain = byId<HTMLSpanElement>('presenceMain');
  const presenceSub = byId<HTMLDivElement>('presenceSub');
  const presence2 = byId<HTMLDivElement>('presence2');
  const browserHint = byId<HTMLDivElement>('browserHint');
  const presenceOptIn = byId<HTMLButtonElement>('presenceOptIn');
  const netRevoke = byId<HTMLButtonElement>('netRevoke');
  presenceOptIn.onclick = () => { presenceOptIn.disabled = true; void grantNet(); };
  // 許可を取り消したら、つながっている相手とも切れるよう読み込み直す
  netRevoke.onclick = () => { storageSet(NET_CONSENT_KEY, '0'); location.reload(); };
  netRevoke.style.display = netConsent ? '' : 'none';
  /**
   * 誰ともつながっていない間は「確認中」。これを過ぎたら「見当たりません」にする。
   * 相手が先にいても、見つかるまで 1 分近くかかることがある: trystero の nostr 戦略は
   * 自分の告知を受け取った相手が接続してくる仕組みで、相手の再告知は 60 秒おき。
   * リレーは購読時刻より新しい出来事しか流さないので、端末の時計が数秒ずれていると
   * 相手からの応答が捨てられ、相手の次の再告知 (最長 60 秒後) まで待つことになる。
   */
  const PRESENCE_CHECK_MS = 70000;
  let presenceSince = Date.now();
  let hadWaiting = false;
  let presenceReported = false;
  function renderPresence() {
    if (!presence) {
      // 通信を許可する前は、許可を求める一文とボタンだけ出す (デバッグ時と、許可した直後の接続待ちは出さない)
      const ask = !netConsent && !dbg.get('debug');
      presenceBox.style.display = ask ? '' : 'none';
      presenceOptIn.style.display = ask ? '' : 'none';
      if (ask) {
        presenceBox.classList.remove('live', 'checking');
        presenceMain.textContent = t('pres.optInLead');
        presenceSub.textContent = '';
      }
      return;
    }
    presenceBox.style.display = '';
    presenceOptIn.style.display = 'none';
    const now = Date.now();
    const s = presence.summary(now);
    const joinable = presence.joinable(now);
    // 入れる部屋があればそれ、無ければ一番人の多い部屋を「まもなく発走」として見せる
    const target = joinable[0] ?? s.waiting[0] ?? null;
    const canJoin = joinable.length > 0;
    const checking = s.others === 0 && now - presenceSince < PRESENCE_CHECK_MS;
    // 誰かとつながるまでの時間 (つながらないまま確認を終えたら 0 人として) を記録する
    if (!presenceReported && (s.others > 0 || !checking)) {
      presenceReported = true;
      report('net', 'presence', { others: s.others, sec: Math.round((now - presenceSince) / 1000), relays: relayStatus().open, nat: netProbe?.nat ?? 'unknown', turn: hasTurn() });
    }
    presenceBox.classList.toggle('live', !!target);
    presenceBox.classList.toggle('checking', !target && checking);
    const sub: string[] = [];
    if (target) {
      const names = target.names.join(isJa ? '、' : ', ');
      const head = `<b>${esc(t('pres.waiting', target.names.length, names))}</b>`;
      if (!target.deadline) {
        // 1 人で相手を待っている。押せば 2 人になってカウントダウンが始まる
        presenceMain.innerHTML = `${head} ${esc(t('pres.waitingPeople'))}`;
        sub.push(t('pres.joinStart'));
      } else {
        const left = Math.max(0, Math.ceil((target.deadline - now) / 1000));
        presenceMain.innerHTML = `${head} ${esc(t('pres.startsIn', left))}`;
        sub.push(canJoin ? t('pres.joinNow') : t('pres.soon'));
      }
    } else {
      presenceMain.textContent = checking ? t('pres.checking') : t('pres.none');
    }
    // トップ画面にいるあいだに待ち人が現れたら音で知らせる
    const anyWaiting = s.waiting.length > 0;
    if (anyWaiting && !hadWaiting && !net && state === 'title') notify(t('pres.appeared'));
    hadWaiting = anyWaiting;
    maybeMergeLobby();
    if (s.title) sub.push(t('pres.title', s.title));
    if (s.racing) sub.push(t('pres.racing', s.racing));
    if (s.others === 0) {
      // 誰も見えないときは、リレーにつながっているかを添える (回線の問題と区別できるように)
      if (!checking) sub.push(t('pres.nobody'));
      const r = relayStatus();
      // 開いた直後はまだつながっていないのが普通なので、確認中のあいだは警告にしない
      sub.push(r.open ? t('pres.relays', r.open, r.total) : checking ? t('pres.relayConnecting') : t('pres.noRelay'));
      sub.push(...netHints());
    }
    presenceSub.textContent = sub.join(' / ');
    // ロビー側: 待っている人にも、来そうな人がいるか見せる
    const sub2: string[] = [];
    if (s.title) sub2.push(t('pres.lobbyTitle', s.title));
    if (s.racing) sub2.push(t('pres.racing', s.racing));
    if (s.others === 0) sub2.push(...netHints());
    presence2.textContent = sub2.join(' / ');
  }
  /**
   * 相手が見えない原因になりやすい回線の事情 (対称型 NAT・STUN 不通・TURN の有無)。
   * 直結できない組み合わせでは TURN が無いと永遠に相手が見えないので、それと分かるようにする。
   */
  function netHints(): string[] {
    const out: string[] = [];
    if (!netProbe) return out;
    if (netProbe.nat === 'symmetric') out.push(hasTurn() ? (netProbe.relay ? t('pres.natSymTurn') : t('pres.natSymTurnNg')) : t('pres.natSym'));
    else if (netProbe.nat === 'blocked') out.push(t('pres.natBlocked'));
    else if (hasTurn() && !netProbe.relay) out.push(t('pres.turnNg'));
    return out;
  }
  // アプリ内ブラウザ (Facebook 等) は WebRTC が不安定なので、Safari / Chrome で開くよう勧める
  const iab = inAppBrowser();
  if (iab) { browserHint.textContent = t('pres.inApp', iab); browserHint.style.display = ''; }
  // presence に入ったら表示を始める (読み込み時に許可済みなら、ここではもう入っている)
  const onNetStarted = () => {
    presenceSince = Date.now();
    if (presence) presence.onChange = renderPresence;
    netRevoke.style.display = '';
    void turnLoad?.then(updateOnlineAvailability);
    renderPresence();
  };
  if (presence) onNetStarted(); else onPresenceStart = onNetStarted;
  renderPresence();
  setInterval(renderPresence, 500);
  // 動作確認用 (tools/presencetest.mjs が読む)
  (window as never as Record<string, unknown>).__presence = () => presence ? { ...presence.summary(), rooms: presence.roomIds, relays: relayStatus(), probe: netProbe, turn: hasTurn(), inApp: iab } : null;

  function applyLobby(info: LobbyInfo) {
    if (!net) return;
    mySlot = Math.max(0, net.mySlot);
    player = karts[mySlot];
    for (let i = 0; i < karts.length; i++) {
      const id = info.order[i];
      karts[i].def.isPlayer = i === mySlot;
      karts[i].def.name = id ? (info.names[id] ?? t('lobby.anon')) : DEFAULT_NAMES[i];
      // 自分のカートには名前を出さない。カメラのすぐ前にあるので視界を塞ぐ
      setLabel(i, i === mySlot ? '' : id ? karts[i].def.name : `${DEFAULT_NAMES[i]} (AI)`);
    }
    renderLobby();
    // 人が増えたら「対戦相手が来た」と知らせる (入った側にも「相手がいる」の合図になる)
    const humans = info.order.length;
    if (humans >= 2 && humans > lastHumans && !net.started) { notify(t('lobby.arrived')); showToast(t('lobby.arrived')); }
    lastHumans = humans;
    // 締切が決まった / 消えたのをトップ画面の人にも伝える
    if (net.kind === 'open' && !net.started) presence?.set({ s: 'wait', name: myName, room: net.code, deadline: net.deadline });
  }

  function beginOnlineRace() {
    if (!net) return;
    presence?.set({ s: 'race' });
    // 席が決まる前に発走したら (相手との接続が間に合わなかった) オンラインは
    // あきらめて 1 人で走る。席が無いまま 0 番を名乗ると、ホストとカートを
    // 奪い合ってしまう。
    report('net', 'start', { humans: net.order.length, seated: net.mySlot >= 0, host: net.isHost });
    if (net.mySlot < 0) {
      net.leave();
      net = null;
      mySlot = 0;
      player = karts[0];
      karts[0].def.isPlayer = true;
      for (let i = 0; i < karts.length; i++) setLabel(i, '');
      hud.showLandmark(t('race.soloFallback'));
      overlay.style.display = 'none';
      audio.start();
      state = 'countdown'; countdown = 3.999;
      audio.countdown();
      return;
    }
    mySlot = net.mySlot;
    player = karts[mySlot];
    for (let i = 0; i < karts.length; i++) karts[i].def.isPlayer = i === mySlot;
    // 席が変わったまま発走した場合に備えて、自分の名前はここでも消す
    setLabel(mySlot, '');
    overlay.style.display = 'none';
    audio.start();
    state = 'countdown'; countdown = 3.999;
    audio.countdown();
    renderLobby();
  }

  function applyPoses(poses: Pose[]) {
    for (const p of poses) {
      const k = karts[p.slot];
      if (!k || isLocal(k)) continue;
      if (!k.hasNet) { k.x = p.x; k.z = p.z; k.y = p.y; k.heading = p.heading; }
      k.hasNet = true;
      k.netX = p.x; k.netZ = p.z; k.netY = p.y; k.netHeading = p.heading; k.netSpeed = p.speed;
      k.drifting = p.drifting; k.lap = p.lap; k.s = p.s;
      if (p.spin > k.spinTimer) { k.spinTimer = p.spin; }
      k.boostTimer = Math.max(k.boostTimer, p.boost);
      k.starTimer = Math.max(k.starTimer, p.star);
    }
  }

  function applyEvent(ev: NetEvent) {
    const k = karts[ev.slot];
    if (!k) return;
    if (ev.t === 'use') {
      if (!isLocal(k)) items.spawnFromNet(ev.item as ItemType, k, ev.x, ev.z, ev.y, ev.heading, ev.speed);
    } else if (ev.t === 'hit') {
      if (!isLocal(k)) { k.spinTimer = Math.max(k.spinTimer, 1.3); k.drifting = 0; }
    } else if (ev.t === 'fin') {
      if (!k.finished) { k.finished = true; k.finishTime = ev.time; }
    }
  }

  function connect(code: string, kind: RoomKind) {
    if (net) return;
    const name = (nameInput.value.trim() || t('lobby.anon')).slice(0, 10);
    storageSet('mk.name', name);
    myName = name;
    lastHumans = 0;
    try {
      net = new NetSession(code, name, kind, {
        onLobby: applyLobby, onStart: beginOnlineRace, onPose: applyPoses,
        onEvent: applyEvent, onPeers: renderLobby,
        // レース中の部屋に入ってしまった。公開ロビーなら新しい部屋で待ち直す
        onBusy: () => { if (net?.kind === 'open') switchRoom(newOpenCode()); else netNote2.textContent = t('net.busy'); },
      });
    } catch (e) {
      netNote2.textContent = t('net.failed', String(e));
      return;
    }
    audio.start();   // ボタン操作のうちに起こしておき、相手が来たときの音を出せるようにする
    onlineHome.style.display = 'none';
    onlineRoom.style.display = 'block';
    mainButtons.style.display = 'none';
    renderLobby();
    tickCountdown();
    // トップ画面にいる人へ「対戦待ち」を知らせる。合言葉の部屋は公開しないので「レース中」扱い
    presence?.set(kind === 'open' ? { s: 'wait', name, room: code, deadline: 0 } : { s: 'race' });
    // 動作確認用 (tools/nettest.mjs が読む)
    (window as never as Record<string, unknown>).__net = () => ({
      code, slot: mySlot, host: net?.isHost, started: net?.started, order: net?.order ?? [], deadline: net?.deadline ?? 0,
      labels: labels.filter(Boolean).length,
      karts: karts.map((k, i) => ({ i, name: k.def.name, x: Math.round(k.x), z: Math.round(k.z), lap: k.lap, fromNet: k.hasNet })),
    });
    // 1 人でも部屋を開けるよう、自分がホストなら座席を配る
    setTimeout(() => net?.publishLobby(), 300);
  }

  // 公開ロビー: 待っている人が見えていればその部屋へ、いなければ新しい部屋を作って待つ。
  // presence で接続は共有済みなので、待っている人の部屋には席の受け渡しだけで入れる。
  // 押したことを通信の許可とみなす (ボタンの近くに何が伝わるかを書いてある)
  byId<HTMLButtonElement>('openBtn').onclick = async () => {
    goLandscape();
    openBtn.disabled = true;
    await grantNet();
    await turnLoad;   // 許可した直後は、ここで TURN の資格情報を取る
    updateOnlineAvailability();
    if (!hasTurn()) return;   // 中継を確かめられなければ対戦しない (理由はボタンに出る)
    const waiting = presence?.joinable()[0];
    connect(waiting ? waiting.code : newOpenCode(), 'open');
  };
  goBtn.onclick = () => net?.startRace();
  byId<HTMLButtonElement>('leaveBtn').onclick = () => { net?.leave(); location.reload(); };
  // ?room=XXXXX のリンクなら合言葉の部屋へ直接入る (UI は隠してある)
  // リンクを開いただけで知らない相手とつながらないよう、通信をまだ許可していなければ先に確かめる
  if (linkRoom && (netConsent || confirm(t('net.confirmLink', linkRoom)))) {
    void grantNet().then(() => turnLoad).then(() => {
      updateOnlineAvailability();
      if (hasTurn()) connect(linkRoom, 'join');
    });
  }

  /* 合言葉で部屋を作る方式。公開ロビーに切り替えたので止めてあります。
     戻すときは index.html のボタンと合わせてコメントを外してください。
  byId<HTMLButtonElement>('createBtn').onclick = () => connect(makeRoomCode(), 'create');
  byId<HTMLButtonElement>('joinBtn').onclick = () => {
    const code = normalizeRoomCode(roomInput.value);
    if (code.length < 4) { roomInput.focus(); return; }
    connect(code, 'join');
  };
  byId<HTMLButtonElement>('copyBtn').onclick = async () => {
    const url = new URL(location.href);
    url.searchParams.set('room', net?.code ?? '');
    try { await navigator.clipboard.writeText(url.toString()); byId('copyBtn').textContent = 'コピーしました'; }
    catch { byId('copyBtn').textContent = url.toString(); }
  };
  */

  // デバッグ: ?debug=1&idx=<サンプル番号>&wp=<経由地>&cam=<0..3> でカウントダウン無しに任意地点から開始
  if (params.get('debug')) {
    overlay.style.display = 'none';
    let idx = Number(params.get('idx') ?? 0);
    const wp = params.get('wp');
    if (wp !== null) { const w = WAYPOINTS[Number(wp)]; const [wx, wz] = llToXZ(w.lat, w.lon); idx = track.nearest(wx, wz).idx; }
    player.placeAt(track, idx - 3, 0);
    const f0 = new THREE.Vector3(Math.cos(player.heading), 0, Math.sin(player.heading));
    camPos.set(player.x - f0.x * 7.5, player.y + 3.2, player.z - f0.z * 7.5);
    camLook.set(player.x + f0.x * 6, player.y + 1.2, player.z + f0.z * 6);
    // ?ahead=1 でライバルをプレイヤーの前に並べる (撮影用)
    const ahead = params.get('ahead') === '1';
    karts.forEach((k, i) => { if (i > 0) k.placeAt(track, ahead ? idx + 4 * i : idx - 3 - 6 * i, (i % 2 ? 3.5 : -3.5)); });
    camMode = Number(params.get('cam') ?? 0);
    state = 'race';
    (window as any).__debug = { track, karts, terrain, scene, camera, rail, THREE };
  }

  // 初期カメラ (タイトル: 上空から)
  const p0 = track.pointAt(0, 0);
  camera.position.set(p0.x + 60, p0.y + 90, p0.z + 120);
  camera.lookAt(p0);

  // ---- ループ ----
  let last = performance.now();
  let titleAngle = 0;
  // FPS 表示 (0.5 秒ごとに更新, ?nofps=1 で非表示)
  const fpsEl = document.getElementById('fps')!;
  let fpsFrames = 0, fpsSince = last;
  if (params.get('nofps')) fpsEl.style.display = 'none';
  // デバッグ: steps=N で 1 フレームに N 回 (1/60s) 物理更新, ai=1 でプレイヤーも AI 操作
  const debugSteps = Number(params.get('steps') ?? 0);
  const debugAi = params.get('ai') === '1';
  // 位置の送信間隔。上げると滑らかになるが通信量が増える
  const POSE_HZ = 15;
  /** 前回位置を送った時刻 (performance.now) */
  let poseTimer = 0;
  const idleInput = { throttle: 0, brake: 0, steer: 0, drift: false, item: false, lookBack: false };
  // 録画 (プロモ動画の素材撮り): ?rec=1 で実時間に依存せず 1/30 秒ずつ進める。
  // 描画が遅い環境でも滑らかな映像になるよう、外から window.__recStep(n) で n コマ進めてから撮る。
  // ?nohud=1 で HUD を隠す。?photo=... に &orbit=<度/秒> を付けると撮影カメラが周回する。
  const recMode = params.get('rec') === '1';
  let recTime = 0;
  if (params.get('nohud')) { document.getElementById('hud')!.style.display = 'none'; document.getElementById('touch')!.style.display = 'none'; }
  if (recMode) {
    (window as any).__recStep = (n: number) => {
      for (let i = 0; i < n; i++) { recTime += 1 / 30; last += 1000 / 30; step(1 / 30, last); }
    };
  }
  function frame(now: number) {
    requestAnimationFrame(frame);
    if (recMode) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt, now);
  }
  function step(dt: number, now: number) {
    fpsFrames++;
    if (now - fpsSince >= 500) {
      const fps = Math.round(fpsFrames * 1000 / (now - fpsSince));
      fpsEl.textContent = `${fps} fps`;
      fpsEl.style.color = fps >= 50 ? '#7cff5a' : fps >= 30 ? '#ffd83d' : '#ff5b5b';
      fpsFrames = 0; fpsSince = now;
    }
    if (state === 'title') {
      titleAngle += dt * 0.15;
      const r = 140;
      camera.position.set(p0.x + Math.cos(titleAngle) * r, p0.y + 70 + Math.sin(titleAngle * 0.7) * 15, p0.z + Math.sin(titleAngle) * r);
      camera.lookAt(p0.x, p0.y + 10, p0.z);
      updateSun(camera.position);
      renderer.render(scene, camera);
      return;
    }
    if (state === 'countdown') {
      const prev = Math.ceil(countdown);
      countdown -= dt;
      const cur = Math.ceil(countdown);
      if (cur !== prev) {
        if (cur >= 1) { hud.showCenter(String(cur), 0.9); audio.countdown(); }
        else { hud.showCenter(t('race.go'), 1, '#7cff5a'); audio.countdown(true); state = 'race'; raceTime = 0; }
      } else if (prev === 4 && countdown < 3) { /* noop */ }
      if (countdown > 3) { /* 表示待ち */ } else if (cur >= 1 && hud) { /* number shown on change */ }
    }
    const racing = state === 'race' || state === 'finish';
    const pin = racing ? input.read() : (input.read(), idleInput);
    if (debugSteps > 0 && racing) { for (let i = 0; i < debugSteps; i++) simulate(1 / 60, pin, racing); }
    else simulate(dt, pin, racing);
    // 自分が動かしているカートの位置を配る (15Hz)。
    // 間隔は dt ではなく実時間で測る。dt は 0.05 秒で頭打ちにしてあるので、
    // fps が落ちた端末では送信間隔まで一緒に間延びしてしまう。
    if (net?.started) {
      if (now - poseTimer >= 1000 / POSE_HZ) {
        poseTimer = now;
        const out: Pose[] = [];
        for (let i = 0; i < karts.length; i++) {
          const k = karts[i];
          if (!isLocal(k)) continue;
          out.push({
            slot: i, x: k.x, z: k.z, y: k.y, heading: k.heading, speed: k.speed,
            drifting: k.drifting, spin: k.spinTimer, lap: k.lap, s: k.s,
            boost: k.boostTimer, star: k.starTimer, finished: 0,
          });
        }
        net.sendPoses(out);
      }
    }
    // カメラ
    updateCamera(dt, pin.lookBack);
    updateSun(player.mesh.position);
    hud.update(dt, player, karts, raceTime, track, track.labels);
    audio.engineUpdate(Math.abs(player.speed), pin.throttle, player.boostTimer > 0);
    renderer.render(scene, camera);
  }

  function simulate(dt: number, pin: typeof idleInput, racing: boolean) {
    if (racing) raceTime += dt;
    rail.update(dt);
    for (const k of karts) {
      // 他人が動かしているカートは受信位置へ寄せるだけ (物理を回すと相手とずれる)
      if (!isLocal(k)) { k.netApply(dt, track); continue; }
      let inp = pin;
      if (!k.def.isPlayer || k.finished || debugAi) inp = racing ? k.aiInput(dt, track, karts, player, rand) : idleInput;
      if (inp.item && racing) {
        const held = k.item;
        items.use(k, itemEvents);
        // 使えたときだけ配る (ルーレット中や手ぶらのときは何も起きない)
        if (net?.started && held && !k.item) {
          net.emit({ t: 'use', slot: karts.indexOf(k), item: held, x: k.x, z: k.z, y: k.y, heading: k.heading, speed: k.speed });
        }
      }
      k.update(dt, racing ? inp : idleInput, track, kartEvents);
    }
    // カート同士の衝突
    for (let i = 0; i < karts.length; i++) for (let j = i + 1; j < karts.length; j++) {
      const a = karts[i], b = karts[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 2.3 * 2.3 && d2 > 0.0001) {
        const d = Math.sqrt(d2), push = (2.3 - d) / 2;
        const nx = dx / d, nz = dz / d;
        // 相手のカートは持ち主が動かすので、押し返すのは自分の側だけ。
        // 両方動かすと次の受信で戻されてガタつく。片側だけのときは倍押す。
        const aL = isLocal(a), bL = isLocal(b);
        if (aL) { const f = bL ? 1 : 2; a.x -= nx * push * f; a.z -= nz * push * f; }
        if (bL) { const f = aL ? 1 : 2; b.x += nx * push * f; b.z += nz * push * f; }
        if (bL && a.invincible && !b.invincible && b.spinTimer <= 0) { b.spinTimer = 1.2; itemEvents.onHit(b, a); }
        if (aL && b.invincible && !a.invincible && a.spinTimer <= 0) { a.spinTimer = 1.2; itemEvents.onHit(a, b); }
        const avg = (a.speed + b.speed) / 2;
        a.speed = lerp(a.speed, avg, 0.3); b.speed = lerp(b.speed, avg, 0.3);
        if (a.def.isPlayer || b.def.isPlayer) audio.bump();
      }
    }
    // 電車・気動車との接触 (一畑電車と JR は踏切でコースと交わる)
    if (racing) {
      for (const k of karts) {
        if (k.spinTimer > 0 || k.invincible || !isLocal(k)) continue;
        // 接触してもスピンするのはカートだけ。電車は減速も停止も折り返しもせず
        // そのまま走り続ける (rail.ts の Train.update は接触を見ていない)。
        if (rail.hitTrain(k.x, k.z, 1.3)) {
          k.spinTimer = 1.5; k.drifting = 0; k.speed *= 0.25;
          itemEvents.onHit(k, null);
          if (k.def.isPlayer) hud.showLandmark(t('race.tram'));
        }
      }
    }
    if (racing) items.update(dt, karts, itemEvents, isLocal);
    // 順位
    const order = [...karts].sort((a, b) => (a.finished && b.finished) ? a.finishTime - b.finishTime : a.finished ? -1 : b.finished ? 1 : b.progress - a.progress);
    order.forEach((k, i) => (k.rank = i + 1));
    // 地名表示
    for (const l of track.labels) {
      const d = track.wrap(player.trackIdx - l.idx);
      if (d >= 0 && d < 6 && lastLabel !== l.idx && racing) { lastLabel = l.idx; hud.showLandmark(l.name); }
    }
  }

  // デバッグ用の撮影カメラ: ?photo=<lat>,<lon>,<注視高さ>,<距離>,<方位角deg>
  const photoArg = params.get('photo');
  const photo = photoArg ? photoArg.split(',').map(Number) : null;
  const orbitSpeed = Number(params.get('orbit') ?? 0);
  // ?camk=<倍率> で追従カメラを硬くする (撮影用。高速でもカートが小さくならない)
  const camStiff = Number(params.get('camk') ?? 1);

  function updateCamera(dt: number, lookBack: boolean) {
    const fx = Math.cos(player.heading), fz = Math.sin(player.heading);
    if (photo) {
      const [plat, plon, ph = 12, pd = 70, paz = 180] = photo;
      const [tx, tz] = llToXZ(plat, plon);
      const a = ((paz + orbitSpeed * recTime) * Math.PI) / 180;
      camera.position.set(tx + Math.sin(a) * pd, terrain.groundHeight(tx, tz) + ph + pd * 0.35, tz + Math.cos(a) * pd);
      camera.lookAt(tx, terrain.groundHeight(tx, tz) + ph, tz);
      camera.fov = 55; camera.updateProjectionMatrix();
      return;
    }
    if (camMode === 3) { // 俯瞰 (デバッグ)
      camera.position.set(player.x, player.y + 320, player.z + 1);
      camera.lookAt(player.x, player.y, player.z);
      camera.fov = 60; camera.updateProjectionMatrix();
      return;
    }
    const dist = camMode === 0 ? 7.5 : camMode === 1 ? 12 : 0.4;
    const height = camMode === 0 ? 3.2 : camMode === 1 ? 5.5 : 1.4;
    const dir = lookBack ? -1 : 1;
    const back = camMode === 2 ? -1 : 1;
    const target = new THREE.Vector3(player.x - fx * dist * dir * back, player.y + height, player.z - fz * dist * dir * back);
    const speedT = clamp(player.speed / 56, 0, 1);
    const k = camMode === 2 ? 1 : Math.min(1, dt * (5 + speedT * 3) * camStiff);
    camPos.lerp(target, k);
    if (camMode === 2) camPos.copy(target);
    const lookAt = new THREE.Vector3(player.x + fx * 6 * dir, player.y + 1.2, player.z + fz * 6 * dir);
    camLook.lerp(lookAt, Math.min(1, dt * 10));
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    const fovTarget = 68 + speedT * 12 + (player.boostTimer > 0 ? 10 : 0) + (player.starTimer > 0 ? 4 : 0);
    camFov = lerp(camFov, fovTarget, Math.min(1, dt * 4));
    camera.fov = camFov; camera.updateProjectionMatrix();
  }
  function updateSun(center: THREE.Vector3) {
    sun.position.copy(SUN_DIR).multiplyScalar(600).add(center);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    sky.position.copy(center);
  }
  requestAnimationFrame(frame);
}

function nextFrame() { return new Promise<void>(r => requestAnimationFrame(() => r())); }

/** データ範囲外を囲む遠景の山並み (松江は北と南を山に囲まれ、西に宍道湖が広がる) */
function makeHills(terrain: Terrain): THREE.Mesh {
  const cx = (terrain.xMin + terrain.xMax) / 2, cz = (terrain.zMin + terrain.zMax) / 2;
  const size = 14000, seg = 140;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const r = rng(7);
  const noise = (x: number, z: number) => Math.sin(x * 0.0021 + 1.3) * Math.cos(z * 0.0017 + 0.4) * 0.5 + Math.sin(x * 0.0063 + z * 0.0041) * 0.3 + Math.sin(x * 0.013 - z * 0.011) * 0.2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
    const dx = Math.max(0, Math.abs(x - cx) - (terrain.xMax - terrain.xMin) / 2 - 250);
    const dz = Math.max(0, Math.abs(z - cz) - (terrain.zMax - terrain.zMin) / 2 - 250);
    const d = Math.hypot(dx, dz);
    // 宍道湖 (西〜南西) は低く。湖は西へ 17km 続くので水面の下に沈めておく
    const lake = (x < cx - 600 && z > cz - 1800) || (x < cx + 400 && z > cz + 1200);
    const southFactor = lake ? 0 : 1;
    const ramp = clamp((d - 200) / 1500, 0, 1);
    let y = -6 + ramp * (180 + 140 * noise(x, z) + r() * 6) * southFactor;
    if (d === 0) y = -6;
    pos.setXYZ(i, x, y, z);
    const g = clamp((y + 6) / 200, 0, 1);
    col[i * 3] = 0.35 - g * 0.1; col[i * 3 + 1] = 0.55 - g * 0.1; col[i * 3 + 2] = 0.3;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  return mesh;
}

/**
 * WebGL のコンテキストが失われたとき (GPU のメモリ不足・ドライバのリセット・モバイルで
 * 裏に回したときなど)。three.js はそのまま描画を止めるので、放っておくと黒い画面のまま
 * 戻らない。テクスチャを全部上げ直すより読み込み直すほうが確実なので、案内を出して
 * 再読み込みしてもらう。ブラウザが自分で戻したときは自動で読み込み直す。
 */
function watchContextLoss(canvas: HTMLCanvasElement): void {
  const box = document.getElementById('glLost');
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();   // 戻せる可能性を残す (これが無いと restored が来ない)
    report('gl', 'contextlost', {});
    if (!box) return;
    document.getElementById('glLostMsg')!.textContent = t('gl.lost');
    const b = document.getElementById('glLostBtn') as HTMLButtonElement;
    b.textContent = t('gl.reload');
    b.onclick = () => location.reload();
    box.style.display = 'flex';
  });
  canvas.addEventListener('webglcontextrestored', () => location.reload());
}

main().catch(e => {
  console.error(e);
  reportError('main', e);
  // 読み込みに失敗したら押して読み込み直せるようにする (無効のままだと手詰まりになる)
  const b = document.getElementById('startBtn') as HTMLButtonElement;
  b.textContent = t('load.error', e instanceof Error ? e.message : String(e));
  b.disabled = false;
  b.onclick = () => location.reload();
});
