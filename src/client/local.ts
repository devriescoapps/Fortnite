// Offline play: the authoritative server (matchmaker, matches, bots, profiles) runs inside the
// browser and talks to the game over an in-memory link instead of a WebSocket. Used when the game
// is hosted as static files (itch.io, GitHub Pages, Netlify...) or opened without a server.
//
// Client -> server messages are applied synchronously (preserving the exact ordering of actions
// and inputs that a WebSocket guarantees); server -> client messages are queued and delivered in a
// microtask so the game never re-enters its own handlers.
import { ByteReader, ByteWriter } from '../shared/binary';
import { MATCH_DEFAULTS } from '../shared/constants';
import type { MapData } from '../shared/mapdata';
import { MSG_SNAPSHOT, Snapshot, decodeSnapshot, encodeInputs } from '../shared/protocol';
import type { InputCmd } from '../shared/sim';
import type { Terrain } from '../shared/terrain';
import type { ServerConfig } from '../server/config';
import { Gateway, Session, startLoop } from '../server/gateway';
import { Matchmaker } from '../server/matchmaker';
import { ProfileBackend, ProfileStore } from '../server/profiles';
import type { MsgHandler, NetLike } from './net';

const PROFILE_KEY = 'surgefall.offline.profiles.v1';

function localStorageBackend(): ProfileBackend {
  return {
    load: () => {
      try {
        return localStorage.getItem(PROFILE_KEY);
      } catch {
        return null;
      }
    },
    save: (json) => {
      try {
        localStorage.setItem(PROFILE_KEY, json);
      } catch {
        /* storage full / blocked: progress lasts for this session only */
      }
    },
  };
}

export interface LocalOptions {
  maxPlayers?: number;
  devCommands?: boolean;
  lobbyTime?: number;
}

export class LocalNet implements NetLike {
  onMessage: MsgHandler = () => {};
  onSnapshot: (s: Snapshot) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  connected = false;
  readonly rtt = 0;
  private gateway: Gateway;
  private profiles: ProfileStore;
  private session: Session | null = null;
  private writer = new ByteWriter(512);
  private outbox: (unknown | Uint8Array)[] = [];
  private flushing = false;
  private stopLoop: (() => void) | null = null;

  constructor(island: { terrain: Terrain; map: MapData }, opts: LocalOptions = {}) {
    const cfg: ServerConfig = {
      port: 0,
      dataDir: '',
      maxPlayers: opts.maxPlayers ?? MATCH_DEFAULTS.maxPlayers,
      lobbyTime: opts.lobbyTime ?? 12, // nobody else to wait for
      queueWait: 0,
      stormScale: 1,
      botSkill: 0.45,
      fillBots: true,
      maxMatches: 1,
      devCommands: !!opts.devCommands,
    };
    this.profiles = new ProfileStore(localStorageBackend(), 800);
    const mm = new Matchmaker(cfg, island, this.profiles);
    this.gateway = new Gateway(cfg, mm, this.profiles);
    this.stopLoop = startLoop(() => mm.tick());
    // save progress when the page goes away
    addEventListener('pagehide', () => this.profiles.flush());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.profiles.flush();
    });
  }

  connect() {
    if (this.session) return;
    const self = this;
    this.session = this.gateway.connect({
      get open() {
        return self.connected;
      },
      send: (msg) => this.post(msg),
      sendBin: (data) => this.post(data.slice()), // the server reuses its encode buffer
    });
    this.connected = true;
    queueMicrotask(() => this.onOpen());
  }

  private post(m: unknown) {
    this.outbox.push(m);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      const list = this.outbox;
      this.outbox = [];
      for (const x of list) {
        if (x instanceof Uint8Array) {
          const r = new ByteReader(x);
          if (r.u8() === MSG_SNAPSHOT) this.onSnapshot(decodeSnapshot(r));
        } else {
          const msg = x as { t?: string };
          if (msg.t === 'pong') continue;
          // JSON round-trip: the client must never share object references with the server
          this.onMessage(JSON.parse(JSON.stringify(msg)));
        }
      }
    });
  }

  send(msg: unknown) {
    if (!this.session) return;
    const m = msg as { t?: string };
    if (m.t === 'ping') return; // latency is zero
    this.session.text(JSON.parse(JSON.stringify(msg)));
  }

  sendInputs(list: InputCmd[]) {
    if (!this.session || !list.length) return;
    for (let i = 0; i < list.length; i += 30) {
      // same wire encoding as online so inputs are quantized identically
      this.session.binary(encodeInputs(this.writer, list.slice(i, i + 30)));
    }
  }

  stop() {
    this.stopLoop?.();
    this.profiles.flush();
    this.session?.closed();
    this.session = null;
    this.connected = false;
  }
}
