// Long-term progression: levels, season pass, challenges, currency and cosmetics.
// Cosmetics are purely visual: every character uses the same hitbox and stats.
import type { CosmeticLoadout } from './protocol';
import { POIS } from './pois';
import { hash32 } from './rng';

export const SEASON = { id: 1, name: 'Season 1: Surge Rising', tiers: 40, xpPerTier: 1000 };
export const CURRENCY = 'Glimmer';

export type CosSlot = 'outfit' | 'headwear' | 'backpack' | 'glider' | 'trail' | 'emote';

export interface Cosmetic {
  id: string;
  slot: CosSlot;
  name: string;
  rarity: number;
  source: { kind: 'default' } | { kind: 'level'; level: number } | { kind: 'tier'; tier: number } | { kind: 'shop'; price: number };
  colors?: { primary: number; secondary: number; skin: number; accent: number };
  style?: string;
}

const o = (id: string, name: string, rarity: number, source: Cosmetic['source'], primary: number, secondary: number, skin: number, accent: number, style: string): Cosmetic =>
  ({ id, slot: 'outfit', name, rarity, source, colors: { primary, secondary, skin, accent }, style });

export const COSMETICS: Cosmetic[] = [
  // Outfits (style = face/body flavor)
  o('rookie', 'Rookie Runner', 0, { kind: 'default' }, 0x3a86ff, 0xf1f1f1, 0xf2c79b, 0xffbe0b, 'smile'),
  o('rookie2', 'Rookie Rival', 0, { kind: 'default' }, 0xff595e, 0x2b2d42, 0x8d5524, 0xffca3a, 'smile'),
  o('tidecaller', 'Tidecaller', 1, { kind: 'level', level: 3 }, 0x00b4d8, 0xe0fbfc, 0xffdbac, 0x0077b6, 'goggles'),
  o('emberscout', 'Ember Scout', 1, { kind: 'tier', tier: 2 }, 0xf77f00, 0x1d1d1d, 0xc68642, 0xfcbf49, 'visor'),
  o('mossranger', 'Moss Ranger', 1, { kind: 'shop', price: 800 }, 0x588157, 0xa3b18a, 0xe0ac69, 0x3a5a40, 'mask'),
  o('neonnomad', 'Neon Nomad', 2, { kind: 'tier', tier: 8 }, 0xff00a8, 0x14213d, 0xf1c27d, 0x00f5d4, 'visor'),
  o('circuitknight', 'Circuit Knight', 2, { kind: 'shop', price: 1200 }, 0x6c757d, 0x0d1b2a, 0xd9a066, 0x4cc9f0, 'helm'),
  o('coralcaptain', 'Captain Coral', 2, { kind: 'level', level: 10 }, 0xff7f6e, 0x1d3557, 0x8d5524, 0xf1faee, 'goggles'),
  o('frostbyte', 'Frostbyte', 3, { kind: 'tier', tier: 16 }, 0xcaf0f8, 0x48cae4, 0xffe0bd, 0x0096c7, 'helm'),
  o('glitchpop', 'Glitch Pop', 3, { kind: 'shop', price: 1500 }, 0x9d4edd, 0xb5ff3d, 0xf2c79b, 0x240046, 'visor'),
  o('midnightfox', 'Midnight Fox', 3, { kind: 'tier', tier: 24 }, 0x1b263b, 0xff9f1c, 0xffe8d6, 0xff9f1c, 'mask'),
  o('sunflare', 'Sunflare Ace', 4, { kind: 'tier', tier: 40 }, 0xffd60a, 0xd00000, 0xc68642, 0xffffff, 'helm'),
  o('cocoa', 'Cocoa Commando', 1, { kind: 'level', level: 6 }, 0x7f5539, 0xddb892, 0x9c6644, 0x4a5759, 'goggles'),
  // Headwear
  { id: 'hat_none', slot: 'headwear', name: 'None', rarity: 0, source: { kind: 'default' } },
  { id: 'cap', slot: 'headwear', name: 'Ballcap', rarity: 0, source: { kind: 'default' } },
  { id: 'beanie', slot: 'headwear', name: 'Cozy Beanie', rarity: 1, source: { kind: 'level', level: 2 } },
  { id: 'headphones', slot: 'headwear', name: 'Beat Cans', rarity: 1, source: { kind: 'tier', tier: 4 } },
  { id: 'foxears', slot: 'headwear', name: 'Fox Ears', rarity: 2, source: { kind: 'shop', price: 500 } },
  { id: 'partyhat', slot: 'headwear', name: 'Party Cone', rarity: 1, source: { kind: 'level', level: 5 } },
  { id: 'mohawk', slot: 'headwear', name: 'Spike Crest', rarity: 2, source: { kind: 'tier', tier: 12 } },
  { id: 'halo', slot: 'headwear', name: 'Glow Ring', rarity: 3, source: { kind: 'tier', tier: 28 } },
  { id: 'crown', slot: 'headwear', name: 'Victory Crown', rarity: 4, source: { kind: 'level', level: 25 } },
  // Backpacks
  { id: 'bp_none', slot: 'backpack', name: 'None', rarity: 0, source: { kind: 'default' } },
  { id: 'satchel', slot: 'backpack', name: 'Trail Satchel', rarity: 0, source: { kind: 'default' } },
  { id: 'rocketpack', slot: 'backpack', name: 'Fizzle Pack', rarity: 2, source: { kind: 'tier', tier: 10 } },
  { id: 'shell', slot: 'backpack', name: 'Turtle Shell', rarity: 1, source: { kind: 'level', level: 4 } },
  { id: 'guitar', slot: 'backpack', name: 'Road Guitar', rarity: 2, source: { kind: 'shop', price: 700 } },
  { id: 'wings', slot: 'backpack', name: 'Tiny Wings', rarity: 3, source: { kind: 'tier', tier: 20 } },
  { id: 'flag', slot: 'backpack', name: 'Rally Flag', rarity: 1, source: { kind: 'tier', tier: 6 } },
  // Gliders
  { id: 'delta', slot: 'glider', name: 'Delta Wing', rarity: 0, source: { kind: 'default' } },
  { id: 'parafoil', slot: 'glider', name: 'Parafoil', rarity: 1, source: { kind: 'level', level: 7 } },
  { id: 'kite', slot: 'glider', name: 'Box Kite', rarity: 2, source: { kind: 'tier', tier: 14 } },
  { id: 'leaf', slot: 'glider', name: 'Maple Drifter', rarity: 2, source: { kind: 'shop', price: 900 } },
  { id: 'manta', slot: 'glider', name: 'Manta Ray', rarity: 3, source: { kind: 'tier', tier: 32 } },
  // Trails
  { id: 'trail_none', slot: 'trail', name: 'None', rarity: 0, source: { kind: 'default' } },
  { id: 'sparkle', slot: 'trail', name: 'Sparkle Stream', rarity: 1, source: { kind: 'level', level: 8 } },
  { id: 'bubbles', slot: 'trail', name: 'Bubbly', rarity: 1, source: { kind: 'tier', tier: 18 } },
  { id: 'leaves', slot: 'trail', name: 'Falling Leaves', rarity: 2, source: { kind: 'shop', price: 400 } },
  { id: 'flames', slot: 'trail', name: 'Afterburn', rarity: 3, source: { kind: 'tier', tier: 36 } },
  { id: 'rainbow', slot: 'trail', name: 'Prism Streak', rarity: 4, source: { kind: 'level', level: 30 } },
  // Emotes
  { id: 'wave', slot: 'emote', name: 'Hey There', rarity: 0, source: { kind: 'default' } },
  { id: 'cheer', slot: 'emote', name: 'Big Cheer', rarity: 0, source: { kind: 'default' } },
  { id: 'bop', slot: 'emote', name: 'Head Bop', rarity: 1, source: { kind: 'tier', tier: 3 } },
  { id: 'robot', slot: 'emote', name: 'Servo Shuffle', rarity: 2, source: { kind: 'level', level: 12 } },
  { id: 'spin', slot: 'emote', name: 'Twirl', rarity: 1, source: { kind: 'shop', price: 300 } },
  { id: 'flex', slot: 'emote', name: 'Flex Zone', rarity: 2, source: { kind: 'tier', tier: 22 } },
  { id: 'sit', slot: 'emote', name: 'Take a Seat', rarity: 1, source: { kind: 'level', level: 15 } },
];

