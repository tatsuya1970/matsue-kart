// PLATEAU (国土交通省) 松江市 2024 CityGML ダウンロードスクリプト
// 対象: 松江駅〜宍道湖〜松江城〜松江高専 周辺の 3次メッシュ (2次メッシュ 533310)
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://assets.cms.plateau.reearth.io/assets/7c/606e42-b9e0-410b-8c0b-b64731336e05/32201_matsue-shi_city_2024_citygml_1_op/udx';
const OUT = path.resolve('data/citygml');

// 3次メッシュ: 行 3..9 (緯度 35.4417-35.5000), 列 0..5 (経度 133.0-133.075)
// 宍道湖の上などデータの無いメッシュは 404 になるので飛ばす
const meshes = [];
for (let r = 3; r <= 9; r++) for (let c = 0; c <= 5; c++) meshes.push(`533310${r}${c}`);

const jobs = [];
for (const m of meshes) {
  jobs.push({ type: 'bldg', url: `${BASE}/bldg/${m}_bldg_6697_op.gml`, file: `${m}_bldg.gml` });
  jobs.push({ type: 'tran', url: `${BASE}/tran/${m}_tran_6697_op.gml`, file: `${m}_tran.gml` });
}
// DEM は 2次メッシュを 4 分割したファイル (00 / 05 / 50 / 55)
for (const q of ['00', '05', '50', '55']) {
  jobs.push({ type: 'dem', url: `${BASE}/dem/533310_dem_6697_${q}_op.gml`, file: `533310_dem_${q}.gml` });
}

await mkdir(OUT, { recursive: true });

async function download(job) {
  const dest = path.join(OUT, job.file);
  try {
    const s = await stat(dest);
    if (s.size > 1000) { console.log(`skip (exists) ${job.file} ${(s.size / 1e6).toFixed(1)}MB`); return; }
  } catch {}
  const res = await fetch(job.url);
  if (!res.ok) { console.log(`MISSING ${job.file} (${res.status})`); return; }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`ok ${job.file} ${(buf.length / 1e6).toFixed(1)}MB`);
}

// 4並列
let i = 0;
async function worker() { while (i < jobs.length) { const j = jobs[i++]; try { await download(j); } catch (e) { console.log(`ERR ${j.file}: ${e.message}`); } } }
await Promise.all([worker(), worker(), worker(), worker()]);
console.log('done');
