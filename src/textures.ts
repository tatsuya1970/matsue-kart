// プロシージャルテクスチャ (Canvas)
import * as THREE from 'three';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!] as const;
}

function toTexture(c: HTMLCanvasElement, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** 壁面テクスチャ: 1タイル = 幅4m x 高さ3.5m (窓2つ x 1階) */
export function makeWallTexture(variant: number): THREE.Texture {
  const [c, ctx] = canvas(256, 224);
  const noise = (a: number) => (Math.random() - 0.5) * a;
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  switch (variant) {
    case 0: { // ガラス張りオフィス
      ctx.fillStyle = '#5d86a8'; ctx.fillRect(0, 0, 256, 224);
      const g = ctx.createLinearGradient(0, 0, 256, 224);
      g.addColorStop(0, 'rgba(200,225,245,0.55)'); g.addColorStop(0.5, 'rgba(90,130,170,0.2)'); g.addColorStop(1, 'rgba(30,60,90,0.5)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 224);
      ctx.fillStyle = '#243d55';
      for (let x = 0; x < 256; x += 64) ctx.fillRect(x, 0, 5, 224);
      ctx.fillRect(0, 0, 256, 10); ctx.fillRect(0, 214, 256, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      for (let i = 0; i < 4; i++) ctx.fillRect(i * 64 + 8, 14, 20, 40);
      break;
    }
    case 1: { // コンクリートオフィス (ベージュ)
      ctx.fillStyle = '#c9bfae'; ctx.fillRect(0, 0, 256, 224);
      for (let i = 0; i < 600; i++) { ctx.fillStyle = `rgba(0,0,0,${rnd(0, 0.08)})`; ctx.fillRect(rnd(0, 256), rnd(0, 224), 3, 3); }
      for (let i = 0; i < 2; i++) {
        const x = 20 + i * 128;
        ctx.fillStyle = '#2b3a48'; ctx.fillRect(x, 50, 88, 120);
        ctx.fillStyle = 'rgba(160,200,230,0.35)'; ctx.fillRect(x + 4, 54, 80, 50);
        ctx.fillStyle = '#8e8474'; ctx.fillRect(x - 4, 170, 96, 6);
        ctx.fillStyle = '#5a6a78'; ctx.fillRect(x + 42, 50, 4, 120);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, 210, 256, 14);
      break;
    }
    case 2: { // マンション (白, バルコニー)
      ctx.fillStyle = '#e8e4dc'; ctx.fillRect(0, 0, 256, 224);
      ctx.fillStyle = '#d5d0c6'; ctx.fillRect(0, 150, 256, 74);
      // バルコニー手すり
      ctx.fillStyle = '#9aa3ad'; ctx.fillRect(0, 150, 256, 6);
      ctx.fillStyle = '#b8bfc7';
      for (let x = 0; x < 256; x += 12) ctx.fillRect(x, 156, 3, 50);
      ctx.fillStyle = '#7d8790'; ctx.fillRect(0, 206, 256, 18);
      // 窓
      for (let i = 0; i < 2; i++) {
        const x = 24 + i * 128;
        ctx.fillStyle = '#34495e'; ctx.fillRect(x, 40, 80, 105);
        ctx.fillStyle = 'rgba(190,215,235,0.45)'; ctx.fillRect(x + 4, 44, 34, 96);
        ctx.fillStyle = '#c9ccd1'; ctx.fillRect(x + 38, 40, 4, 105);
      }
      ctx.fillStyle = '#c8c2b8'; ctx.fillRect(122, 0, 12, 224);
      break;
    }
    case 3: { // レンガ / 茶系ビル
      ctx.fillStyle = '#9a5a45'; ctx.fillRect(0, 0, 256, 224);
      for (let y = 0; y < 224; y += 14) {
        for (let x = (y / 14 % 2) * 16 - 16; x < 256; x += 32) {
          ctx.fillStyle = `rgb(${150 + noise(30) | 0},${85 + noise(20) | 0},${65 + noise(20) | 0})`;
          ctx.fillRect(x + 1, y + 1, 30, 12);
        }
      }
      for (let i = 0; i < 2; i++) {
        const x = 28 + i * 128;
        ctx.fillStyle = '#e9e2d4'; ctx.fillRect(x - 6, 44, 84, 120);
        ctx.fillStyle = '#233240'; ctx.fillRect(x, 50, 72, 108);
        ctx.fillStyle = 'rgba(200,220,240,0.35)'; ctx.fillRect(x + 4, 54, 30, 100);
        ctx.fillStyle = '#e9e2d4'; ctx.fillRect(x + 34, 50, 4, 108);
      }
      break;
    }
    case 4: { // 住宅 (グレー壁, 小窓)
      ctx.fillStyle = '#d8d6cf'; ctx.fillRect(0, 0, 256, 224);
      for (let i = 0; i < 500; i++) { ctx.fillStyle = `rgba(0,0,0,${rnd(0, 0.06)})`; ctx.fillRect(rnd(0, 256), rnd(0, 224), 4, 4); }
      ctx.fillStyle = '#6b6f73'; ctx.fillRect(0, 0, 256, 8);
      ctx.fillStyle = '#3b4a58'; ctx.fillRect(40, 70, 60, 70); ctx.fillRect(156, 70, 60, 70);
      ctx.fillStyle = 'rgba(210,230,245,0.4)'; ctx.fillRect(44, 74, 24, 62); ctx.fillRect(160, 74, 24, 62);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(36, 66, 68, 4); ctx.fillRect(152, 66, 68, 4);
      ctx.fillStyle = '#bdb9b0'; ctx.fillRect(0, 200, 256, 24);
      break;
    }
    default: { // 商業ビル (看板色)
      ctx.fillStyle = '#eae6df'; ctx.fillRect(0, 0, 256, 224);
      ctx.fillStyle = '#2f3b47'; ctx.fillRect(0, 40, 256, 130);
      ctx.fillStyle = 'rgba(180,210,235,0.35)';
      for (let x = 8; x < 256; x += 40) ctx.fillRect(x, 48, 30, 114);
      const cols = ['#e63946', '#f4a261', '#2a9d8f', '#e9c46a', '#457b9d'];
      ctx.fillStyle = cols[Math.floor(Math.random() * cols.length)];
      ctx.fillRect(0, 176, 256, 40);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let x = 20; x < 240; x += 36) ctx.fillRect(x, 186, 22, 20);
      break;
    }
  }
  return toTexture(c);
}

export function makeRoofTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#8f8c86'; ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 400; i++) { ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`; ctx.fillRect(Math.random() * 128, Math.random() * 128, 4, 4); }
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2; ctx.strokeRect(8, 8, 112, 112);
  return toTexture(c);
}

/** コース路面 (1タイル = 道幅 x 20m) */
export function makeRoadTexture(): THREE.Texture {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#3d3f44'; ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 6000; i++) { ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.06})`; ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2); }
  // 車線 (中央: 黄色実線 / 左右: 白破線) — 進行方向は v 方向
  ctx.fillStyle = '#e9c34a'; ctx.fillRect(252, 0, 8, 512);
  ctx.fillStyle = '#f0f0f0';
  for (let y = 0; y < 512; y += 128) { ctx.fillRect(124, y, 6, 64); ctx.fillRect(382, y, 6, 64); }
  // 端の白線
  ctx.fillRect(6, 0, 8, 512); ctx.fillRect(498, 0, 8, 512);
  return toTexture(c);
}

export function makeCheckerTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 64);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) { ctx.fillStyle = (x + y) % 2 ? '#111' : '#fafafa'; ctx.fillRect(x * 32, y * 32, 32, 32); }
  return toTexture(c);
}

