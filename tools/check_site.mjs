// 配信物の点検 — デプロイ前 (dist/) とデプロイ後・定期監視 (本番 URL) の両方で使う
//
//   node tools/check_site.mjs dist                                   # ビルド結果を点検
//   node tools/check_site.mjs https://matsue.citykart.jp/            # 本番を点検
//   node tools/check_site.mjs https://matsue.citykart.jp/ --commit 61276fc --wait 600
//        # そのコミットの版が配信されるまで最大 600 秒待つ (デプロイ直後の確認)
//   node tools/check_site.mjs https://matsue.citykart.jp/ --relays    # 対戦のリレーも見る
//
// 見ること:
//   - index.html と英語版があり、そこから読む JS が取れる (古い HTML が消えた JS を指すと白画面になる)
//   - 地形・LOD2・天守の .bin が .json の頂点数と同じ長さ (版の違う組や欠けを検出する)
//   - アトラス・天守のテクスチャ・建物・道路のデータがある
//   - --relays: 対戦のシグナリングに使う nostr リレーのうち、いくつにつながるか
// 失敗があれば終了コード 1 (GitHub Actions が失敗を通知する)。
//
// 本番のトップ画面を開くと、利用者の「対戦待ち」表示に監視のブラウザが映ってしまうので
// (src/net.ts の APP_ID の注記)、ここではブラウザを使わず HTTP とリレーの口だけを見る。
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { apiHeaders, hasStaticCredential, hasTurnServer, originFromCname, validateConfigUrl } from './turn_config.mjs';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--')) ?? 'dist';
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const expectCommit = opt('--commit');
const waitSec = Number(opt('--wait') ?? 0);
const checkRelays = args.includes('--relays');
const remote = /^https?:\/\//.test(target);
const base = remote ? target.replace(/\/?$/, '/') : path.resolve(target);

// src/net.ts と合わせる (APP_ID と RELAY_CONFIG.redundancy)
const APP_ID = 'matsue-kart';
const REDUNDANCY = 8;
/** これより少ないリレーにしかつながらなければ失敗 (相手と同じリレーに乗れない恐れが高い) */
const MIN_RELAYS = 3;

// ---- 取得 (ローカルと本番で同じ口) ----
const bust = `cb=${Date.now()}`;   // CDN やプロキシのキャッシュを避けて、いま配信されている版を見る
async function get(rel) {
  if (!remote) {
    const p = path.join(base, rel);
    try { return { ok: true, status: 200, body: await readFile(p) }; } catch { return { ok: false, status: 404, body: Buffer.alloc(0) }; }
  }
  const url = new URL(rel, base);
  url.search = bust;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      return { ok: res.ok, status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    } catch (e) {
      if (i === 2) return { ok: false, status: 0, body: Buffer.alloc(0), error: String(e) };
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}
async function exists(rel) {
  if (!remote) { try { return (await stat(path.join(base, rel))).isFile(); } catch { return false; } }
  const url = new URL(rel, base);
  url.search = bust;
  try { return (await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) })).ok; } catch { return false; }
}

