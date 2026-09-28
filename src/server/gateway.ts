// Transport-agnostic client sessions: message validation, rate limiting, profile/party/queue
// handling and input routing. The Node server wires it to WebSockets (main.ts); offline play
// wires the very same code to an in-memory link inside the browser (client/local.ts).
import { ByteReader } from '../shared/binary';
import { PROTOCOL_VERSION, TICK_RATE } from '../shared/constants';
import { MSG_INPUT, decodeInputs } from '../shared/protocol';
import type { ServerConfig } from './config';
import { Conn, Matchmaker } from './matchmaker';
import { ProfileStore, publicProfile, sanitizeName } from './profiles';

export interface Transport {
  readonly open: boolean;
  send(msg: unknown): void;
  sendBin(data: Uint8Array): void;
}

const MAX_MSGS_PER_SEC = 300;

export class Session {
  readonly conn: Conn;
  private lastInputSeq = 0;
  private msgCount = 0;
  private windowStart = Date.now();

  constructor(private gw: Gateway, t: Transport, id: number) {
    this.conn = {
      id, profile: null, profileId: null, state: 'menu', match: null, player: null, party: null, queueMode: null,
      get open() {
        return t.open;
      },
      send: (msg: unknown) => t.send(msg),
      sendBin: (data: Uint8Array) => t.sendBin(data),
    };
  }

  /** Flood protection; false means the transport should be closed. */
  private admit() {
    const now = Date.now();
    if (now - this.windowStart > 1000) {
      this.windowStart = now;
      this.msgCount = 0;
    }
    return ++this.msgCount <= MAX_MSGS_PER_SEC;
  }

  /** A binary frame (input batch). Returns false if the client must be disconnected. */
  binary(bytes: Uint8Array): boolean {
    if (!this.admit()) return false;
    const c = this.conn;
    const r = new ByteReader(bytes);
    if (r.u8() !== MSG_INPUT || !c.player || c.state !== 'match') return true;
    for (const cmd of decodeInputs(r)) {
      if (cmd.seq <= this.lastInputSeq) continue; // replayed / duplicate
      this.lastInputSeq = cmd.seq;
      c.player.queue.push({ kind: 'input', cmd });
    }
    return true;
  }

  /** A JSON control message (already parsed). Returns false if the client must be disconnected. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  text(msg: any): boolean {
    if (!this.admit()) return false;
    this.handle(msg);
    return true;
  }

  closed() {
    this.gw.mm.onDisconnect(this.conn);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handle(msg: any) {
    const c = this.conn;
    const { mm, profiles, cfg } = this.gw;
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'hello') {
      let p = profiles.get(msg.token);
      if (!p) p = profiles.create(msg.name);
      else if (msg.name && typeof msg.name === 'string' && sanitizeName(msg.name) !== p.name) p.name = sanitizeName(msg.name);
      profiles.rollChallenges(p);
      c.profile = p;
      c.profileId = p.id;
      c.send({ t: 'welcome', token: p.token, profile: publicProfile(p), version: PROTOCOL_VERSION, tickRate: TICK_RATE });
      const active = mm.findActive(p.id);
      if (active && (!active.p.link || !active.p.link.open)) {
        c.state = 'match';
        c.match = active.m;
        c.player = active.p;
        this.lastInputSeq = 0;
        active.m.reconnect(active.p, c);
        c.send({ t: 'msg', text: 'Reconnected to your match' });
      }
      return;
    }
    if (!c.profile) return;
    switch (msg.t) {
      case 'queue':
        if (c.state === 'menu') {
          this.lastInputSeq = 0;
          mm.enqueue(c, msg.mode);
        }
        break;
      case 'cancel':
        mm.cancel(c);
        break;
      case 'act':
        if (c.player && c.state === 'match' && msg.a && typeof msg.a === 'object') c.player.queue.push({ kind: 'action', act: msg.a });
        break;
      case 'leave':
        if (c.match && c.player) c.match.leave(c.player);
        c.state = 'menu';
        c.match = null;
        c.player = null;
        c.send({ t: 'profile', profile: publicProfile(c.profile) });
        break;
      case 'equip':
        profiles.equip(c.profile, msg.loadout ?? {});
        c.send({ t: 'profile', profile: publicProfile(c.profile) });
        break;
      case 'buy': {
        const err = profiles.buy(c.profile, String(msg.id));
        if (err) c.send({ t: 'error', text: err });
        c.send({ t: 'profile', profile: publicProfile(c.profile) });
        break;
      }
      case 'rename':
        c.profile.name = sanitizeName(msg.name);
        profiles.markDirty();
        c.send({ t: 'profile', profile: publicProfile(c.profile) });
        break;
      case 'profile':
        c.send({ t: 'profile', profile: publicProfile(c.profile) });
        break;
      case 'party.create':
        mm.createParty(c);
        break;
      case 'party.join':
        mm.joinParty(c, msg.code);
        break;
      case 'party.leave':
        mm.leaveParty(c);
        break;
      case 'ping':
        c.send({ t: 'pong', c: msg.c, s: Date.now() });
        break;
      case 'dev':
        if (cfg.devCommands && c.match && c.player) c.match.dev(c.player, msg);
        break;
    }
  }
}

export class Gateway {
  private nextId = 1;

  constructor(readonly cfg: ServerConfig, readonly mm: Matchmaker, readonly profiles: ProfileStore) {}

  connect(t: Transport) {
    return new Session(this, t, this.nextId++);
  }
}

/** Drift-corrected fixed-rate loop driving the matchmaker (and every match). */
export function startLoop(tick: () => void, schedule: (fn: () => void, ms: number) => unknown = setTimeout) {
  const TICK_MS = 1000 / TICK_RATE;
  let next = performance.now();
  let running = true;
  const loop = () => {
    if (!running) return;
    const now = performance.now();
    let n = 0;
    while (now >= next && n < 5) {
      tick();
      next += TICK_MS;
      n++;
    }
    if (now - next > 250) next = now; // fell far behind (e.g. a throttled background tab): skip ahead
    schedule(loop, Math.max(0, next - performance.now()));
  };
  loop();
  return () => {
    running = false;
  };
}
