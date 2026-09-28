// Unified input: keyboard + mouse (pointer lock), touch controls (mobile) and gamepads.

export type ActionName =
  | 'slot0' | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5' | 'slotNext' | 'slotPrev'
  | 'build' | 'wall' | 'floor' | 'ramp' | 'roof' | 'material' | 'edit' | 'drop'
  | 'inventory' | 'map' | 'emote1' | 'emote2' | 'ping' | 'menu' | 'specPrev' | 'specNext'
  | 'use' | 'exitVehicle' | 'jumpPress' | 'reload' | 'firePress' | 'sprintLock';

export type InputSource = 'kbm' | 'touch' | 'pad';

const KEYMAP: Record<string, ActionName> = {
  Digit1: 'slot0', Digit2: 'slot1', Digit3: 'slot2', Digit4: 'slot3', Digit5: 'slot4', Digit6: 'slot5',
  KeyQ: 'build', F1: 'wall', F2: 'floor', F3: 'ramp', F4: 'roof', KeyG: 'material', KeyT: 'edit', KeyX: 'drop',
  Tab: 'inventory', KeyM: 'map', KeyB: 'emote1', KeyN: 'emote2', KeyV: 'ping', Escape: 'menu',
  ArrowLeft: 'specPrev', ArrowRight: 'specNext', KeyE: 'use', KeyF: 'exitVehicle', Space: 'jumpPress', KeyR: 'reload',
};

export interface LookDelta {
  mouse: { dx: number; dy: number };
  pad: { dx: number; dy: number };
  touch: { dx: number; dy: number }; // screen pixels dragged
}

export class Input {
  keys = new Set<string>();
  lmb = false;
  rmb = false;
  private mouseDX = 0;
  private mouseDY = 0;
  private padDX = 0;
  private padDY = 0;
  touchDX = 0;
  touchDY = 0;
  private actions: ActionName[] = [];
  locked = false;
  captureEnabled = false; // true while playing (no menu open)
  /** Pointer lock was refused after a click (e.g. an embedding frame): look by dragging instead. */
  lockFailed = false;
  onLockFailed: () => void = () => {};
  private lockFromGesture = false;
  /** Where the latest input came from (drives touch-mode switching and aim assist). */
  source: InputSource = 'kbm';
  onSource: (s: InputSource) => void = () => {};
  private lastTouchAt = -1e9;
  // touch
  touchMove = { x: 0, y: 0 };
  touchButtons = new Set<string>();
  // gamepad
  padMove = { x: 0, y: 0 };
  padButtons = new Set<string>();
  private padPrev: boolean[] = [];
  usingPad = false;

