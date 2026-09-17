// キーボード / タッチ入力
export interface Input {
  throttle: number; // 0..1
  brake: number;    // 0..1
  steer: number;    // -1 (左) .. 1 (右)
  drift: boolean;
  item: boolean;    // 押した瞬間だけ true
  lookBack: boolean;
}

/** タッチ操作のボタン (index.html の #pads) */
type Pad = 'left' | 'right' | 'brake' | 'drift' | 'item';
const PADS: [id: string, key: Pad][] = [['tLeft', 'left'], ['tRight', 'right'], ['tBrake', 'brake'], ['tDrift', 'drift'], ['tItem', 'item']];

export class InputManager {
  keys = new Set<string>();
  private itemPressed = false;
  private itemLatched = false;
  onCamera: (() => void) | null = null;
  onMute: (() => void) | null = null;
  onAny: (() => void) | null = null;
  touch: Record<Pad, boolean> = { left: false, right: false, brake: false, drift: false, item: false };
  /**
   * タッチ端末ではアクセルを自動にする。親指 2 本でハンドル・ドリフト・アイテムを
   * 賄うので、アクセルまで押しっぱなしにする指が無い。ブレーキを押している間だけ離す。
   */
  readonly autoGas = matchMedia('(pointer: coarse)').matches;
  private pads: { el: HTMLElement; key: Pad }[] = [];
  /** 触れている指ごとに、いま乗っているボタン (identifier → Pad)。マウスは -1 */
  private fingers = new Map<number, Pad | null>();

  constructor() {
    window.addEventListener('keydown', e => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyC') this.onCamera?.();
      if (e.code === 'KeyM') this.onMute?.();
      if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'Enter' || e.code === 'KeyX') this.itemPressed = true;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      this.onAny?.();
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.fingers.clear(); this.refresh(); });

    // タッチはボタンごとではなく #touch (画面全面) で受ける。ボタンに touchstart を
    // 付ける方式だと、◀ に置いた指を ▶ へ滑らせても ◀ が押されたままになる。
    // 指ごとに座標からボタンを引き直すので、滑らせても持ち替えても効く。
    const layer = document.getElementById('touch');
    if (!layer) return;
    for (const [id, key] of PADS) {
      const el = document.getElementById(id);
      if (el) this.pads.push({ el, key });
    }
    const track = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) this.press(t.identifier, this.padAt(t.clientX, t.clientY));
    };
    layer.addEventListener('touchstart', e => { track(e); this.onAny?.(); }, { passive: false });
    layer.addEventListener('touchmove', track, { passive: false });
    const release = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) this.fingers.delete(t.identifier);
      this.refresh();
    };
    layer.addEventListener('touchend', release, { passive: false });
    layer.addEventListener('touchcancel', release, { passive: false });
    // マウスでも押せるようにしておく (PC のブラウザでスマホ表示を試すとき用)
    layer.addEventListener('mousedown', e => { this.press(-1, this.padAt(e.clientX, e.clientY)); this.onAny?.(); });
    window.addEventListener('mouseup', () => { if (this.fingers.delete(-1)) this.refresh(); });
  }

  /** 座標にあるボタン。丸ボタンだが判定は少し広めの矩形 (縁で取りこぼさないように) */
  private padAt(x: number, y: number): Pad | null {
    const m = 10;
    for (const p of this.pads) {
      const r = p.el.getBoundingClientRect();
      if (x >= r.left - m && x <= r.right + m && y >= r.top - m && y <= r.bottom + m) return p.key;
    }
    return null;
  }

  private press(id: number, pad: Pad | null): void {
    const prev = this.fingers.get(id);
    if (this.fingers.has(id) && prev === pad) return;
    this.fingers.set(id, pad);
    // アイテムは押した瞬間だけ。滑って乗ったときも同じ扱い
    if (pad === 'item' && prev !== 'item') this.itemPressed = true;
    this.refresh();
  }

  /** 指の配置から各ボタンの押下状態を作り直し、押されているボタンを光らせる */
  private refresh(): void {
    for (const k of Object.keys(this.touch) as Pad[]) this.touch[k] = false;
    for (const pad of this.fingers.values()) if (pad) this.touch[pad] = true;
    for (const p of this.pads) p.el.classList.toggle('on', this.touch[p.key]);
  }

  read(): Input {
    const k = this.keys;
    const left = k.has('ArrowLeft') || k.has('KeyA') || this.touch.left;
    const right = k.has('ArrowRight') || k.has('KeyD') || this.touch.right;
    const item = this.itemPressed && !this.itemLatched;
    this.itemLatched = this.itemPressed;
    this.itemPressed = false;
    const brake = k.has('ArrowDown') || k.has('KeyS') || this.touch.brake;
    return {
      throttle: (k.has('ArrowUp') || k.has('KeyW') || (this.autoGas && !brake)) ? 1 : 0,
      brake: brake ? 1 : 0,
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      drift: k.has('ShiftLeft') || k.has('ShiftRight') || k.has('Space') || this.touch.drift,
      item,
      lookBack: k.has('KeyB'),
    };
  }
}
