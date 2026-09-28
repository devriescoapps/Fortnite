// In-match HUD. Minimal during combat; everything is DOM so it scales cleanly on any screen.
import { AMMO_NAMES, AMMO_TYPES, ITEM_BY_CODE, ItemStack, RARITIES, RARITY_RELOAD, weaponDamage, weaponDps } from '../../shared/items';
import type { PieceType } from '../../shared/build';
import { MapMarks, MapPainter } from './minimap';

/** World half-extent shown by the full map (centered on the island). */
export const BIGMAP_HALF = 640;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function itemGlyph(code: number) {
  const d = ITEM_BY_CODE[code];
  if (!d) return '?';
  if (d.weapon) {
    switch (d.weapon.cls) {
      case 'ar': return '🔫';
      case 'smg': return '🔫';
      case 'shotgun': return '💥';
      case 'sniper': return '🎯';
      case 'pistol': return '🔫';
      case 'explosive': return '🚀';
      case 'melee': return d.id === 'pryhammer' ? '🔨' : '🏏';
    }
  }
  if (d.use) return d.use.shield ? '🛡️' : d.use.overTime ? '🥤' : '➕';
  if (d.throwable) return d.throwable.kind === 'smoke' ? '💨' : '💣';
  if (d.utility) return d.utility === 'springpad' ? '⤴️' : '🧱';
  return '•';
}

export interface TeamRow {
  name: string;
  hp: number;
  shield: number;
  down: boolean;
  dead: boolean;
  color: string;
  me: boolean;
}

export class Hud {
  root: HTMLElement;
  private el: Record<string, HTMLElement> = {};
  private minimap: HTMLCanvasElement;
  private bigmap: HTMLDivElement;
  private bigCanvas: HTMLCanvasElement;
  private inv: HTMLDivElement;
  private toasts: HTMLElement;
  private feedEl: HTMLElement;
  private hitT = 0;
  private cache: Record<string, string> = {};
  bigMapOpen = false;
  inventoryOpen = false;
  onSwap: (a: number, b: number) => void = () => {};
  onDrop: (slot: number) => void = () => {};
  onDropAmmo: (i: number) => void = () => {};
  onDropMat: (i: number) => void = () => {};
  onSelectSlot: (i: number) => void = () => {};
  onSpectate: (dir: 1 | -1) => void = () => {};
  onBag: () => void = () => {};
  onMap: () => void = () => {};
  onCloseInventory: () => void = () => {};
  /** Tap/click on the full map: world x/z of the marker. */
  onMapMark: (x: number, z: number) => void = () => {};
  /** Touch devices: tap-to-move instead of drag and drop. */
  touch = false;
  private moveFrom = -1;