  constructor(private canvas: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'Tab' || e.code.startsWith('F') && e.code.length <= 3) e.preventDefault();
      if (e.code === 'Space' && this.captureEnabled) e.preventDefault();
      this.usingPad = false;
      this.setSource('kbm');
      if (!e.repeat) {
        const a = KEYMAP[e.code];
        if (a) this.actions.push(a);
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.reset());
    // remember touches so the compatibility mouse events a tap generates are ignored
    window.addEventListener('touchstart', () => {
      this.lastTouchAt = performance.now();
      this.setSource('touch');
    }, { capture: true, passive: true });
    canvas.addEventListener('mousedown', (e) => {
      if (this.fromTouch()) return;
      this.usingPad = false;
      this.setSource('kbm');
      if (this.captureEnabled && !this.locked && !this.lockFailed) {
        this.requestLock(true);
        return;
      }
      if (e.button === 0) {
        this.lmb = true;
        this.actions.push('firePress');
      }
      if (e.button === 2) this.rmb = true;
      if (e.button === 1) this.actions.push('ping');
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      // without pointer lock, holding a mouse button and dragging looks around
      const drag = this.lockFailed && this.captureEnabled && (e.buttons & 3) !== 0 && !this.fromTouch();
      if (!this.locked && !drag) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
      if (e.movementX || e.movementY) this.setSource('kbm');
    });
    window.addEventListener('wheel', (e) => {
      if (!this.captureEnabled) return;
      this.actions.push(e.deltaY > 0 ? 'slotNext' : 'slotPrev');
    });
    document.addEventListener('pointerlockerror', () => this.lockRefused());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.lmb = this.rmb = false;
      }
    });
  }

  private fromTouch() {
    return performance.now() - this.lastTouchAt < 1000;
  }

  private setSource(s: InputSource) {
    if (this.source === s) return;
    this.source = s;
    this.onSource(s);
  }

  /** Release everything held (window blur, tab hidden, app switched on a phone). */
  reset() {
    this.keys.clear();
    this.lmb = this.rmb = false;
    this.touchButtons.clear();
    this.touchMove = { x: 0, y: 0 };
    this.mouseDX = this.mouseDY = this.padDX = this.padDY = this.touchDX = this.touchDY = 0;
  }

  /** `fromGesture`: requested from a click; a refusal then means lock is unavailable here. */
  requestLock(fromGesture = false) {
    if (this.locked || this.fromTouch() || this.lockFailed) return;
    this.lockFromGesture = fromGesture;
    try {
      if (!this.canvas.requestPointerLock) return this.lockRefused();
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => this.lockRefused());
    } catch {
      this.lockRefused();
    }
  }

  private lockRefused() {
    if (!this.lockFromGesture || this.lockFailed) return; // automatic requests may fail without a click
    this.lockFailed = true;
    this.onLockFailed();
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  push(a: ActionName) {
    this.actions.push(a);
  }

  consumeActions(): ActionName[] {
    const a = this.actions;
    this.actions = [];
    return a;
  }

  consumeLook(): LookDelta {
    const r: LookDelta = {
      mouse: { dx: this.mouseDX, dy: this.mouseDY },
      pad: { dx: this.padDX, dy: this.padDY },
      touch: { dx: this.touchDX, dy: this.touchDY },
    };
    this.mouseDX = this.mouseDY = this.padDX = this.padDY = this.touchDX = this.touchDY = 0;
    return r;
  }

  axes() {
    let x = 0, z = 0;
    if (this.keys.has('KeyW')) z += 1;
    if (this.keys.has('KeyS')) z -= 1;
    if (this.keys.has('KeyD')) x += 1;
    if (this.keys.has('KeyA')) x -= 1;
    x += this.touchMove.x + this.padMove.x;
    z += this.touchMove.y + this.padMove.y;
    const l = Math.hypot(x, z);
    if (l > 1) {
      x /= l;
      z /= l;
    }
    return { x, z };
  }

  held(name: 'jump' | 'sprint' | 'crouch' | 'fire' | 'ads' | 'reload' | 'use'): boolean {
    const k = this.keys;
    switch (name) {
      case 'jump': return k.has('Space') || this.touchButtons.has('jump') || this.padButtons.has('jump');
      case 'sprint': return k.has('ShiftLeft') || k.has('ShiftRight') || this.padButtons.has('sprint') || this.touchButtons.has('sprint');
      case 'crouch': return k.has('KeyC') || k.has('ControlLeft') || this.touchButtons.has('crouch') || this.padButtons.has('crouch');
      case 'fire': return this.lmb || this.touchButtons.has('fire') || this.padButtons.has('fire');
      case 'ads': return this.rmb || this.touchButtons.has('ads') || this.padButtons.has('ads');
      case 'reload': return k.has('KeyR') || this.touchButtons.has('reload') || this.padButtons.has('reload');
      case 'use': return k.has('KeyE') || this.touchButtons.has('use') || this.padButtons.has('use');
    }
  }

  /** Poll gamepads (call once per frame). */
  pollGamepad(dt: number, sens: number) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && [...pads].find((p) => p && p.connected);
    this.padMove.x = this.padMove.y = 0;
    this.padButtons.clear();
    if (!gp) return;
    const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    const lx = dz(gp.axes[0] ?? 0), ly = dz(gp.axes[1] ?? 0);
    const rx = dz(gp.axes[2] ?? 0), ry = dz(gp.axes[3] ?? 0);
    const b = (i: number) => !!gp.buttons[i]?.pressed || (gp.buttons[i]?.value ?? 0) > 0.4;
    const any = Math.abs(lx) + Math.abs(ly) + Math.abs(rx) + Math.abs(ry) > 0 || gp.buttons.some((x) => x.pressed);
    if (any) {
      this.usingPad = true;
      this.setSource('pad');
    }
    if (!this.usingPad) return;
    this.padMove.x = lx;
    this.padMove.y = -ly;
    const curve = (v: number) => Math.sign(v) * v * v;
    this.padDX += curve(rx) * 900 * dt * sens;
    this.padDY += curve(ry) * 600 * dt * sens;
    const edge = (i: number, a: ActionName) => {
      const now = b(i);
      if (now && !this.padPrev[i]) this.actions.push(a);
      this.padPrev[i] = now;
    };
    if (b(0)) this.padButtons.add('jump');
    if (b(1)) this.padButtons.add('crouch');
    if (b(2)) this.padButtons.add('use');
    if (b(2)) this.padButtons.add('reload');
    if (b(6)) this.padButtons.add('ads');
    if (b(7)) this.padButtons.add('fire');
    if (b(10)) this.padButtons.add('sprint');
    edge(0, 'jumpPress');
    edge(2, 'use');
    edge(3, 'build');
    edge(4, 'slotPrev');
    edge(5, 'slotNext');
    edge(7, 'firePress');
    edge(8, 'map');
    edge(9, 'menu');
    edge(11, 'ping');
    edge(12, 'material');
    edge(13, 'drop');
    edge(14, 'emote1');
    edge(15, 'inventory');
  }
}

