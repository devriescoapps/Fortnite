// Client orchestrator: menus <-> matchmaking <-> match; client-side prediction with server
// reconciliation for the local player, snapshot interpolation for everyone else, input ->
// commands, building, interaction, camera, event handling, audio mixing and HUD updates.
import * as THREE from 'three';
import { BUILD_COST, BUILD_INTERVAL, INPUT_DT, INTERACT_RANGE, INTERP_DELAY, MATCH_DEFAULTS, Mode as GameMode, PICKUP_RANGE, SKYPORT, TEAM_COLORS, TICK_RATE, WATER_LEVEL } from '../shared/constants';
import { BuildGrid, MATERIALS, Piece, PieceType, buildTarget, inBuildRange, isPieceGrounded, pieceCenter, slotKey } from '../shared/build';
import { CollisionWorld, OwnerKind } from '../shared/collision';
import { AMMO_TYPES, ITEM_BY_CODE, RARITIES, ammoIndex, stackName } from '../shared/items';
import { forwardFromYawPitch, rightFromYaw, wrapAngle, fmtTime } from '../shared/math';
import { MapData, PROP_TYPES, buildWorld, generateMap } from '../shared/mapdata';
import { nearestPoi } from '../shared/pois';
import { DriveSnap, EF_ADS, EF_BUILDING, EF_CROUCH, EF_GROUNDED, EF_RELOAD, EF_SLIDE, EF_SPRINT, EF_USING, EntSnap, GroundItemInfo, MatchInit, MatchPhase, PieceInfo, PlayerInfo, ResultsMsg, Snapshot, quantizeInput } from '../shared/protocol';
import { DEFAULT_LOADOUT, EMOTE_IDS } from '../shared/progression';
import { BTN, InputCmd, Mode, SLOT_KEEP, SimEvent, SimState, SHOULDER_RIGHT, SHOULDER_UP, copySim, createSim, eyeHeight, spreadDegrees, stepSim } from '../shared/sim';
import { StormState, distanceToSafety, initialStorm, isInStorm, stormCircleAt } from '../shared/storm';
import { NO_GROUND, Terrain, biomeAt } from '../shared/terrain';
import { VEHICLES, VehicleState, quantizeVehicle, seatWorldPos, stepVehicle } from '../shared/vehicle';
import { AudioEngine } from './audio';
import { AssistTarget, applyAssist, onTarget, pickTarget } from './aimassist';
import { Input, InputSource, TouchContext, TouchControls } from './input';
import { LocalNet } from './local';
import { Net, NetLike } from './net';
import { CharacterModel } from './render/characters';
import { Effects } from './render/effects';
import { Environment } from './render/environment';
import { LootRenderer, PieceRenderer, ProjectileRenderer, PropRenderer, VehicleRenderer } from './render/worldview';
import { HAS_TOUCH, IS_MOBILE, Settings, loadSettings, loadToken, saveSettings, saveToken } from './settings';
import { Hud, TeamRow } from './ui/hud';
import { Menus, PartyInfo, PublicProfile } from './ui/menus';
import { MapPainter } from './ui/minimap';

type AppState = 'menu' | 'queue' | 'match';

interface Remote {
  id: number;
  info: PlayerInfo;
  model: CharacterModel;
  buf: { t: number; e: EntSnap }[];
  cur: EntSnap;
  stepT: number;
  lastSeen: number;
  tag: HTMLDivElement | null;
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
}

interface MatchState {
  init: MatchInit;
  you: number;
  team: number;
  mode: GameMode;
  players: Map<number, PlayerInfo>;
  phase: MatchPhase;
  phaseEnd: number;
  sim: SimState;
  prev: THREE.Vector3;
  pending: InputCmd[];
  seq: number;
  offset: THREE.Vector3;
  remotes: Map<number, Remote>;
  timeOffset: number;
  haveTime: boolean;
  lastSnap: number;
  storm: StormState;
  bus: MatchInit['bus'];
  busPos: { x: number; y: number; z: number; yaw: number } | null;
  alive: number;
  kills: number;
  spectating: number;
  eliminated: boolean;
  results: ResultsMsg | null;
  resultsShown: boolean;
  buildMode: boolean;
  piece: PieceType;
  mat: number;
  lastBuildAt: number;
  predicted: Map<string, { id: number; t: number }>;
  slotReq: number;
  sprintOn: boolean;
  crouchOn: boolean;
  channel: { kind: string; dur: number; t0: number } | null;
  chips: number[];
  pings: { x: number; y: number; z: number; color: string; until: number; el: HTMLDivElement }[];
  pads: { x: number; y: number; z: number }[];
  itemInfo: Map<number, GroundItemInfo>;
  pickupCd: Map<number, number>;
  target: { kind: 'item' | 'chest' | 'ammo' | 'supply' | 'revive' | 'spire' | 'vehicle'; id: number } | null;
  ended: boolean;
  winnerTeam: number;
  recoil: number;
  shake: number;
  stepT: number;
  model: CharacterModel;
  lastHurt: number;
  prevMode: Mode;
  vehicles: Map<number, { x: number; y: number; z: number; speed: number }>;
  /** Predicted vehicle while driving (null when walking or riding as a passenger). */
  drive: VehicleState | null;
  wasPredicted: boolean;
}

export class Game {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  settings: Settings;
  net: NetLike;
  input: Input;
  audio = new AudioEngine();
  touch: TouchControls | null = null;
  terrain!: Terrain;
  map!: MapData;
  world!: CollisionWorld;
  grid!: BuildGrid;
  propColliders!: Map<number, number>;
  env!: Environment;
  props!: PropRenderer;
  pieces!: PieceRenderer;
  loot!: LootRenderer;
  vehicles!: VehicleRenderer;
  projectiles!: ProjectileRenderer;
  fx!: Effects;
  hud!: Hud;
  menus!: Menus;
  painter!: MapPainter;
  state: AppState = 'menu';
  profile: PublicProfile | null = null;
  party: { info: PartyInfo | null; you: number } = { info: null, you: 0 };
  m: MatchState | null = null;
  view = { yaw: 0, pitch: 0 };
  private last = performance.now() / 1000;
  private acc = 0;
  private outgoing: InputCmd[] = [];
  private evScratch: SimEvent[] = [];
  private preview!: CharacterModel;
  private queueMode = 'solo';
  private fpsAcc = { n: 0, t: 0, fps: 0 };
  private mapT = 0;
  private screens: HTMLElement;
  private paused = false;
  private clock = 0;
  private cameraPos = new THREE.Vector3();
  private fovNow = 80;
  private lastLevel = 0;
  /** Touch UI active (phones/tablets, or a touch laptop whose last input was a touch). */
  touchMode = false;
  /** No game server reachable: matches run in this browser (see client/local.ts). */
  offline = false;
  private renderScale = 1;
  private resCap = 1;
  private perf = { t: 0, frames: 0, good: 0 };
  private lastRenderAt = 0;
  private prevAdsHeld = false;
  private autoPulse = false;
  private assistPick: ReturnType<typeof pickTarget> = null;

