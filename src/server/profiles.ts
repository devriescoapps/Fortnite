// Persistent player profiles (JSON file store with atomic, debounced writes).
// All progression math runs here on the server so clients cannot grant themselves XP.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CosmeticLoadout, ResultsMsg } from '../shared/protocol';
import {
  COSMETIC_BY_ID, DEFAULT_LOADOUT, MatchStats, activeChallenges, addXp, challengeIncrement, dayIndex, defaultOwned,
  levelReward, matchCurrency, matchXp, sanitizeLoadout, seasonTier, shopRotation, tierReward, weekIndex,
} from '../shared/progression';

export interface LifetimeStats {
  matches: number;
  wins: number;
  top10: number;
  kills: number;
  deaths: number;
  damage: number;
  timePlayed: number;
  chests: number;
  builds: number;
}

export interface Profile {
  id: string;
  token: string;
  name: string;
  created: number;
  level: number;
  xp: number;
  seasonXp: number;
  currency: number;
  owned: string[];
  loadout: CosmeticLoadout;
  stats: LifetimeStats;
  challenges: { day: number; week: number; progress: Record<string, number>; done: string[] };
  lastMatchDay: number;
}

export function publicProfile(p: Profile) {
  const now = Date.now();
  return {
    id: p.id,
    name: p.name,
    level: p.level,
    xp: p.xp,
    seasonXp: p.seasonXp,
    tier: seasonTier(p.seasonXp),
    currency: p.currency,
    owned: p.owned,
    loadout: p.loadout,
    stats: p.stats,
    challenges: activeChallenges(now).map((c) => ({
      id: c.id, name: c.name, goal: c.goal, xp: c.xp, currency: c.currency, period: c.period,
      progress: Math.min(c.goal, p.challenges.progress[c.id] ?? 0), done: p.challenges.done.includes(c.id),
    })),
    shop: shopRotation(now).map((c) => ({ id: c.id, name: c.name, slot: c.slot, rarity: c.rarity, price: c.source.kind === 'shop' ? c.source.price : 0 })),
  };
}

export function sanitizeName(n: unknown): string {
  const s = typeof n === 'string' ? n : '';
  const clean = s.replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 16);
  return clean.length >= 2 ? clean : `Player${Math.floor(Math.random() * 9000 + 1000)}`;
}

