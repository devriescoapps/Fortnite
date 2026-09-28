// Front-end screens: main menu (play/party), locker, challenges, season pass, shop, career,
// settings, matchmaking overlay, pause menu and end-of-match results.
import type { Mode } from '../../shared/constants';
import { POIS } from '../../shared/pois';
import {
  COSMETICS, COSMETIC_BY_ID, CURRENCY, CosSlot, SEASON, levelReward, tierReward, xpToNext,
} from '../../shared/progression';
import type { CosmeticLoadout, ResultsMsg } from '../../shared/protocol';
import type { Settings } from '../settings';

export interface PublicProfile {
  id: string;
  name: string;
  level: number;
  xp: number;
  seasonXp: number;
  tier: number;
  currency: number;
  owned: string[];
  loadout: CosmeticLoadout;
  stats: Record<string, number>;
  challenges: { id: string; name: string; goal: number; xp: number; currency: number; period: string; progress: number; done: boolean }[];
  shop: { id: string; name: string; slot: string; rarity: number; price: number }[];
}

export interface PartyInfo {
  code: string;
  leader: number;
  members: { id: number; name: string; level: number }[];
}

export interface MenuCtx {
  profile(): PublicProfile | null;
  settings(): Settings;
  party(): { info: PartyInfo | null; you: number };
  play(mode: Mode): void;
  cancelQueue(): void;
  equip(l: Partial<CosmeticLoadout>): void;
  buy(id: string): void;
  rename(name: string): void;
  saveSettings(s: Settings): void;
  partyCreate(): void;
  partyJoin(code: string): void;
  partyLeave(): void;
  preview(l: CosmeticLoadout): void;
  click(): void;
  connected(): boolean;
  /** Touch UI is active (phone/tablet). */
  touch(): boolean;
  /** Playing without a server: the match runs in this browser against bots. */
  offline(): boolean;
}

type Tab = 'play' | 'locker' | 'challenges' | 'pass' | 'shop' | 'career' | 'settings';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const SLOT_ICON: Record<CosSlot, string> = { outfit: '🧍', headwear: '🧢', backpack: '🎒', glider: '🪂', trail: '✨', emote: '💃' };

export class Menus {
  root: HTMLDivElement;
  private tab: Tab = 'play';
  private mode: Mode = 'solo';
  private lockerSlot: CosSlot = 'outfit';
  private overlay: HTMLDivElement | null = null;
  visible = false;

  constructor(parent: HTMLElement, private ctx: MenuCtx) {
    this.root = document.createElement('div');
    this.root.className = 'menu hidden ui-interactive';
    parent.appendChild(this.root);
  }

  show() {
    this.visible = true;
    this.root.classList.remove('hidden');
    this.render();
  }

  hide() {
    this.visible = false;
    this.root.classList.add('hidden');
  }

  refresh() {
    if (this.visible) this.render();
  }