export const EMOTE_IDS = COSMETICS.filter((c) => c.slot === 'emote').map((c) => c.id);
export const COSMETIC_BY_ID: Record<string, Cosmetic> = Object.fromEntries(COSMETICS.map((c) => [c.id, c]));

export const DEFAULT_LOADOUT: CosmeticLoadout = {
  outfit: 'rookie',
  headwear: 'cap',
  backpack: 'satchel',
  glider: 'delta',
  trail: 'trail_none',
  emote1: 'wave',
  emote2: 'cheer',
};

export function defaultOwned(): string[] {
  return COSMETICS.filter((c) => c.source.kind === 'default').map((c) => c.id);
}

/** Validate a loadout against owned cosmetics; unknown/unowned entries fall back to defaults. */
export function sanitizeLoadout(l: Partial<CosmeticLoadout> | undefined, owned: Set<string> | null): CosmeticLoadout {
  const out = { ...DEFAULT_LOADOUT };
  if (!l) return out;
  const ok = (id: unknown, slot: CosSlot) => {
    if (typeof id !== 'string') return false;
    const c = COSMETIC_BY_ID[id];
    return !!c && c.slot === slot && (!owned || owned.has(id));
  };
  if (ok(l.outfit, 'outfit')) out.outfit = l.outfit!;
  if (ok(l.headwear, 'headwear')) out.headwear = l.headwear!;
  if (ok(l.backpack, 'backpack')) out.backpack = l.backpack!;
  if (ok(l.glider, 'glider')) out.glider = l.glider!;
  if (ok(l.trail, 'trail')) out.trail = l.trail!;
  if (ok(l.emote1, 'emote')) out.emote1 = l.emote1!;
  if (ok(l.emote2, 'emote')) out.emote2 = l.emote2!;
  return out;
}