async function checkOnce() {
  const errors = [];
  const fail = m => errors.push(m);
  const json = async rel => {
    const r = await get(rel);
    if (!r.ok) { fail(`${rel}: HTTP ${r.status}${r.error ? ` (${r.error})` : ''}`); return null; }
    try { return JSON.parse(r.body.toString('utf8')); } catch { fail(`${rel}: JSON として読めない`); return null; }
  };
  const binSize = async (rel, expect) => {
    const r = await get(rel);
    if (!r.ok) return fail(`${rel}: HTTP ${r.status}`);
    if (r.body.length !== expect) fail(`${rel}: ${r.body.length} バイト (json から見ると ${expect} バイトのはず)`);
  };

  // HTML と JS
  for (const page of ['index.html', 'en/index.html']) {
    const r = await get(page);
    if (!r.ok) { fail(`${page}: HTTP ${r.status}`); continue; }
    const html = r.body.toString('utf8');
    const scripts = [...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map(m => m[1]);
    if (!scripts.length) { fail(`${page}: module の script が無い`); continue; }
    for (const src of scripts) {
      const rel = new URL(src, remote ? base : 'http://x/').pathname.replace(/^\//, '');
      const js = await get(rel);
      if (!js.ok) { fail(`${page} → ${src}: HTTP ${js.status}`); continue; }
      if (expectCommit && page === 'index.html' && !js.body.includes(`"${expectCommit}"`)) fail(`${src}: コミット ${expectCommit} の版ではない`);
    }
  }

  // 地形
  const terrain = await json('data/terrain.json');
  if (terrain) await binSize('data/terrain.bin', terrain.w * terrain.h * 2);
  // LOD2 (位置 3 + UV 2 の float32) とアトラス (高画質用と 2048px 版)
  const lod2 = await json('data/lod2.json');
  if (lod2) {
    await binSize('data/lod2.bin', lod2.vertexCount * 5 * 4);
    for (const a of lod2.atlases) {
      for (const f of [a, a.replace(/\.jpg$/, '_2k.jpg')]) if (!(await exists(`data/${f}`))) fail(`data/${f}: 無い`);
    }
  }
  // 松江城天守 (位置 3 + UV 2 + 色 3 の float32) とテクスチャ
  const castle = await json('data/castle.json');
  if (castle) {
    await binSize('data/castle.bin', castle.vertexCount * 8 * 4);
    for (const g of castle.groups) if (g.texture && !(await exists(`data/${g.texture}`))) fail(`data/${g.texture}: 無い`);
  }
  // 建物・道路
  const bldg = await json('data/buildings.json');
  if (bldg && !(bldg.count > 0)) fail('data/buildings.json: 建物が 0 棟');
  const roads = await json('data/roads.json');
  if (roads && !(Array.isArray(roads.items) && roads.items.length)) fail('data/roads.json: 道路が空');

  // 本番では TURN を必須とする。設定 API が壊れたり STUN だけを返したりしても
  // HTTP/リレー監視だけでは気づけないため、定期監視でも実際の応答を検査する。
  if (remote || await exists('turn.json')) {
    const turn = await json('turn.json');
    // 配信される turn.json に固定の資格情報が入っていれば、誰でも TURN を使えてしまう
    if (turn && hasStaticCredential(turn)) fail('turn.json に TURN の資格情報 (username / credential) がそのまま入っている');
    let resolved = turn;
    if (turn?.url) {
      try {
        // 鍵付きの URL (?apiKey=...) は配信されると鍵が公開されるので、ここでも止める
        const endpoint = validateConfigUrl(turn.url);
        // 資格情報 API (workers/turn/) はサイトの Origin からだけ許可するので、監視も同じ Origin を名乗る
        const origin = remote ? new URL(base).origin : originFromCname((await get('CNAME')).body.toString('utf8'));
        const res = await fetch(endpoint, { signal: AbortSignal.timeout(10000), headers: apiHeaders(origin) });
        if (!res.ok) {
          // Worker は 1 日の発行上限に達すると 503 と { "error": "daily_cap" } を返す (利用者には「今日は対戦できない」と出ている)
          const body = (await res.text().catch(() => '')).slice(0, 200);
          fail(body.includes('daily_cap') ? `TURN 設定 API: 1 日の発行上限に達している (${body})` : `TURN 設定 API: HTTP ${res.status}`);
        } else {
          resolved = await res.json();
        }
      } catch (e) {
        fail(`TURN 設定 API: ${e instanceof Error ? e.message : String(e)}`);
        resolved = null;
      }
    }
    if (resolved && !hasTurnServer(resolved)) fail('TURN 設定に turn:/turns: server が無い');
  }
  return errors;
}

/** 対戦のシグナリングに使うリレー (trystero が appId から決める組) へつながるか */
async function relayCheck() {
  const { getRelays } = await import('@trystero-p2p/core');
  const { defaultRelayUrls } = await import('@trystero-p2p/nostr');
  const urls = getRelays({ appId: APP_ID, relayConfig: { redundancy: REDUNDANCY } }, defaultRelayUrls, REDUNDANCY, true);
  const results = await Promise.all(urls.map(url => new Promise(resolve => {
    let done = false;
    const finish = ok => { if (done) return; done = true; try { ws.close(); } catch { /* 閉じ済み */ } resolve({ url, ok }); };
    const ws = new WebSocket(url);
    const timer = setTimeout(() => finish(false), 10000);
    ws.onopen = () => { clearTimeout(timer); finish(true); };
    ws.onerror = () => { clearTimeout(timer); finish(false); };
  })));
  for (const r of results) console.log(`  ${r.ok ? 'OK ' : 'NG '} ${r.url}`);
  const open = results.filter(r => r.ok).length;
  console.log(`リレー: ${open}/${urls.length} につながった`);
  return open >= MIN_RELAYS ? [] : [`リレーが ${open}/${urls.length} しかつながらない (${MIN_RELAYS} 未満)`];
}

const deadline = Date.now() + waitSec * 1000;
let errors = await checkOnce();
while (errors.length && Date.now() < deadline) {
  console.log(`まだ揃っていない (${errors.length} 件)。30 秒後にもう一度見ます: ${errors[0]}`);
  await new Promise(r => setTimeout(r, 30000));
  errors = await checkOnce();
}
if (checkRelays) errors.push(...await relayCheck());

if (errors.length) {
  console.error(`NG: ${remote ? base : target}`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`OK: ${remote ? base : target}${expectCommit ? ` (コミット ${expectCommit})` : ''}`);
