// Playwright で動作確認スクリーンショットを撮る (開発用)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] || 'data/shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:5182/', { waitUntil: 'load' });
// 読み込み完了 (スタートボタン有効化) を待つ
await page.waitForFunction(() => { const b = document.getElementById('startBtn'); return b && !b.disabled; }, null, { timeout: 180000 });
await page.screenshot({ path: `${OUT}/01_title.png` });
await page.click('#startBtn');
await page.waitForTimeout(4500);
await page.screenshot({ path: `${OUT}/02_start.png` });
// アクセル + 少し走る
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/03_drive.png` });
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/04_drift.png` });
await page.keyboard.up('ArrowLeft');
await page.keyboard.up('ShiftLeft');
await page.keyboard.press('KeyC');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/05_cam2.png` });
await page.keyboard.up('ArrowUp');
const info = await page.evaluate(() => ({ speed: document.getElementById('speed')?.textContent, lap: document.getElementById('lap')?.textContent, pos: document.getElementById('pos')?.textContent }));
console.log(JSON.stringify(info));
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