  constructor() {
    this.canvas = document.getElementById('view') as HTMLCanvasElement;
    this.settings = loadSettings();
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: this.settings.quality !== 'low', powerPreference: 'high-performance' });
    this.resCap = Math.min(window.devicePixelRatio, this.settings.quality === 'high' ? 2 : this.settings.quality === 'medium' ? 1.25 : IS_MOBILE ? 1 : 0.85);
    this.renderScale = this.resCap;
    this.renderer.setPixelRatio(this.renderScale);
    this.canvas.addEventListener('webglcontextlost', () => this.hud?.toast('Graphics were reset by the device — restoring…', 'warn'));
    this.renderer.shadowMap.enabled = this.settings.quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, 1, 0.1, 3200);
    this.screens = document.getElementById('screens')!;
    this.input = new Input(this.canvas);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.net = new Net(`${proto}://${location.host}/ws`);
    this.audio.volumes = { master: this.settings.master, music: this.settings.music, sfx: this.settings.sfx };
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // ------------------------------------------------------------------ boot
  async boot() {
    const bootMsg = document.querySelector('.boot-msg') as HTMLElement;
    await new Promise((r) => setTimeout(r, 30));
    this.terrain = new Terrain();
    this.map = generateMap(this.terrain);
    bootMsg.textContent = 'Painting the island…';
    await new Promise((r) => setTimeout(r, 10));
    this.resetWorld();
    this.env = new Environment(this.scene, this.terrain, this.map, this.settings.quality);
    this.props = new PropRenderer(this.scene, this.map, this.settings.quality);
    this.pieces = new PieceRenderer(this.scene, this.settings.quality);
    this.loot = new LootRenderer(this.scene);
    this.vehicles = new VehicleRenderer(this.scene);
    this.fx = new Effects(this.scene, document.getElementById('numbers')!);
    this.projectiles = new ProjectileRenderer(this.scene);
    this.projectiles.onTrail = (kind, p) => {
      if (kind === 0) this.fx.trail(p.x, p.y, p.z, 0xffb347, 0.35);
      else if (kind === 3) this.fx.trail(p.x, p.y, p.z, 0xfff2c0, 0.12);
      else if (kind === 2) this.fx.trail(p.x, p.y, p.z, 0xb388ff, 0.2);
    };
    this.projectiles.raycast = (o, d, max) => {
      const hit = this.world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, max);
      let t = hit ? hit.t : Infinity;
      for (const r of this.m?.remotes.values() ?? []) {
        const vx = r.pos.x - o.x, vy = r.pos.y + 1 - o.y, vz = r.pos.z - o.z;
        const along = vx * d.x + vy * d.y + vz * d.z;
        if (along <= 0 || along > Math.min(t, max)) continue;
        const px = vx - d.x * along, py = vy - d.y * along, pz = vz - d.z * along;
        if (px * px + pz * pz < 0.3 && Math.abs(py) < 1) t = along;
      }
      return t <= max ? t : null;
    };
    this.projectiles.onImpact = (p) => this.fx.burst(p.x, p.y, p.z, 4, 0xfff0b0, 3, 0.25, 0.08);
    for (const p of this.grid.pieces.values()) this.pieces.add(p, 0);
    for (const [i, lp] of this.map.launchPads.entries()) this.loot.addPad(1000 + i, lp.x, lp.y, lp.z);
    this.painter = new MapPainter(this.terrain);
    this.hud = new Hud(document.getElementById('hud')!, this.painter);
    this.bindHud();
    this.menus = new Menus(this.screens, {
      profile: () => this.profile,
      settings: () => this.settings,
      party: () => this.party,
      play: (mode) => this.queue(mode),
      cancelQueue: () => this.net.send({ t: 'cancel' }),
      equip: (l) => this.net.send({ t: 'equip', loadout: l }),
      buy: (id) => this.net.send({ t: 'buy', id }),
      rename: (name) => {
        this.settings.name = name;
        saveSettings(this.settings);
        this.net.send({ t: 'rename', name });
      },
      saveSettings: (s) => this.applySettings(s),
      partyCreate: () => this.net.send({ t: 'party.create' }),
      partyJoin: (code) => this.net.send({ t: 'party.join', code }),
      partyLeave: () => this.net.send({ t: 'party.leave' }),
      preview: (l) => this.preview.setCosmetics(l),
      click: () => {
        this.audio.unlock();
        this.audio.ui('click');
      },
      connected: () => this.net.connected,
      touch: () => this.touchMode,
      offline: () => this.offline,
    });
    this.preview = new CharacterModel(DEFAULT_LOADOUT);
    this.preview.root.position.set(SKYPORT.x - 1.4, SKYPORT.y, SKYPORT.z - 19);
    this.preview.root.rotation.y = Math.PI * 0.18;
    this.scene.add(this.preview.root);
    if (HAS_TOUCH || IS_MOBILE) {
      this.touch = new TouchControls(this.input, document.getElementById('app')!);
      this.touch.setVisible(false);
    }
    this.applyTouchLook();
    this.setTouchMode(IS_MOBILE || (HAS_TOUCH && !matchMedia('(pointer: fine)').matches));
    this.input.onSource = (src) => this.onInputSource(src);
    this.bindMobileShell();
    document.getElementById('boot')!.remove();
    // Online when a game server answers; otherwise (static hosting, file://, ?mode=offline) the
    // server runs right here in the browser against bots.
    const params = new URLSearchParams(location.search);
    const want = params.get('mode') ?? (window as { SURGEFALL_MODE?: string }).SURGEFALL_MODE ?? 'auto';
    if (want === 'offline' || location.protocol === 'file:') this.goOffline(false);
    else if (want !== 'online' && this.net instanceof Net) {
      const net = this.net;
      net.onFirstFailure = () => this.goOffline(true);
      // a static host rejects the socket at once (onFirstFailure); this covers hosts that hang
      setTimeout(() => {
        if (!net.everConnected && this.net === net) this.goOffline(true);
      }, 6000);
    }
    this.bindNet();
    this.net.connect();
    const unlock = () => {
      this.audio.unlock();
      this.audio.ensureAmbience();
      if (this.state !== 'match') this.audio.menuMusic(true);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    // iOS only unlocks WebAudio from touchend/click
    window.addEventListener('touchend', () => this.audio.unlock(), { passive: true });
    window.addEventListener('click', () => this.audio.unlock());
    this.showMenu();
    requestAnimationFrame(() => this.frame());
  }

  private bindNet() {
    this.net.onMessage = (m) => this.onMessage(m);
    this.net.onSnapshot = (s) => this.onSnapshot(s);
    this.net.onOpen = () => {
      this.net.send({ t: 'hello', token: loadToken(this.offline), name: this.settings.name || undefined });
      this.menus.refresh();
    };
    this.net.onClose = () => {
      this.hud.toast('Connection lost — reconnecting…', 'warn');
      this.menus.refresh();
    };
  }

  /** Switch to the in-browser server (no game server reachable). */
  private goOffline(connectNow: boolean) {
    if (this.offline) return;
    if (this.net instanceof Net) this.net.stop();
    this.offline = true;
    const dev = new URLSearchParams(location.search).get('dev') === '1';
    this.net = new LocalNet({ terrain: this.terrain, map: this.map }, { maxPlayers: IS_MOBILE ? 24 : MATCH_DEFAULTS.maxPlayers, devCommands: dev });
    document.body.classList.add('offline');
    if (connectNow) {
      this.bindNet();
      this.net.connect();
    }
    this.menus?.refresh();
  }

  private resetWorld() {
    const w = buildWorld(this.terrain, this.map);
    this.world = w.world;
    this.grid = w.grid;
    this.propColliders = w.propColliders;
  }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.applyTouchLook();
  }

  // ------------------------------------------------------------------ mobile shell
  /** Button size/opacity CSS variables; buttons shrink on short screens so the layout never collides. */
  private applyTouchLook() {
    const auto = Math.max(0.8, Math.min(1.3, window.innerHeight / 380));
    const st = document.documentElement.style;
    st.setProperty('--bs', String(+(auto * (this.settings?.buttonScale ?? 1)).toFixed(3)));
    st.setProperty('--bo', String(this.settings?.buttonOpacity ?? 0.85));
  }

  private setTouchMode(on: boolean) {
    if (on && !this.touch) return;
    this.touchMode = on;
    document.body.classList.toggle('touch', on);
    if (this.hud) this.hud.touch = on;
    this.touch?.setVisible(on && this.state === 'match');
    if (on) this.input.exitLock();
    this.menus?.refresh();
  }

  private onInputSource(src: InputSource) {
    if (src === 'touch') {
      if (!this.touchMode) this.setTouchMode(true);
      else this.touch?.setVisible(this.state === 'match');
    } else if (this.touchMode && !IS_MOBILE) this.setTouchMode(false);
    else if (src === 'pad') this.touch?.setVisible(false); // controller on a phone: hide the buttons
  }

  private bindMobileShell() {
    // iOS Safari ignores user-scalable=no; block pinch/double-tap zoom and long-press callouts
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    document.addEventListener('contextmenu', (e) => {
      if (this.touchMode) e.preventDefault();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // app switched / screen locked: release held controls so nothing stays pressed
        this.input.reset();
        this.touch?.reset();
        this.audio.ctx?.suspend().catch(() => {});
      } else {
        this.audio.ctx?.resume().catch(() => {});
      }
    });
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
  }

  /** Fullscreen + landscape lock on phones (must run inside a user gesture, e.g. the Play tap). */
  private enterFullscreen() {
    if (!this.touchMode || !this.settings.fullscreen) return;
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      if (!document.fullscreenElement) {
        const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : (el.webkitRequestFullscreen?.(), undefined);
        Promise.resolve(p).then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.('landscape')).catch(() => {});
      }
    } catch {
      /* unsupported (iPhone Safari) — the rotate hint covers portrait */
    }
  }

  private vibrate(ms: number | number[]) {
    if (!this.touchMode || !this.settings.vibration) return;
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* not supported */
    }
  }

  /** Label for an input hint in prompts ("E", "USE", "X"...). */
  private keyLabel(a: 'use' | 'exit' | 'jump') {
    if (this.touchMode) return a === 'use' ? 'USE' : a === 'exit' ? 'EXIT' : 'DROP';
    if (this.input.usingPad) return a === 'use' ? 'X' : a === 'exit' ? 'X' : 'A';
    return a === 'use' ? 'E' : a === 'exit' ? 'F' : 'SPACE';
  }

  private applySettings(s: Settings) {
    const q = this.settings.quality;
    this.settings = s;
    saveSettings(s);
    this.audio.volumes = { master: s.master, music: s.music, sfx: s.sfx };
    this.audio.applyVolumes();
    this.applyTouchLook();
    if (!s.dynamicRes && this.renderScale !== this.resCap) {
      this.renderScale = this.resCap;
      this.renderer.setPixelRatio(this.renderScale);
    }
    if (s.quality !== q) this.hud?.toast('Graphics quality applies after reload', 'warn');
  }

  private bindHud() {
    const act = (a: object) => this.net.send({ t: 'act', a });
    this.hud.onSwap = (a, b) => {
      act({ a: 'swap', from: a, to: b });
      setTimeout(() => this.refreshInventory(), 120);
    };
    this.hud.onDrop = (slot) => {
      act({ a: 'drop', slot });
      setTimeout(() => this.refreshInventory(), 120);
    };
    this.hud.onDropAmmo = (i) => {
      act({ a: 'dropAmmo', ammo: i, count: 0 });
      setTimeout(() => this.refreshInventory(), 120);
    };
    this.hud.onDropMat = (i) => {
      act({ a: 'dropMat', mat: i, count: 30 });
      setTimeout(() => this.refreshInventory(), 120);
    };
    this.hud.onSelectSlot = (i) => {
      if (!this.m) return;
      if (this.m.sim.inv.slots[i]) {
        this.m.slotReq = i;
        this.m.buildMode = false;
      }
      if (this.hud.inventoryOpen) setTimeout(() => this.refreshInventory(i), 60);
    };
    this.hud.onSpectate = (d) => act({ a: 'spectate', dir: d });
    this.hud.onBag = () => this.input.push('inventory');
    this.hud.onMap = () => this.input.push('map');
    this.hud.onCloseInventory = () => {
      if (this.m && this.hud.inventoryOpen) this.toggleInventory(this.m, false);
    };
    this.hud.onMapMark = (x, z) => {
      if (!this.m) return;
      act({ a: 'ping', x, y: Math.max(WATER_LEVEL, this.terrain.surfaceAt(x, z)) + 0.5, z });
      this.vibrate(8);
    };
  }

  private refreshInventory(sel?: number) {
    if (!this.m || !this.hud.inventoryOpen) return;
    const s = this.m.sim;
    this.hud.renderInventory(s.inv.slots, s.inv.ammo, s.inv.mats, sel ?? s.slot);
  }

  // ------------------------------------------------------------------ menu flow
  private showMenu() {
    this.state = 'menu';
    document.body.classList.remove('in-match', 'building');
    this.hud.show(false);
    this.touch?.setVisible(false);
    this.menus.closeOverlay();
    this.menus.show();
    this.input.captureEnabled = false;
    this.input.exitLock();
    this.preview.root.visible = true;
    this.audio.menuMusic(true);
  }

  private queue(mode: GameMode) {
    this.enterFullscreen();
    this.audio.unlock();
    this.audio.ui('click');
    this.queueMode = mode;
    this.net.send({ t: 'queue', mode });
  }

  // ------------------------------------------------------------------ messages
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onMessage(msg: any) {
    switch (msg.t) {
      case 'welcome':
        saveToken(msg.token, this.offline);
        this.profile = msg.profile;
        this.lastLevel = msg.profile.level;
        if (!this.settings.name) {
          this.settings.name = msg.profile.name;
          saveSettings(this.settings);
        }
        this.menus.refresh();
        break;
      case 'profile':
        if (msg.profile) {
          this.profile = msg.profile;
          this.menus.refresh();
        } else this.net.send({ t: 'profile' });
        break;
      case 'party':
        this.party = { info: msg.party, you: msg.you ?? this.party.you };
        this.menus.refresh();
        break;
      case 'error':
        this.audio.ui('error');
        this.hud.toast(msg.text, 'warn');
        if (this.state !== 'match') this.flashMenuError(msg.text);
        break;
      case 'queue':
        if (msg.status === 'searching') {
          this.state = 'queue';
          const leader = !this.party.info || this.party.info.leader === this.party.you;
          this.menus.showQueue(this.screens, msg.mode ?? this.queueMode, msg.waited ?? 0, leader);
        } else if (msg.status === 'cancelled') {
          this.menus.closeOverlay();
          this.state = 'menu';
        }
        break;
      case 'match':
        this.enterMatch(msg as MatchInit);
        break;
      case 'ev':
        for (const e of msg.l) this.onEvent(e);
        break;
      case 'results':
        this.onResults(msg as ResultsMsg);
        break;
      case 'matchOver':
        this.leaveMatch(false);
        break;
      case 'msg':
        this.hud.toast(msg.text, '');
        break;
      default:
        break;
    }
  }

  private flashMenuError(text: string) {
    const d = document.createElement('div');
    d.className = 'toast warn';
    d.textContent = text;
    document.getElementById('toast-layer')!.appendChild(d);
    setTimeout(() => d.remove(), 2000);
  }

  // ------------------------------------------------------------------ match lifecycle
  private enterMatch(init: MatchInit) {
    if (this.m) this.cleanupMatch();
    this.pendingSelf = null;
    this.menus.closeOverlay();
    this.menus.hide();
    this.audio.menuMusic(false);
    this.audio.ui('match');
    this.state = 'match';
    this.preview.root.visible = false;
    // rebuild authoritative-mirror world
    this.resetWorld();
    this.pieces.clear();
    this.props.restoreAll();
    this.loot.clear();
    this.vehicles.clear();
    this.projectiles.clear();
    const removed = new Set(init.removedMapPieces);
    for (const id of removed) this.grid.remove(id);
    for (const [id, hp] of init.damagedMapPieces) {
      const p = this.grid.get(id);
      if (p) p.hp = hp;
    }
    for (const p of this.grid.pieces.values()) this.pieces.add(p, init.time);
    for (const pi of init.pieces) this.addPiece(pi, init.time);
    for (const id of init.removedProps) this.removeProp(id, false);
    const itemInfo = new Map<number, GroundItemInfo>();
    for (const it of init.items) {
      this.loot.addItem(it);
      itemInfo.set(it.id, it);
    }
    for (const c of init.containers) this.loot.addContainer(c);
    const pads: MatchState['pads'] = [];
    for (const pd of init.launchPads) {
      this.loot.addPad(pd.id, pd.x, pd.y, pd.z);
      pads.push({ x: pd.x, y: pd.y, z: pd.z });
    }
    const players = new Map<number, PlayerInfo>();
    for (const p of init.players) players.set(p.id, p);
    const me = players.get(init.you);
    const model = new CharacterModel(me?.cos ?? DEFAULT_LOADOUT);
    this.scene.add(model.root);
    const sim = createSim(SKYPORT.x, SKYPORT.y + 1, SKYPORT.z);
    this.m = {
      init, you: init.you, team: init.team, mode: init.mode, players, phase: init.phase, phaseEnd: init.phaseEnd,
      sim, prev: new THREE.Vector3(sim.x, sim.y, sim.z), pending: [], seq: 0, offset: new THREE.Vector3(),
      remotes: new Map(), timeOffset: init.time - performance.now() / 1000, haveTime: false, lastSnap: 0,
      storm: init.storm ?? initialStorm(), bus: init.bus, busPos: null, alive: init.alive, kills: 0,
      spectating: init.spectating ?? 0, eliminated: init.spectating !== undefined, results: null, resultsShown: false,
      buildMode: false, piece: 'wall', mat: 0, lastBuildAt: 0, predicted: new Map(), slotReq: SLOT_KEEP, sprintOn: false, crouchOn: false,
      channel: null, chips: [], pings: [], pads, itemInfo, pickupCd: new Map(), target: null, ended: false, winnerTeam: -1,
      recoil: 0, shake: 0, stepT: 0, model, lastHurt: -10, prevMode: Mode.Walk, vehicles: new Map(), drive: null, wasPredicted: true,
    };
    this.view.yaw = 0; // face north, toward the island
    this.view.pitch = -0.05;
    this.hud.show(true);
    document.body.classList.add('in-match');
    this.touch?.setVisible(this.touchMode);
    this.touch?.setSprintLock(false);
    this.input.captureEnabled = true;
    if (!this.touchMode) this.input.requestLock();
    const phaseMsg = init.phase === 'lobby' ? 'Warm up on the Skyport — builds are free here!' : '';
    if (phaseMsg) this.hud.toast(phaseMsg, '');
    this.hud.toggleBigMap(false);
    this.hud.closeInventory();
  }

  private cleanupMatch() {
    const m = this.m;
    if (!m) return;
    for (const r of m.remotes.values()) {
      this.scene.remove(r.model.root);
      r.tag?.remove();
    }
    for (const p of m.pings) p.el.remove();
    this.scene.remove(m.model.root);
    this.audio.stopLoop('bus');
    for (const k of ['chest0', 'chest1', 'chest2', 'veh0', 'veh1', 'veh2']) this.audio.stopLoop(k);
    this.m = null;
  }

  private leaveMatch(sendLeave: boolean) {
    if (sendLeave) this.net.send({ t: 'leave' });
    this.cleanupMatch();
    this.hud.victory(null);
    this.hud.spectate(null);
    this.hud.banner(null);
    this.pieces.setGhost(null, false);
    // restore pristine island for the menu backdrop
    this.resetWorld();
    this.pieces.clear();
    this.props.restoreAll();
    this.loot.clear();
    this.vehicles.clear();
    this.projectiles.clear();
    this.vehicles.setBus(null, 0);
    for (const p of this.grid.pieces.values()) this.pieces.add(p, 0);
    for (const [i, lp] of this.map.launchPads.entries()) this.loot.addPad(1000 + i, lp.x, lp.y, lp.z);
    this.showMenu();
    this.net.send({ t: 'profile' });
  }

  private onResults(r: ResultsMsg) {
    const m = this.m;
    if (!m) return;
    m.results = r;
    const delay = r.won ? 4500 : 2200;
    setTimeout(() => {
      if (this.m !== m || m.resultsShown) return;
      m.resultsShown = true;
      this.input.exitLock();
      if (r.levelAfter > r.levelBefore) this.audio.ui('level');
      const canSpectate = !m.ended && [...m.remotes.values()].length > 0;
      this.menus.showResults(this.screens, r, canSpectate, () => this.leaveMatch(true), () => this.menus.closeOverlay());
    }, delay);
  }

  // ------------------------------------------------------------------ world mirror helpers
  private addPiece(pi: PieceInfo, now: number) {
    const key = slotKey(pi);
    const pred = this.m?.predicted.get(key);
    if (pred) {
      this.grid.remove(pred.id);
      this.pieces.remove(pred.id);
      this.m!.predicted.delete(key);
    }
    const existing = this.grid.get(pi.id);
    if (existing) {
      this.grid.remove(pi.id);
      this.pieces.remove(pi.id);
    }
    const p: Piece = { ...pi, grounded: isPieceGrounded(pi, this.terrain), colliderIds: [] };
    this.grid.add(p);
    this.pieces.add(p, now);
  }

  private removePieces(ids: number[]) {
    for (const id of ids) {
      const p = this.grid.get(id);
      if (!p) continue;
      const c = pieceCenter(p);
      const md = MATERIALS[p.mat];
      this.fx.burst(c.x, c.y, c.z, 14, md.color, 5, 0.8, 0.25);
      this.grid.remove(id);
      this.pieces.remove(id);
    }
    if (ids.length) {
      const p0 = this.m?.sim;
      if (p0) this.audio.breakPiece({ x: p0.x, y: p0.y, z: p0.z });
    }
  }

  private removeProp(id: number, effects = true) {
    const cid = this.propColliders.get(id);
    if (cid !== undefined) this.world.remove(cid);
    this.propColliders.delete(id);
    this.props.remove(id);
    if (effects) {
      const p = this.map.props[id];
      const T = PROP_TYPES[p.t];
      this.fx.burst(p.x, p.y + 1.5, p.z, 24, T.harvest === 'stone' ? 0x9aa1ab : T.harvest === 'alloy' ? 0xb0c4de : 0x8b5a2b, 5, 0.9, 0.3);
      this.audio.breakPiece({ x: p.x, y: p.y, z: p.z });
    }
  }

  // ------------------------------------------------------------------ server events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onEvent(e: any) {
    const m = this.m;
    if (!m) return;
    const now = this.serverNow();
    switch (e.e) {
      case 'shot': {
        const r = m.remotes.get(e.p);
        const def = ITEM_BY_CODE[e.c];
        const o = new THREE.Vector3(e.o[0], e.o[1], e.o[2]);
        this.fx.muzzle(o, def.weapon?.cls === 'shotgun' || def.weapon?.cls === 'sniper');
        for (const h of e.h as number[][]) {
          const end = new THREE.Vector3(h[0], h[1], h[2]);
          this.fx.tracer(o, end, def.weapon?.cls === 'sniper' ? 0xfff2c0 : 0xffd98a, def.weapon?.cls === 'sniper' ? 0.25 : 0.08);
          if (h[3] === 0) this.fx.burst(h[0], h[1], h[2], 4, 0xfff0b0, 3, 0.25, 0.08);
          else if (h[3] === 1 || h[3] === 2) this.fx.burst(h[0], h[1], h[2], 5, 0x6fd3ff, 3, 0.3, 0.1);
        }
        if (def.weapon) this.audio.shot(def.weapon.cls, { x: o.x, y: o.y, z: o.z });
        r?.model.triggerFire();
        break;
      }
      case 'hit': {
        const kind = e.h ? 'head' : e.sh ? 'shield' : 'health';
        this.fx.damageNumber(new THREE.Vector3(e.x, e.y, e.z), e.d, kind);
        this.hud.hitmarker(e.h ? 'head' : 'hit');
        this.audio.hitmarker(!!e.h, !!e.sh);
        this.vibrate(e.h ? 18 : 8);
        break;
      }
      case 'hurt': {
        m.lastHurt = this.clock;
        if (Number.isFinite(e.x)) {
          const ang = Math.atan2(-(e.x - m.sim.x), -(e.z - m.sim.z));
          this.hud.damageDir(-(ang - this.view.yaw));
        }
        this.audio.hurt(m.sim.shield > 0 && e.c !== 'storm' && e.c !== 'fall');
        if (e.c !== 'storm') this.vibrate(e.d > 30 ? 40 : 20);
        m.shake = Math.min(0.5, m.shake + e.d / 120);
        break;
      }
      case 'feed': {
        const col = (team: number) => (team === m.team ? '#ffd23f' : '#fff');
        const w = e.w >= 0 && ITEM_BY_CODE[e.w] ? ` <span class="muted">[${ITEM_BY_CODE[e.w].name}]</span>` : '';
        const html = e.kn
          ? `<span style="color:${col(e.kt)}">${escapeHtml(e.k || '?')}</span> <span class="kn">knocked</span> <span style="color:${col(e.vt)}">${escapeHtml(e.v)}</span>${w}`
          : e.ki
            ? `<span style="color:${col(e.kt)}">${escapeHtml(e.k)}</span> ${e.h ? '🎯' : '✖'} <span style="color:${col(e.vt)}">${escapeHtml(e.v)}</span>${w}`
            : `<span style="color:${col(e.vt)}">${escapeHtml(e.v)}</span> <span class="muted">was eliminated by ${escapeHtml(e.k || 'the island')}</span>`;
        this.hud.feed(html, e.ki === m.you || e.vi === m.you);
        if (e.kn && e.ki === m.you) this.hud.toast(`Knocked <b>${escapeHtml(e.v)}</b>`, 'elim');
        break;
      }
      case 'elimd':
        m.kills++;
        this.hud.toast(`You eliminated <b>${escapeHtml(e.v)}</b>`, 'elim');
        this.hud.hitmarker('kill');
        this.audio.elimination();
        this.vibrate([30, 40, 30]);
        break;
      case 'elim':
        m.eliminated = true;
        this.pendingSelf = null;
        m.buildMode = false;
        this.pieces.setGhost(null, false);
        this.hud.banner('ELIMINATED', e.by ? `by ${escapeHtml(e.by)}` : '');
        setTimeout(() => this.hud.banner(null), 3500);
        this.audio.defeat();
        this.hud.closeInventory();
        this.vibrate(120);
        break;
      case 'spec':
        m.spectating = e.id;
        break;
      case 'reborn':
        m.eliminated = false;
        m.results = null;
        m.resultsShown = false;
        this.menus.closeOverlay();
        this.hud.banner('REBORN!', 'Your squad brought you back');
        setTimeout(() => this.hud.banner(null), 3000);
        if (!this.touchMode) this.input.requestLock();
        break;
      case 'p+':
        this.addPiece(e.p, now);
        if (e.p.owner !== 0 && e.p.owner !== m.you) {
          const c = pieceCenter(e.p);
          this.audio.build(c, e.p.mat);
        }
        break;
      case 'p-':
        this.removePieces(e.ids);
        break;
      case 'php':
        for (const [id, hp] of e.l as [number, number][]) {
          const p = this.grid.get(id);
          if (!p) continue;
          p.hp = hp;
          this.pieces.flash(id);
        }
        break;
      case 'bf': {
        const pred = m.predicted.get(e.key);
        if (pred) {
          this.grid.remove(pred.id);
          this.pieces.remove(pred.id);
          m.predicted.delete(e.key);
        }
        if (e.why === 'mats') this.hud.toast('Not enough materials', 'warn');
        break;
      }
      case 'i+':
        this.loot.addItem(e.item, e.from);
        m.itemInfo.set(e.item.id, e.item);
        break;
      case 'i-':
        this.loot.removeItem(e.id);
        m.itemInfo.delete(e.id);
        break;
      case 'ic': {
        const it = m.itemInfo.get(e.id);
        if (it) it.count = e.n;
        break;
      }
      case 'c+':
        this.loot.addContainer(e.c);
        break;
      case 'co': {
        const c = this.loot.containers.get(e.id);
        this.loot.openContainer(e.id);
        if (c) {
          this.audio.chestOpen(c.info);
          this.fx.burst(c.info.x, c.info.y + 0.8, c.info.z, 30, 0xffe066, 4, 0.8, 0.14, 3);
        }
        break;
      }
      case 'prop-':
        this.removeProp(e.id);
        break;
      case 'prophit':
        this.props.hit(e.id);
        break;
      case 'boom': {
        this.fx.explosion(e.x, e.y, e.z, e.r);
        this.audio.explosion(e);
        const d = Math.hypot(e.x - m.sim.x, e.z - m.sim.z);
        m.shake = Math.min(1, m.shake + Math.max(0, 1 - d / 40));
        break;
      }
      case 'smoke':
        this.fx.smoke(e.x, e.y, e.z, e.r, e.d, this.clock);
        break;
      case 'fx':
        if (e.k === 'spark') this.fx.burst(e.x, e.y, e.z, 4, 0xfff0b0, 3, 0.25, 0.08);
        else this.fx.burst(e.x, e.y, e.z, 8, 0xc8904f, 4, 0.5, 0.14);
        break;
      case 'storm': {
        const prevStage = m.storm.stage;
        m.storm = e.s;
        if (e.s.stage === 'wait' && prevStage !== 'wait') this.hud.toast(`Surge phase ${e.s.phase + 1}: the next safe zone is marked`, 'storm');
        break;
      }
      case 'phase':
        m.phase = e.phase;
        m.phaseEnd = e.end;
        if (e.bus) m.bus = e.bus;
        if (e.phase === 'bus') {
          this.hud.toast('All aboard the Skywhale! Press <b>SPACE</b> to jump', '');
          m.buildMode = false;
          for (const [k, v] of m.predicted) {
            this.grid.remove(v.id);
            this.pieces.remove(v.id);
            m.predicted.delete(k);
          }
        } else if (e.phase === 'play') {
          this.audio.stopLoop('bus');
        } else if (e.phase === 'ended') {
          m.ended = true;
          m.winnerTeam = e.winner;
          if (e.winner === m.team) {
            this.hud.victory('SURGE SURVIVOR!<small>#1 · Victory</small>');
            this.audio.victory();
            for (let i = 0; i < 10; i++) setTimeout(() => this.fx.burst(m.sim.x, m.sim.y + 3, m.sim.z, 40, [0xffd23f, 0xff4fd8, 0x3ff0ff, 0x8b5cff][i % 4], 9, 1.4, 0.2, 4), i * 250);
          } else {
            this.hud.toast(`${escapeHtml((e.names ?? []).join(' & '))} won the match!`, '');
          }
        }
        break;
      case 'alive':
        m.alive = e.n;
        break;
      case 'msg':
        this.hud.toast(escapeHtml(e.text), e.k === 'storm' ? 'storm' : e.k === 'supply' ? 'supply' : e.k === 'warn' ? 'warn' : '');
        if (e.k === 'supply' || e.k === 'storm') this.audio.ui('notify');
        break;
      case 'chan':
        m.channel = { kind: e.k, dur: e.d, t0: this.clock };
        if (e.k === 'revive' || e.k === 'spire') this.audio.heal(false);
        break;
      case 'chanx':
        m.channel = null;
        break;
      case 'pad+':
        this.loot.addPad(e.pad.id, e.pad.x, e.pad.y, e.pad.z);
        m.pads.push({ x: e.pad.x, y: e.pad.y, z: e.pad.z });
        break;
      case 'snd': {
        const pos = e.x !== undefined ? e : m.remotes.get(e.p)?.pos;
        if (!pos) break;
        if (e.k === 'reload') this.audio.reload(pos);
        else if (e.k === 'rocket') this.audio.shot('explosive', pos);
        else this.audio.whoosh(pos);
        break;
      }
      case 'swing':
        m.remotes.get(e.p)?.model.triggerSwing();
        break;
      case 'harv':
        this.hud.harvest(`+${e.n} ${['Timber', 'Stone', 'Alloy'][e.m]}`);
        this.audio.harvest(null, e.m === 0 ? 'wood' : e.m === 1 ? 'stone' : 'metal');
        break;
      case 'chips':
        m.chips = e.ids;
        break;
      case 'ping': {
        const el = document.createElement('div');
        el.className = 'ping-mark';
        el.textContent = '📍';
        document.getElementById('tags')!.appendChild(el);
        const info = m.players.get(e.from);
        const color = TEAM_COLORS[[...m.players.values()].filter((p) => p.team === m.team).findIndex((p) => p.id === e.from) % 4] ?? '#fff';
        m.pings.push({ x: e.x, y: e.y, z: e.z, color, until: this.clock + 8, el });
        this.audio.ui('notify');
        if (info && e.from !== m.you) this.hud.toast(`${escapeHtml(info.name)} pinged a location`, '');
        break;
      }
      case 'join':
        m.players.set(e.player.id, e.player);
        break;
      case 'leave': {
        m.players.delete(e.id);
        const r = m.remotes.get(e.id);
        if (r) {
          this.scene.remove(r.model.root);
          r.tag?.remove();
          m.remotes.delete(e.id);
        }
        break;
      }
      case 'vboom':
        this.vehicles.remove(e.id);
        break;
    }
  }

  // ------------------------------------------------------------------ snapshots
  private serverNow() {
    const m = this.m;
    return m ? performance.now() / 1000 + m.timeOffset : 0;
  }

  private onSnapshot(s: Snapshot) {
    const m = this.m;
    if (!m) return;
    const local = performance.now() / 1000;
    const sample = s.time - local;
    if (!m.haveTime || Math.abs(sample - m.timeOffset) > 0.5) {
      m.timeOffset = sample;
      m.haveTime = true;
    } else m.timeOffset += (sample - m.timeOffset) * 0.05;
    m.lastSnap = local;

    // --- self reconciliation: keep only the newest authoritative state; replay once per frame ---
    if (s.self && !m.eliminated) this.pendingSelf = { self: s.self, ack: s.ack, drive: s.drive ?? null };
    m.busPos = s.bus;

    // --- remote entities ---
    const seen = new Set<number>();
    for (const e of s.ents) {
      seen.add(e.id);
      let r = m.remotes.get(e.id);
      if (!r) {
        const info = m.players.get(e.id) ?? { id: e.id, name: `Player ${e.id}`, team: -1, bot: true, cos: DEFAULT_LOADOUT, level: 1 };
        const model = new CharacterModel(info.cos);
        this.scene.add(model.root);
        r = { id: e.id, info, model, buf: [], cur: e, stepT: 0, lastSeen: s.time, tag: null, pos: new THREE.Vector3(e.x, e.y, e.z), yaw: e.yaw, pitch: e.pitch };
        if (info.team === m.team) {
          const tag = document.createElement('div');
          tag.className = 'tag';
          document.getElementById('tags')!.appendChild(tag);
          r.tag = tag;
        }
        m.remotes.set(e.id, r);
      }
      r.buf.push({ t: s.time, e });
      if (r.buf.length > 12) r.buf.shift();
      r.cur = e;
      r.lastSeen = s.time;
    }
    for (const [id, r] of m.remotes) {
      if (!seen.has(id) && s.time - r.lastSeen > 0.4) {
        this.scene.remove(r.model.root);
        r.tag?.remove();
        m.remotes.delete(id);
      }
    }
    // vehicles & projectiles
    this.projectiles.sync(s.projs, s.time);
    this.vehicles.sync(s.vehicles, s.time);
    m.vehicles.clear();
    for (const v of s.vehicles) m.vehicles.set(v.id, { x: v.x, y: v.y, z: v.z, speed: v.speed });
  }

  private pendingSelf: { self: SimState; ack: number; drive: DriveSnap | null } | null = null;

  /** Reset the predicted player (and driven vehicle) to the latest server state and replay unacknowledged inputs. */
  private reconcile(m: MatchState) {
    const ps = this.pendingSelf;
    if (!ps) return;
    this.pendingSelf = null;
    m.pending = m.pending.filter((c) => c.seq > ps.ack);
    const oldX = m.sim.x, oldY = m.sim.y, oldZ = m.sim.z;
    copySim(m.sim, ps.self);
    const d = ps.drive;
    if (m.sim.mode === Mode.Vehicle && d && d.seat === 0 && d.st) {
      const prevId = m.drive?.id;
      const v: VehicleState = m.drive && prevId === d.id ? m.drive : { id: d.id, type: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0, vy: 0, hp: VEHICLES[0].hp, seats: [m.you, 0, 0, 0], boost: 0 };
      Object.assign(v, d.st);
      m.drive = v;
      for (const c of m.pending) this.driveStep(m, c);
      const sp = seatWorldPos(v, 0);
      m.sim.x = sp.x;
      m.sim.y = sp.y;
      m.sim.z = sp.z;
    } else {
      m.drive = null;
      if (!serverDriven(m.sim.mode)) {
        const ctx = { world: this.world, playerId: m.you, canAttack: m.phase === 'bus' || m.phase === 'play', pads: m.pads };
        for (const c of m.pending) {
          this.evScratch.length = 0;
          stepSim(m.sim, c, INPUT_DT, ctx, this.evScratch);
        }
      }
    }
    const predicted = !serverDriven(m.sim.mode) || !!m.drive;
    const dx = oldX - m.sim.x, dy = oldY - m.sim.y, dz = oldZ - m.sim.z;
    const err = Math.hypot(dx, dy, dz);
    if (err > 3 || !predicted || !m.wasPredicted) {
      m.offset.set(0, 0, 0);
      m.prev.set(m.sim.x, m.sim.y, m.sim.z);
    } else if (err > 0.001) {
      m.offset.x += dx;
      m.offset.y += dy;
      m.offset.z += dz;
      m.prev.x -= dx;
      m.prev.y -= dy;
      m.prev.z -= dz;
    }
    m.wasPredicted = predicted;
  }

  /** Advance the predicted driven vehicle by one input (same code the server runs). */
  private driveStep(m: MatchState, c: InputCmd) {
    const v = m.drive!;
    stepVehicle(v, { mx: c.mx, mz: c.mz, handbrake: (c.buttons & BTN.JUMP) !== 0 }, INPUT_DT, this.world, []);
    quantizeVehicle(v);
  }

  // ------------------------------------------------------------------ per-frame
  private frame() {
    requestAnimationFrame(() => this.frame());
    const now = performance.now() / 1000;
    // optional frame cap (battery saver); the fixed-step sim catches up on the next frame
    const cap = this.settings.fpsCap;
    if (cap > 0 && now - this.lastRenderAt < 1 / cap - 0.002) return;
    this.lastRenderAt = now;
    const rawDt = now - this.last;
    const dt = Math.min(0.1, rawDt);
    // the fixed-step simulation may catch up more than one visual frame so slow devices keep real-time speed
    const simDt = Math.min(0.25, rawDt);
    this.last = now;
    this.clock += dt;
    this.input.pollGamepad(dt, this.settings.sensitivity);
    this.fpsAcc.n++;
    this.fpsAcc.t += dt;
    if (this.fpsAcc.t > 0.5) {
      this.fpsAcc.fps = this.fpsAcc.n / this.fpsAcc.t;
      this.fpsAcc.n = 0;
      this.fpsAcc.t = 0;
    }
    this.adaptResolution(rawDt);
    const m = this.m;
    if (m && this.state === 'match') {
      this.reconcile(m);
      this.handleActions(m);
      this.applyLook(m, dt);
      this.acc += simDt;
      let steps = 0;
      while (this.acc >= INPUT_DT && steps < 16) {
        this.stepLocal(m);
        this.acc -= INPUT_DT;
        steps++;
      }
      if (steps >= 16) this.acc = 0;
      this.net.sendInputs(this.outgoing);
      this.outgoing = [];
      const decay = Math.exp(-dt * 12);
      m.offset.multiplyScalar(decay);
      this.updateRemotes(m, dt);
      this.updateInteract(m);
      this.updateBuild(m);
      this.updateTouch(m);
      this.updateCamera(m, dt);
      this.updateHud(m, dt);
      this.updateAudio(m, dt);
      this.vehicles.setBus(m.phase === 'bus' && m.busPos ? m.busPos : null, dt);
      this.vehicles.predicted = m.drive;
      this.vehicles.update(dt, this.serverNow() - INTERP_DELAY);
      this.projectiles.update(dt, this.serverNow() - INTERP_DELAY);
    } else {
      this.input.consumeActions();
      this.input.consumeLook();
      this.updateMenuCamera(dt);
    }
    const cam = this.camera.position;
    this.env.update(dt, cam, this.clock);
    this.props.update(dt, cam, this.settings.quality === 'low' ? 380 : this.settings.quality === 'medium' ? 600 : 900);
    this.pieces.update(dt, this.m ? this.serverNow() : 0);
    this.loot.update(dt, cam, this.camera, this.m ? this.serverNow() : 0);
    this.fx.update(dt, this.camera, this.clock, window.innerWidth, window.innerHeight);
    this.hud?.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Dynamic resolution: drop the render scale when frames are slow, raise it again after a
   * sustained stretch of fast frames. Keeps phones responsive in busy fights.
   */
  private adaptResolution(rawDt: number) {
    if (!this.settings.dynamicRes || rawDt > 0.5) return; // ignore hitches (tab switches)
    const p = this.perf;
    p.t += rawDt;
    p.frames++;
    if (p.t < 1) return;
    const fps = p.frames / p.t;
    p.t = 0;
    p.frames = 0;
    const cap = this.settings.fpsCap || 60;
    let next = this.renderScale;
    if (fps < Math.min(28, cap * 0.8)) {
      next = Math.max(0.5, this.renderScale * 0.85);
      p.good = 0;
    } else if (fps > Math.min(50, cap * 0.92)) {
      if (++p.good >= 3) {
        next = Math.min(this.resCap, this.renderScale * 1.1);
        p.good = 0;
      }
    } else p.good = 0;
    if (Math.abs(next - this.renderScale) > 0.01) {
      this.renderScale = next;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  /** Pick the touch control set for what the player is doing right now. */
  private updateTouch(m: MatchState) {
    const t = this.touch;
    if (!t || !this.touchMode) return;
    const s = m.sim;
    let ctx: TouchContext;
    if (this.paused || this.hud.inventoryOpen) ctx = 'hidden';
    else if (m.eliminated || s.mode === Mode.Dead) ctx = 'spec';
    else if (s.mode === Mode.Bus) ctx = 'bus';
    else if (s.mode === Mode.Skydive || s.mode === Mode.Glide) ctx = 'air';
    else if (s.mode === Mode.Vehicle) ctx = 'vehicle';
    else if (s.mode === Mode.Downed) ctx = 'downed';
    else if (s.mode === Mode.Swim) ctx = 'swim';
    else ctx = m.buildMode ? 'build' : 'walk';
    t.setContext(ctx);
    document.body.classList.toggle('building', ctx === 'build');
    if (ctx === 'build') {
      t.setMaterial(['WOOD', 'STONE', 'ALLOY'][m.mat]);
      t.setPiece(m.piece, false);
    }
  }

  private updateMenuCamera(dt: number) {
    const t = this.clock;
    this.camera.position.set(SKYPORT.x + 1.0 + Math.sin(t * 0.2) * 0.25, SKYPORT.y + 2.2, SKYPORT.z - 11.5 + Math.cos(t * 0.15) * 0.25);
    this.camera.lookAt(SKYPORT.x + 2.4, SKYPORT.y + 2.6, SKYPORT.z - 22);
    this.fovNow = 60;
    this.camera.fov = 60;
    this.camera.updateProjectionMatrix();
    this.preview.update(dt, { mode: Mode.Walk, speed: 0, grounded: true, crouch: false, sprint: false, ads: false, slide: false, reload: false, using: false, building: false, vy: 0, pitch: 0, emote: Math.floor(t / 6) % 3 === 2 ? 3 : 0, item: 0, rarity: 0 }, t);
    this.env.setStorm(0, 0, 800, null, false);
    this.vehicles.setBus(null, dt);
  }

  private handleActions(m: MatchState) {
    const s = m.sim;
    for (const a of this.input.consumeActions()) {
      const uiOpen = this.hud.inventoryOpen || this.paused;
      if (!uiOpen && a === 'jumpPress') this.queuedPress |= BTN.JUMP;
      if (!uiOpen && a === 'firePress' && !m.eliminated) {
        if (m.buildMode) this.queuedBuild = true;
        else this.queuedPress |= BTN.FIRE;
      }
      switch (a) {
        case 'menu':
          if (this.hud.inventoryOpen) this.toggleInventory(m, false);
          else if (this.hud.bigMapOpen) this.hud.toggleBigMap(false);
          else this.togglePause(!this.paused);
          break;
        case 'inventory':
          this.toggleInventory(m, !this.hud.inventoryOpen);
          break;
        case 'map':
          this.hud.toggleBigMap();
          break;
        default:
          if (uiOpen) break;
          this.handleGameAction(m, s, a);
      }
    }
  }

  private handleGameAction(m: MatchState, s: SimState, a: string) {
    const act = (x: object) => this.net.send({ t: 'act', a: x });
    if (m.eliminated) {
      if (a === 'specPrev' || a === 'slotPrev') act({ a: 'spectate', dir: -1 });
      if (a === 'specNext' || a === 'slotNext' || a === 'firePress') act({ a: 'spectate', dir: 1 });
      return;
    }
    switch (a) {
      case 'slot0': case 'slot1': case 'slot2': case 'slot3': case 'slot4': case 'slot5': {
        const i = Number(a.slice(4));
        if (s.inv.slots[i]) m.slotReq = i;
        m.buildMode = false;
        break;
      }
      case 'slotNext':
      case 'slotPrev': {
        if (m.buildMode) {
          const order: PieceType[] = ['wall', 'floor', 'ramp', 'roof'];
          m.piece = order[(order.indexOf(m.piece) + (a === 'slotNext' ? 1 : 3)) % 4];
          break;
        }
        const dir = a === 'slotNext' ? 1 : -1;
        const cur = m.slotReq !== SLOT_KEEP ? m.slotReq : s.slot;
        for (let k = 1; k <= 6; k++) {
          const i = (cur + dir * k + 6) % 6;
          if (s.inv.slots[i]) {
            m.slotReq = i;
            break;
          }
        }
        break;
      }
      case 'build':
        if (s.mode === Mode.Walk) m.buildMode = !m.buildMode;
        break;
      case 'sprintLock':
        this.touch?.setSprintLock(!this.touch.sprintLocked);
        break;
      case 'wall': case 'floor': case 'ramp': case 'roof':
        if (s.mode !== Mode.Walk) break;
        m.buildMode = true;
        m.piece = a as PieceType;
        break;
      case 'material':
        m.mat = (m.mat + 1) % 3;
        break;
      case 'edit': {
        const eye = this.aimOrigin(s);
        const f = forwardFromYawPitch(this.view.yaw, this.view.pitch);
        const hit = this.world.raycast(eye.x, eye.y, eye.z, f.x, f.y, f.z, 8, undefined, true);
        if (hit?.collider && hit.collider.ownerKind === OwnerKind.Piece) {
          const p = this.grid.get(hit.collider.ownerId);
          if (p && p.type === 'wall' && p.owner !== 0) act({ a: 'edit', id: p.id });
        }
        break;
      }
      case 'drop':
        if (s.slot > 0 && s.inv.slots[s.slot]) act({ a: 'drop', slot: s.slot });
        break;
      case 'emote1':
      case 'emote2': {
        const p = m.players.get(m.you);
        const id = a === 'emote1' ? p?.cos.emote1 : p?.cos.emote2;
        const idx = EMOTE_IDS.indexOf(id ?? 'wave');
        if (idx >= 0 && s.mode === Mode.Walk && s.grounded) {
          act({ a: 'emote', id: idx });
          s.emote = idx + 1;
        }
        break;
      }
      case 'ping': {
        const o = this.camera.position;
        const f = new THREE.Vector3();
        this.camera.getWorldDirection(f);
        const hit = this.world.raycast(o.x, o.y, o.z, f.x, f.y, f.z, 600);
        if (hit) act({ a: 'ping', x: hit.x, y: hit.y, z: hit.z });
        break;
      }
      case 'use':
        this.useTarget(m);
        break;
      case 'exitVehicle':
        if (s.mode === Mode.Vehicle) act({ a: 'exitVehicle' });
        break;
      case 'specPrev':
      case 'specNext':
        break;
    }
  }

  private toggleInventory(m: MatchState, open: boolean) {
    if (open && !m.eliminated) {
      this.input.exitLock();
      this.hud.openInventory(m.sim.inv.slots, m.sim.inv.ammo, m.sim.inv.mats, m.sim.slot);
    } else {
      this.hud.closeInventory();
      // never grab the cursor while a menu (e.g. the results screen) needs it
      if (!this.touchMode && !this.paused && !m.eliminated && !this.menus.overlayKind) this.input.requestLock();
    }
  }

  private togglePause(p: boolean) {
    this.paused = p;
    if (p) {
      this.input.exitLock();
      this.menus.showPause(this.screens, () => this.togglePause(false), () => {
        this.paused = false;
        this.leaveMatch(true);
      }, () => this.menus.showSettingsOverlay(this.screens, () => this.togglePause(true)));
    } else {
      this.menus.closeOverlay();
      if (!this.touchMode) this.input.requestLock();
    }
  }

  private applyLook(m: MatchState, dt: number) {
    const look = this.input.consumeLook();
    const adsHeld = this.input.held('ads');
    const adsPressed = adsHeld && !this.prevAdsHeld;
    this.prevAdsHeld = adsHeld;
    this.assistPick = null;
    if (this.hud.inventoryOpen || this.paused || this.hud.bigMapOpen) return;
    const w = this.currentWeapon(m);
    const zoom = m.sim.ads && w ? w.zoom : 1;
    const adsK = m.sim.ads ? this.settings.adsSensitivity / zoom : 1;
    const inv = this.settings.invertY ? -1 : 1;
    const mouseK = 0.0022 * this.settings.sensitivity * adsK;
    const touchK = 0.0048 * this.settings.touchSensitivity * adsK;
    const dYaw = -(look.mouse.dx + look.pad.dx) * mouseK - look.touch.dx * touchK;
    const dPitch = (-(look.mouse.dy + look.pad.dy) * mouseK - look.touch.dy * touchK) * inv;
    // aim assist: touch and controller only (mouse aim is never assisted)
    const assisted = this.settings.aimAssist > 0 && (this.touchMode || this.input.usingPad) && this.input.source !== 'kbm';
    const pick = assisted || this.settings.autoFire ? this.findAssistTarget(m, w) : null;
    this.assistPick = pick;
    let yaw = wrapAngle(this.view.yaw + dYaw), pitch = this.view.pitch + dPitch;
    if (assisted && pick) {
      const ax = this.input.axes();
      const active = Math.abs(dYaw) + Math.abs(dPitch) > 1e-5 || Math.hypot(ax.x, ax.z) > 0.2 || this.input.held('fire');
      const out = applyAssist({ yaw: this.view.yaw, pitch: this.view.pitch, lookYaw: dYaw, lookPitch: dPitch, active, ads: m.sim.ads, adsPressed, dt, strength: this.settings.aimAssist }, pick);
      yaw = out.yaw;
      pitch = out.pitch;
    }
    this.view.yaw = wrapAngle(yaw);
    this.view.pitch = Math.max(-1.45, Math.min(1.45, pitch));
  }

  /** Nearest visible enemy near the crosshair (for aim assist / auto-fire). */
  private findAssistTarget(m: MatchState, w: ReturnType<Game['currentWeapon']>) {
    const s = m.sim;
    if (m.eliminated || m.buildMode || s.mode !== Mode.Walk && s.mode !== Mode.Swim) return null;
    if (!w) return null;
    const range = Math.min(w.cls === 'melee' ? 4 : w.range, 160);
    const o = this.aimOrigin(s);
    const targets: AssistTarget[] = [];
    for (const r of m.remotes.values()) {
      if (r.info.team === m.team) continue;
      const md = r.cur.mode;
      if (md === Mode.Dead || md === Mode.Bus || md === Mode.Vehicle) continue;
      const dx = r.pos.x - s.x, dz = r.pos.z - s.z;
      if (dx * dx + dz * dz > range * range) continue;
      const y = r.pos.y + (md === Mode.Downed ? 0.35 : r.cur.flags & EF_CROUCH ? 0.85 : 1.15);
      targets.push({ id: r.id, x: r.pos.x, y, z: r.pos.z });
    }
    if (!targets.length) return null;
    return pickTarget(this.view.yaw, this.view.pitch, o.x, o.y, o.z, targets, {
      cone: m.sim.ads ? 0.07 : 0.1,
      maxRange: range,
      visible: (t) => {
        const dx = t.x - o.x, dy = t.y - o.y, dz = t.z - o.z;
        const d = Math.hypot(dx, dy, dz);
        return !this.world.raycast(o.x, o.y, o.z, dx / d, dy / d, dz / d, d - 0.4, undefined, true);
      },
    });
  }

  private currentWeapon(m: MatchState) {
    const it = m.sim.inv.slots[m.sim.slot];
    return it ? ITEM_BY_CODE[it.code].weapon ?? null : null;
  }

  private buttons(m: MatchState): number {
    const i = this.input;
    const uiOpen = this.hud.inventoryOpen || this.paused || this.hud.bigMapOpen;
    if (uiOpen) return m.buildMode ? BTN.BUILD : 0;
    let b = 0;
    if (i.held('jump')) b |= BTN.JUMP;
    b |= this.queuedPress & ~(m.buildMode ? BTN.FIRE : 0);
    this.queuedPress = 0;
    const sprintHeld = i.held('sprint');
    if (this.settings.toggleSprint) {
      if (sprintHeld && !(m.sim.prevButtons & BTN.SPRINT) && !this.sprintEdge) m.sprintOn = !m.sprintOn;
      this.sprintEdge = sprintHeld;
      if (m.sprintOn) b |= BTN.SPRINT;
    } else if (sprintHeld || this.settings.autoSprint) b |= BTN.SPRINT;
    const crouchHeld = i.held('crouch');
    if (this.settings.toggleCrouch) {
      if (crouchHeld && !this.crouchEdge) m.crouchOn = !m.crouchOn;
      this.crouchEdge = crouchHeld;
      if (m.crouchOn) b |= BTN.CROUCH;
    } else if (crouchHeld) b |= BTN.CROUCH;
    if (m.buildMode) b |= BTN.BUILD;
    else if (i.held('fire')) b |= BTN.FIRE;
    else if (this.settings.autoFire && this.touchMode && onTarget(this.assistPick)) {
      // auto-fire: hold for automatic weapons, pulse for semi-automatic ones
      const w = this.currentWeapon(m);
      this.autoPulse = !this.autoPulse;
      if (w && w.cls !== 'melee' && (w.auto || this.autoPulse)) b |= BTN.FIRE;
    }
    if (i.held('ads') && !m.buildMode) b |= BTN.ADS;
    if (i.held('reload')) b |= BTN.RELOAD;
    if (i.held('use')) b |= BTN.USE;
    return b;
  }
  private sprintEdge = false;
  private crouchEdge = false;
  private queuedPress = 0;

  private stepLocal(m: MatchState) {
    const s = m.sim;
    const ax = this.hud.inventoryOpen || this.paused ? { x: 0, z: 0 } : this.input.axes();
    const renderT = this.serverNow() - INTERP_DELAY;
    const cmd = quantizeInput({
      seq: ++m.seq, mx: ax.x, mz: ax.z, yaw: this.view.yaw, pitch: Math.max(-1.45, Math.min(1.45, this.view.pitch + m.recoil)),
      buttons: this.buttons(m), slot: m.slotReq, viewTick: Math.max(0, renderT * TICK_RATE),
    });
    m.slotReq = SLOT_KEEP;
    if (m.eliminated) m.pending.length = 0;
    else m.pending.push(cmd);
    if (m.pending.length > 240) m.pending.shift();
    this.outgoing.push(cmd);
    m.prev.set(s.x, s.y, s.z);
    if (s.mode === Mode.Vehicle && m.drive) {
      this.driveStep(m, cmd);
      const sp = seatWorldPos(m.drive, 0);
      s.x = sp.x;
      s.y = sp.y;
      s.z = sp.z;
    }
    if (serverDriven(s.mode)) {
      s.yaw = cmd.yaw;
      s.pitch = cmd.pitch;
      s.prevButtons = cmd.buttons;
      return;
    }
    const ev: SimEvent[] = [];
    stepSim(s, cmd, INPUT_DT, { world: this.world, playerId: m.you, canAttack: m.phase === 'bus' || m.phase === 'play', pads: m.pads }, ev);
    for (const e of ev) this.localEvent(m, e);
    // recoil recovers toward zero
    m.recoil *= Math.exp(-INPUT_DT * 7);
    // footsteps
    const sp = Math.hypot(s.vx, s.vz);
    if (s.mode === Mode.Walk && s.grounded && sp > 1.5) {
      m.stepT -= INPUT_DT * sp;
      if (m.stepT <= 0) {
        m.stepT = s.sprint ? 2.9 : 2.4;
        this.audio.footstep(null, this.surfaceAt(s.x, s.y, s.z), s.crouch ? 0.4 : 1);
      }
    }
  }

  private surfaceAt(x: number, y: number, z: number): 'grass' | 'wood' | 'stone' | 'metal' | 'sand' | 'snow' | 'water' {
    if (y < WATER_LEVEL + 0.2) return 'water';
    const g = this.world.groundAt(x, z, y + 0.1, 0.3);
    const th = this.terrain.heightAt(x, z);
    if (g !== NO_GROUND && Math.abs(g - th) > 0.05) {
      const list = this.world.queryXZ(x - 0.3, z - 0.3, x + 0.3, z + 0.3);
      for (const c of list) if (c.ownerKind === OwnerKind.Piece && Math.abs(c.maxY - y) < 0.4) {
        const p = this.grid.get(c.ownerId);
        const h = p ? MATERIALS[p.mat].harvest ?? MATERIALS[p.mat].id : 'timber';
        return h === 'stone' ? 'stone' : h === 'alloy' ? 'metal' : 'wood';
      }
      return 'stone';
    }
    const b = biomeAt(x, z);
    if (th < 2.2 || b === 'desert') return 'sand';
    if (b === 'mountain' && th > 50) return 'snow';
    if (b === 'city' || b === 'industrial' || b === 'facility') return 'stone';
    return 'grass';
  }

  private aimOrigin(s: SimState) {
    const r = rightFromYaw(this.view.yaw);
    return { x: s.x + r.x * SHOULDER_RIGHT, y: s.y + eyeHeight(s) + SHOULDER_UP, z: s.z + r.z * SHOULDER_RIGHT };
  }

  private localEvent(m: MatchState, e: SimEvent) {
    const s = m.sim;
    switch (e.t) {
      case 'shot': {
        const def = ITEM_BY_CODE[e.code];
        const w = def.weapon!;
        const o = new THREE.Vector3(e.ox, e.oy - 0.15, e.oz);
        const f = forwardFromYawPitch(s.yaw, s.pitch);
        const muzzle = o.clone().add(new THREE.Vector3(f.x * 0.9, f.y * 0.9, f.z * 0.9));
        this.fx.muzzle(muzzle, w.cls === 'shotgun' || w.cls === 'sniper');
        if (w.ballistic) {
          // predicted bullet: starts at the true firing origin so its path matches the server's
          for (let k = 0; k < e.dirs.length; k += 3) {
            const sp = w.ballistic.speed;
            this.projectiles.spawnLocal(new THREE.Vector3(e.ox, e.oy, e.oz), new THREE.Vector3(e.dirs[k] * sp, e.dirs[k + 1] * sp, e.dirs[k + 2] * sp), w.ballistic.gravity, w.range);
          }
        }
        for (let k = 0; !w.ballistic && k < e.dirs.length; k += 3) {
          const dx = e.dirs[k], dy = e.dirs[k + 1], dz = e.dirs[k + 2];
          const hit = this.world.raycast(e.ox, e.oy, e.oz, dx, dy, dz, Math.min(w.range, 300));
          // stop tracers at remote players too (visual only; damage is server-side)
          let t = hit ? hit.t : Math.min(w.range, 300);
          for (const r of m.remotes.values()) {
            const vx = r.pos.x - e.ox, vy = r.pos.y + 1 - e.oy, vz = r.pos.z - e.oz;
            const along = vx * dx + vy * dy + vz * dz;
            if (along <= 0 || along > t) continue;
            const px = vx - dx * along, py = vy - dy * along, pz = vz - dz * along;
            if (px * px + pz * pz < 0.3 && Math.abs(py) < 1) t = along;
          }
          const end = new THREE.Vector3(e.ox + dx * t, e.oy + dy * t, e.oz + dz * t);
          this.fx.tracer(muzzle, end, w.cls === 'sniper' ? 0xfff2c0 : 0xffd98a, w.cls === 'sniper' ? 0.25 : 0.07);
          if (hit && hit.t <= t + 0.01) {
            this.fx.burst(end.x, end.y, end.z, 3, 0xfff0b0, 3, 0.2, 0.08);
            if (hit.collider && hit.collider.ownerKind === OwnerKind.Piece) this.pieces.flash(hit.collider.ownerId);
          }
        }
        this.audio.shot(w.cls, null, true);
        const kick = (w.recoil * Math.PI) / 180;
        m.recoil += kick * (0.7 + Math.random() * 0.5) * (s.ads ? 0.7 : 1);
        this.view.yaw += (Math.random() - 0.5) * kick * 0.4;
        m.shake = Math.min(0.4, m.shake + kick * 2);
        m.model.triggerFire();
        break;
      }
      case 'rocket':
        this.fx.muzzle(new THREE.Vector3(e.ox, e.oy, e.oz), true);
        this.audio.shot('explosive', null, true);
        m.recoil += 0.05;
        break;
      case 'melee': {
        m.model.triggerSwing();
        this.audio.shot('melee', null, true);
        const hit = this.world.raycast(e.ox, e.oy, e.oz, e.dx, e.dy, e.dz, 2.8);
        if (hit?.collider) {
          const kind = hit.collider.ownerKind === OwnerKind.Prop ? PROP_TYPES[this.map.props[hit.collider.ownerId].t].harvest : hit.collider.ownerKind === OwnerKind.Piece ? MATERIALS[this.grid.get(hit.collider.ownerId)?.mat ?? 0].harvest : null;
          this.audio.harvest(null, kind === 'stone' ? 'stone' : kind === 'alloy' ? 'metal' : 'wood');
          this.fx.burst(hit.x, hit.y, hit.z, 6, kind === 'stone' ? 0xaab2bd : kind === 'alloy' ? 0xd0e0ff : 0xc8904f, 3, 0.4, 0.12);
          if (hit.collider.ownerKind === OwnerKind.Piece) this.pieces.flash(hit.collider.ownerId);
        }
        break;
      }
      case 'throw':
        this.audio.whoosh(null);
        m.model.triggerSwing();
        break;
      case 'utility':
        this.audio.build(null, 2);
        break;
      case 'used':
        this.audio.heal(true);
        break;
      case 'land':
        this.audio.land(null, e.speed > 12);
        if (e.speed > 10) m.shake = Math.min(0.6, m.shake + e.speed / 60);
        break;
      case 'jump':
        this.audio.jump(null);
        break;
      case 'deploy':
      case 'launch':
        this.audio.whoosh(null);
        break;
      case 'reload':
        this.audio.reload(null);
        break;
      case 'mantle':
        this.audio.jump(null);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ remotes
  private updateRemotes(m: MatchState, dt: number) {
    const rt = this.serverNow() - INTERP_DELAY;
    const cam = this.camera.position;
    const w = window.innerWidth, h = window.innerHeight;
    const v = new THREE.Vector3();
    for (const r of m.remotes.values()) {
      const buf = r.buf;
      let a = buf[0], b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= rt && buf[i + 1].t >= rt) {
          a = buf[i];
          b = buf[i + 1];
          break;
        }
      }
      let k = b.t > a.t ? (rt - a.t) / (b.t - a.t) : 1;
      k = Math.max(0, Math.min(1.2, k));
      const ea = a.e, eb = b.e;
      const tele = Math.hypot(eb.x - ea.x, eb.z - ea.z) > 20;
      if (tele) k = 1;
      r.pos.set(ea.x + (eb.x - ea.x) * k, ea.y + (eb.y - ea.y) * k, ea.z + (eb.z - ea.z) * k);
      r.yaw = ea.yaw + wrapAngle(eb.yaw - ea.yaw) * k;
      r.pitch = ea.pitch + (eb.pitch - ea.pitch) * k;
      const e = k >= 0.5 ? eb : ea;
      const model = r.model;
      model.root.visible = e.mode !== Mode.Bus && e.mode !== Mode.Dead;
      model.root.position.copy(r.pos);
      model.root.rotation.y = r.yaw;
      const dist = cam.distanceTo(r.pos);
      model.setLod(dist > 140);
      model.update(dt, {
        mode: e.mode, speed: e.speed, grounded: !!(e.flags & EF_GROUNDED), crouch: !!(e.flags & EF_CROUCH), sprint: !!(e.flags & EF_SPRINT),
        ads: !!(e.flags & EF_ADS), slide: !!(e.flags & EF_SLIDE), reload: !!(e.flags & EF_RELOAD), using: !!(e.flags & EF_USING),
        building: !!(e.flags & EF_BUILDING), vy: e.vy, pitch: r.pitch, emote: e.emote, item: e.item, rarity: e.rarity,
      }, this.clock);
      // footsteps
      if (e.mode === Mode.Walk && (e.flags & EF_GROUNDED) && e.speed > 1.5 && dist < 45) {
        r.stepT -= dt * e.speed;
        if (r.stepT <= 0) {
          r.stepT = e.flags & EF_SPRINT ? 2.9 : 2.4;
          if (!(e.flags & EF_CROUCH)) this.audio.footstep(r.pos, this.surfaceAt(r.pos.x, r.pos.y, r.pos.z));
        }
      }
      // skydive trails (cosmetic)
      if ((e.mode === Mode.Skydive || e.mode === Mode.Glide) && r.info.cos.trail !== 'trail_none' && dist < 200) {
        this.fx.trail(r.pos.x, r.pos.y + 1, r.pos.z, trailColor(r.info.cos.trail));
      }
      // teammate name tags
      if (r.tag) {
        v.set(r.pos.x, r.pos.y + 2.3, r.pos.z).project(this.camera);
        const vis = v.z < 1 && model.root.visible;
        r.tag.style.display = vis ? '' : 'none';
        if (vis) {
          r.tag.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%,-100%)`;
          const html = `${escapeHtml(r.info.name)}${e.mode === Mode.Downed ? ' <span style="color:#ff6b6b">DOWN</span>' : ''}<div class="hp"><div style="width:${Math.min(100, e.hp)}%;background:${e.mode === Mode.Downed ? '#ff4d4d' : ''}"></div></div>`;
          if (r.tag.innerHTML !== html) r.tag.innerHTML = html;
        }
      }
    }
    // pings
    m.pings = m.pings.filter((p) => {
      if (this.clock > p.until) {
        p.el.remove();
        return false;
      }
      v.set(p.x, p.y + 1, p.z).project(this.camera);
      p.el.style.display = v.z < 1 ? '' : 'none';
      p.el.style.left = `${((v.x + 1) / 2) * w}px`;
      p.el.style.top = `${((1 - v.y) / 2) * h}px`;
      return true;
    });
  }

  // ------------------------------------------------------------------ interaction
  private updateInteract(m: MatchState) {
    const s = m.sim;
    m.target = null;
    if (m.eliminated || this.hud.inventoryOpen) {
      this.hud.prompt(null);
      return;
    }
    if (s.mode === Mode.Vehicle) {
      this.hud.prompt(this.touchMode ? null : `<span class="k">${this.keyLabel('exit')}</span> Exit vehicle`);
      return;
    }
    if (s.mode !== Mode.Walk && s.mode !== Mode.Swim) {
      this.hud.prompt(null);
      return;
    }
    const f = forwardFromYawPitch(this.view.yaw, 0);
    const K = this.keyLabel('use');
    let best: MatchState['target'] = null;
    let bestScore = -1e9;
    let label = '';
    const consider = (kind: NonNullable<MatchState['target']>['kind'], id: number, x: number, y: number, z: number, range: number, prio: number, text: string) => {
      const dx = x - s.x, dz = z - s.z;
      const d = Math.hypot(dx, y - (s.y + 0.4), dz);
      if (d > range) return;
      const dot = d > 0.01 ? (dx * f.x + dz * f.z) / Math.hypot(dx, dz) : 1;
      const score = prio * 10 + dot * 2 - d * 0.3;
      if (score > bestScore && (kind === 'revive' || kind === 'vehicle' || kind === 'spire' || this.hasLOS(s, x, y, z))) {
        bestScore = score;
        best = { kind, id };
        label = text;
      }
    };
    // auto-pickup ammo/materials when walking over them
    for (const it of m.itemInfo.values()) {
      const d = Math.hypot(it.x - s.x, it.z - s.z);
      if (d > PICKUP_RANGE + 0.5 || Math.abs(it.y - s.y) > 2.5) continue;
      const def = ITEM_BY_CODE[it.code];
      if ((def.category === 'ammo' || def.category === 'material') && d < 1.6) {
        const cd = m.pickupCd.get(it.id) ?? 0;
        if (this.clock > cd) {
          m.pickupCd.set(it.id, this.clock + 1.0);
          const full = def.category === 'ammo' ? s.inv.ammo[ammoIndex(def.ammoType!)] >= 300 : s.inv.mats[['timber', 'stone', 'alloy'].indexOf(def.material!)] >= 500;
          if (!full) {
            this.net.send({ t: 'act', a: { a: 'pickup', id: it.id } });
            this.audio.pickup();
          }
        }
        continue;
      }
      if (def.category === 'special') {
        if (it.owner === m.you) continue;
        const o = m.players.get(it.owner ?? -1);
        if (!o || o.team !== m.team) continue;
        consider('item', it.id, it.x, it.y, it.z, PICKUP_RANGE, 3, `<span class="k">${K}</span> Pick up <span class="rn" style="color:var(--cyan)">${escapeHtml(o.name)}'s Rebirth Chip</span>`);
        continue;
      }
      const r = RARITIES[it.rarity];
      const cnt = it.count > 1 ? ` ×${it.count}` : '';
      consider('item', it.id, it.x, it.y + 0.3, it.z, PICKUP_RANGE + 0.3, 2, `<span class="k">${K}</span> Pick up <span class="rn" style="color:${r.color}">${escapeHtml(stackName(it))}${cnt}</span>`);
    }
    for (const c of this.loot.containers.values()) {
      if (c.info.open) continue;
      if (c.info.kind === 'supply' && (c.info.land ?? 0) > this.serverNow()) continue;
      const name = c.info.kind === 'chest' ? 'Open Cache' : c.info.kind === 'ammo' ? 'Open Ammo Crate' : 'Open Supply Drop';
      consider(c.info.kind, c.info.id, c.info.x, c.info.y + 0.4, c.info.z, INTERACT_RANGE + 0.5, 3, `<span class="k">${K}</span> Hold · ${name}`);
    }
    for (const r of m.remotes.values()) {
      if (r.info.team === m.team && r.cur.mode === Mode.Downed) consider('revive', r.id, r.pos.x, r.pos.y, r.pos.z, 2.6, 5, `<span class="k">${K}</span> Hold · Revive ${escapeHtml(r.info.name)}`);
    }
    if (m.chips.length && m.storm.phase < MATCH_DEFAULTS.rebirthWindowPhase) {
      this.map.spires.forEach((sp, i) => consider('spire', i + 1, sp.x, sp.y + 1, sp.z, 4.5, 4, `<span class="k">${K}</span> Hold · Rebirth teammates (${m.chips.length})`));
    }
    for (const [id, v] of m.vehicles) consider('vehicle', id, v.x, v.y + 0.5, v.z, 4.5, 1, `<span class="k">${K}</span> Enter Dune Rover`);
    m.target = best;
    const tk = (best as MatchState['target'])?.kind;
    this.touch?.setUse(m.channel ? 'HOLD' : !tk ? null : tk === 'item' ? 'PICK UP' : tk === 'revive' ? 'REVIVE' : tk === 'spire' ? 'REBIRTH' : tk === 'vehicle' ? 'DRIVE' : 'OPEN');
    let html = best ? label : null;
    if (m.channel) {
      const k = (this.clock - m.channel.t0) / m.channel.dur;
      this.hud.channel(Math.min(1, k));
      html = null;
    } else this.hud.channel(null);
    this.hud.prompt(html);
  }

  private hasLOS(s: SimState, x: number, y: number, z: number) {
    const ox = s.x, oy = s.y + 1.2, oz = s.z;
    const dx = x - ox, dy = y - oy, dz = z - oz;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.9) return true;
    return !this.world.raycast(ox, oy, oz, dx / d, dy / d, dz / d, d - 0.35, undefined, true);
  }

  private useTarget(m: MatchState) {
    const t = m.target;
    if (!t) return;
    const act = (a: object) => this.net.send({ t: 'act', a });
    switch (t.kind) {
      case 'item':
        act({ a: 'pickup', id: t.id });
        this.audio.pickup();
        break;
      case 'chest':
      case 'ammo':
      case 'supply':
        act({ a: 'interact', kind: t.kind, id: t.id });
        break;
      case 'revive':
      case 'spire':
      case 'vehicle':
        act({ a: 'interact', kind: t.kind, id: t.id });
        break;
    }
  }

  // ------------------------------------------------------------------ building
  private updateBuild(m: MatchState) {
    const s = m.sim;
    // players who already jumped from the transport and landed may build (the server allows it too)
    const canBuild = m.buildMode && !m.eliminated && s.mode === Mode.Walk && m.phase !== 'ended';
    if (!canBuild) {
      this.pieces.setGhost(null, false);
      if (m.buildMode && s.mode !== Mode.Walk && s.mode !== Mode.Mantle) m.buildMode = false;
      if (m.eliminated) m.buildMode = false;
      return;
    }
    const spec = buildTarget(m.piece, s.x, s.y, s.z, this.view.yaw, this.view.pitch, this.grid);
    const eyeY = s.y + eyeHeight(s);
    const valid = this.grid.canPlace(spec, this.terrain).ok && s.inv.mats[m.mat] >= BUILD_COST && inBuildRange(spec, s.x, eyeY, s.z);
    this.pieces.setGhost(spec, valid);
    const firing = (this.input.held('fire') || this.queuedBuild) && !this.hud.inventoryOpen && !this.paused;
    this.queuedBuild = false;
    if (firing && valid && this.clock - m.lastBuildAt >= BUILD_INTERVAL) {
      m.lastBuildAt = this.clock;
      this.net.send({ t: 'act', a: { a: 'build', type: spec.type, i: spec.i, j: spec.j, k: spec.k, d: spec.d, mat: m.mat } });
      // predict locally so ramp-rushing feels instant
      const md = MATERIALS[m.mat];
      const id = -(++this.predId);
      const p: Piece = { ...spec, id, variant: 0, mat: m.mat, hp: md.maxHp * 0.1, maxHp: md.maxHp, owner: m.you, team: m.team, anchored: false, grounded: isPieceGrounded(spec, this.terrain), tint: 0, buildStart: this.serverNow(), buildTime: md.buildTime, colliderIds: [] };
      this.grid.add(p);
      this.pieces.add(p, this.serverNow());
      m.predicted.set(slotKey(spec), { id, t: this.clock });
      this.audio.build(null, m.mat);
    }
    // expire unconfirmed predictions
    for (const [k, v] of m.predicted) {
      if (this.clock - v.t > 1.5) {
        this.grid.remove(v.id);
        this.pieces.remove(v.id);
        m.predicted.delete(k);
      }
    }
  }
  private predId = 0;
  private queuedBuild = false;

  // ------------------------------------------------------------------ camera
  private updateCamera(m: MatchState, dt: number) {
    const s = m.sim;
    const alpha = this.acc / INPUT_DT;
    const px = m.prev.x + (s.x - m.prev.x) * alpha + m.offset.x;
    const py = m.prev.y + (s.y - m.prev.y) * alpha + m.offset.y;
    const pz = m.prev.z + (s.z - m.prev.z) * alpha + m.offset.z;
    // local model
    const model = m.model;
    const selfVisible = !m.eliminated && s.mode !== Mode.Bus && s.mode !== Mode.Dead;
    model.root.visible = selfVisible;
    model.root.position.set(px, py, pz);
    model.root.rotation.y = s.mode === Mode.Walk && Math.hypot(s.vx, s.vz) < 0.2 && !s.ads && !(this.input.held('fire')) ? model.root.rotation.y + wrapAngle(this.view.yaw - model.root.rotation.y) * Math.min(1, dt * 10) : this.view.yaw;
    const it = s.inv.slots[s.slot];
    model.update(dt, {
      mode: s.mode, speed: Math.hypot(s.vx, s.vz), grounded: s.grounded, crouch: s.crouch, sprint: s.sprint, ads: s.ads, slide: s.slideT > 0,
      reload: s.reloadT > 0, using: s.useT >= 0, building: m.buildMode, vy: s.vy, pitch: this.view.pitch, emote: s.emote,
      item: m.buildMode ? 254 : it ? it.code : 255, rarity: it ? it.rarity : 0,
    }, this.clock);
    const me = m.players.get(m.you);
    if ((s.mode === Mode.Skydive || s.mode === Mode.Glide) && me && me.cos.trail !== 'trail_none') this.fx.trail(px, py + 1, pz, trailColor(me.cos.trail));

    // camera target
    const cam = this.camera;
    const w = this.currentWeapon(m);
    let fov = this.settings.fov;
    const yaw = this.view.yaw, pitch = this.view.pitch + m.recoil;
    const f = forwardFromYawPitch(yaw, pitch);
    let pivot: THREE.Vector3;
    let dist = 3.3;
    let side = SHOULDER_RIGHT;
    if (m.eliminated) {
      const r = m.remotes.get(m.spectating);
      pivot = r ? r.pos.clone().add(new THREE.Vector3(0, 1.7, 0)) : new THREE.Vector3(px, py + 30, pz);
      dist = r ? 5 : 30;
      side = 0;
    } else if (s.mode === Mode.Bus && m.busPos) {
      pivot = new THREE.Vector3(m.busPos.x, m.busPos.y + 6, m.busPos.z);
      dist = 42;
      side = 0;
    } else if (s.mode === Mode.Skydive || s.mode === Mode.Glide) {
      pivot = new THREE.Vector3(px, py + (s.mode === Mode.Glide ? 3.4 : 1.8), pz);
      dist = s.mode === Mode.Glide ? 8.5 : 7;
      side = 0;
    } else if (s.mode === Mode.Vehicle) {
      pivot = new THREE.Vector3(px, py + 2, pz);
      dist = 8;
      side = 0;
    } else {
      const rgt = rightFromYaw(yaw);
      pivot = new THREE.Vector3(px + rgt.x * SHOULDER_RIGHT, py + eyeHeight(s) + SHOULDER_UP, pz + rgt.z * SHOULDER_RIGHT);
      if (s.ads && w) {
        dist = w.cls === 'sniper' ? 0.4 : 1.6;
        fov = this.settings.fov / w.zoom;
      } else if (m.buildMode) dist = 3.8;
      if (s.sprint) fov += 6;
      side = SHOULDER_RIGHT;
    }
    // camera collision
    let d = dist;
    const hit = this.world.raycast(pivot.x, pivot.y, pivot.z, -f.x, -f.y, -f.z, dist + 0.3);
    if (hit) d = Math.max(0.3, hit.t - 0.3);
    // when a wall pushes the camera into the player's head, hide the local model instead of clipping
    if (d < 1.1 && !m.eliminated && !(s.ads && w && w.cls === 'sniper')) model.root.visible = false;
    const target = new THREE.Vector3(pivot.x - f.x * d, pivot.y - f.y * d, pivot.z - f.z * d);
    // keep camera above water/terrain
    const th = this.terrain.heightAt(target.x, target.z);
    if (th !== NO_GROUND && target.y < th + 0.4) target.y = th + 0.4;
    this.cameraPos.copy(target);
    // shake
    m.shake = Math.max(0, m.shake - dt * 1.8);
    const sh = m.shake * m.shake * 0.25;
    cam.position.set(target.x + (Math.random() - 0.5) * sh, target.y + (Math.random() - 0.5) * sh, target.z + (Math.random() - 0.5) * sh);
    cam.lookAt(cam.position.x + f.x, cam.position.y + f.y, cam.position.z + f.z);
    this.fovNow += (fov - this.fovNow) * Math.min(1, dt * 14);
    if (Math.abs(cam.fov - this.fovNow) > 0.01) {
      cam.fov = this.fovNow;
      cam.updateProjectionMatrix();
    }
  }

  // ------------------------------------------------------------------ HUD
  private updateHud(m: MatchState, dt: number) {
    const s = m.sim;
    const spec = m.eliminated ? m.remotes.get(m.spectating) : undefined;
    if (spec) this.hud.setVitals(spec.cur.hp, spec.cur.shield, spec.cur.mode === Mode.Downed);
    else this.hud.setVitals(s.mode === Mode.Downed ? s.hp : s.hp, s.shield, s.mode === Mode.Downed);
    this.hud.setMats(s.inv.mats, m.mat, m.buildMode);
    this.hud.setHotbar(s.inv.slots, m.slotReq !== SLOT_KEEP ? m.slotReq : s.slot, m.buildMode);
    const it = s.inv.slots[s.slot];
    const w = it ? ITEM_BY_CODE[it.code].weapon : undefined;
    const reserve = w?.ammo ? s.inv.ammo[AMMO_TYPES.indexOf(w.ammo)] : 0;
    const reloadK = s.reloadT > 0 && w ? 1 - s.reloadT / w.reload : 0;
    const useDef = it ? ITEM_BY_CODE[it.code].use : undefined;
    this.hud.setWeapon(m.buildMode || m.eliminated ? null : it ?? null, reserve, reloadK, s.useT >= 0 && useDef ? s.useT / useDef.time : -1);
    let tgt = '';
    if (m.buildMode) tgt = ['Timber', 'Stone', 'Alloy'][m.mat];
    this.hud.setBuild(m.buildMode && !m.eliminated, m.piece, tgt);
    this.hud.setStats(m.alive, m.kills);
    // storm
    const now = this.serverNow();
    const st = m.storm;
    const circ = stormCircleAt(st, now);
    const viewPos = spec ? spec.pos : new THREE.Vector3(s.x, s.y, s.z);
    const inStorm = isInStorm(st, now, viewPos.x, viewPos.z);
    if (m.phase === 'lobby') this.hud.setStorm('Skywhale departs in', fmtTime(m.phaseEnd - now), false);
    else if (m.phase === 'bus') {
      const doors = m.bus ? m.bus.t0 + MATCH_DEFAULTS.busDoorsOpen - now : 0;
      const jumpHint = this.touchMode ? 'Tap DROP to jump' : `Press ${this.keyLabel('jump')} to jump`;
      this.hud.setStorm(doors > 0 ? 'Doors open in' : s.mode === Mode.Bus ? jumpHint : 'Everyone out in', fmtTime(doors > 0 ? doors : (m.bus?.t1 ?? now) - now), false);
    } else if (st.stage === 'wait' || st.stage === 'shrink') {
      const dSafe = distanceToSafety({ ...st, stage: 'done', to: st.to } as StormState, now, viewPos.x, viewPos.z);
      const t = st.stage === 'wait' ? `Surge closes in · phase ${st.phase + 1}` : 'Surge closing!';
      this.hud.setStorm(t, `${fmtTime(st.t1 - now)}${dSafe > 0 ? ` · ${Math.round(dSafe)}m to safety` : ' · safe'}`, inStorm);
    } else if (st.stage === 'done') this.hud.setStorm('Final circle', inStorm ? 'IN THE SURGE' : '', inStorm);
    else this.hud.setStorm('', '', false);
    this.env.setStorm(circ.x, circ.z, circ.r, st.stage === 'wait' ? st.to : null, inStorm);
    this.hud.stormTint(inStorm ? 1 : 0);
    // team
    if (m.mode !== 'solo') {
      const rows: TeamRow[] = [];
      let ci = 0;
      for (const p of m.players.values()) {
        if (p.team !== m.team) continue;
        const color = TEAM_COLORS[ci++ % 4];
        if (p.id === m.you) rows.push({ name: p.name, hp: s.hp, shield: s.shield, down: s.mode === Mode.Downed, dead: m.eliminated, color, me: true });
        else {
          const r = m.remotes.get(p.id);
          rows.push({ name: p.name, hp: r ? r.cur.hp : 0, shield: r ? r.cur.shield : 0, down: r?.cur.mode === Mode.Downed, dead: !r, color, me: false });
        }
      }
      this.hud.setTeam(rows);
    }
    // crosshair
    const showCross = !m.eliminated && (s.mode === Mode.Walk) && !this.hud.inventoryOpen;
    let spread = 2;
    if (w && !m.buildMode) spread = spreadDegrees(s, w, it!.rarity);
    const px = (spread / this.camera.fov) * window.innerHeight * 0.5;
    this.hud.crosshair(px, showCross, !!(s.ads && w && w.cls === 'sniper' && w.zoom > 3));
    this.hud.spectate(m.eliminated && spec ? spec.info.name : null);
    this.hud.root.classList.toggle('spec', m.eliminated);
    if (this.settings.showFps) this.hud.fps(`${this.fpsAcc.fps.toFixed(0)} fps · ${this.net.rtt.toFixed(0)} ms · ${m.pending.length} pending`);
    else this.hud.fps(null);
    // minimap (10 Hz)
    this.mapT -= dt;
    if (this.mapT <= 0) {
      this.mapT = 0.1;
      const mates: { x: number; z: number; color: string; name: string; down: boolean }[] = [];
      let ci = 0;
      for (const p of m.players.values()) {
        if (p.team !== m.team) continue;
        const color = TEAM_COLORS[ci++ % 4];
        if (p.id === m.you) continue;
        const r = m.remotes.get(p.id);
        if (r) mates.push({ x: r.pos.x, z: r.pos.z, color, name: p.name, down: r.cur.mode === Mode.Downed });
      }
      const supplies = [...this.loot.containers.values()].filter((c) => c.info.kind === 'supply' && !c.info.open).map((c) => ({ x: c.info.x, z: c.info.z }));
      this.hud.drawMinimap({
        me: { x: viewPos.x, z: viewPos.z, yaw: spec ? spec.yaw : this.view.yaw },
        mates, storm: st.stage === 'idle' ? null : circ, next: st.stage === 'wait' ? st.to : null,
        pings: m.pings.map((p) => ({ x: p.x, z: p.z, color: p.color })), supplies,
        bus: m.phase === 'bus' && m.bus && m.busPos ? { ...m.bus, px: m.busPos.x, pz: m.busPos.z } : null,
      }, this.clock);
    }
    // landing hint while skydiving
    if (s.mode === Mode.Skydive || s.mode === Mode.Glide) {
      const np = nearestPoi(s.x, s.z);
      this.hud.banner(null);
      if (np.dist < np.poi.r + 40) this.hud.setStorm(np.poi.name.toUpperCase(), `${Math.round(s.y - Math.max(0, this.terrain.surfaceAt(s.x, s.z)))}m`, false);
    }
  }

  // ------------------------------------------------------------------ audio mix
  private updateAudio(m: MatchState, dt: number) {
    const cam = this.camera.position;
    const f = new THREE.Vector3();
    this.camera.getWorldDirection(f);
    this.audio.setListener(cam, f.x, f.z);
    if (!this.audio.ctx) return;
    this.audio.ensureAmbience();
    const s = m.sim;
    const air = s.mode === Mode.Skydive ? 1 : s.mode === Mode.Glide ? 0.6 : s.mode === Mode.Bus ? 0.5 : Math.min(0.35, Math.max(0.08, (cam.y - 20) / 200));
    this.audio.setLoop('wind', air * 0.5);
    const now = this.serverNow();
    const c = stormCircleAt(m.storm, now);
    const dEdge = Math.abs(Math.hypot(cam.x - c.x, cam.z - c.z) - c.r);
    const inStorm = isInStorm(m.storm, now, cam.x, cam.z);
    this.audio.setLoop('storm', m.storm.stage === 'idle' ? 0 : inStorm ? 0.9 : Math.max(0, 1 - dEdge / 90) * 0.6);
    const coast = Math.max(0, Math.min(1, (Math.hypot(cam.x, cam.z) - 420) / 150));
    this.audio.setLoop('ocean', coast * 0.5);
    const b = biomeAt(cam.x, cam.z);
    if (s.mode === Mode.Walk && (b === 'forest' || b === 'plains' || b === 'town')) this.audio.birds(0.8);
    if (s.mode === Mode.Bus) {
      this.audio.busDrone();
      this.audio.setLoop('bus', 0.35);
    } else this.audio.setLoop('bus', 0);
    // nearest chest hums
    const chests = [...this.loot.containers.values()].filter((x) => x.info.kind === 'chest' && !x.info.open).map((x) => ({ x, d: Math.hypot(x.info.x - cam.x, x.info.z - cam.z) })).sort((a, b2) => a.d - b2.d).slice(0, 3);
    for (let i = 0; i < 3; i++) {
      const key = `chest${i}`;
      const ch = chests[i];
      if (ch && ch.d < 22) {
        this.audio.chestHum(key, ch.x.info);
        this.audio.setLoop(key, 0.18 * (1 - ch.d / 22), ch.x.info);
      } else if (this.audio.hasLoop(key)) this.audio.setLoop(key, 0);
    }
    const vs = [...m.vehicles.entries()].map(([id, v]) => ({ id, v, d: Math.hypot(v.x - cam.x, v.z - cam.z) })).sort((a, b2) => a.d - b2.d).slice(0, 3);
    for (let i = 0; i < 3; i++) {
      const key = `veh${i}`;
      const v = vs[i];
      if (v && v.d < 70) {
        this.audio.engineLoop(key, v.v);
        const sp = Math.abs(v.v.speed);
        this.audio.setLoop(key, sp > 0.5 ? 0.25 : 0.05, v.v, 1 + sp / 14);
      } else if (this.audio.hasLoop(key)) this.audio.setLoop(key, 0);
    }
  }
}

function serverDriven(mode: Mode) {
  return mode === Mode.Bus || mode === Mode.Vehicle || mode === Mode.Dead;
}

function trailColor(id: string) {
  switch (id) {
    case 'sparkle': return 0xfff3a0;
    case 'bubbles': return 0x9fe8ff;
    case 'leaves': return 0x7fcf4a;
    case 'flames': return 0xff7a2e;
    case 'rainbow': return [0xff4d4d, 0xffd23f, 0x58d36a, 0x3fa3ff, 0xbd6bff][Math.floor(performance.now() / 80) % 5];
    default: return 0xffffff;
  }
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

