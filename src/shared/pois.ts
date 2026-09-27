// Named locations on the island. Positions are designed (fixed); loot, storm and
// transport path are randomized per match. Heights are multiples of GRID so map
// structures align with the build grid.

export type PoiKind =
  | 'city'
  | 'town'
  | 'industrial'
  | 'harbor'
  | 'mountain'
  | 'facility'
  | 'desert'
  | 'forest'
  | 'junction';

export interface Poi {
  id: string;
  name: string;
  kind: PoiKind;
  x: number;
  z: number;
  r: number; // flatten radius
  h: number; // plateau height (multiple of 4)
  lootTier: number; // 1 = normal, >1 biases toward higher rarities
  blurb: string;
}

export const POIS: Poi[] = [
  { id: 'glasspoint', name: 'Glasspoint City', kind: 'city', x: 150, z: -20, r: 92, h: 12, lootTier: 1.15, blurb: 'Glass towers and tight streets. Vertical fights, lots of loot.' },
  { id: 'haybale', name: 'Haybale Hollow', kind: 'town', x: -130, z: 190, r: 78, h: 8, lootTier: 1.0, blurb: 'Sleepy farm town with gable roofs and a big red barn.' },
  { id: 'rustworks', name: 'Rustworks', kind: 'industrial', x: -270, z: -290, r: 92, h: 8, lootTier: 1.05, blurb: 'Warehouses, cranes and container mazes. Plenty of alloy.' },
  { id: 'saltwind', name: 'Saltwind Harbor', kind: 'harbor', x: 330, z: 360, r: 64, h: 4, lootTier: 1.0, blurb: 'Lighthouse, boathouses and docks over open water.' },
  { id: 'frostpeak', name: 'Frostpeak Lookout', kind: 'mountain', x: 360, z: -320, r: 26, h: 88, lootTier: 1.25, blurb: 'A radio outpost on the snowy summit. Great sightlines.' },
  { id: 'sitenull', name: 'Site Null', kind: 'facility', x: 10, z: -410, r: 72, h: 16, lootTier: 1.2, blurb: 'Abandoned research facility. Something is buried below.' },
  { id: 'sunscorch', name: 'Sunscorch Mesa', kind: 'desert', x: -380, z: 320, r: 60, h: 20, lootTier: 1.0, blurb: 'Adobe homes atop red mesas under a hot sun.' },
  { id: 'mossgrove', name: 'Mossgrove Lodge', kind: 'forest', x: -400, z: -20, r: 44, h: 12, lootTier: 1.0, blurb: 'Timber lodge deep in the thicket beside Mirror Lake.' },
  { id: 'pitstop', name: 'Pitstop Junction', kind: 'junction', x: -10, z: 110, r: 42, h: 8, lootTier: 0.95, blurb: 'Crossroads gas station. Grab a Rover and go.' },
];

/** Underground bunker beneath Site Null (rare loot). */
export const UNDERVAULT = { name: 'The Undervault', poi: 'sitenull' };

export const LAKE = { x: -300, z: -120, r: 46, depth: -6, name: 'Mirror Lake' };

/** Region centers used for biome classification (voronoi-ish). */
export type Biome = 'plains' | 'forest' | 'industrial' | 'facility' | 'mountain' | 'city' | 'town' | 'harbor' | 'desert';
export const BIOME_CENTERS: { biome: Biome; x: number; z: number; w: number }[] = [
  { biome: 'forest', x: -360, z: -60, w: 1.0 },
  { biome: 'forest', x: -230, z: 60, w: 0.8 },
  { biome: 'industrial', x: -270, z: -300, w: 0.9 },
  { biome: 'facility', x: 10, z: -410, w: 0.8 },
  { biome: 'mountain', x: 360, z: -310, w: 1.3 },
  { biome: 'city', x: 150, z: -20, w: 0.85 },
  { biome: 'town', x: -130, z: 190, w: 0.8 },
  { biome: 'harbor', x: 330, z: 360, w: 0.75 },
  { biome: 'desert', x: -370, z: 320, w: 1.2 },
  { biome: 'plains', x: 20, z: 160, w: 1.0 },
  { biome: 'plains', x: 200, z: 200, w: 1.0 },
  { biome: 'plains', x: -80, z: -180, w: 1.0 },
  { biome: 'plains', x: 180, z: -250, w: 0.9 },
];

/** Roads connect POIs (rendered as terrain paint; used for vehicle spawns). */
export const ROADS: [string, string][] = [
  ['pitstop', 'glasspoint'],
  ['pitstop', 'haybale'],
  ['pitstop', 'sitenull'],
  ['haybale', 'sunscorch'],
  ['glasspoint', 'saltwind'],
  ['sitenull', 'rustworks'],
  ['rustworks', 'mossgrove'],
  ['mossgrove', 'haybale'],
  ['glasspoint', 'sitenull'],
];

export function poiById(id: string) {
  return POIS.find((p) => p.id === id)!;
}

export function nearestPoi(x: number, z: number) {
  let best = POIS[0];
  let bd = Infinity;
  for (const p of POIS) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return { poi: best, dist: bd };
}