  constructor(root: HTMLElement, private painter: MapPainter) {
    this.root = root;
    root.innerHTML = `
      <div class="storm-tint" style="opacity:0"></div>
      <div class="scope hidden"></div>
      <div class="hud-tl" data-el="team"></div>
      <div class="feed"></div>
      <div class="hud-tr">
        <canvas id="minimap" width="200" height="200"></canvas>
        <div class="hud-stats"><div class="pill"><span class="ico">👥</span><span data-el="alive">0</span></div><div class="pill"><span class="ico">✖</span><span data-el="kills">0</span></div></div>
        <div class="storm-info" data-el="storm"><div class="t" data-el="stormT"></div><div data-el="stormV"></div></div>
      </div>
      <div id="crosshair"><div class="c dot"></div><div class="c" data-el="ch0"></div><div class="c" data-el="ch1"></div><div class="c" data-el="ch2"></div><div class="c" data-el="ch3"></div></div>
      <div id="hitmarker"></div>
      <div class="prompt hidden" data-el="prompt"></div>
      <div class="channel hidden" data-el="channel"><div></div></div>
      <div class="dmg-dir hidden" data-el="dmgdir"></div>
      <div class="hud-bl">
        <div class="vital sh" data-el="shRow"><div class="val" data-el="shV">0</div><div class="track"><div class="fill" data-el="shF"></div></div></div>
        <div class="vital hp" data-el="hpRow"><div class="val" data-el="hpV">100</div><div class="track"><div class="fill" data-el="hpF"></div></div></div>
        <div class="mats" data-el="mats"></div>
      </div>
      <div class="hud-bc interactive" data-el="hotbar"></div>
      <div class="hud-br">
        <div class="weapon-name" data-el="wname"></div>
        <div class="ammo" data-el="ammo"></div>
        <div class="build-bar" data-el="buildbar"></div>
      </div>
      <div class="center-banner hidden" data-el="banner"><div class="big" data-el="bannerBig"></div><div class="sub" data-el="bannerSub"></div></div>
      <div class="spec-bar hidden" data-el="spec"><button class="btn small ghost" data-spec="-1">◀</button><span data-el="specName"></span><button class="btn small ghost" data-spec="1">▶</button></div>
      <div class="victory hidden" data-el="victory"><div class="v" data-el="victoryT"></div></div>
      <div class="fps hidden" data-el="fps"></div>
      <div data-el="toasts"></div>`;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    this.minimap = root.querySelector('#minimap') as HTMLCanvasElement;
    this.toasts = this.el.toasts;
    this.feedEl = root.querySelector('.feed') as HTMLElement;
    root.querySelectorAll<HTMLButtonElement>('[data-spec]').forEach((b) => b.addEventListener('click', () => this.onSpectate(Number(b.dataset.spec) as 1 | -1)));

    this.minimap.addEventListener('click', () => this.onMap());

    this.bigmap = document.createElement('div');
    this.bigmap.className = 'bigmap hidden';
    this.bigmap.innerHTML = '<div class="bigmap-inner"><button class="btn small ghost close-x" aria-label="Close map">✕</button><div class="bigmap-hint muted">Tap the map to mark a spot for your team</div></div>';
    this.bigCanvas = document.createElement('canvas');
    this.bigCanvas.width = this.bigCanvas.height = 900;
    this.bigmap.firstElementChild!.prepend(this.bigCanvas);
    root.appendChild(this.bigmap);
    this.bigmap.querySelector('.close-x')!.addEventListener('click', () => this.onMap());
    this.bigmap.addEventListener('click', (e) => {
      if (e.target === this.bigmap) this.onMap(); // tap outside the map closes it
    });
    this.bigCanvas.addEventListener('click', (e) => {
      const r = this.bigCanvas.getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
      if (u < 0 || u > 1 || v < 0 || v > 1) return;
      this.onMapMark((u * 2 - 1) * BIGMAP_HALF, (v * 2 - 1) * BIGMAP_HALF);
    });

    this.inv = document.createElement('div');
    this.inv.className = 'overlay hidden ui-interactive';
    root.appendChild(this.inv);
  }

  private set(key: string, html: string) {
    if (this.cache[key] === html) return;
    this.cache[key] = html;
    this.el[key].innerHTML = html;
  }

  show(v: boolean) {
    this.root.classList.toggle('hidden', !v);
  }

  setVitals(hp: number, shield: number, downed: boolean) {
    const h = Math.max(0, Math.ceil(hp)), s = Math.max(0, Math.ceil(shield));
    this.set('hpV', String(h));
    this.set('shV', String(s));
    this.el.hpF.style.width = `${Math.min(100, hp)}%`;
    this.el.shF.style.width = `${Math.min(100, shield)}%`;
    this.el.hpRow.classList.toggle('down', downed);
    this.el.shRow.style.visibility = downed ? 'hidden' : '';
  }

  setMats(mats: number[], selected: number, build: boolean) {
    const colors = ['#c8904f', '#9aa3ad', '#6f8fb8'];
    this.set('mats', mats.map((m, i) => `<div class="mat ${build && i === selected ? 'on' : ''}"><i style="background:${colors[i]}"></i>${m}</div>`).join(''));
  }

