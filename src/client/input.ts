// Unified input: keyboard + mouse (pointer lock), touch controls (mobile) and gamepads.

export type ActionName =
  | 'slot0' | 'slot1' | 'slot2' | 'slot3' | 'slot4' | 'slot5' | 'slotNext' | 'slotPrev'
  | 'build' | 'wall' | 'floor' | 'ramp' | 'roof' | 'material' | 'edit' | 'drop'
  | 'inventory' | 'map' | 'emote1' | 'emote2' | 'ping' | 'menu' | 'specPrev' | 'specNext'
  | 'use' | 'exitVehicle' | 'jumpPress' | 'reload' | 'firePress';

const KEYMAP: Record<string, ActionName> = {
  Digit1: 'slot0', Digit2: 'slot1', Digit3: 'slot2', Digit4: 'slot3', Digit5: 'slot4', Digit6: 'slot5',
  KeyQ: 'build', F1: 'wall', F2: 'floor', F3: 'ramp', F4: 'roof', KeyG: 'material', KeyT: 'edit', KeyX: 'drop',
  Tab: 'inventory', KeyM: 'map', KeyB: 'emote1', KeyN: 'emote2', KeyV: 'ping', Escape: 'menu',
  ArrowLeft: 'specPrev', ArrowRight: 'specNext', KeyE: 'use', KeyF: 'exitVehicle', Space: 'jumpPress', KeyR: 'reload',
};

export class Input {
  keys = new Set<string>();
  lmb = false;
  rmb = false;
  lookDX = 0;
  lookDY = 0;
  private actions: ActionName[] = [];
  locked = false;
  captureEnabled = false; // true while playing (no menu open)
  // touch
  touchMove = { x: 0, y: 0 };
  touchButtons = new Set<string>();
  // gamepad
  padMove = { x: 0, y: 0 };
  padLook = { x: 0, y: 0 };
  padButtons = new Set<string>();
  private padPrev: boolean[] = [];
  usingPad = false;