/** Which control set the touch overlay shows. */
export type TouchContext = 'walk' | 'build' | 'swim' | 'air' | 'bus' | 'vehicle' | 'downed' | 'spec' | 'hidden';

interface TouchButtonDef {
  cls: string;
  label: string;
  hold?: string; // held state in Input.touchButtons
  act?: ActionName; // action pushed on press
  look?: boolean; // the finger that presses it may also drag to aim
  ctx: TouchContext[];
}

const PLAY: TouchContext[] = ['walk', 'build'];
const BUTTONS: TouchButtonDef[] = [
  { cls: 't-fire', label: 'FIRE', hold: 'fire', look: true, ctx: PLAY },
  { cls: 't-fire2', label: '●', hold: 'fire', look: true, ctx: ['walk'] },
  { cls: 't-ads', label: 'AIM', hold: 'ads', ctx: ['walk'] },
  { cls: 't-jump', label: 'JUMP', hold: 'jump', act: 'jumpPress', ctx: ['walk', 'build', 'swim', 'air', 'bus', 'vehicle'] },
  { cls: 't-crouch', label: 'CROUCH', hold: 'crouch', ctx: PLAY },
  { cls: 't-reload', label: '⟳', hold: 'reload', act: 'reload', ctx: ['walk'] },
  { cls: 't-use', label: 'USE', hold: 'use', act: 'use', ctx: ['walk', 'build', 'swim', 'vehicle'] },
  { cls: 't-build', label: 'BUILD', act: 'build', ctx: PLAY },
  { cls: 't-sprint', label: 'RUN', act: 'sprintLock', ctx: ['walk'] },
  { cls: 't-ping', label: '📍', act: 'ping', ctx: ['walk', 'build', 'swim', 'air', 'vehicle'] },
  { cls: 't-emote', label: '💃', act: 'emote1', ctx: ['walk'] },
  { cls: 't-menu', label: '☰', act: 'menu', ctx: ['walk', 'build', 'swim', 'air', 'bus', 'vehicle', 'downed', 'spec'] },
];

