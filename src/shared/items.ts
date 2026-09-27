// Item & weapon definitions. All names are original to SURGEFALL.

export type Rarity = 0 | 1 | 2 | 3 | 4;
export const RARITIES = [
  { name: 'Common', color: '#b9c2cc', hex: 0xb9c2cc },
  { name: 'Uncommon', color: '#58d36a', hex: 0x58d36a },
  { name: 'Rare', color: '#3fa3ff', hex: 0x3fa3ff },
  { name: 'Epic', color: '#bd6bff', hex: 0xbd6bff },
  { name: 'Legendary', color: '#ffab2e', hex: 0xffab2e },
] as const;

export type Category = 'weapon' | 'heal' | 'throwable' | 'utility' | 'ammo' | 'material' | 'special';
export type WeaponClass = 'ar' | 'smg' | 'shotgun' | 'sniper' | 'pistol' | 'explosive' | 'melee';
export type AmmoType = 'light' | 'medium' | 'heavy' | 'shells' | 'rockets';
export const AMMO_TYPES: AmmoType[] = ['light', 'medium', 'heavy', 'shells', 'rockets'];
export const AMMO_NAMES: Record<AmmoType, string> = {
  light: 'Light Rounds',
  medium: 'Medium Rounds',
  heavy: 'Heavy Rounds',
  shells: 'Shells',
  rockets: 'Rockets',
};
export const AMMO_MAX: Record<AmmoType, number> = { light: 360, medium: 300, heavy: 60, shells: 60, rockets: 12 };

export interface ProjectileSpec {
  kind: 'rocket' | 'grenade' | 'smoke' | 'bullet';
  speed: number;
  gravity: number;
  fuse: number; // seconds (0 = impact)
  radius: number; // explosion radius
  damage: number; // player damage at center
  structure: number; // build damage at center
}

export interface WeaponStats {
  cls: WeaponClass;
  ammo: AmmoType | null;
  damage: number;
  headMult: number;
  interval: number;
  auto: boolean;
  burst: number;
  burstInterval: number;
  pellets: number;
  mag: number;
  reload: number;
  spreadHip: number; // degrees
  spreadAds: number;
  bloomPerShot: number;
  bloomMax: number;
  bloomRecover: number; // degrees per second
  recoil: number; // degrees of view kick
  range: number;
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  structureMult: number;
  zoom: number; // FOV divisor while aiming
  equipTime: number;
  projectile?: ProjectileSpec;
  /** Bullets travel with finite speed and drop (snipers) instead of instant hitscan. */
  ballistic?: { speed: number; gravity: number };
  meleeRange?: number;
  knockback?: number;
}

export interface UseSpec {
  time: number;
  heal?: number;
  healCap?: number;
  shield?: number;
  shieldCap?: number;
  overTime?: number; // total restored over time (health first, then shield)
}

export interface ItemDef {
  id: string;
  code: number;
  name: string;
  category: Category;
  rarities: Rarity[];
  stack: number;
  desc: string;
  weapon?: WeaponStats;
  use?: UseSpec;
  throwable?: ProjectileSpec;
  utility?: 'springpad' | 'popfort';
  ammoType?: AmmoType;
  material?: 'timber' | 'stone' | 'alloy';
}

const W = (w: Partial<WeaponStats> & Pick<WeaponStats, 'cls' | 'ammo' | 'damage' | 'interval' | 'mag' | 'reload'>): WeaponStats => ({
  headMult: 1.5,
  auto: true,
  burst: 1,
  burstInterval: 0,
  pellets: 1,
  spreadHip: 3,
  spreadAds: 0.6,
  bloomPerShot: 0.3,
  bloomMax: 3,
  bloomRecover: 10,
  recoil: 0.6,
  range: 300,
  falloffStart: 60,
  falloffEnd: 150,
  falloffMin: 0.7,
  structureMult: 1,
  zoom: 1.35,
  equipTime: 0.35,
  ...w,
});