export class ProfileStore {
  private byToken = new Map<string, Profile>();
  private file: string;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private dir: string, private persist = true) {
    this.file = join(dir, 'profiles.json');
    if (persist) this.load();
  }

  private load() {
    try {
      if (!existsSync(this.file)) return;
      const arr = JSON.parse(readFileSync(this.file, 'utf8')) as Profile[];
      for (const p of arr) this.byToken.set(p.token, this.migrate(p));
    } catch (e) {
      console.warn('[profiles] failed to load, starting fresh:', (e as Error).message);
    }
  }

  private migrate(p: Profile): Profile {
    p.owned ??= defaultOwned();
    p.loadout = sanitizeLoadout(p.loadout, new Set(p.owned));
    p.challenges ??= { day: dayIndex(), week: weekIndex(), progress: {}, done: [] };
    p.stats ??= { matches: 0, wins: 0, top10: 0, kills: 0, deaths: 0, damage: 0, timePlayed: 0, chests: 0, builds: 0 };
    return p;
  }

  get(token: string | undefined): Profile | undefined {
    if (!token || typeof token !== 'string') return undefined;
    return this.byToken.get(token);
  }

  create(name: string): Profile {
    const p: Profile = {
      id: randomBytes(6).toString('hex'),
      token: randomBytes(24).toString('hex'),
      name: sanitizeName(name),
      created: Date.now(),
      level: 1,
      xp: 0,
      seasonXp: 0,
      currency: 200,
      owned: defaultOwned(),
      loadout: { ...DEFAULT_LOADOUT },
      stats: { matches: 0, wins: 0, top10: 0, kills: 0, deaths: 0, damage: 0, timePlayed: 0, chests: 0, builds: 0 },
      challenges: { day: dayIndex(), week: weekIndex(), progress: {}, done: [] },
      lastMatchDay: -1,
    };
    this.byToken.set(p.token, p);
    this.markDirty();
    return p;
  }

  rollChallenges(p: Profile) {
    const d = dayIndex(), w = weekIndex();
    if (p.challenges.day !== d) {
      for (const k of Object.keys(p.challenges.progress)) if (k.startsWith('d_')) delete p.challenges.progress[k];
      p.challenges.done = p.challenges.done.filter((id) => !id.startsWith('d_'));
      p.challenges.day = d;
    }
    if (p.challenges.week !== w) {
      for (const k of Object.keys(p.challenges.progress)) if (k.startsWith('w_')) delete p.challenges.progress[k];
      p.challenges.done = p.challenges.done.filter((id) => !id.startsWith('w_'));
      p.challenges.week = w;
    }
  }

  equip(p: Profile, loadout: Partial<CosmeticLoadout>) {
    p.loadout = sanitizeLoadout({ ...p.loadout, ...loadout }, new Set(p.owned));
    this.markDirty();
  }

  buy(p: Profile, id: string): string | null {
    const c = COSMETIC_BY_ID[id];
    if (!c || c.source.kind !== 'shop') return 'Not for sale';
    if (!shopRotation().some((s) => s.id === id)) return 'Not in today\'s shop';
    if (p.owned.includes(id)) return 'Already owned';
    if (p.currency < c.source.price) return 'Not enough Glimmer';
    p.currency -= c.source.price;
    p.owned.push(id);
    this.markDirty();
    return null;
  }

  /** Apply end-of-match rewards and return the results breakdown for the client. */
  applyMatch(p: Profile, s: MatchStats, total: number): Omit<ResultsMsg, 't'> {
    this.rollChallenges(p);
    const xp = matchXp(s, total);
    const today = dayIndex();
    if (p.lastMatchDay !== today) {
      xp.push({ label: 'First match of the day', amount: 300 });
      p.lastMatchDay = today;
    }
    const doneNow: string[] = [];
    let currency = matchCurrency(s);
    for (const c of activeChallenges()) {
      if (p.challenges.done.includes(c.id)) continue;
      const inc = challengeIncrement(c, s);
      if (inc <= 0) continue;
      const prog = (p.challenges.progress[c.id] ?? 0) + inc;
      p.challenges.progress[c.id] = prog;
      if (prog >= c.goal) {
        p.challenges.done.push(c.id);
        doneNow.push(c.name);
        xp.push({ label: `Challenge: ${c.name}`, amount: c.xp });
        currency += c.currency;
      }
    }
    const totalXp = xp.reduce((a, b) => a + b.amount, 0);
    const levelBefore = p.level;
    const lv = addXp(p.level, p.xp, totalXp);
    for (let l = p.level + 1; l <= lv.level; l++) {
      const r = levelReward(l);
      currency += r.currency;
      if (r.cosmetic && !p.owned.includes(r.cosmetic)) p.owned.push(r.cosmetic);
    }
    p.level = lv.level;
    p.xp = lv.xp;
    const tierBefore = seasonTier(p.seasonXp);
    p.seasonXp += totalXp;
    const tierAfter = seasonTier(p.seasonXp);
    for (let t = tierBefore + 1; t <= tierAfter; t++) {
      const r = tierReward(t);
      if (r.cosmetic && !p.owned.includes(r.cosmetic)) p.owned.push(r.cosmetic);
      if (r.currency) currency += r.currency;
    }
    p.currency += currency;
    const st = p.stats;
    st.matches++;
    if (s.won) st.wins++;
    if (s.placement <= 10) st.top10++;
    st.kills += s.kills;
    if (!s.won) st.deaths++;
    st.damage += Math.round(s.damage);
    st.timePlayed += Math.round(s.timeAlive);
    st.chests += s.chests;
    st.builds += s.builds;
    this.markDirty();
    return {
      placement: s.placement, total, won: s.won, kills: s.kills, damage: Math.round(s.damage), survived: Math.round(s.timeAlive),
      xp, totalXp, levelBefore, levelAfter: p.level, currency, challengesDone: doneNow, tierBefore, tierAfter,
    };
  }

  markDirty() {
    if (!this.persist) return;
    this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 1500);
  }

  flush() {
    this.timer = null;
    if (!this.dirty || !this.persist) return;
    this.dirty = false;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify([...this.byToken.values()]));
      renameSync(tmp, this.file);
    } catch (e) {
      console.warn('[profiles] save failed:', (e as Error).message);
    }
  }
}