// ---------------------------------------------------------------------------
// Levels & season pass
// ---------------------------------------------------------------------------

export function xpToNext(level: number) {
  return Math.min(5000, 1000 + 150 * (level - 1));
}

/** Apply XP to (level, xp) and return new values plus levels gained. */
export function addXp(level: number, xp: number, gain: number) {
  let l = level;
  let x = xp + gain;
  let gained = 0;
  while (x >= xpToNext(l)) {
    x -= xpToNext(l);
    l++;
    gained++;
  }
  return { level: l, xp: x, gained };
}

export function seasonTier(seasonXp: number) {
  return Math.min(SEASON.tiers, Math.floor(seasonXp / SEASON.xpPerTier) + 1);
}

/** Reward for reaching a season tier: cosmetics from COSMETICS, otherwise currency. */
export function tierReward(tier: number): { cosmetic?: string; currency?: number } {
  const c = COSMETICS.find((c) => c.source.kind === 'tier' && c.source.tier === tier);
  if (c) return { cosmetic: c.id };
  return { currency: tier % 5 === 0 ? 300 : 100 };
}

export function levelReward(level: number): { cosmetic?: string; currency: number } {
  const c = COSMETICS.find((c) => c.source.kind === 'level' && c.source.level === level);
  return { cosmetic: c?.id, currency: 100 };
}

// ---------------------------------------------------------------------------
// Match stats & XP
// ---------------------------------------------------------------------------

export interface MatchStats {
  kills: number;
  headshots: number;
  damage: number;
  damageTaken: number;
  chests: number;
  ammoBoxes: number;
  supplies: number;
  builds: number;
  harvested: number;
  healed: number;
  revives: number;
  rebirths: number;
  vehicleDist: number;
  footDist: number;
  landedPoi: string;
  phasesSurvived: number;
  placement: number;
  timeAlive: number;
  won: boolean;
  classKills: Record<string, number>;
}

