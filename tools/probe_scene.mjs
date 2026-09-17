// カメラ前方に何が写っているかをレイキャストで調べる (開発用)
//   node tools/probe_scene.mjs "debug=1&wp=7&cam=0"
import { chromium } from 'playwright';

const query = process.argv[2] ?? 'debug=1&wp=7&cam=0';
// 第 2 引数以降で画面座標を指定できる: "-0.55,0.32"
const customPts = process.argv.slice(3).map(s => s.split(',').map(Number));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5182/?' + query, { waitUntil: 'load' });
await page.waitForFunction(() => (window).__debug, null, { timeout: 240000 });
await page.waitForTimeout(2000);

const out = await page.evaluate((customPts) => {
  const d = (window).__debug;
  const T = d.THREE;
  const rc = new T.Raycaster();
  const lines = [];
  // 画面 5 点から前方へ
  const pts = customPts.length ? customPts : [[0, 0], [0, 0.4], [-0.6, 0.2], [0.6, 0.2], [0, -0.3], [-0.7, -0.5], [-0.4, -0.35], [-0.85, -0.2]];
  for (const [px, py] of pts) {
    rc.setFromCamera(new T.Vector2(px, py), d.camera);
    const hits = rc.intersectObjects(d.scene.children, true).slice(0, 3);
    lines.push(`screen(${px},${py}): ` + (hits.length ? hits.map(h => {
      const m = h.object;
      const mat = m.material;
      const col = mat && mat.color ? '#' + mat.color.getHexString() : '-';
      const tex = mat && mat.map ? (mat.map.name || 'tex') : 'noTex';
      return `${m.type}/${mat?.type ?? '-'} col=${col} ${tex} d=${h.distance.toFixed(1)} tris=${m.geometry?.index ? m.geometry.index.count / 3 : (m.geometry?.attributes?.position?.count ?? 0) / 3} y=${h.point.y.toFixed(1)}`;
    }).join(' | ') : 'nothing'));
  }
  // シーン直下の各グループの世界バウンディングボックス
  const box = new T.Box3();
  d.scene.children.forEach((c, i) => {
    if (c.isLight || !c.children.length && !c.geometry) return;
    box.setFromObject(c);
    if (!box.isEmpty()) {
      const s = box.getSize(new T.Vector3()), ctr = box.getCenter(new T.Vector3());
      lines.push(`child${i} ${c.type}(${c.children.length}) size=(${s.x.toFixed(0)},${s.y.toFixed(0)},${s.z.toFixed(0)}) center=(${ctr.x.toFixed(0)},${ctr.y.toFixed(0)},${ctr.z.toFixed(0)})`);
    }
  });
  // カメラ位置とプレイヤー
  const p = d.karts[0];
  lines.push(`camera=(${d.camera.position.x.toFixed(1)},${d.camera.position.y.toFixed(1)},${d.camera.position.z.toFixed(1)}) player=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`);
  // シーン直下の子の一覧
  lines.push('scene children: ' + d.scene.children.map((c, i) => `${i}:${c.type}(${c.children.length})`).join(' '));
  return lines.join('\n');
}, customPts);
console.log(out);
await browser.close();