export const ITEMS: ItemDef[] = [
  {
    id: 'pryhammer', code: 0, name: 'Pry Hammer', category: 'weapon', rarities: [0], stack: 1,
    desc: 'Harvesting tool. Smash scenery for building materials.',
    weapon: W({ cls: 'melee', ammo: null, damage: 20, interval: 0.45, mag: 0, reload: 0, structureMult: 2.75, meleeRange: 2.6, recoil: 0, equipTime: 0.2 }),
  },
  {
    id: 'vanguard', code: 1, name: 'Vanguard Rifle', category: 'weapon', rarities: [0, 1, 2, 3, 4], stack: 1,
    desc: 'Reliable full-auto rifle. Accurate first shot when aiming.',
    weapon: W({ cls: 'ar', ammo: 'medium', damage: 30, interval: 0.18, mag: 30, reload: 2.3, spreadHip: 2.8, spreadAds: 0.3, bloomPerShot: 0.35, bloomMax: 3, bloomRecover: 12, recoil: 0.55 }),
  },
  {
    id: 'tritap', code: 2, name: 'Tri-Tap Burst', category: 'weapon', rarities: [1, 2, 3], stack: 1,
    desc: 'Three-round burst rifle. Rewards precise tapping.',
    weapon: W({ cls: 'ar', ammo: 'medium', damage: 26, headMult: 1.6, interval: 0.55, auto: false, burst: 3, burstInterval: 0.075, mag: 27, reload: 2.4, spreadHip: 2.4, spreadAds: 0.25, bloomPerShot: 0.25, recoil: 0.45 }),
  },
  {
    id: 'buzzcut', code: 3, name: 'Buzzcut SMG', category: 'weapon', rarities: [0, 1, 2, 3], stack: 1,
    desc: 'High fire-rate spray for close quarters.',
    weapon: W({ cls: 'smg', ammo: 'light', damage: 15, interval: 0.083, mag: 30, reload: 2.0, spreadHip: 3.2, spreadAds: 1.8, bloomPerShot: 0.22, bloomMax: 4, bloomRecover: 14, recoil: 0.32, range: 150, falloffStart: 15, falloffEnd: 45, falloffMin: 0.6 }),
  },
  {
    id: 'hornet', code: 4, name: 'Hornet Compact', category: 'weapon', rarities: [2, 3, 4], stack: 1,
    desc: 'Tiny SMG with a huge magazine and wild bloom.',
    weapon: W({ cls: 'smg', ammo: 'light', damage: 12, interval: 0.066, mag: 40, reload: 2.2, spreadHip: 3.8, spreadAds: 2.2, bloomPerShot: 0.2, bloomMax: 4.5, bloomRecover: 14, recoil: 0.28, range: 140, falloffStart: 12, falloffEnd: 40, falloffMin: 0.55 }),
  },
  {
    id: 'thumper', code: 5, name: 'Thumper Pump', category: 'weapon', rarities: [0, 1, 2, 3, 4], stack: 1,
    desc: 'Pump-action shotgun. Devastating up close.',
    weapon: W({ cls: 'shotgun', ammo: 'shells', damage: 9, headMult: 2, interval: 0.95, auto: false, pellets: 10, mag: 5, reload: 4.2, spreadHip: 6.5, spreadAds: 5, bloomPerShot: 0, recoil: 4, range: 60, falloffStart: 6, falloffEnd: 25, falloffMin: 0.35, structureMult: 1.2, zoom: 1.2 }),
  },
  {
    id: 'rattler', code: 6, name: 'Rattler Auto', category: 'weapon', rarities: [1, 2, 3], stack: 1,
    desc: 'Semi-auto shotgun with a quick follow-up.',
    weapon: W({ cls: 'shotgun', ammo: 'shells', damage: 8, headMult: 1.75, interval: 0.55, auto: false, pellets: 8, mag: 8, reload: 5, spreadHip: 6, spreadAds: 4.5, bloomPerShot: 0, recoil: 3, range: 55, falloffStart: 6, falloffEnd: 22, falloffMin: 0.35, zoom: 1.2 }),
  },
  {
    id: 'longshot', code: 7, name: 'Longshot Bolt', category: 'weapon', rarities: [2, 3, 4], stack: 1,
    desc: 'Bolt-action sniper with a powerful scope.',
    weapon: W({ cls: 'sniper', ammo: 'heavy', damage: 105, headMult: 2.5, interval: 1.3, auto: false, mag: 1, reload: 2.6, spreadHip: 7, spreadAds: 0, bloomPerShot: 0, recoil: 5, range: 800, falloffStart: 800, falloffEnd: 800, falloffMin: 1, zoom: 3.6, equipTime: 0.5, ballistic: { speed: 340, gravity: 14 } }),
  },
  {
    id: 'marksman', code: 8, name: 'Marksman DMR', category: 'weapon', rarities: [1, 2, 3, 4], stack: 1,
    desc: 'Semi-auto marksman rifle for mid-long range.',
    weapon: W({ cls: 'sniper', ammo: 'heavy', damage: 46, headMult: 2, interval: 0.38, auto: false, mag: 10, reload: 2.4, spreadHip: 4, spreadAds: 0.15, bloomPerShot: 0.6, bloomMax: 3, recoil: 1.6, range: 600, falloffStart: 200, falloffEnd: 400, falloffMin: 0.8, zoom: 2.4, equipTime: 0.45, ballistic: { speed: 280, gravity: 14 } }),
  },
  {
    id: 'pip', code: 9, name: 'Pip Pistol', category: 'weapon', rarities: [0, 1, 2], stack: 1,
    desc: 'Light sidearm. Fast and forgiving.',
    weapon: W({ cls: 'pistol', ammo: 'light', damage: 23, headMult: 1.75, interval: 0.16, auto: false, mag: 16, reload: 1.4, spreadHip: 2.2, spreadAds: 1.0, bloomPerShot: 0.5, bloomMax: 3, recoil: 0.8, range: 180, falloffStart: 25, falloffEnd: 60, falloffMin: 0.6, equipTime: 0.25 }),
  },
  {
    id: 'mauler', code: 10, name: 'Mauler Revolver', category: 'weapon', rarities: [2, 3, 4], stack: 1,
    desc: 'Six-shot hand cannon. Big hits, slow cadence.',
    weapon: W({ cls: 'pistol', ammo: 'heavy', damage: 58, headMult: 2, interval: 0.65, auto: false, mag: 6, reload: 2.2, spreadHip: 2, spreadAds: 0.4, bloomPerShot: 1.2, bloomMax: 3, recoil: 3, range: 250, falloffStart: 40, falloffEnd: 110, falloffMin: 0.7 }),
  },
  {
    id: 'boomtube', code: 11, name: 'Boomtube', category: 'weapon', rarities: [2, 3, 4], stack: 1,
    desc: 'Rocket launcher. Shreds structures and anyone behind them.',
    weapon: W({ cls: 'explosive', ammo: 'rockets', damage: 0, interval: 1.2, auto: false, mag: 1, reload: 3, spreadHip: 1, spreadAds: 0.2, bloomPerShot: 0, recoil: 3, range: 400, equipTime: 0.6,
      projectile: { kind: 'rocket', speed: 55, gravity: 0, fuse: 0, radius: 5, damage: 100, structure: 450 } }),
  },
  {
    id: 'slugger', code: 12, name: 'Slugger Bat', category: 'weapon', rarities: [2, 3], stack: 1,
    desc: 'Melee bat that launches opponents on impact.',
    weapon: W({ cls: 'melee', ammo: null, damage: 42, interval: 0.7, mag: 0, reload: 0, structureMult: 1.5, meleeRange: 3, knockback: 16, recoil: 0, equipTime: 0.25 }),
  },
  // --- throwables ---
  {
    id: 'popper', code: 20, name: 'Popper Grenade', category: 'throwable', rarities: [1], stack: 6,
    desc: 'Bouncy frag grenade. Cooks for 2.5 seconds.',
    throwable: { kind: 'grenade', speed: 24, gravity: 22, fuse: 2.5, radius: 5, damage: 95, structure: 350 },
  },
  {
    id: 'haze', code: 21, name: 'Haze Bomb', category: 'throwable', rarities: [1], stack: 4,
    desc: 'Releases a thick cloud of violet smoke.',
    throwable: { kind: 'smoke', speed: 22, gravity: 22, fuse: 1.2, radius: 8, damage: 0, structure: 0 },
  },
  // --- utility ---
  {
    id: 'springpad', code: 25, name: 'Spring Pad', category: 'utility', rarities: [2], stack: 3,
    desc: 'Deployable pad that launches you skyward. Redeploy your glider!',
    utility: 'springpad',
  },
  {
    id: 'popfort', code: 26, name: 'Pop Fort', category: 'utility', rarities: [3], stack: 2,
    desc: 'Instantly encloses you in an alloy box.',
    utility: 'popfort',
  },
  // --- healing ---
  {
    id: 'patch', code: 30, name: 'Patch Kit', category: 'heal', rarities: [0], stack: 15,
    desc: 'Restores 15 health (up to 75).', use: { time: 3.2, heal: 15, healCap: 75 },
  },
  {
    id: 'medcrate', code: 31, name: 'Med Crate', category: 'heal', rarities: [1], stack: 3,
    desc: 'Restores all health.', use: { time: 8, heal: 100, healCap: 100 },
  },
  {
    id: 'cell', code: 32, name: 'Shield Cell', category: 'heal', rarities: [1], stack: 6,
    desc: 'Restores 25 shield (up to 50).', use: { time: 2, shield: 25, shieldCap: 50 },
  },
  {
    id: 'canister', code: 33, name: 'Shield Canister', category: 'heal', rarities: [2], stack: 3,
    desc: 'Restores 50 shield.', use: { time: 4.5, shield: 50, shieldCap: 100 },
  },
  {
    id: 'fizzpop', code: 34, name: 'Fizzpop', category: 'heal', rarities: [3], stack: 2,
    desc: 'Fizzy drink: restores 75 health or shield over 15 seconds.', use: { time: 1.8, overTime: 75 },
  },
  // --- ammo & materials (not held in slots) ---
  { id: 'ammo_light', code: 40, name: AMMO_NAMES.light, category: 'ammo', rarities: [0], stack: 999, desc: 'SMGs and light pistols.', ammoType: 'light' },
  { id: 'ammo_medium', code: 41, name: AMMO_NAMES.medium, category: 'ammo', rarities: [0], stack: 999, desc: 'Rifles.', ammoType: 'medium' },
  { id: 'ammo_heavy', code: 42, name: AMMO_NAMES.heavy, category: 'ammo', rarities: [0], stack: 999, desc: 'Snipers and hand cannons.', ammoType: 'heavy' },
  { id: 'ammo_shells', code: 43, name: AMMO_NAMES.shells, category: 'ammo', rarities: [0], stack: 999, desc: 'Shotguns.', ammoType: 'shells' },
  { id: 'ammo_rockets', code: 44, name: AMMO_NAMES.rockets, category: 'ammo', rarities: [0], stack: 999, desc: 'Explosive launchers.', ammoType: 'rockets' },
  { id: 'mat_timber', code: 50, name: 'Timber', category: 'material', rarities: [0], stack: 999, desc: 'Fast to build, low health.', material: 'timber' },
  { id: 'mat_stone', code: 51, name: 'Stone', category: 'material', rarities: [0], stack: 999, desc: 'Balanced building material.', material: 'stone' },
  { id: 'mat_alloy', code: 52, name: 'Alloy', category: 'material', rarities: [0], stack: 999, desc: 'Slow to build, very tough.', material: 'alloy' },
  // --- special ---
  { id: 'chip', code: 60, name: 'Rebirth Chip', category: 'special', rarities: [4], stack: 1, desc: 'Bring to a Rebirth Spire to bring your teammate back.' },
];

