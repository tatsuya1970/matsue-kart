// 完成したコースを地図で見られる形に書き出す。
//   public/course.geojson  GeoJSON (geojson.io / QGIS / OSM 系ツール)
//   public/course.gpx      GPX トラック (GPS アプリ・Google Earth)
//   public/course.kml      KML (Google マイマップ / Google Earth)
//   public/course-map.html Leaflet + OpenStreetMap で表示する単体ページ
import { readFileSync, writeFileSync } from 'node:fs';

const cp = JSON.parse(readFileSync('data/course_path.json', 'utf8'));
const lat0 = cp.origin.lat, lon0 = cp.origin.lon;
const mPerLat = 110950, mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
const toLL = ([x, z]) => [lat0 - z / mPerLat, lon0 + x / mPerLon];

// 経路 (閉ループ)。地図では 4m 間隔で十分
const ll = [];
for (let i = 0; i < cp.points.length; i += 2) ll.push(toLL(cp.points[i]));
ll.push(ll[0]);
const r6 = v => Math.round(v * 1e6) / 1e6;

const labels = cp.labels.filter(l => l.label).map(l => ({ name: l.name, ll: toLL(cp.points[l.idx % cp.points.length]) }));
const start = toLL(cp.points[0]);

// 高架区間 (今の版では 0 のこともある)
const viaduct = [];
{
  let run = null;
  for (let i = 0; i < cp.points.length; i++) {
    if (cp.elevated[i]) { if (!run) run = []; run.push(toLL(cp.points[i])); }
    else if (run) { if (run.length > 3) viaduct.push(run); run = null; }
  }
  if (run && run.length > 3) viaduct.push(run);
}

// ---------------- GeoJSON ----------------
const geojson = {
  type: 'FeatureCollection',
  name: 'Matsue Kart course',
  features: [
    {
      type: 'Feature',
      properties: { name: '松江グランプリ コース', length_m: cp.length, stroke: '#e63946', 'stroke-width': 5 },
      geometry: { type: 'LineString', coordinates: ll.map(([la, lo]) => [r6(lo), r6(la)]) },
    },
    ...viaduct.map((run, i) => ({
      type: 'Feature',
      properties: { name: `新設高架 ${i + 1}`, stroke: '#3a86ff', 'stroke-width': 6 },
      geometry: { type: 'LineString', coordinates: run.map(([la, lo]) => [r6(lo), r6(la)]) },
    })),
    {
      type: 'Feature',
      properties: { name: 'スタート / ゴール', 'marker-color': '#ffd83d' },
      geometry: { type: 'Point', coordinates: [r6(start[1]), r6(start[0])] },
    },
    ...labels.map(l => ({
      type: 'Feature',
      properties: { name: l.name, 'marker-color': '#1d3557' },
      geometry: { type: 'Point', coordinates: [r6(l.ll[1]), r6(l.ll[0])] },
    })),
  ],
};
writeFileSync('public/course.geojson', JSON.stringify(geojson, null, 1));

// ---------------- GPX ----------------
const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Matsue Kart" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>松江グランプリ コース</name><desc>1周 ${cp.length}m</desc></metadata>
${labels.map(l => `  <wpt lat="${r6(l.ll[0])}" lon="${r6(l.ll[1])}"><name>${l.name}</name></wpt>`).join('\n')}
  <trk><name>松江グランプリ コース</name><trkseg>
${ll.map(([la, lo]) => `    <trkpt lat="${r6(la)}" lon="${r6(lo)}"/>`).join('\n')}
  </trkseg></trk>
</gpx>
`;
writeFileSync('public/course.gpx', gpx);

// ---------------- KML (Google マイマップ用) ----------------
const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <name>松江グランプリ コース</name>
  <description>Matsue Kart / 1周 ${cp.length}m</description>
  <Style id="course"><LineStyle><color>ff4639e6</color><width>5</width></LineStyle></Style>
  <Style id="viaduct"><LineStyle><color>ffff863a</color><width>6</width></LineStyle></Style>
  <Placemark><name>コース</name><styleUrl>#course</styleUrl><LineString><tessellate>1</tessellate><coordinates>
${ll.map(([la, lo]) => `${r6(lo)},${r6(la)},0`).join(' ')}
  </coordinates></LineString></Placemark>
${viaduct.map((run, i) => `  <Placemark><name>新設高架 ${i + 1}</name><styleUrl>#viaduct</styleUrl><LineString><tessellate>1</tessellate><coordinates>
${run.map(([la, lo]) => `${r6(lo)},${r6(la)},0`).join(' ')}
  </coordinates></LineString></Placemark>`).join('\n')}
  <Placemark><name>スタート / ゴール</name><Point><coordinates>${r6(start[1])},${r6(start[0])},0</coordinates></Point></Placemark>
${labels.map(l => `  <Placemark><name>${l.name}</name><Point><coordinates>${r6(l.ll[1])},${r6(l.ll[0])},0</coordinates></Point></Placemark>`).join('\n')}
</Document></kml>
`;
writeFileSync('public/course.kml', kml);