export function emptyStats(): MatchStats {
  return {
    kills: 0, headshots: 0, damage: 0, damageTaken: 0, chests: 0, ammoBoxes: 0, supplies: 0, builds: 0, harvested: 0,
    healed: 0, revives: 0, rebirths: 0, vehicleDist: 0, footDist: 0, landedPoi: '', phasesSurvived: 0, placement: 0,
    timeAlive: 0, won: false, classKills: {},
  };
}

export function matchXp(s: MatchStats, total: number): { label: string; amount: number }[] {
  const out: { label: string; amount: number }[] = [];
  const surv = Math.floor(s.timeAlive / 10) * 5;
  if (surv) out.push({ label: 'Survival', amount: surv });
  if (s.won) out.push({ label: 'Surge Survivor (Victory)', amount: 500 });
  else if (s.placement <= 3) out.push({ label: 'Top 3', amount: 300 });
  else if (s.placement <= Math.max(10, Math.ceil(total * 0.3))) out.push({ label: 'Top 10', amount: 150 });
  else if (s.placement <= Math.ceil(total * 0.6)) out.push({ label: 'Top half', amount: 50 });
  if (s.kills) out.push({ label: `Eliminations x${s.kills}`, amount: s.kills * 60 });
  if (s.chests) out.push({ label: `Caches opened x${s.chests}`, amount: s.chests * 15 });
  if (s.supplies) out.push({ label: 'Supply drops', amount: s.supplies * 40 });
  const dmg = Math.floor(s.damage / 5);
  if (dmg) out.push({ label: 'Damage dealt', amount: dmg });
  if (s.revives + s.rebirths) out.push({ label: 'Team support', amount: (s.revives + s.rebirths) * 50 });
  if (s.builds >= 10) out.push({ label: 'Builder', amount: Math.min(100, s.builds * 2) });
  return out;
}