  private render() {
    const p = this.ctx.profile();
    const tabs: [Tab, string][] = [['play', 'Play'], ['locker', 'Locker'], ['challenges', 'Challenges'], ['pass', 'Surge Pass'], ['shop', 'Shop'], ['career', 'Career'], ['settings', 'Settings']];
    const need = p ? xpToNext(p.level) : 1;
    this.root.innerHTML = `
      <div class="topbar">
        <div class="logo">SURGE<span>FALL</span></div>
        <div class="tabs">${tabs.map(([k, n]) => `<button class="tab ${this.tab === k ? 'on' : ''}" data-tab="${k}">${n}</button>`).join('')}</div>
        <div class="spacer"></div>
        ${p ? `<div class="profile-chip"><div class="lvl">${p.level}</div><div><div>${esc(p.name)}</div><div class="bar" style="width:110px;height:6px"><div style="width:${(p.xp / need) * 100}%"></div></div></div><div class="coins">◆ ${p.currency}</div></div>` : '<div class="muted">Connecting…</div>'}
      </div>
      <div class="menu-body">${this.body(p)}</div>`;
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab as Tab;
        this.ctx.click();
        this.render();
      }),
    );
    this.bind();
    if (p) this.ctx.preview(p.loadout);
  }

  private body(p: PublicProfile | null): string {
    if (!p) return '<div class="card">Connecting to server…</div>';
    switch (this.tab) {
      case 'play': return this.playTab(p);
      case 'locker': return this.lockerTab(p);
      case 'challenges': return this.challengesTab(p);
      case 'pass': return this.passTab(p);
      case 'shop': return this.shopTab(p);
      case 'career': return this.careerTab(p);
      case 'settings': return this.settingsTab();
    }
  }

  private playTab(p: PublicProfile) {
    const { info, you } = this.ctx.party();
    const modes: [Mode, string, string][] = [['solo', 'SOLO', 'Every player for themselves'], ['duos', 'DUOS', 'Teams of 2 · revives'], ['squads', 'SQUADS', 'Teams of 4 · rebirth']];
    const leader = !info || info.leader === you;
    return `
      <div class="menu-left"></div>
      <div class="menu-right">
        <div class="card">
          <h3>Mode</h3>
          <div class="modes">${modes.map(([m, n, d]) => `<button class="mode ${this.mode === m ? 'on' : ''}" data-mode="${m}">${n}<small>${d}</small></button>`).join('')}</div>
        </div>
        <button class="play-btn" id="play" ${leader && this.ctx.connected() ? '' : 'disabled style="opacity:.5"'}>${leader ? 'PLAY' : 'WAITING FOR LEADER'}</button>
        ${this.ctx.offline() ? `<div class="card"><h3>Offline mode</h3><div class="muted" style="font-size:13px">No game server here, so matches run right in your browser against bots. Progress is saved on this device. Host the server build for online play with friends.</div></div>` : `<div class="card">
          <h3>Party</h3>
          ${info ? `<div class="row"><span class="muted">Code</span> <b style="font-size:22px;letter-spacing:.15em">${info.code}</b><button class="btn small ghost" id="pleave">Leave</button></div>
            <div class="party-list">${info.members.map((m) => `<div class="party-member"><span class="lvl" style="min-width:26px;height:26px;font-size:12px">${m.level}</span>${esc(m.name)}${m.id === info.leader ? ' 👑' : ''}</div>`).join('')}</div>`
            : `<div class="row"><button class="btn" id="pcreate">Create party</button><input class="field" id="pcode" maxlength="6" placeholder="CODE" style="width:100px;text-transform:uppercase"><button class="btn ghost" id="pjoin">Join</button></div>
               <div class="muted" style="font-size:12px;margin-top:8px">Share the code with friends to queue on the same team.</div>`}
        </div>`}
        <div class="card">
          <h3>Welcome back, ${esc(p.name)}</h3>
          ${this.ctx.touch() ? `<div class="controls-grid">
            <b>Left</b><span>Move with the stick · push it to the edge to sprint · <b>RUN</b> locks sprint</span>
            <b>Right</b><span>Drag anywhere to look · drag from <b>FIRE</b> to aim while shooting</span>
            <b>Buttons</b><span><b>AIM</b> scope · <b>JUMP</b> jump/mantle/glide · <b>CROUCH</b> crouch/slide · <b>⟳</b> reload</span>
            <b>USE</b><span>Appears when you can pick up, open, revive or drive — hold it for caches</span>
            <b>BUILD</b><span>Pieces replace the hotbar · <b>PLACE</b> builds · <b>◆</b> material · <b>✎</b> edit a wall</span>
            <b>Tap</b><span>Hotbar to switch items · <b>🎒</b> inventory · minimap for the full map · <b>📍</b> ping</span>
          </div>` : `<div class="controls-grid">
            <b>WASD</b><span>Move · <b>Shift</b> sprint · <b>C</b> crouch/slide · <b>Space</b> jump/mantle/glide</span>
            <b>Mouse</b><span>Aim · <b>LMB</b> fire · <b>RMB</b> aim down sights · <b>R</b> reload</span>
            <b>1–6</b><span>Harvest tool / inventory slots · wheel to cycle</span>
            <b>Q</b><span>Build mode · <b>F1–F4</b> wall/floor/ramp/roof · <b>G</b> material · <b>T</b> edit</span>
            <b>E</b><span>Interact / pick up / revive · <b>F</b> exit vehicle · <b>X</b> drop</span>
            <b>Tab</b><span>Inventory · <b>M</b> map · <b>V</b> ping · <b>B/N</b> emotes</span>
          </div>`}
        </div>
      </div>`;
  }

  private lockerTab(p: PublicProfile) {
    const slots: CosSlot[] = ['outfit', 'headwear', 'backpack', 'glider', 'trail', 'emote'];
    const owned = new Set(p.owned);
    const list = COSMETICS.filter((c) => c.slot === this.lockerSlot);
    const equipped = (id: string) => {
      const l = p.loadout;
      return l.outfit === id || l.headwear === id || l.backpack === id || l.glider === id || l.trail === id || l.emote1 === id || l.emote2 === id;
    };
    const src = (c: (typeof COSMETICS)[number]) => {
      switch (c.source.kind) {
        case 'default': return 'Default';
        case 'level': return `Level ${c.source.level}`;
        case 'tier': return `Pass tier ${c.source.tier}`;
        case 'shop': return `Shop ◆${c.source.price}`;
      }
    };
    return `
      <div class="menu-left"></div>
      <div class="menu-right" style="width:min(560px,100%)">
        <div class="card">
          <div class="slot-tabs">${slots.map((s) => `<button class="btn small ${this.lockerSlot === s ? '' : 'ghost'}" data-slot="${s}">${SLOT_ICON[s]} ${s}</button>`).join('')}</div>
          <div class="grid-items scroll">
            ${list.map((c) => `<div class="cos r${c.rarity} ${equipped(c.id) ? 'on' : ''} ${owned.has(c.id) ? '' : 'locked'}" data-cos="${c.id}">
              <div class="swatch" style="${c.colors ? `background:linear-gradient(135deg, ${hex(c.colors.primary)}, ${hex(c.colors.accent)})` : ''}">${owned.has(c.id) ? SLOT_ICON[c.slot] : '🔒'}</div>
              ${esc(c.name)}<div class="src">${src(c)}</div>
              ${c.slot === 'emote' && owned.has(c.id) ? `<div class="row" style="justify-content:center;margin-top:4px"><button class="btn small ${p.loadout.emote1 === c.id ? '' : 'ghost'}" data-emote="1" data-eid="${c.id}">1</button><button class="btn small ${p.loadout.emote2 === c.id ? '' : 'ghost'}" data-emote="2" data-eid="${c.id}">2</button></div>` : ''}</div>`).join('')}
          </div>
          ${this.lockerSlot === 'emote' ? `<div class="muted" style="font-size:12px;margin-top:8px">Pick which emote goes in slot 1 and slot 2${this.ctx.touch() ? ' (the 💃 button plays slot 1)' : ' (B / N in a match)'}.</div>` : ''}
        </div>
        <div class="muted" style="font-size:12px">Cosmetics are purely visual — every character has the same size, hitbox and stats.</div>
      </div>`;
  }

  private challengesTab(p: PublicProfile) {
    const sec = (period: string, title: string) => `
      <div class="card"><h3>${title}</h3>
      ${p.challenges.filter((c) => c.period === period).map((c) => `<div class="chal"><div class="row" style="justify-content:space-between"><span>${c.done ? '✅ ' : ''}${esc(c.name)}</span><span class="coins" style="font-size:13px">+${c.xp} XP · ◆${c.currency}</span></div>
      <div class="bar"><div style="width:${(c.progress / c.goal) * 100}%"></div></div><div class="muted" style="font-size:12px">${c.progress} / ${c.goal}</div></div>`).join('')}
      </div>`;
    return `<div class="menu-left"></div><div class="menu-right" style="width:min(560px,100%)">${sec('daily', 'Daily challenges')}${sec('weekly', 'Weekly challenges')}</div>`;
  }

  private passTab(p: PublicProfile) {
    const cur = p.tier;
    const into = p.seasonXp % SEASON.xpPerTier;
    const tiers = [];
    for (let t = 1; t <= SEASON.tiers; t++) {
      const r = tierReward(t);
      const label = r.cosmetic ? `${SLOT_ICON[COSMETIC_BY_ID[r.cosmetic].slot]} ${esc(COSMETIC_BY_ID[r.cosmetic].name)}` : `◆ ${r.currency}`;
      tiers.push(`<div class="tier ${t <= cur ? 'got' : ''} ${t === cur ? 'cur' : ''}"><div class="n">${t}</div>${label}</div>`);
    }
    const lvReward = levelReward(p.level + 1);
    return `<div class="menu-right" style="width:100%">
      <div class="card"><h3>${SEASON.name}</h3>
        <div class="row" style="justify-content:space-between"><b>Tier ${cur} / ${SEASON.tiers}</b><span class="muted">${into} / ${SEASON.xpPerTier} season XP</span></div>
        <div class="bar" style="margin:8px 0 14px"><div style="width:${(into / SEASON.xpPerTier) * 100}%"></div></div>
        <div class="muted" style="font-size:13px;margin-bottom:10px">Next level reward: ${lvReward.cosmetic ? esc(COSMETIC_BY_ID[lvReward.cosmetic].name) + ' + ' : ''}◆${lvReward.currency}. The pass is earned only by playing — no purchases.</div>
        <div class="tiers scroll" style="max-height:calc(100vh - 290px)">${tiers.join('')}</div>
      </div></div>`;
  }

  private shopTab(p: PublicProfile) {
    const owned = new Set(p.owned);
    return `<div class="menu-left"></div><div class="menu-right" style="width:min(560px,100%)">
      <div class="card"><h3>Today's shop · earned ${CURRENCY} only</h3>
        <div class="grid-items">${p.shop.map((s) => `<div class="cos r${s.rarity}"><div class="swatch">${SLOT_ICON[s.slot as CosSlot] ?? '★'}</div>${esc(s.name)}
          <div class="src">${s.slot}</div>
          ${owned.has(s.id) ? '<div class="muted" style="margin-top:6px">Owned</div>' : `<button class="btn small" style="margin-top:6px" data-buy="${s.id}">◆ ${s.price}</button>`}</div>`).join('')}</div>
      </div></div>`;
  }

  private careerTab(p: PublicProfile) {
    const s = p.stats;
    const kd = s.deaths ? (s.kills / s.deaths).toFixed(2) : s.kills.toFixed(0);
    const items: [string, string | number][] = [
      ['Level', p.level], ['Matches', s.matches], ['Wins', s.wins], ['Top 10', s.top10], ['Eliminations', s.kills], ['K/D', kd],
      ['Damage', s.damage], ['Caches opened', s.chests], ['Pieces built', s.builds], ['Time survived', `${Math.round(s.timePlayed / 60)}m`],
    ];
    return `<div class="menu-left"></div><div class="menu-right" style="width:min(560px,100%)"><div class="card"><h3>Career</h3>
      <div class="stat-grid">${items.map(([k, v]) => `<div class="stat"><span class="muted">${k}</span><b>${v}</b></div>`).join('')}</div></div>
      <div class="card"><h3>Island guide</h3>${POIS.map((poi) => `<div style="margin:6px 0"><b>${poi.name}</b> <span class="muted" style="font-size:12px">— ${poi.blurb}</span></div>`).join('')}</div></div>`;
  }

  private settingsTab() {
    const s = this.ctx.settings();
    const p = this.ctx.profile();
    const range = (k: keyof Settings, min: number, max: number, step: number) => `<input type="range" data-set="${k}" min="${min}" max="${max}" step="${step}" value="${s[k]}">`;
    const check = (k: keyof Settings) => `<input type="checkbox" data-set="${k}" ${s[k] ? 'checked' : ''}>`;
    const touch = this.ctx.touch();
    const head = (t: string) => `<div class="set-head">${t}</div><div></div>`;
    return `<div class="menu-left"></div><div class="menu-right" style="width:min(620px,100%)"><div class="card scroll"><h3>Settings</h3>
      <div class="settings-grid">
        <label>Display name</label><div class="row"><input class="field" id="nm" maxlength="16" value="${esc(p?.name ?? '')}"><button class="btn small" id="rename">Save</button></div>
        ${head(touch ? 'Touch controls' : 'Mouse & keyboard')}
        ${touch ? `<label>Look sensitivity</label>${range('touchSensitivity', 0.2, 3, 0.05)}
        <label>Button size</label>${range('buttonScale', 0.7, 1.4, 0.05)}
        <label>Button opacity</label>${range('buttonOpacity', 0.3, 1, 0.05)}
        <label>Auto-fire when on target</label>${check('autoFire')}
        <label>Vibration</label>${check('vibration')}
        <label>Fullscreen when playing</label>${check('fullscreen')}` : `<label>Mouse sensitivity</label>${range('sensitivity', 0.2, 3, 0.05)}
        <label>Toggle sprint</label>${check('toggleSprint')}
        <label>Toggle crouch</label>${check('toggleCrouch')}`}
        <label>ADS sensitivity</label>${range('adsSensitivity', 0.2, 1.5, 0.05)}
        <label>Aim assist (touch & controller)</label>${range('aimAssist', 0, 1, 0.05)}
        <label>Invert Y</label>${check('invertY')}
        ${head('Graphics')}
        <label>Graphics quality</label><select class="field" data-set="quality">${['low', 'medium', 'high'].map((q) => `<option ${s.quality === q ? 'selected' : ''}>${q}</option>`).join('')}</select>
        <label>Field of view</label>${range('fov', 65, 100, 1)}
        <label>Dynamic resolution</label>${check('dynamicRes')}
        <label>Frame rate limit</label><select class="field" data-set="fpsCap" data-num="1">${[[0, 'Display rate'], [60, '60 fps'], [30, '30 fps (battery saver)']].map(([v, n]) => `<option value="${v}" ${s.fpsCap === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <label>Show FPS / ping</label>${check('showFps')}
        ${head('Audio')}
        <label>Master volume</label>${range('master', 0, 1, 0.05)}
        <label>Music volume</label>${range('music', 0, 1, 0.05)}
        <label>Effects volume</label>${range('sfx', 0, 1, 0.05)}
      </div>
      <div class="muted" style="font-size:12px;margin-top:12px">Graphics quality changes apply after reload. Gamepads are supported automatically${touch ? '' : '; touch screens switch to touch controls when you tap'}.</div>
    </div></div>`;
  }

  private bind(root: HTMLElement = this.root) {
    const $ = (sel: string) => root.querySelector(sel) as HTMLElement | null;
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        this.mode = b.dataset.mode as Mode;
        this.ctx.click();
        this.render();
      }),
    );
    $('#play')?.addEventListener('click', () => this.ctx.play(this.mode));
    $('#pcreate')?.addEventListener('click', () => this.ctx.partyCreate());
    $('#pjoin')?.addEventListener('click', () => this.ctx.partyJoin(((root.querySelector('#pcode') as HTMLInputElement).value || '').toUpperCase()));
    $('#pleave')?.addEventListener('click', () => this.ctx.partyLeave());
    root.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((b) =>
      b.addEventListener('click', () => {
        this.lockerSlot = b.dataset.slot as CosSlot;
        this.render();
      }),
    );
    root.querySelectorAll<HTMLDivElement>('[data-cos]').forEach((el) =>
      el.addEventListener('click', (e) => {
        const p = this.ctx.profile();
        const id = el.dataset.cos!;
        if (!p || !p.owned.includes(id)) return;
        const c = COSMETIC_BY_ID[id];
        this.ctx.click();
        if (c.slot === 'emote') this.ctx.equip((e as MouseEvent).shiftKey ? { emote2: id } : { emote1: id });
        else this.ctx.equip({ [c.slot]: id } as Partial<CosmeticLoadout>);
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-emote]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.ctx.click();
        this.ctx.equip(b.dataset.emote === '1' ? { emote1: b.dataset.eid } : { emote2: b.dataset.eid });
      }),
    );
    root.querySelectorAll<HTMLButtonElement>('[data-buy]').forEach((b) => b.addEventListener('click', () => this.ctx.buy(b.dataset.buy!)));
    $('#rename')?.addEventListener('click', () => this.ctx.rename((root.querySelector('#nm') as HTMLInputElement).value));
    root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-set]').forEach((inp) =>
      inp.addEventListener('change', () => {
        const s = { ...this.ctx.settings() };
        const k = inp.dataset.set as keyof Settings;
        if (inp instanceof HTMLInputElement && inp.type === 'checkbox') (s as Record<string, unknown>)[k] = inp.checked;
        else if (inp instanceof HTMLInputElement || inp.dataset.num) (s as Record<string, unknown>)[k] = Number(inp.value);
        else (s as Record<string, unknown>)[k] = inp.value;
        this.ctx.saveSettings(s);
      }),
    );
  }

  // ------------------------------------------------------------------ overlays
  closeOverlay() {
    this.overlay?.remove();
    this.overlay = null;
  }

  private openOverlay(html: string, parent: HTMLElement) {
    this.closeOverlay();
    const o = document.createElement('div');
    o.className = 'overlay ui-interactive';
    o.innerHTML = `<div class="dialog">${html}</div>`;
    parent.appendChild(o);
    this.overlay = o;
    return o;
  }

  showQueue(parent: HTMLElement, mode: string, waited: number, leader: boolean) {
    const o = this.overlay && this.overlay.dataset.kind === 'queue' ? this.overlay : this.openOverlay('', parent);
    o.dataset.kind = 'queue';
    o.querySelector('.dialog')!.innerHTML = `<h2>Finding a match</h2><div class="muted">${mode.toUpperCase()} · ${waited}s</div><div class="spinner"></div>
      <div class="muted" style="font-size:13px;margin-bottom:14px">Lobbies fill with players; open seats are taken by bots.</div>
      ${leader ? '<button class="btn warn" id="cancelq">Cancel</button>' : ''}`;
    o.querySelector('#cancelq')?.addEventListener('click', () => this.ctx.cancelQueue());
  }

  showPause(parent: HTMLElement, onResume: () => void, onLeave: () => void, onSettings: () => void) {
    const o = this.openOverlay(`<h2>Paused</h2><div class="muted" style="margin-bottom:16px">The match keeps running!</div>
      <div class="row" style="justify-content:center"><button class="btn" id="resume">Resume</button><button class="btn ghost" id="psettings">Settings</button><button class="btn warn" id="leave">Leave match</button></div>`, parent);
    o.dataset.kind = 'pause';
    o.querySelector('#resume')!.addEventListener('click', onResume);
    o.querySelector('#leave')!.addEventListener('click', onLeave);
    o.querySelector('#psettings')!.addEventListener('click', onSettings);
  }

  showSettingsOverlay(parent: HTMLElement, onClose: () => void) {
    const o = this.openOverlay(`<div style="text-align:left">${this.settingsTab().replace('<div class="menu-left"></div>', '')}</div><button class="btn" id="sclose" style="margin-top:12px">Done</button>`, parent);
    o.dataset.kind = 'settings';
    this.bind(o);
    o.querySelector('#sclose')!.addEventListener('click', onClose);
  }

  showResults(parent: HTMLElement, r: ResultsMsg, canSpectate: boolean, onLobby: () => void, onSpectate: () => void) {
    const title = r.won ? 'SURGE SURVIVOR!' : r.placement <= 10 ? 'Great run!' : 'Eliminated';
    const o = this.openOverlay(`<div class="results">
      <div class="muted">${title}</div>
      <div class="place">#${r.placement}<span class="muted" style="font-size:22px"> / ${r.total}</span></div>
      <div class="row" style="justify-content:center;gap:18px;margin:6px 0 10px">
        <div><b style="font-size:24px">${r.kills}</b><div class="muted">elims</div></div>
        <div><b style="font-size:24px">${r.damage}</b><div class="muted">damage</div></div>
        <div><b style="font-size:24px">${Math.floor(r.survived / 60)}:${String(r.survived % 60).padStart(2, '0')}</b><div class="muted">survived</div></div>
      </div>
      <div class="xp-list">${r.xp.map((x, i) => `<div style="animation-delay:${i * 0.08}s"><span>${esc(x.label)}</span><b class="coins">+${x.amount} XP</b></div>`).join('')}
        <div style="animation-delay:${r.xp.length * 0.08}s"><span><b>Total</b></span><b class="coins">+${r.totalXp} XP · ◆${r.currency}</b></div></div>
      ${r.levelAfter > r.levelBefore ? `<div style="font-size:22px;font-weight:900;color:var(--cyan)">LEVEL UP! ${r.levelBefore} → ${r.levelAfter}</div>` : ''}
      ${r.tierAfter > r.tierBefore ? `<div style="font-weight:900;color:var(--sun)">Surge Pass tier ${r.tierAfter} unlocked!</div>` : ''}
      ${r.challengesDone.length ? `<div class="muted" style="margin-top:6px">Challenges completed: ${r.challengesDone.map(esc).join(', ')}</div>` : ''}
      <div class="row" style="justify-content:center;margin-top:16px">
        ${canSpectate ? '<button class="btn ghost" id="spec">Spectate</button>' : ''}
        <button class="btn" id="lobby">Return to lobby</button>
      </div></div>`, parent);
    o.dataset.kind = 'results';
    o.querySelector('#lobby')!.addEventListener('click', onLobby);
    o.querySelector('#spec')?.addEventListener('click', onSpectate);
  }

  get overlayKind() {
    return this.overlay?.dataset.kind ?? null;
  }
}