  setHotbar(slots: (ItemStack | null)[], sel: number, build: boolean) {
    const html = slots.map((s, i) => {
      if (!s) return `<div class="hslot" data-i="${i}"><span class="key">${i + 1}</span></div>`;
      const d = ITEM_BY_CODE[s.code];
      const r = RARITIES[s.rarity];
      const ct = d.weapon ? (d.weapon.ammo ? s.mag : '') : s.count > 1 ? s.count : '';
      return `<div class="hslot r${s.rarity} ${i === sel && !build ? 'on' : ''}" data-i="${i}" style="--rc:${r.color}" title="${esc(d.name)}"><div class="rar"></div><span class="key">${i + 1}</span><span class="glyph">${itemGlyph(s.code)}</span><span class="nm">${esc(d.name.split(' ')[0])}</span><span class="ct">${ct}</span></div>`;
    }).join('') + '<div class="hslot hbag" data-bag="1"><span class="glyph">🎒</span><span class="nm">BAG</span></div>';
    if (this.cache.hotbar !== html) {
      this.set('hotbar', html);
      this.el.hotbar.querySelectorAll<HTMLElement>('.hslot[data-i]').forEach((e) => e.addEventListener('click', () => this.onSelectSlot(Number(e.dataset.i))));
      this.el.hotbar.querySelector('.hbag')!.addEventListener('click', () => this.onBag());
    }
  }

  setWeapon(it: ItemStack | null, reserve: number, reloadK: number, useK: number) {
    if (!it) {
      this.set('wname', '');
      this.set('ammo', '');
      return;
    }
    const d = ITEM_BY_CODE[it.code];
    const r = RARITIES[it.rarity];
    this.set('wname', `<span style="color:${r.color}">${d.category === 'weapon' ? r.name + ' ' : ''}${esc(d.name)}</span>`);
    if (d.weapon && d.weapon.ammo) {
      const txt = reloadK > 0 ? `<span style="font-size:22px">RELOADING ${Math.round(reloadK * 100)}%</span>` : `${it.mag}<small> / ${reserve}</small>`;
      this.set('ammo', txt);
    } else if (d.use) this.set('ammo', useK >= 0 ? `<span style="font-size:22px">USING ${Math.round(useK * 100)}%</span>` : `${it.count}<small> left</small>`);
    else if (d.throwable || d.utility) this.set('ammo', `${it.count}`);
    else this.set('ammo', '');
  }

  setBuild(on: boolean, piece: PieceType, target: string) {
    if (!on) {
      this.set('buildbar', '');
      return;
    }
    const pieces: [PieceType, string, string][] = [['wall', 'F1', '▮'], ['floor', 'F2', '▬'], ['ramp', 'F3', '◢'], ['roof', 'F4', '▲']];
    this.set('buildbar', pieces.map(([p, k, g]) => `<div class="bp ${p === piece ? 'on' : ''}"><div style="font-size:20px">${g}</div>${k}</div>`).join('') + (target ? `<div class="bp" style="width:auto;padding:0 8px">${target}</div>` : ''));
  }

  setStats(alive: number, kills: number) {
    this.set('alive', String(alive));
    this.set('kills', String(kills));
  }

  setStorm(title: string, value: string, danger: boolean) {
    this.set('stormT', title);
    this.set('stormV', value);
    this.el.storm.classList.toggle('danger', danger);
    this.el.storm.style.display = title ? '' : 'none';
  }