// ---------------- Leaflet + OpenStreetMap ----------------
const html = `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>松江グランプリ コース地図</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html,body{margin:0;height:100%;font-family:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
  #map{height:100%}
  .box{position:absolute;z-index:1000;background:rgba(255,255,255,.94);border-radius:10px;
       box-shadow:0 2px 12px rgba(0,0,0,.25);padding:12px 14px;font-size:13px;line-height:1.7}
  #info{top:12px;left:12px;max-width:290px}
  #info h1{margin:0 0 6px;font-size:17px}
  #info .len{color:#c1121f;font-weight:700}
  #info ol{margin:6px 0 0;padding-left:1.2em}
  .lbl{background:#1d3557;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;white-space:nowrap}
  #layers{bottom:22px;left:12px}
  #layers label{display:block;cursor:pointer}
</style>
</head><body>
<div id="map"></div>
<div class="box" id="info">
  <h1>松江グランプリ コース</h1>
  <div>1周 <span class="len">${(cp.length / 1000).toFixed(2)} km</span> / 2周勝負</div>
  <div style="margin-top:6px;color:#555">走行線は国土交通省 PLATEAU の道路データ (tran) の上を通るよう探索したものです。</div>
  <ol id="wps"></ol>
</div>
<div class="box" id="layers">
  <label><input type="radio" name="bm" value="osm" checked> OpenStreetMap</label>
  <label><input type="radio" name="bm" value="gsi"> 地理院地図</label>
  <label><input type="radio" name="bm" value="photo"> 空中写真</label>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const COURSE = ${JSON.stringify(ll.map(([la, lo]) => [r6(la), r6(lo)]))};
const VIADUCT = ${JSON.stringify(viaduct.map(r => r.map(([la, lo]) => [r6(la), r6(lo)])))};
const LABELS = ${JSON.stringify(labels.map(l => ({ name: l.name, ll: [r6(l.ll[0]), r6(l.ll[1])] })))};
const START = ${JSON.stringify([r6(start[0]), r6(start[1])])};

const map = L.map('map');
const bases = {
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
  gsi: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '地理院タイル' }),
  photo: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
    maxZoom: 18, attribution: '地理院タイル (シームレス空中写真)' }),
};
let current = bases.osm.addTo(map);
document.querySelectorAll('input[name=bm]').forEach(r => r.addEventListener('change', e => {
  map.removeLayer(current); current = bases[e.target.value].addTo(map);
}));

const line = L.polyline(COURSE, { color: '#e63946', weight: 6, opacity: .9 }).addTo(map);
L.polyline(COURSE, { color: '#fff', weight: 2, opacity: .7, dashArray: '10 12' }).addTo(map);
VIADUCT.forEach(r => L.polyline(r, { color: '#3a86ff', weight: 8, opacity: .95 })
  .bindTooltip('新設の高架道路').addTo(map));

L.circleMarker(START, { radius: 9, color: '#111', weight: 3, fillColor: '#ffd83d', fillOpacity: 1 })
  .bindTooltip('スタート / ゴール', { permanent: true, direction: 'right', className: 'lbl' }).addTo(map);

const ol = document.getElementById('wps');
LABELS.forEach(l => {
  L.circleMarker(l.ll, { radius: 5, color: '#1d3557', weight: 2, fillColor: '#fff', fillOpacity: 1 })
    .bindTooltip(l.name, { permanent: true, direction: 'top', className: 'lbl' }).addTo(map);
  const li = document.createElement('li');
  li.textContent = l.name;
  li.style.cursor = 'pointer';
  li.onclick = () => map.setView(l.ll, 17);
  ol.appendChild(li);
});
map.fitBounds(line.getBounds(), { padding: [40, 40] });
</script>
</body></html>
`;
writeFileSync('public/course-map.html', html);

console.log('書き出しました:');
console.log('  public/course.geojson  (geojson.io / QGIS)');
console.log('  public/course.gpx      (GPX トラック)');
console.log('  public/course.kml      (Google マイマップ / Google Earth)');
console.log('  public/course-map.html (OpenStreetMap 上に表示)');
console.log(`  コース長 ${cp.length}m / 地点 ${ll.length} / ラベル ${labels.length}`);