/** On-screen touch controls for phones/tablets. */
export class TouchControls {
  root: HTMLDivElement;
  private stick: HTMLDivElement;
  private knob: HTMLDivElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private buildRow: HTMLDivElement;
  private buttons = new Map<string, { el: HTMLDivElement; def: TouchButtonDef }>();
  private ctx: TouchContext = 'hidden';
  private labels: Record<string, string> = {};
  private useLabel: string | null = null;
  sprintLocked = false;

  constructor(private input: Input, parent: HTMLElement) {
    const root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `<div class="t-stickzone"><div class="t-stick"><div class="t-knob"></div></div></div>
      ${BUTTONS.map((b) => `<div class="t-btn ${b.cls}" data-k="${b.cls}"><span>${b.label}</span></div>`).join('')}
      <div class="t-build-row">
        <div class="t-btn t-sm" data-a="wall"><b>▮</b>WALL</div><div class="t-btn t-sm" data-a="floor"><b>▬</b>FLOOR</div>
        <div class="t-btn t-sm" data-a="ramp"><b>◢</b>RAMP</div><div class="t-btn t-sm" data-a="roof"><b>▲</b>ROOF</div>
        <div class="t-btn t-sm t-mat" data-a="material"><b>◆</b><span>WOOD</span></div><div class="t-btn t-sm" data-a="edit"><b>✎</b>EDIT</div>
      </div>`;
    parent.appendChild(root);
    this.root = root;
    this.stick = root.querySelector('.t-stick')!;
    this.knob = root.querySelector('.t-knob')!;
    this.buildRow = root.querySelector('.t-build-row')!;
    for (const def of BUTTONS) this.buttons.set(def.cls, { el: root.querySelector(`[data-k="${def.cls}"]`)!, def });

    const zone = root.querySelector('.t-stickzone') as HTMLDivElement;
    zone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (this.stickId !== null) return;
      const t = e.changedTouches[0];
      this.stickId = t.identifier;
      this.stickOrigin = { x: t.clientX, y: t.clientY };
      const r = root.getBoundingClientRect();
      const half = this.stick.offsetWidth / 2;
      this.stick.style.left = `${t.clientX - r.left - half}px`;
      this.stick.style.top = `${t.clientY - r.top - half}px`;
      this.stick.classList.add('on');
    }, { passive: false });
    const onMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) {
          const reach = this.stick.offsetWidth * 0.45;
          let dx = (t.clientX - this.stickOrigin.x) / reach;
          let dy = (t.clientY - this.stickOrigin.y) / reach;
          const l = Math.hypot(dx, dy);
          if (l > 1) {
            dx /= l;
            dy /= l;
          }
          this.input.touchMove = { x: dx, y: -dy };
          this.knob.style.transform = `translate(calc(-50% + ${dx * reach * 0.8}px), calc(-50% + ${dy * reach * 0.8}px))`;
          // pushing past the ring sprints
          if (l > 1.3 || (this.sprintLocked && l > 0.3)) this.input.touchButtons.add('sprint');
          else this.input.touchButtons.delete('sprint');
        } else if (t.identifier === this.lookId) {
          this.input.touchDX += t.clientX - this.lookLast.x;
          this.input.touchDY += t.clientY - this.lookLast.y;
          this.lookLast = { x: t.clientX, y: t.clientY };
        }
      }
    };
    const onEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) this.releaseStick();
        if (t.identifier === this.lookId) this.lookId = null;
      }
    };
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    // look: any touch that doesn't land on a control or on interactive UI
    parent.addEventListener('touchstart', (e) => {
      if (this.ctx === 'hidden') return;
      for (const t of Array.from(e.changedTouches)) {
        const el = t.target as HTMLElement;
        if (el.closest('.t-btn, .t-stickzone, .ui-interactive, .interactive, #minimap')) continue;
        if (this.lookId === null) {
          this.lookId = t.identifier;
          this.lookLast = { x: t.clientX, y: t.clientY };
        }
      }
    }, { passive: true });

    for (const { el, def } of this.buttons.values()) {
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add('down');
        if (def.hold) this.input.touchButtons.add(def.hold);
        if (def.act) this.input.push(def.act === 'use' && this.ctx === 'vehicle' ? 'exitVehicle' : def.act);
        if (def.hold === 'fire') this.input.push('firePress');
        if (def.look && this.lookId === null) {
          const t = e.changedTouches[0];
          this.lookId = t.identifier;
          this.lookLast = { x: t.clientX, y: t.clientY };
        }
      }, { passive: false });
      const up = (e: TouchEvent) => {
        e.preventDefault();
        el.classList.remove('down');
        if (def.hold) this.input.touchButtons.delete(def.hold);
      };
      el.addEventListener('touchend', up, { passive: false });
      el.addEventListener('touchcancel', up, { passive: false });
    }
    for (const el of Array.from(this.buildRow.querySelectorAll<HTMLDivElement>('[data-a]'))) {
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.input.push(el.dataset.a as ActionName);
        el.classList.add('down');
      }, { passive: false });
      el.addEventListener('touchend', () => el.classList.remove('down'));
      el.addEventListener('touchcancel', () => el.classList.remove('down'));
    }
  }

  private releaseStick() {
    this.stickId = null;
    this.input.touchMove = { x: 0, y: 0 };
    this.knob.style.transform = '';
    this.stick.classList.remove('on');
    this.stick.style.left = this.stick.style.top = '';
    this.input.touchButtons.delete('sprint');
  }

  /** Drop all touch state (context switch, app backgrounded). */
  reset() {
    this.releaseStick();
    this.lookId = null;
    this.input.touchButtons.clear();
    for (const { el } of this.buttons.values()) el.classList.remove('down');
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
    if (!v) this.reset();
  }

  setContext(ctx: TouchContext) {
    if (ctx === this.ctx) return;
    this.ctx = ctx;
    this.root.dataset.ctx = ctx;
    for (const { el, def } of this.buttons.values()) {
      const on = def.ctx.includes(ctx);
      el.classList.toggle('off', !on);
      if (!on && def.hold && this.input.touchButtons.has(def.hold)) {
        this.input.touchButtons.delete(def.hold);
        el.classList.remove('down');
      }
    }
    this.buildRow.classList.toggle('off', ctx !== 'build');
    this.setLabel('t-jump', ctx === 'bus' ? 'DROP' : ctx === 'air' ? 'GLIDE' : ctx === 'vehicle' ? 'BRAKE' : 'JUMP');
    this.setLabel('t-fire', ctx === 'build' ? 'PLACE' : 'FIRE');
    this.setLabel('t-build', ctx === 'build' ? '🔫' : 'BUILD');
    if (ctx === 'hidden' || ctx === 'spec') this.releaseStick();
    this.refreshUse();
  }

  private setLabel(cls: string, text: string) {
    if (this.labels[cls] === text) return;
    this.labels[cls] = text;
    const span = this.buttons.get(cls)?.el.querySelector('span');
    if (span) span.textContent = text;
  }

  /** Contextual USE button: the label names the action, hidden when there is nothing to do. */
  setUse(label: string | null) {
    if (label === this.useLabel) return;
    this.useLabel = label;
    this.refreshUse();
  }

  private refreshUse() {
    const b = this.buttons.get('t-use')!;
    const label = this.ctx === 'vehicle' ? 'EXIT' : this.useLabel;
    this.setLabel('t-use', label ?? 'USE');
    b.el.classList.toggle('off', !label || !b.def.ctx.includes(this.ctx));
  }

  setMaterial(name: string) {
    const span = this.buildRow.querySelector('.t-mat span');
    if (span && span.textContent !== name) span.textContent = name;
  }

  setPiece(piece: string, editing: boolean) {
    for (const el of Array.from(this.buildRow.querySelectorAll<HTMLDivElement>('[data-a]'))) {
      el.classList.toggle('sel', el.dataset.a === piece || (editing && el.dataset.a === 'edit'));
    }
  }

  setSprintLock(on: boolean) {
    this.sprintLocked = on;
    this.buttons.get('t-sprint')!.el.classList.toggle('sel', on);
  }

  get context() {
    return this.ctx;
  }
}