  setTeam(rows: TeamRow[]) {
    this.set('team', rows.length > 1 ? rows.map((r) => `<div class="team-row ${r.down ? 'down' : ''} ${r.dead ? 'dead' : ''}"><div class="nm"><span style="color:${r.color}">● ${esc(r.name)}${r.me ? ' (you)' : ''}</span><span>${r.dead ? '☠' : r.down ? 'DOWN' : Math.ceil(r.hp)}</span></div>
      <div class="mini"><div style="width:${r.dead ? 0 : Math.min(100, r.hp) * 0.5}%;background:var(${r.down ? '--pink' : '--hp'})"></div><div style="width:${r.dead ? 0 : Math.min(100, r.shield) * 0.5}%;background:var(--shield)"></div></div></div>`).join('') : '');
  }

  crosshair(spreadPx: number, show: boolean, scope: boolean) {
    const ch = this.root.querySelector('#crosshair') as HTMLElement;
    ch.style.display = show && !scope ? '' : 'none';
    this.root.querySelector('.scope')!.classList.toggle('hidden', !scope);
    const g = Math.max(4, spreadPx);
    const len = 8;
    const s = (e: HTMLElement, x: number, y: number, w: number, h: number) => {
      e.style.left = `${x}px`;
      e.style.top = `${y}px`;
      e.style.width = `${w}px`;
      e.style.height = `${h}px`;
    };
    s(this.el.ch0, -1, -g - len, 2, len);
    s(this.el.ch1, -1, g, 2, len);
    s(this.el.ch2, -g - len, -1, len, 2);
    s(this.el.ch3, g, -1, len, 2);
  }

  hitmarker(kind: 'hit' | 'head' | 'kill') {
    const h = this.root.querySelector('#hitmarker') as HTMLElement;
    h.className = kind === 'hit' ? '' : kind;
    h.style.opacity = '1';
    this.hitT = kind === 'kill' ? 0.35 : 0.15;
  }

  prompt(html: string | null) {
    if (!html) {
      this.el.prompt.classList.add('hidden');
      return;
    }
    this.el.prompt.classList.remove('hidden');
    this.set('prompt', html);
  }

  channel(k: number | null) {
    this.el.channel.classList.toggle('hidden', k === null);
    if (k !== null) (this.el.channel.firstElementChild as HTMLElement).style.width = `${Math.min(100, k * 100)}%`;
  }

  toast(text: string, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.innerHTML = text;
    this.toasts.appendChild(t);
    setTimeout(() => t.remove(), kind === 'warn' ? 1200 : 2600);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild!.remove();
  }

  harvest(text: string) {
    const t = document.createElement('div');
    t.className = 'harv';
    t.textContent = text;
    this.root.appendChild(t);
    setTimeout(() => t.remove(), 800);
  }

  feed(html: string, mine: boolean) {
    const d = document.createElement('div');
    d.innerHTML = html;
    if (mine) d.className = 'me';
    this.feedEl.appendChild(d);
    setTimeout(() => d.remove(), 6000);
    while (this.feedEl.children.length > 6) this.feedEl.firstElementChild!.remove();
  }

  damageDir(angle: number) {
    const d = this.el.dmgdir;
    d.classList.remove('hidden');
    d.style.transform = `rotate(${angle}rad)`;
    d.style.opacity = '1';
    clearTimeout((d as HTMLElement & { _t?: number })._t);
    (d as HTMLElement & { _t?: number })._t = window.setTimeout(() => d.classList.add('hidden'), 900);
  }

  stormTint(k: number) {
    (this.root.querySelector('.storm-tint') as HTMLElement).style.opacity = String(k);
  }

  banner(big: string | null, sub = '') {
    this.el.banner.classList.toggle('hidden', !big);
    if (big) {
      this.set('bannerBig', big);
      this.set('bannerSub', sub);
    }
  }

  victory(text: string | null) {
    this.el.victory.classList.toggle('hidden', !text);
    if (text) this.set('victoryT', text);
  }

  spectate(name: string | null) {
    this.el.spec.classList.toggle('hidden', !name);
    if (name) this.set('specName', `Spectating <b>${esc(name)}</b>`);
  }

