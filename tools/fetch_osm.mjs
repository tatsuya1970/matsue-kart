// ルート計画用の OpenStreetMap データ (道路・鉄道) を Overpass API から取る
//   node tools/fetch_osm.mjs   → data/osm/matsue.json
// Node の fetch では Overpass に繋がらない環境があったので curl を使う。
// データは © OpenStreetMap contributors (ODbL)。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const BBOX = '35.444,132.960,35.505,133.085';
const query = `[out:json][timeout:120];(
  way["highway"~"^(trunk|primary|secondary|tertiary|trunk_link|primary_link|unclassified|residential)$"](${BBOX});
  way["railway"~"rail|light_rail"](${BBOX});
  node["railway"="station"](${BBOX});
);out geom tags;`;
mkdirSync('data/osm', { recursive: true });
const tmp = 'data/osm/query.txt';
writeFileSync(tmp, query);
execFileSync('curl', ['-s', '-m', '180', '-A', 'matsue-kart', '--data-urlencode', `data@${tmp}`, 'https://overpass-api.de/api/interpreter', '-o', 'data/osm/matsue.json'], { stdio: 'inherit' });
console.log('data/osm/matsue.json を書き出しました');
