// PLATEAU 建築物 LOD2 — 実写テクスチャ (航空写真由来) をアトラスで貼った建物
import * as THREE from 'three';
import { atlasFile, type QualityPreset } from './quality';
import { assetUrl } from './geo';
import { t } from './i18n';

export interface Lod2Meta {
  vertexCount: number;
  atlasSize: number;
  atlases: string[];
  groups: { atlas: number; start: number; count: number }[];
  skipIds: string[];
}

export async function loadLod2(preset: QualityPreset, onProgress?: (p: number, label?: string) => void): Promise<{ group: THREE.Group; meta: Lod2Meta; triangles: number }> {
  const meta: Lod2Meta = await (await fetch(assetUrl('data/lod2.json'))).json();
  onProgress?.(0.1, t('load.lod2Shape'));
  const buf = await (await fetch(assetUrl('data/lod2.bin'))).arrayBuffer();
  const n = meta.vertexCount;
  const pos = new Float32Array(buf, 0, n * 3);
  const uv = new Float32Array(buf, n * 3 * 4, n * 2);

  const loader = new THREE.TextureLoader();
  const group = new THREE.Group();
  let loaded = 0;
  const jobs = meta.groups.map(async g => {
    if (g.count === 0) return;
    const name = meta.atlases[g.atlas];
    // 低画質時は 2048px 版を使う。未生成の環境では元の 4096px に戻す
    const load = (f: string) => new Promise<THREE.Texture>((res, rej) => loader.load(assetUrl(`data/${f}`), res, undefined, rej));
    const tex = await load(atlasFile(name, preset)).catch(e => {
      if (!preset.halfAtlas) throw e;
      console.warn(`${atlasFile(name, preset)} が無いので ${name} を使います (npm run data:lq で生成できます)`);
      return load(name);
    });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false; // アトラスは上下反転せずに使う (UV 側で調整済み)
    tex.anisotropy = preset.halfAtlas ? 4 : 8;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(g.start * 3, (g.start + g.count) * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv.subarray(g.start * 2, (g.start + g.count) * 2), 2));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    // デバッグ: ?lod2basic=1 で無照明表示 (テクスチャ/UV と法線の切り分け)
    const q = new URLSearchParams(location.search);
    const mat = q.get('lod2basic')
      ? new THREE.MeshBasicMaterial({ map: tex })
      : new THREE.MeshLambertMaterial({ map: tex, side: q.get('lod2dbl') ? THREE.DoubleSide : THREE.FrontSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    loaded++;
    onProgress?.(0.1 + (loaded / meta.groups.length) * 0.9, t('load.lod2Tex', loaded, meta.groups.length));
  });
  await Promise.all(jobs);
  return { group, meta, triangles: n / 3 };
}