  fps(text: string | null) {
    this.el.fps.classList.toggle('hidden', !text);
    if (text) this.set('fps', text);
  }

  update(dt: number) {
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) (this.root.querySelector('#hitmarker') as HTMLElement).style.opacity = '0';
    }
  }

  drawMinimap(marks: MapMarks, time: number) {
    const me = marks.me;
    const cx = me ? me.x : 0, cz = me ? me.z : 0;
    this.painter.draw(this.minimap, marks, cx, cz, 120, false, time);
    if (this.bigMapOpen) this.painter.draw(this.bigCanvas, marks, 0, 0, BIGMAP_HALF, true, time);
  }

  toggleBigMap(v?: boolean) {
    this.bigMapOpen = v ?? !this.bigMapOpen;
    this.bigmap.classList.toggle('hidden', !this.bigMapOpen);
  }

  // ---------------------------------------------------------------- inventory
  openInventory(slots: (ItemStack | null)[], ammo: number[], mats: number[], sel: number) {
    this.inventoryOpen = true;
    this.moveFrom = -1;
    this.inv.classList.remove('hidden');
    this.renderInventory(slots, ammo, mats, sel);
  }

  closeInventory() {
    this.inventoryOpen = false;
    this.inv.classList.add('hidden');
  }

  renderInventory(slots: (ItemStack | null)[], ammo: number[], mats: number[], sel: number) {
    const detail = slots[sel] ?? slots[0];
    const d = detail ? ITEM_BY_CODE[detail.code] : null;
    let stats = '';
    if (d && d.weapon && detail) {
      const w = d.weapon;
      const line = (label: string, v: number, max: number, txt: string) => `<div class="statline"><span class="muted">${label}</span><div class="bar"><div style="width:${Math.min(100, (v / max) * 100)}%"></div></div><b>${txt}</b></div>`;
      const dmg = weaponDamage(w, detail.rarity) * w.pellets;
      const melee = w.cls === 'melee';
      stats = line('Damage', dmg, 120, dmg.toFixed(0)) + line('DPS', weaponDps(w, detail.rarity), 260, weaponDps(w, detail.rarity).toFixed(0)) +
        line('Fire rate', 1 / w.interval, 16, (1 / w.interval).toFixed(1)) + (w.mag ? line('Magazine', w.mag, 40, String(w.mag)) : '') +
        (w.reload ? line('Reload', 5 - w.reload * RARITY_RELOAD[detail.rarity], 5, `${(w.reload * RARITY_RELOAD[detail.rarity]).toFixed(1)}s`) : '') +
        (melee ? line('Reach', w.meleeRange ?? 2.5, 4, `${w.meleeRange ?? 2.5}m`) + line('vs Structures', w.structureMult, 3, `×${w.structureMult}`)
          : line('Accuracy', 8 - w.spreadAds, 8, `${Math.max(0, 100 - w.spreadAds * 12).toFixed(0)}%`) + line('Range', w.falloffEnd, 800, `${w.range}m`)) +
        (w.ammo ? `<div class="muted" style="font-size:12px">Uses ${AMMO_NAMES[w.ammo]} · headshot ×${w.headMult}</div>` : '');
    }
    const moving = this.moveFrom > 0 && !!slots[this.moveFrom];
    const hint = this.touch
      ? moving ? `<b style="color:var(--sun)">Tap a slot to move ${esc(ITEM_BY_CODE[slots[this.moveFrom]!.code].name)} there</b>` : 'Tap an item to inspect · Move to rearrange'
      : 'Drag items between slots to rearrange · click to inspect · Tab to close';
    this.inv.innerHTML = `<div class="dialog inv-dialog">
      <button class="btn small ghost close-x" id="invclose" aria-label="Close inventory">✕</button>
      <h2>Inventory</h2><div class="muted inv-hint">${hint}</div>
      <div class="inv">${slots.map((s, i) => {
        const cls = `${i === sel ? 'sel' : ''} ${moving && i === this.moveFrom ? 'moving' : ''} ${moving && i > 0 && i !== this.moveFrom ? 'target' : ''}`;
        if (!s) return `<div class="islot ${cls}" data-i="${i}"></div>`;
        const dd = ITEM_BY_CODE[s.code];
        return `<div class="islot filled r${s.rarity} ${cls}" draggable="${i > 0 && !this.touch}" data-i="${i}" style="--rc:${RARITIES[s.rarity].color}"><span class="ig">${itemGlyph(s.code)}</span><b>${esc(dd.name)}</b><span class="muted">${RARITIES[s.rarity].name}</span><span class="ct">${dd.weapon?.ammo ? s.mag : s.count > 1 ? s.count : ''}</span></div>`;
      }).join('')}</div>
      ${d ? `<div class="inv-detail"><b style="color:${RARITIES[detail!.rarity].color};font-size:18px">${esc(d.name)}</b> <span class="muted">${esc(d.desc)}</span>${stats}
        ${sel > 0 && slots[sel] ? `<div class="row" style="margin-top:8px"><button class="btn small" id="equipsel">Equip</button>${this.touch ? `<button class="btn small ghost" id="movesel">${moving ? 'Cancel move' : 'Move'}</button>` : ''}<button class="btn small warn" id="dropsel">Drop</button></div>` : ''}</div>` : ''}
      <div class="ammo-row">${AMMO_TYPES.map((a, i) => `<div class="pill interactive">${AMMO_NAMES[a]}: <b>${ammo[i]}</b>${ammo[i] ? `<button class="btn small ghost" data-da="${i}">drop</button>` : ''}</div>`).join('')}</div>
      <div class="ammo-row">${['Timber', 'Stone', 'Alloy'].map((m, i) => `<div class="pill">${m}: <b>${mats[i]}</b>${mats[i] ? `<button class="btn small ghost" data-dm="${i}">drop 30</button>` : ''}</div>`).join('')}</div>
    </div>`;
    let dragFrom = -1;
    this.inv.querySelectorAll<HTMLElement>('.islot').forEach((e) => {
      const i = Number(e.dataset.i);
      e.addEventListener('click', () => {
        if (this.moveFrom > 0) {
          const from = this.moveFrom;
          this.moveFrom = -1;
          if (i > 0 && i !== from) this.onSwap(from, i);
          else this.renderInventory(slots, ammo, mats, sel);
          return;
        }
        this.onSelectSlot(i);
      });
      e.addEventListener('dragstart', () => (dragFrom = i));
      e.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        e.classList.add('dragover');
      });
      e.addEventListener('dragleave', () => e.classList.remove('dragover'));
      e.addEventListener('drop', (ev) => {
        ev.preventDefault();
        e.classList.remove('dragover');
        if (dragFrom > 0 && i > 0 && dragFrom !== i) this.onSwap(dragFrom, i);
      });
    });
    this.inv.querySelector('#invclose')?.addEventListener('click', () => this.onCloseInventory());
    this.inv.querySelector('#equipsel')?.addEventListener('click', () => {
      this.onSelectSlot(sel);
      this.onCloseInventory();
    });
    this.inv.querySelector('#movesel')?.addEventListener('click', () => {
      this.moveFrom = this.moveFrom > 0 ? -1 : sel;
      this.renderInventory(slots, ammo, mats, sel);
    });
    this.inv.querySelector('#dropsel')?.addEventListener('click', () => this.onDrop(sel));
    this.inv.querySelectorAll<HTMLElement>('[data-da]').forEach((b) => b.addEventListener('click', () => this.onDropAmmo(Number(b.dataset.da))));
    this.inv.querySelectorAll<HTMLElement>('[data-dm]').forEach((b) => b.addEventListener('click', () => this.onDropMat(Number(b.dataset.dm))));
  }
}