export const ITEM_BY_ID: Record<string, ItemDef> = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
export const ITEM_BY_CODE: ItemDef[] = [];
for (const it of ITEMS) ITEM_BY_CODE[it.code] = it;
export const HARVEST_TOOL = ITEM_BY_ID.pryhammer;

export const RARITY_DAMAGE = [1.0, 1.05, 1.1, 1.16, 1.22];
export const RARITY_RELOAD = [1.0, 0.95, 0.9, 0.85, 0.8];
export const RARITY_SPREAD = [1.0, 0.95, 0.9, 0.86, 0.82];

export function weaponDamage(w: WeaponStats, rarity: number) {
  return w.damage * RARITY_DAMAGE[rarity];
}

export function damageFalloff(w: WeaponStats, dist: number) {
  if (dist <= w.falloffStart) return 1;
  if (dist >= w.falloffEnd) return w.falloffMin;
  const t = (dist - w.falloffStart) / (w.falloffEnd - w.falloffStart);
  return 1 - t * (1 - w.falloffMin);
}

/** A stack of items in an inventory slot or on the ground. */
export interface ItemStack {
  code: number;
  rarity: number;
  count: number;
  mag: number; // rounds loaded (weapons)
}

export function makeStack(id: string, rarity: number, count = 1): ItemStack {
  const def = ITEM_BY_ID[id];
  return { code: def.code, rarity, count, mag: def.weapon ? def.weapon.mag : 0 };
}

export function stackName(s: ItemStack) {
  const def = ITEM_BY_CODE[s.code];
  return def.category === 'weapon' ? `${RARITIES[s.rarity].name} ${def.name}` : def.name;
}

export function ammoIndex(a: AmmoType) {
  return AMMO_TYPES.indexOf(a);
}

/** DPS estimate for UI stat display. */
export function weaponDps(w: WeaponStats, rarity: number) {
  const perShot = weaponDamage(w, rarity) * w.pellets * w.burst;
  return perShot / (w.interval + (w.burst - 1) * w.burstInterval);
}
