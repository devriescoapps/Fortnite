// Fully procedural audio (WebAudio synthesis — no sample files): positional weapon sounds,
// footsteps, building, loot, UI, ambience, storm, vehicles and music stings.
import type { WeaponClass } from '../shared/items';

type V = { x: number; y: number; z: number };

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private amb!: GainNode;
  private white!: AudioBuffer;
  private brown!: AudioBuffer;
  private listener = { x: 0, y: 0, z: 0 };
  private loops = new Map<string, { src: AudioScheduledSourceNode[]; gain: GainNode; panner?: PannerNode; extra?: AudioNode[] }>();
  private musicTimer = 0;
  volumes = { master: 0.8, music: 0.5, sfx: 0.9 };

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.connect(comp);
    this.music = ctx.createGain();
    this.music.connect(this.master);
    this.amb = ctx.createGain();
    this.amb.connect(comp);
    this.white = this.noiseBuffer('white');
    this.brown = this.noiseBuffer('brown');
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master;
    this.sfx.gain.value = this.volumes.sfx;
    this.amb.gain.value = this.volumes.sfx * 0.6;
    this.music.gain.value = this.volumes.music * 0.5;
  }

  private noiseBuffer(kind: 'white' | 'brown') {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 2;
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    return b;
  }

  setListener(pos: V, fx: number, fz: number) {
    this.listener = pos;
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(pos.x, t, 0.02);
      l.positionY.setTargetAtTime(pos.y, t, 0.02);
      l.positionZ.setTargetAtTime(pos.z, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setTargetAtTime(0, t, 0.02);
      l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z);
    }
  }

  private out(pos: V | null, maxDist = 250): AudioNode | null {
    if (!this.ctx) return null;
    if (!pos) return this.sfx;
    const d = Math.hypot(pos.x - this.listener.x, pos.y - this.listener.y, pos.z - this.listener.z);
    if (d > maxDist) return null;
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.rolloffFactor = 1.1;
    p.maxDistance = maxDist;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    // distant sounds get muffled
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(700, 18000 - d * 90);
    lp.connect(p);
    p.connect(this.sfx);
    return lp;
  }

  private noise(dest: AudioNode, t: number, dur: number, gain: number, filter: BiquadFilterType, freq: number, q = 1, brown = false, freqEnd?: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = brown ? this.brown : this.white;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private tone(dest: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number, attack = 0.004) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------------ weapons
  shot(cls: WeaponClass, pos: V | null, local = false) {
    const d = this.out(local ? null : pos, 400);
    if (!d || !this.ctx) return;
    const t = this.ctx.currentTime;
    const v = local ? 0.55 : 0.9;
    switch (cls) {
      case 'ar':
        this.noise(d, t, 0.16, 0.7 * v, 'bandpass', 1500, 0.8);
        this.tone(d, t, 'sine', 160, 50, 0.14, 0.6 * v);
        break;
      case 'smg':
        this.noise(d, t, 0.09, 0.55 * v, 'bandpass', 2400, 0.9);
        this.tone(d, t, 'square', 220, 80, 0.06, 0.18 * v);
        break;
      case 'shotgun':
        this.noise(d, t, 0.45, 0.95 * v, 'lowpass', 2600, 0.7, false, 400);
        this.tone(d, t, 'sine', 120, 38, 0.3, 0.9 * v);
        this.noise(d, t + 0.35, 0.12, 0.2 * v, 'bandpass', 900, 3); // pump
        break;
      case 'sniper':
        this.noise(d, t, 0.9, 0.9 * v, 'highpass', 900, 0.5, false);
        this.tone(d, t, 'sawtooth', 300, 40, 0.25, 0.35 * v);
        this.noise(d, t + 0.05, 1.2, 0.25 * v, 'lowpass', 500, 0.5, true);
        break;
      case 'pistol':
        this.noise(d, t, 0.12, 0.6 * v, 'bandpass', 2000, 1.2);
        this.tone(d, t, 'triangle', 300, 90, 0.08, 0.3 * v);
        break;
      case 'explosive':
        this.noise(d, t, 0.6, 0.6 * v, 'bandpass', 700, 0.6, false, 2500);
        this.tone(d, t, 'sine', 90, 40, 0.3, 0.6 * v);
        break;
      case 'melee':
        this.noise(d, t, 0.12, 0.35 * v, 'bandpass', 700, 1.5, false, 300);
        break;
    }
  }

  explosion(pos: V) {
    const d = this.out(pos, 600);
    if (!d || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noise(d, t, 1.6, 1.4, 'lowpass', 1800, 0.7, true, 90);
    this.tone(d, t, 'sine', 70, 25, 1.1, 1.2);
    this.noise(d, t, 0.25, 0.6, 'highpass', 2000, 0.5);
  }

  reload(pos: V | null) {
    const d = this.out(pos, 40);
    if (!d || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noise(d, t, 0.06, 0.25, 'bandpass', 3000, 4);
    this.noise(d, t + 0.35, 0.08, 0.3, 'bandpass', 1800, 4);
    this.tone(d, t + 0.36, 'square', 900, 600, 0.04, 0.05);
  }

  empty() {
    if (!this.ctx) return;
    this.noise(this.sfx, this.ctx.currentTime, 0.04, 0.2, 'bandpass', 4000, 6);
  }

  // ------------------------------------------------------------------ movement
  footstep(pos: V | null, surface: 'grass' | 'wood' | 'stone' | 'metal' | 'sand' | 'snow' | 'water', loud = 1) {
    const d = this.out(pos, 45);
    if (!d || !this.ctx) return;
    const t = this.ctx.currentTime;
    const g = (pos ? 0.55 : 0.18) * loud;
    switch (surface) {
      case 'grass': this.noise(d, t, 0.09, g, 'lowpass', 900, 0.7); break;
      case 'sand': this.noise(d, t, 0.12, g, 'lowpass', 1400, 0.5); break;
      case 'snow': this.noise(d, t, 0.14, g * 1.2, 'bandpass', 1100, 0.6); break;
      case 'wood':
        this.noise(d, t, 0.07, g, 'bandpass', 500, 2);
        this.tone(d, t, 'sine', 140, 90, 0.07, g * 0.6);
        break;
      case 'stone': this.noise(d, t, 0.05, g, 'highpass', 1800, 0.8); break;
      case 'metal':
        this.noise(d, t, 0.05, g, 'bandpass', 2600, 3);
        this.tone(d, t, 'triangle', 800, 700, 0.1, g * 0.2);
        break;
      case 'water': this.noise(d, t, 0.25, g * 1.3, 'bandpass', 700, 0.8, false, 1500); break;
    }
  }

  jump(pos: V | null) {
    const d = this.out(pos, 40);
    if (!d || !this.ctx) return;
    this.noise(d, this.ctx.currentTime, 0.12, pos ? 0.3 : 0.12, 'bandpass', 600, 1);
  }

  land(pos: V | null, hard: boolean) {
    const d = this.out(pos, 50);
    if (!d || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noise(d, t, hard ? 0.3 : 0.14, hard ? 0.8 : 0.35, 'lowpass', 600, 0.8, true);
  }

  whoosh(pos: V | null) {
    const d = this.out(pos, 200);
    if (!d || !this.ctx) return;
    this.noise(d, this.ctx.currentTime, 0.7, 0.5, 'bandpass', 400, 1.2, false, 1600);
  }

  // ------------------------------------------------------------------ build / harvest
  build(pos: V | null, mat: number) {
    const d = this.out(pos, 80);
    if (!d || !this.ctx) return;
    const t = this.ctx.currentTime;
    const f = [260, 420, 700][mat] ?? 300;
    this.tone(d, t, 'triangle', f, f * 0.6, 0.09, 0.4);
    this.noise(d, t, 0.08, 0.35, 'bandpass', f * 3, 2);
    this.tone(d, t + 0.06, 'triangle', f * 1.3, f * 0.8, 0.08, 0.25);
  }

  harvest(pos: V | null, kind: 'wood' | 'stone' | 'metal') {
    const d = this.out(pos, 80);
    if (!d || !this.ctx) return;
    const t = this.ctx.currentTime;
    if (kind === 'wood') {
      this.tone(d, t, 'sine', 180, 110, 0.12, 0.6);
      this.noise(d, t, 0.1, 0.4, 'bandpass', 900, 2);
    } else if (kind === 'stone') {
      this.noise(d, t, 0.14, 0.6, 'bandpass', 2200, 1.5);
      this.tone(d, t, 'square', 320, 200, 0.05, 0.12);
    } else {
      this.tone(d, t, 'triangle', 1400, 1300, 0.35, 0.35);
      this.tone(d, t, 'sine', 2100, 2000, 0.25, 0.15);
      this.noise(d, t, 0.05, 0.3, 'highpass', 3000, 1);
    }
  }

  breakPiece(pos: V) {
    const d = this.out(pos, 150);
    if (!d || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.noise(d, t, 0.5, 0.7, 'lowpass', 1500, 0.8, true, 200);
    this.noise(d, t + 0.05, 0.3, 0.4, 'bandpass', 2500, 1.5);
  }

  // ------------------------------------------------------------------ feedback
  hitmarker(head: boolean, shield: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = head ? 2200 : shield ? 1500 : 1100;
    this.tone(this.sfx, t, 'sine', f, f * 0.95, 0.06, 0.18);
    if (head) this.tone(this.sfx, t + 0.05, 'sine', f * 1.5, f * 1.4, 0.08, 0.14);
  }

  elimination() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [880, 1320, 1760].forEach((f, i) => this.tone(this.sfx, t + i * 0.07, 'triangle', f, f, 0.18, 0.2));
  }

  hurt(shield: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (shield) this.tone(this.sfx, t, 'sine', 700, 350, 0.12, 0.2);
    else this.noise(this.sfx, t, 0.15, 0.35, 'lowpass', 600, 1, true);
  }

  pickup() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(this.sfx, t, 'triangle', 660, 660, 0.08, 0.2);
    this.tone(this.sfx, t + 0.06, 'triangle', 990, 990, 0.12, 0.2);
  }

  chestOpen(pos: V) {
    const d = this.out(pos, 60);
    if (!d || !this.ctx) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(d, t + i * 0.05, 'sine', f, f, 0.35, 0.18));
    this.noise(d, t, 0.3, 0.2, 'highpass', 5000, 1);
  }

  heal(done: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (done) [600, 800, 1000].forEach((f, i) => this.tone(this.sfx, t + i * 0.06, 'sine', f, f * 1.1, 0.15, 0.15));
    else this.noise(this.sfx, t, 0.3, 0.1, 'bandpass', 3000, 3);
  }

  ui(kind: 'click' | 'hover' | 'error' | 'notify' | 'match' | 'level') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    switch (kind) {
      case 'click': this.tone(this.sfx, t, 'square', 900, 600, 0.05, 0.08); break;
      case 'hover': this.tone(this.sfx, t, 'sine', 1400, 1400, 0.03, 0.03); break;
      case 'error': this.tone(this.sfx, t, 'sawtooth', 200, 140, 0.18, 0.12); break;
      case 'notify': this.tone(this.sfx, t, 'triangle', 1200, 1250, 0.2, 0.15); break;
      case 'match': [440, 554, 659, 880].forEach((f, i) => this.tone(this.sfx, t + i * 0.1, 'triangle', f, f, 0.3, 0.18)); break;
      case 'level': [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(this.sfx, t + i * 0.09, 'square', f, f, 0.2, 0.08)); break;
    }
  }

  // ------------------------------------------------------------------ loops
  private startLoop(key: string, make: (ctx: AudioContext, g: GainNode) => { src: AudioScheduledSourceNode[]; extra?: AudioNode[] }, dest: AudioNode, panned?: V) {
    if (!this.ctx || this.loops.has(key)) return;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    let panner: PannerNode | undefined;
    if (panned) {
      panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.refDistance = 3;
      panner.rolloffFactor = 1.4;
      panner.positionX.value = panned.x;
      panner.positionY.value = panned.y;
      panner.positionZ.value = panned.z;
      g.connect(panner).connect(dest);
    } else g.connect(dest);
    const r = make(this.ctx, g);
    this.loops.set(key, { src: r.src, gain: g, panner, extra: r.extra });
  }

  setLoop(key: string, vol: number, pos?: V, pitch?: number) {
    const l = this.loops.get(key);
    if (!l || !this.ctx) return;
    const t = this.ctx.currentTime;
    l.gain.gain.setTargetAtTime(vol, t, 0.15);
    if (pos && l.panner) {
      l.panner.positionX.setTargetAtTime(pos.x, t, 0.05);
      l.panner.positionY.setTargetAtTime(pos.y, t, 0.05);
      l.panner.positionZ.setTargetAtTime(pos.z, t, 0.05);
    }
    if (pitch !== undefined) for (const s of l.src) if (s instanceof OscillatorNode) s.frequency.setTargetAtTime(pitch * (s as OscillatorNode & { base?: number }).base!, t, 0.1);
  }

  stopLoop(key: string) {
    const l = this.loops.get(key);
    if (!l) return;
    for (const s of l.src) try { s.stop(); } catch { /* already stopped */ }
    l.gain.disconnect();
    this.loops.delete(key);
  }

  hasLoop(key: string) {
    return this.loops.has(key);
  }

  ensureAmbience() {
    if (!this.ctx) return;
    // wind
    this.startLoop('wind', (ctx, g) => {
      const s = ctx.createBufferSource();
      s.buffer = this.white;
      s.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 500;
      f.Q.value = 0.6;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.13;
      const lg = ctx.createGain();
      lg.gain.value = 250;
      lfo.connect(lg).connect(f.frequency);
      s.connect(f).connect(g);
      s.start();
      lfo.start();
      return { src: [s, lfo] };
    }, this.amb);
    // storm rumble
    this.startLoop('storm', (ctx, g) => {
      const s = ctx.createBufferSource();
      s.buffer = this.brown;
      s.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 260;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      (o as OscillatorNode & { base?: number }).base = 48;
      o.frequency.value = 48;
      const og = ctx.createGain();
      og.gain.value = 0.08;
      s.connect(f).connect(g);
      o.connect(og).connect(g);
      s.start();
      o.start();
      return { src: [s, o] };
    }, this.amb);
    // ocean
    this.startLoop('ocean', (ctx, g) => {
      const s = ctx.createBufferSource();
      s.buffer = this.brown;
      s.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 700;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.09;
      const lg = ctx.createGain();
      lg.gain.value = 0.5;
      const vg = ctx.createGain();
      vg.gain.value = 0.6;
      lfo.connect(lg).connect(vg.gain);
      s.connect(f).connect(vg).connect(g);
      s.start();
      lfo.start();
      return { src: [s, lfo] };
    }, this.amb);
  }

  birds(vol: number) {
    if (!this.ctx || vol <= 0.01 || Math.random() > 0.015) return;
    const t = this.ctx.currentTime;
    const base = 2200 + Math.random() * 1800;
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) this.tone(this.amb, t + i * 0.11, 'sine', base, base * (1.2 + Math.random() * 0.3), 0.08, 0.05 * vol);
  }

  engineLoop(key: string, pos: V) {
    this.startLoop(key, (ctx, g) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      (o as OscillatorNode & { base?: number }).base = 55;
      o.frequency.value = 55;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 500;
      const o2 = ctx.createOscillator();
      o2.type = 'square';
      (o2 as OscillatorNode & { base?: number }).base = 27.5;
      o2.frequency.value = 27.5;
      const g2 = ctx.createGain();
      g2.gain.value = 0.4;
      o.connect(f).connect(g);
      o2.connect(g2).connect(f);
      o.start();
      o2.start();
      return { src: [o, o2] };
    }, this.sfx, pos);
  }

  chestHum(key: string, pos: V) {
    this.startLoop(key, (ctx, g) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      (o as OscillatorNode & { base?: number }).base = 523;
      o.frequency.value = 523;
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      (o2 as OscillatorNode & { base?: number }).base = 784;
      o2.frequency.value = 784;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 3;
      const lg = ctx.createGain();
      lg.gain.value = 0.3;
      const vg = ctx.createGain();
      vg.gain.value = 0.5;
      lfo.connect(lg).connect(vg.gain);
      o.connect(vg);
      o2.connect(vg);
      vg.connect(g);
      o.start();
      o2.start();
      lfo.start();
      return { src: [o, o2, lfo] };
    }, this.sfx, pos);
  }

  busDrone() {
    this.startLoop('bus', (ctx, g) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      (o as OscillatorNode & { base?: number }).base = 70;
      o.frequency.value = 70;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 300;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 12;
      const lg = ctx.createGain();
      lg.gain.value = 0.3;
      const vg = ctx.createGain();
      vg.gain.value = 0.6;
      lfo.connect(lg).connect(vg.gain);
      o.connect(f).connect(vg).connect(g);
      o.start();
      lfo.start();
      return { src: [o, lfo] };
    }, this.amb);
  }

  // ------------------------------------------------------------------ music
  private playSeq(notes: [number, number, number][], type: OscillatorType, gain: number) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + 0.05;
    for (const [midi, start, dur] of notes) {
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      this.tone(this.music, t0 + start, type, f, f, dur, gain, 0.01);
    }
  }

  victory() {
    const beat = 0.16;
    const mel: [number, number, number][] = [
      [72, 0, 0.3], [76, 1, 0.3], [79, 2, 0.3], [84, 3, 0.8], [83, 5, 0.3], [84, 6, 0.3], [86, 7, 0.3], [88, 8, 1.4],
    ].map(([n, s, d]) => [n, s * beat, d] as [number, number, number]);
    this.playSeq(mel, 'square', 0.12);
    const chords: [number, number, number][] = [];
    for (const [root, s] of [[48, 0], [53, 4], [55, 6], [60, 8]]) for (const iv of [0, 4, 7]) chords.push([root + iv, s * beat, 1.2]);
    this.playSeq(chords, 'triangle', 0.1);
  }

  defeat() {
    const beat = 0.28;
    const mel: [number, number, number][] = [[67, 0, 0.5], [63, 1, 0.5], [60, 2, 0.5], [55, 3, 1.6]].map(([n, s, d]) => [n, s * beat, d] as [number, number, number]);
    this.playSeq(mel, 'triangle', 0.14);
    this.playSeq([[43, 0, 2], [46, 0, 2], [50, 0, 2]], 'sine', 0.08);
  }

  /** Gentle generative menu music. */
  menuMusic(on: boolean) {
    clearInterval(this.musicTimer);
    if (!on || !this.ctx) return;
    const scale = [60, 62, 64, 67, 69, 72, 74, 76];
    const chords = [[48, 55, 64], [45, 52, 60], [41, 48, 57], [43, 50, 59]];
    let bar = 0;
    const step = () => {
      if (!this.ctx) return;
      const ch = chords[bar % chords.length];
      const notes: [number, number, number][] = ch.map((n) => [n, 0, 2.2] as [number, number, number]);
      for (let i = 0; i < 4; i++) if (Math.random() < 0.7) notes.push([scale[Math.floor(Math.random() * scale.length)], i * 0.55, 0.5]);
      this.playSeq(notes, 'sine', 0.06);
      bar++;
    };
    step();
    this.musicTimer = window.setInterval(step, 2200);
  }
}
