// Loot tables. Rarity rolls are biased by location tier (rare locations drop better gear).
import { AMMO_TYPES, AmmoType, ITEM_BY_ID, ItemDef, ItemStack, makeStack } from '../shared/items';
import { RNG } from '../shared/rng';

const BASE_RARITY = [44, 31, 16, 7, 2];

export function rollRarity(rng: RNG, tier: number): number {
  const w = BASE_RARITY.map((b, r) => [r, b * Math.pow(tier, r * 1.6)] as const);
  return rng.weighted(w);
}

const WEAPONS: [string, number][] = [
  ['vanguard', 16], ['tritap', 7], ['buzzcut', 12], ['hornet', 5], ['thumper', 14], ['rattler', 7],
  ['longshot', 4], ['marksman', 5], ['pip', 10], ['mauler', 4], ['boomtube', 3], ['slugger', 3],
];
const CONSUMABLES: [string, number][] = [
  ['patch', 20], ['medcrate', 6], ['cell', 16], ['canister', 7], ['fizzpop', 3], ['popper', 8], ['haze', 4], ['springpad', 5], ['popfort', 2],
];
const CONSUMABLE_COUNT: Record<string, [number, number]> = {
  patch: [3, 5], medcrate: [1, 1], cell: [2, 3], canister: [1, 1], fizzpop: [1, 1], popper: [2, 3], haze: [1, 2], springpad: [1, 2], popfort: [1, 1],
};
export const AMMO_DROP: Record<AmmoType, number> = { light: 36, medium: 30, heavy: 6, shells: 8, rockets: 2 };

function nearestRarity(def: ItemDef, r: number) {
  let best = def.rarities[0];
  for (const x of def.rarities) if (Math.abs(x - r) < Math.abs(best - r) || (Math.abs(x - r) === Math.abs(best - r) && x > best)) best = x;
  return best;
}

export function rollWeapon(rng: RNG, tier: number, minRarity = 0): ItemStack {
  const id = rng.weighted(WEAPONS);
  const def = ITEM_BY_ID[id];
  const r = nearestRarity(def, Math.max(minRarity, rollRarity(rng, tier)));
  return makeStack(id, r);
}

export function ammoFor(stack: ItemStack): ItemStack | null {
  const def = Object.values(ITEM_BY_ID).find((d) => d.code === stack.code)!;
  const a = def.weapon?.ammo;
  if (!a) return null;
  return makeStack(`ammo_${a}`, 0, AMMO_DROP[a]);
}

export function rollConsumable(rng: RNG): ItemStack {
  const id = rng.weighted(CONSUMABLES);
  const def = ITEM_BY_ID[id];
  const [a, b] = CONSUMABLE_COUNT[id];
  return makeStack(id, def.rarities[0], rng.int(a, b));
}

export function rollAmmo(rng: RNG): ItemStack {
  const a = rng.weighted<AmmoType>([['light', 5], ['medium', 5], ['heavy', 2], ['shells', 3], ['rockets', 0.6]]);
  return makeStack(`ammo_${a}`, 0, AMMO_DROP[a]);
}

export function rollMaterials(rng: RNG, amount = 30): ItemStack {
  const m = rng.pick(['timber', 'stone', 'alloy']);
  return makeStack(`mat_${m}`, 0, amount);
}

/** Floor loot: one "thing" (a weapon comes with its ammo). */
export function rollFloorLoot(rng: RNG, tier: number): ItemStack[] {
  const kind = rng.weighted([['weapon', 45], ['consumable', 32], ['ammo', 17], ['mats', 6]] as const);
  switch (kind) {
    case 'weapon': {
      const w = rollWeapon(rng, tier);
      const a = ammoFor(w);
      return a ? [w, a] : [w];
    }
    case 'consumable': return [rollConsumable(rng)];
    case 'ammo': return [rollAmmo(rng)];
    default: return [rollMaterials(rng, 20)];
  }
}

export function rollChestLoot(rng: RNG, tier: number): ItemStack[] {
  const w = rollWeapon(rng, tier * 1.25, 1);
  const out = [w];
  const a = ammoFor(w);
  if (a) out.push(a);
  out.push(rollConsumable(rng));
  if (rng.chance(0.5)) out.push(rollAmmo(rng));
  out.push(rollMaterials(rng, 30));
  return out;
}

export function rollAmmoBox(rng: RNG): ItemStack[] {
  const out = [rollAmmo(rng), rollAmmo(rng)];
  if (rng.chance(0.3)) out.push(makeStack('popper', 1, 1));
  return out;
}

export function rollSupplyDrop(rng: RNG): ItemStack[] {
  const a = rollWeapon(rng, 3.2, 3);
  const b = rollWeapon(rng, 3.2, 3);
  const out = [a, b];
  for (const w of [a, b]) {
    const am = ammoFor(w);
    if (am) out.push(am);
  }
  out.push(makeStack('canister', 2, 2));
  for (const m of ['timber', 'stone', 'alloy']) out.push(makeStack(`mat_${m}`, 0, 60));
  return out;
}

export const AMMO_ITEM_CODES = AMMO_TYPES.map((a) => ITEM_BY_ID[`ammo_${a}`].code);
