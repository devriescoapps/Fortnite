// Matchmaking: per-mode queues, parties, late-join into lobbies, match creation and ticking.
import { Mode, TEAM_SIZE } from '../shared/constants';
import { publicProfile, Profile, ProfileStore } from './profiles';
import type { ServerConfig } from './config';
import { Island, JoinRequest, Match } from './match';
import type { ServerPlayer, ClientLink } from './player';

export interface Conn extends ClientLink {
  id: number;
  profile: Profile | null;
  state: 'menu' | 'queue' | 'match';
  match: Match | null;
  player: ServerPlayer | null;
  party: Party | null;
  queueMode: Mode | null;
}

export interface Party {
  code: string;
  leader: Conn;
  members: Conn[];
}

interface QueueEntry {
  conns: Conn[];
  mode: Mode;
  since: number;
}

const MODES: Mode[] = ['solo', 'duos', 'squads'];

export class Matchmaker {
  private queues = new Map<Mode, QueueEntry[]>(MODES.map((m) => [m, []]));
  readonly matches = new Set<Match>();
  private parties = new Map<string, Party>();

  constructor(private cfg: ServerConfig, private island: Island, private profiles: ProfileStore) {}

  // ---------------------------------------------------------------- parties
  createParty(c: Conn) {
    this.leaveParty(c);
    let code = '';
    do code = Math.random().toString(36).slice(2, 7).toUpperCase();
    while (this.parties.has(code));
    const p: Party = { code, leader: c, members: [c] };
    this.parties.set(code, p);
    c.party = p;
    this.notifyParty(p);
  }

  joinParty(c: Conn, code: string) {
    const p = this.parties.get(String(code).toUpperCase().trim());
    if (!p) return c.send({ t: 'error', text: 'Party not found' });
    if (p.members.length >= 4) return c.send({ t: 'error', text: 'Party is full' });
    if (p.leader.state !== 'menu') return c.send({ t: 'error', text: 'Party is already in a match' });
    this.leaveParty(c);
    p.members.push(c);
    c.party = p;
    this.notifyParty(p);
  }

  leaveParty(c: Conn) {
    const p = c.party;
    if (!p) return;
    p.members = p.members.filter((m) => m !== c);
    c.party = null;
    c.send({ t: 'party', party: null });
    if (!p.members.length) {
      this.parties.delete(p.code);
      return;
    }
    if (p.leader === c) p.leader = p.members[0];
    this.notifyParty(p);
  }

  private notifyParty(p: Party) {
    const info = { code: p.code, leader: p.leader.id, members: p.members.map((m) => ({ id: m.id, name: m.profile?.name ?? '?', level: m.profile?.level ?? 1 })) };
    for (const m of p.members) m.send({ t: 'party', party: info, you: m.id });
  }

  // ---------------------------------------------------------------- queue
  enqueue(c: Conn, mode: Mode) {
    if (!MODES.includes(mode)) return;
    let conns = [c];
    if (c.party) {
      if (c.party.leader !== c) return c.send({ t: 'error', text: 'Only the party leader can start matchmaking' });
      conns = c.party.members.filter((m) => m.open && m.state === 'menu');
      if (conns.length > TEAM_SIZE[mode]) return c.send({ t: 'error', text: `Party too large for ${mode}` });
    }
    if (conns.some((x) => x.state !== 'menu')) return;
    for (const x of conns) {
      x.state = 'queue';
      x.queueMode = mode;
      x.send({ t: 'queue', status: 'searching', mode });
    }
    this.queues.get(mode)!.push({ conns, mode, since: Date.now() });
  }

  cancel(c: Conn) {
    for (const q of this.queues.values()) {
      const i = q.findIndex((e) => e.conns.includes(c));
      if (i >= 0) {
        for (const x of q[i].conns) {
          x.state = 'menu';
          x.queueMode = null;
          x.send({ t: 'queue', status: 'cancelled' });
        }
        q.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------- matches
  private toJoin(c: Conn): JoinRequest {
    const p = c.profile!;
    return { link: c, profile: p, name: p.name, cos: p.loadout, level: p.level };
  }

  private place(entry: QueueEntry, m: Match) {
    const players = m.addParty(entry.conns.map((c) => this.toJoin(c)));
    entry.conns.forEach((c, i) => {
      c.state = 'match';
      c.match = m;
      c.player = players[i];
      c.queueMode = null;
    });
  }

  private createMatch(mode: Mode) {
    const m = new Match({ mode, cfg: this.cfg, island: this.island, profiles: this.profiles });
    m.onClose = (mm) => this.onMatchClosed(mm);
    this.matches.add(m);
    console.log(`[match ${m.id}] created (${mode}), ${this.matches.size} active`);
    return m;
  }

  private onMatchClosed(m: Match) {
    this.matches.delete(m);
    for (const p of m.players.values()) {
      const c = p.link as Conn | null;
      if (c && c.match === m) {
        c.state = 'menu';
        c.match = null;
        c.player = null;
        if (c.profile) c.send({ t: 'profile', profile: publicProfile(c.profile) });
      }
    }
    console.log(`[match ${m.id}] closed, ${this.matches.size} active`);
  }

  /** Find an in-progress match holding this profile's character (reconnect). */
  findActive(profileId: string) {
    for (const m of this.matches) {
      if (m.phase === 'ended') continue;
      const p = m.findByProfile(profileId);
      if (p && !p.eliminated && !p.leftMatch) return { m, p };
    }
    return null;
  }

  tick() {
    const now = Date.now();
    for (const [mode, q] of this.queues) {
      for (let i = 0; i < q.length; ) {
        const e = q[i];
        e.conns = e.conns.filter((c) => c.open);
        if (!e.conns.length) {
          q.splice(i, 1);
          continue;
        }
        let m = [...this.matches].find((mm) => mm.mode === mode && mm.canJoin(e.conns.length));
        if (!m && now - e.since >= this.cfg.queueWait * 1000 && this.matches.size < this.cfg.maxMatches) m = this.createMatch(mode);
        if (!m) {
          const waited = Math.floor((now - e.since) / 1000);
          if (waited !== (e as QueueEntry & { lastSent?: number }).lastSent) {
            (e as QueueEntry & { lastSent?: number }).lastSent = waited;
            for (const c of e.conns) c.send({ t: 'queue', status: 'searching', mode, waited, players: q.reduce((a, b) => a + b.conns.length, 0) });
          }
          i++;
          continue;
        }
        this.place(e, m);
        q.splice(i, 1);
      }
    }
    for (const m of [...this.matches]) {
      try {
        m.update();
      } catch (err) {
        console.error(`[match ${m.id}] tick error`, err);
      }
    }
  }

  onDisconnect(c: Conn) {
    this.cancel(c);
    this.leaveParty(c);
    if (c.match && c.player) c.match.disconnect(c.player);
  }
}