  constructor(private canvas: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'Tab' || e.code.startsWith('F') && e.code.length <= 3) e.preventDefault();
      if (e.code === 'Space' && this.captureEnabled) e.preventDefault();
      this.usingPad = false;
      if (!e.repeat) {
        const a = KEYMAP[e.code];
        if (a) this.actions.push(a);
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.lmb = this.rmb = false;
    });
    canvas.addEventListener('mousedown', (e) => {
      this.usingPad = false;
      if (this.captureEnabled && !this.locked) {
        this.requestLock();
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
      if (!this.locked) return;
      this.lookDX += e.movementX;
      this.lookDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      if (!this.captureEnabled) return;
      this.actions.push(e.deltaY > 0 ? 'slotNext' : 'slotPrev');
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.lmb = this.rmb = false;
      }
    });
  }

  requestLock() {
    if (this.locked) return;
    try {
      const p = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* not supported (e.g. mobile) */
    }
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

  consumeLook() {
    const r = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
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
    if (any) this.usingPad = true;
    if (!this.usingPad) return;
    this.padMove.x = lx;
    this.padMove.y = -ly;
    const curve = (v: number) => Math.sign(v) * v * v;
    this.lookDX += curve(rx) * 900 * dt * sens;
    this.lookDY += curve(ry) * 600 * dt * sens;
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

/** On-screen touch controls for phones/tablets. */
export class TouchControls {
  root: HTMLDivElement;
  private stick: HTMLDivElement;
  private knob: HTMLDivElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  buildButtons: HTMLDivElement;

  constructor(private input: Input, parent: HTMLElement, private sens: () => number) {
    const root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML = `
      <div class="t-stickzone"><div class="t-stick"><div class="t-knob"></div></div></div>
      <div class="t-btn t-fire" data-b="fire">FIRE</div>
      <div class="t-btn t-fire2" data-b="fire">●</div>
      <div class="t-btn t-ads" data-b="ads">AIM</div>
      <div class="t-btn t-jump" data-b="jump" data-a="jumpPress">JUMP</div>
      <div class="t-btn t-crouch" data-b="crouch">CROUCH</div>
      <div class="t-btn t-reload" data-b="reload" data-a="reload">R</div>
      <div class="t-btn t-use" data-b="use" data-a="use">USE</div>
      <div class="t-btn t-build" data-a="build">BUILD</div>
      <div class="t-btn t-sprint" data-b="sprint">RUN</div>
      <div class="t-build-row">
        <div class="t-btn t-sm" data-a="wall">WALL</div><div class="t-btn t-sm" data-a="floor">FLOOR</div>
        <div class="t-btn t-sm" data-a="ramp">RAMP</div><div class="t-btn t-sm" data-a="roof">ROOF</div>
        <div class="t-btn t-sm" data-a="material">MAT</div>
      </div>
      <div class="t-btn t-map" data-a="map">MAP</div>
      <div class="t-btn t-inv" data-a="inventory">BAG</div>
      <div class="t-btn t-menu" data-a="menu">☰</div>`;
    parent.appendChild(root);
    this.root = root;
    this.stick = root.querySelector('.t-stick')!;
    this.knob = root.querySelector('.t-knob')!;
    this.buildButtons = root.querySelector('.t-build-row')!;
    const zone = root.querySelector('.t-stickzone') as HTMLDivElement;
    zone.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      this.stickId = t.identifier;
      this.stickOrigin = { x: t.clientX, y: t.clientY };
      this.stick.style.left = `${t.clientX - 60}px`;
      this.stick.style.top = `${t.clientY - 60}px`;
      this.stick.classList.add('on');
      e.preventDefault();
    }, { passive: false });
    const moveStick = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) {
          let dx = (t.clientX - this.stickOrigin.x) / 55;
          let dy = (t.clientY - this.stickOrigin.y) / 55;
          const l = Math.hypot(dx, dy);
          if (l > 1) {
            dx /= l;
            dy /= l;
          }
          this.input.touchMove = { x: dx, y: -dy };
          this.knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
          if (l > 1.25) this.input.touchButtons.add('sprint');
          else this.input.touchButtons.delete('sprint');
        } else if (t.identifier === this.lookId) {
          const s = this.sens();
          this.input.lookDX += (t.clientX - this.lookLast.x) * 2.2 * s;
          this.input.lookDY += (t.clientY - this.lookLast.y) * 2.2 * s;
          this.lookLast = { x: t.clientX, y: t.clientY };
        }
      }
    };
    const endStick = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) {
          this.stickId = null;
          this.input.touchMove = { x: 0, y: 0 };
          this.knob.style.transform = '';
          this.stick.classList.remove('on');
          this.input.touchButtons.delete('sprint');
        }
        if (t.identifier === this.lookId) this.lookId = null;
      }
    };
    window.addEventListener('touchmove', moveStick, { passive: true });
    window.addEventListener('touchend', endStick);
    window.addEventListener('touchcancel', endStick);
    // look: any touch on the canvas right side
    parent.addEventListener('touchstart', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        const el = t.target as HTMLElement;
        if (el.closest('.t-btn') || el.closest('.t-stickzone') || el.closest('.ui-interactive')) continue;
        if (this.lookId === null && t.clientX > window.innerWidth * 0.35) {
          this.lookId = t.identifier;
          this.lookLast = { x: t.clientX, y: t.clientY };
        }
      }
    }, { passive: true });
    for (const b of Array.from(root.querySelectorAll<HTMLDivElement>('.t-btn'))) {
      const hold = b.dataset.b;
      const act = b.dataset.a as ActionName | undefined;
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        b.classList.add('down');
        if (hold) this.input.touchButtons.add(hold);
        if (act) this.input.push(act);
        if (hold === 'fire') this.input.push('firePress');
        // allow looking while holding fire
        const t = e.changedTouches[0];
        if (hold === 'fire' && this.lookId === null) {
          this.lookId = t.identifier;
          this.lookLast = { x: t.clientX, y: t.clientY };
        }
      }, { passive: false });
      const up = (e: TouchEvent) => {
        e.preventDefault();
        b.classList.remove('down');
        if (hold) this.input.touchButtons.delete(hold);
      };
      b.addEventListener('touchend', up, { passive: false });
      b.addEventListener('touchcancel', up, { passive: false });
    }
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  setBuildMode(v: boolean) {
    this.buildButtons.style.display = v ? 'flex' : 'none';
  }
}