export function makeCurbTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 32);
  ctx.fillStyle = '#d62828'; ctx.fillRect(0, 0, 128, 32);
  ctx.fillStyle = '#f5f5f5'; ctx.fillRect(0, 0, 64, 32);
  return toTexture(c);
}

export function makeItemBoxTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 128);
  const g = ctx.createLinearGradient(0, 0, 128, 128);
  g.addColorStop(0, '#7ef0ff'); g.addColorStop(0.5, '#ffe57e'); g.addColorStop(1, '#ff7ee8');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = 'bold 90px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('?', 64, 70);
  return toTexture(c, false);
}

/** 地名看板 */
export function makeSignTexture(text: string, sub = ''): THREE.Texture {
  const [c, ctx] = canvas(1024, 192);
  ctx.fillStyle = '#1d3557'; ctx.fillRect(0, 0, 1024, 192);
  ctx.fillStyle = '#e63946'; ctx.fillRect(0, 0, 1024, 14); ctx.fillRect(0, 178, 1024, 14);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 96px "Hiragino Sans","Noto Sans JP","Segoe UI",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  // 長い地名 (エディオンピースウィング など) は縮めて収める
  ctx.fillText(text, 512, sub ? 78 : 96, 940);
  if (sub) { ctx.font = '40px sans-serif'; ctx.fillStyle = '#ffd83d'; ctx.fillText(sub, 512, 148); }
  const t = toTexture(c, false);
  return t;
}

