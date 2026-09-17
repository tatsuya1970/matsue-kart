// LOD2 の実写テクスチャ (PLATEAU appearance) をダウンロードする
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = 'https://assets.cms.plateau.reearth.io/assets/7c/606e42-b9e0-410b-8c0b-b64731336e05/32201_matsue-shi_city_2024_citygml_1_op/udx/bldg';
const OUT = path.resolve('data/lod2tex');
const plan = JSON.parse(readFileSync('data/lod2_images.json', 'utf8'));
await mkdir(OUT, { recursive: true });

const jobs = plan.images.map(e => ({ img: e.img, file: e.img.replace(/[\/\\]/g, '__') }));
let done = 0, missing = 0, skipped = 0;

async function one(job) {
  const dest = path.join(OUT, job.file);
  try { const s = await stat(dest); if (s.size > 200) { skipped++; return; } } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/${job.img}`);
      if (res.status === 404) { missing++; return; }
      if (!res.ok) throw new Error(String(res.status));
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);
      done++;
      return;
    } catch (e) {
      if (attempt === 2) { missing++; console.log(`ERR ${job.img}: ${e.message}`); }
    }
  }
}

let i = 0;
const N = 12;
async function worker() { while (i < jobs.length) { const j = jobs[i++]; await one(j); if ((done + skipped) % 250 === 0) console.log(`${done + skipped + missing}/${jobs.length}`); } }
await Promise.all(Array.from({ length: N }, worker));
console.log(`done=${done} skipped=${skipped} missing=${missing} total=${jobs.length}`);