export function matchCurrency(s: MatchStats) {
  return 10 + (s.won ? 100 : 0) + s.kills * 5;
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export type ChallengeStat =
  | 'kills' | 'damage' | 'chests' | 'builds' | 'top10' | 'phases' | 'land' | 'vehicleDist'
  | 'harvested' | 'healed' | 'matches' | 'wins' | 'headshots' | 'revives' | 'supplies' | 'smgKills' | 'shotgunKills' | 'arKills';

export interface ChallengeDef {
  id: string;
  name: string;
  stat: ChallengeStat;
  goal: number;
  xp: number;
  currency: number;
  period: 'daily' | 'weekly';
  poi?: string;
}

const DAILY: ChallengeDef[] = [
  { id: 'd_chests', name: 'Open 5 caches', stat: 'chests', goal: 5, xp: 400, currency: 25, period: 'daily' },
  { id: 'd_kills', name: 'Eliminate 3 opponents', stat: 'kills', goal: 3, xp: 500, currency: 25, period: 'daily' },
  { id: 'd_damage', name: 'Deal 800 damage', stat: 'damage', goal: 800, xp: 400, currency: 25, period: 'daily' },
  { id: 'd_builds', name: 'Place 60 build pieces', stat: 'builds', goal: 60, xp: 350, currency: 25, period: 'daily' },
  { id: 'd_matches', name: 'Play 3 matches', stat: 'matches', goal: 3, xp: 300, currency: 25, period: 'daily' },
  { id: 'd_harvest', name: 'Harvest 400 materials', stat: 'harvested', goal: 400, xp: 350, currency: 25, period: 'daily' },
  { id: 'd_phases', name: 'Survive 6 Surge phases', stat: 'phases', goal: 6, xp: 400, currency: 25, period: 'daily' },
  { id: 'd_heal', name: 'Restore 200 health or shield', stat: 'healed', goal: 200, xp: 300, currency: 25, period: 'daily' },
  { id: 'd_vehicle', name: 'Drive 1000m in a Rover', stat: 'vehicleDist', goal: 1000, xp: 350, currency: 25, period: 'daily' },
];

const WEEKLY: ChallengeDef[] = [
  { id: 'w_wins', name: 'Win a match', stat: 'wins', goal: 1, xp: 2000, currency: 100, period: 'weekly' },
  { id: 'w_top10', name: 'Place top 10 in 5 matches', stat: 'top10', goal: 5, xp: 1500, currency: 100, period: 'weekly' },
  { id: 'w_kills', name: 'Eliminate 15 opponents', stat: 'kills', goal: 15, xp: 1500, currency: 100, period: 'weekly' },
  { id: 'w_headshots', name: 'Land 30 headshots', stat: 'headshots', goal: 30, xp: 1200, currency: 100, period: 'weekly' },
  { id: 'w_smg', name: 'Eliminate 3 opponents with SMGs', stat: 'smgKills', goal: 3, xp: 1200, currency: 100, period: 'weekly' },
  { id: 'w_shotgun', name: 'Eliminate 3 opponents with shotguns', stat: 'shotgunKills', goal: 3, xp: 1200, currency: 100, period: 'weekly' },
  { id: 'w_supply', name: 'Loot 2 supply drops', stat: 'supplies', goal: 2, xp: 1200, currency: 100, period: 'weekly' },
  { id: 'w_revive', name: 'Revive or rebirth 3 teammates', stat: 'revives', goal: 3, xp: 1200, currency: 100, period: 'weekly' },
  ...POIS.slice(0, 6).map((p): ChallengeDef => ({ id: `w_land_${p.id}`, name: `Land at ${p.name}`, stat: 'land', goal: 1, xp: 1000, currency: 100, period: 'weekly', poi: p.id })),
];

export const ALL_CHALLENGES = [...DAILY, ...WEEKLY];
export const CHALLENGE_BY_ID: Record<string, ChallengeDef> = Object.fromEntries(ALL_CHALLENGES.map((c) => [c.id, c]));

export function dayIndex(now = Date.now()) {
  return Math.floor(now / 86400000);
}
export function weekIndex(now = Date.now()) {
  return Math.floor((now / 86400000 + 3) / 7);
}

function pickN<T>(arr: T[], n: number, seed: number): T[] {
  const idx = arr.map((_, i) => i).sort((a, b) => hash32(seed, a) - hash32(seed, b));
  return idx.slice(0, n).map((i) => arr[i]);
}

export function activeChallenges(now = Date.now()): ChallengeDef[] {
  return [...pickN(DAILY, 3, dayIndex(now) * 7919), ...pickN(WEEKLY, 4, weekIndex(now) * 104729)];
}

export function challengeIncrement(c: ChallengeDef, s: MatchStats): number {
  switch (c.stat) {
    case 'kills': return s.kills;
    case 'damage': return Math.floor(s.damage);
    case 'chests': return s.chests;
    case 'builds': return s.builds;
    case 'top10': return s.placement > 0 && s.placement <= 10 ? 1 : 0;
    case 'phases': return s.phasesSurvived;
    case 'land': return s.landedPoi === c.poi ? 1 : 0;
    case 'vehicleDist': return Math.floor(s.vehicleDist);
    case 'harvested': return s.harvested;
    case 'healed': return Math.floor(s.healed);
    case 'matches': return 1;
    case 'wins': return s.won ? 1 : 0;
    case 'headshots': return s.headshots;
    case 'revives': return s.revives + s.rebirths;
    case 'supplies': return s.supplies;
    case 'smgKills': return s.classKills.smg ?? 0;
    case 'shotgunKills': return s.classKills.shotgun ?? 0;
    case 'arKills': return s.classKills.ar ?? 0;
  }
}

/** Daily item shop rotation (earned currency only; no real-money purchases). */
export function shopRotation(now = Date.now()): Cosmetic[] {
  const shopItems = COSMETICS.filter((c) => c.source.kind === 'shop');
  return pickN(shopItems, Math.min(6, shopItems.length), dayIndex(now) * 31337);
}

export const RARITY_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