export function makeBannerTexture(): THREE.Texture {
  const [c, ctx] = canvas(1024, 256);
  ctx.fillStyle = '#1f3a68'; ctx.fillRect(0, 0, 1024, 256);
  for (let x = 0; x < 1024; x += 64) { ctx.fillStyle = (x / 64) % 2 ? '#fff' : '#111'; ctx.fillRect(x, 0, 64, 24); ctx.fillRect(x, 232, 64, 24); }
  ctx.fillStyle = '#fff'; ctx.font = 'italic bold 120px "Segoe UI",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('MATSUE KART', 512, 118);
  ctx.font = 'bold 44px sans-serif'; ctx.fillStyle = '#ffd83d'; ctx.fillText('松江グランプリ  START / FINISH', 512, 196);
  return toTexture(c, false);
}

/** 車両側面 (1 タイル = 車体 1 両分の側面) */
export function makeTrainSideTexture(kind: 'ichibata' | 'jr'): THREE.Texture {
  const [c, ctx] = canvas(1024, 256);
  const body = '#f2f5f7';
  ctx.fillStyle = body; ctx.fillRect(0, 0, 1024, 256);
  const glass = '#1d2b38';
  if (kind === 'ichibata') {
    // 一畑電車: 白い車体に紺の帯と橙の細帯
    ctx.fillStyle = '#1e3f86'; ctx.fillRect(0, 176, 1024, 30);
    ctx.fillStyle = '#f08a24'; ctx.fillRect(0, 206, 1024, 8);
    ctx.fillStyle = '#1e3f86'; ctx.fillRect(0, 56, 1024, 8);
  } else {
    // JR 西日本 山陰地区の気動車: 白い車体に赤と紺の帯
    ctx.fillStyle = '#b22234'; ctx.fillRect(0, 174, 1024, 22);
    ctx.fillStyle = '#233e8b'; ctx.fillRect(0, 196, 1024, 12);
  }
  // 窓とドア
  const winTop = 78, winH = 88;
  const doorW = 84, winW = 108;
  let x = 26;
  const doorMat = '#dfe4e8';
  while (x < 1024 - 26) {
    // ドア
    ctx.fillStyle = doorMat; ctx.fillRect(x, 48, doorW, 168);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 2; ctx.strokeRect(x, 48, doorW, 168);
    ctx.fillStyle = glass; ctx.fillRect(x + 12, winTop, doorW - 24, winH - 18);
    x += doorW + 18;
    // 側窓 2 枚
    for (let k = 0; k < 2 && x < 1024 - 26; k++) {
      ctx.fillStyle = glass;
      roundRect(ctx, x, winTop, winW, winH, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      roundRect(ctx, x + 6, winTop + 6, winW - 12, winH * 0.3, 6);
      x += winW + 16;
    }
  }
  // 床下の陰
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 226, 1024, 30);
  // 屋根寄りの陰
  ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, 0, 1024, 26);
  return toTexture(c);
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/** 線路のバラスト */
export function makeBallastTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#6e6a60'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const g = 80 + Math.random() * 90 | 0;
    ctx.fillStyle = `rgb(${g},${g - 6},${g - 16})`;
    const s = 2 + Math.random() * 4;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, s, s);
  }
  return toTexture(c);
}

/** 高架橋のコンクリート */
export function makeConcreteTexture(): THREE.Texture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#b3b7bb'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${90 + Math.random() * 80 | 0},${90 + Math.random() * 80 | 0},${95 + Math.random() * 70 | 0},0.18)`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 5, 5);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 2;
  for (let y = 0; y < 256; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke(); }
  return toTexture(c);
}

export function makeCoinTexture(): THREE.Texture {
  const [c, ctx] = canvas(64, 64);
  ctx.fillStyle = '#f7c948'; ctx.beginPath(); ctx.arc(32, 32, 30, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#c9961a'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#c9961a'; ctx.font = 'bold 36px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('¥', 32, 34);
  return toTexture(c, false);
}
