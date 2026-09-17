// WebAudio による簡易サウンド (エンジン音 + 効果音)
export class AudioSystem {
  ctx: AudioContext | null = null;
  private engine: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private master: GainNode | null = null;
  muted = false;

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain(); this.master.gain.value = 0.5; this.master.connect(ctx.destination);
      this.engine = ctx.createOscillator(); this.engine.type = 'sawtooth'; this.engine.frequency.value = 60;
      const sub = ctx.createOscillator(); sub.type = 'square'; sub.frequency.value = 30;
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = 400;
      this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0.0;
      this.engine.connect(this.filter); sub.connect(this.filter);
      this.filter.connect(this.engineGain); this.engineGain.connect(this.master);
      this.engine.start(); sub.start();
      (this as any)._sub = sub;
    } catch { /* no audio */ }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  /** speed: m/s, boost: bool */
  engineUpdate(speed: number, throttle: number, boost: boolean) {
    if (!this.ctx || !this.engine || !this.engineGain || !this.filter) return;
    const t = this.ctx.currentTime;
    const f = 55 + speed * 3.2 + (boost ? 40 : 0) + throttle * 8;
    this.engine.frequency.setTargetAtTime(f, t, 0.05);
    ((this as any)._sub as OscillatorNode).frequency.setTargetAtTime(f / 2, t, 0.05);
    this.filter.frequency.setTargetAtTime(300 + speed * 25, t, 0.1);
    this.engineGain.gain.setTargetAtTime(0.08 + Math.min(speed, 60) / 60 * 0.12 + throttle * 0.03, t, 0.1);
  }

  private beep(freq: number, dur: number, type: OscillatorType = 'square', vol = 0.25, slide = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    const g = this.ctx.createGain(); g.gain.value = vol;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }

  countdown(final = false) { this.beep(final ? 880 : 440, final ? 0.6 : 0.2, 'square', 0.3); }
  pickup() { this.beep(660, 0.12, 'triangle', 0.3, 400); }
  coin() { this.beep(1320, 0.1, 'sine', 0.2, 500); }
  useItem() { this.beep(500, 0.15, 'square', 0.25, -200); }
  boost() { this.beep(200, 0.5, 'sawtooth', 0.3, 900); }
  hit() { this.beep(120, 0.4, 'sawtooth', 0.35, -80); }
  bump() { this.beep(90, 0.12, 'square', 0.2); }
  lap() { this.beep(523, 0.15, 'square', 0.25); setTimeout(() => this.beep(659, 0.15, 'square', 0.25), 150); setTimeout(() => this.beep(784, 0.3, 'square', 0.25), 300); }
  finish() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, 0.35, 'square', 0.3), i * 180)); }
  /** 対戦相手が来た合図 (短いファンファーレ)。ロビーで待っているときに鳴らす */
  opponent() {
    const melody = [523, 659, 784, 1047, 784, 1047, 1319];
    melody.forEach((f, i) => setTimeout(() => this.beep(f, i === melody.length - 1 ? 0.7 : 0.16, 'triangle', 0.35), i * 130));
    // 主旋律の下に和音を軽く添える
    [[262, 0], [330, 260], [392, 520], [523, 780]].forEach(([f, d]) => setTimeout(() => this.beep(f, 0.5, 'square', 0.1), d));
  }
}
