# SURGEFALL — Game design

## Premise
A floating resort island in a candy-colored ocean is being swallowed by **the Surge**, a
violet energy storm. Contestants ride the **Skywhale** — a friendly whale-shaped airship — over
the island, jump, glide down on personal gliders and compete to be the last one standing.
Winners are crowned **Surge Survivors**.

## Pillars
1. **Readable chaos** — bright, chunky, high-contrast shapes readable at 200 m; rarity colors
   and loot beams tell you what matters.
2. **Everything is material** — every house, tree, rock and car can be smashed for building
   materials, and everything you build can be destroyed.
3. **Fast, fluid bodies** — sprint, slide, mantle, glide, launch and build in one motion.
4. **Always rotating** — the Surge, supply drops, POI loot tiers and roads keep players moving.

## Art direction
- Stylized, slightly exaggerated, toy-like proportions: big heads, rounded capsule bodies, chunky
  hands and shoes. No characters resemble existing IP.
- Palette: saturated greens, sky blues, sunny yellows, candy pinks; the Surge is violet/indigo.
- All models are built from primitives with baked vertex colors; materials use procedural
  canvas textures (planks, bricks, alloy panels, concrete, glass) tinted per piece.
- Lighting: warm sun + sky hemisphere light, soft fog for depth, neutral tone mapping to keep
  colors vibrant. Water uses an animated shader; the Surge wall uses scrolling noise bands.
- UI: dark violet glass panels, sunny yellow primary buttons, cyan accents, chunky italic
  Rubik headlines.

## The island
| Location | Identity | Combat character | Loot tier |
|---|---|---|---|
| **Glasspoint City** | Glass-and-concrete towers around the landmark Glasspoint Spire | Vertical fights, window peeks, rooftop cache + launch pad | High |
| **Haybale Hollow** | Pastel farm houses with gable roofs, big red barn with hay loft, crop fields | Close-range house fights | Normal |
| **Rustworks** | Steel warehouses, stacked shipping containers, chimneys, tanks, crane | Container mazes, roof control; lots of Alloy | Normal+ |
| **Saltwind Harbor** | Red-and-white lighthouse, boathouses, fish market, long docks, boats | Lighthouse snipes, water escapes (ramps back onto the docks) | Normal |
| **Frostpeak Lookout** | Snowy summit radio outpost with antenna and satellite dish | Long sightlines; launch pads for fast rotations | High |
| **Site Null** | Fenced, broken research labs and a giant dish | Mid-range, broken walls | High |
| **The Undervault** | Bunker beneath Site Null reached by a stair shaft; vault room with two caches | Tight corridor fights for rare loot | Highest |
| **Sunscorch Mesa** | Adobe homes across three red terraces; water tower; cacti | Height advantage on terraces | Normal |
| **Mossgrove Lodge** | Timber lodge and cabins in the densest forest, beside Mirror Lake | Tree cover, ambushes | Normal+ |
| **Pitstop Junction** | Crossroads gas station with canopy, diner, parked Rovers | Vehicle hub, quick rotations | Normal- |

Other features: road network linking POIs, a central pond, beaches all around, a ridge between
the mountain and the facility, 8 Rebirth Spires, scattered wilderness caches.

## Match flow
Skyport warm-up (free building, emotes) → Skywhale flight (random line across the island) →
skydive (dive to fall faster) → auto glider at 85 m → loot → fight → Surge phases → final circle
→ **Surge Survivor** → results → lobby.

## Weapons
| Weapon | Class | Rarities | Dmg | Rate/s | Mag | Reload | Notes |
|---|---|---|---|---|---|---|---|
| Pry Hammer | Harvest/melee | C | 20 | 2.2 | – | – | ×2.75 vs structures, harvests materials |
| Vanguard Rifle | AR | C–L | 30 | 5.6 | 30 | 2.3 s | Accurate first shot when aiming |
| Tri-Tap Burst | AR | U–E | 26×3 | burst | 27 | 2.4 s | 3-round burst |
| Buzzcut SMG | SMG | C–E | 15 | 12 | 30 | 2.0 s | Close-range spray |
| Hornet Compact | SMG | R–L | 12 | 15 | 40 | 2.2 s | Huge mag, wild bloom |
| Thumper Pump | Shotgun | C–L | 9 ×10 pellets | 1.05 | 5 | 4.2 s | ×2 headshots |
| Rattler Auto | Shotgun | U–E | 8 ×8 pellets | 1.8 | 8 | 5.0 s | Fast follow-ups |
| Longshot Bolt | Sniper | R–L | 105 | 0.77 | 1 | 2.6 s | ×2.5 headshots, 3.6× scope |
| Marksman DMR | Sniper | U–L | 46 | 2.6 | 10 | 2.4 s | Semi-auto, 2.4× scope |
| Pip Pistol | Pistol | C–R | 23 | 6.2 | 16 | 1.4 s | Forgiving sidearm |
| Mauler Revolver | Pistol | R–L | 58 | 1.5 | 6 | 2.2 s | Hand cannon |
| Boomtube | Explosive | R–L | 100 splash | 0.8 | 1 | 3.0 s | Rocket; 450 structure damage |
| Slugger Bat | Melee | R–E | 42 | 1.4 | – | – | Launches targets |

Rarity (Common, Uncommon, Rare, Epic, Legendary — gray, green, blue, purple, orange) scales
damage (+22 % max), reload speed (−20 %) and spread (−18 %).

## Items
| Item | Effect |
|---|---|
| Patch Kit | +15 HP (to 75), 3.2 s |
| Med Crate | Full HP, 8 s |
| Shield Cell | +25 shield (to 50), 2 s |
| Shield Canister | +50 shield, 4.5 s |
| Fizzpop | 75 HP/shield over 15 s |
| Popper Grenade | Bouncing frag, 2.5 s fuse |
| Haze Bomb | Violet smoke cloud for 12 s (blocks bot vision too) |
| Spring Pad | Deployable launch pad with glider redeploy |
| Pop Fort | Instant alloy box around you |
| Rebirth Chip | Team modes: carry to a Rebirth Spire to respawn a teammate |

Ammo: Light, Medium, Heavy, Shells, Rockets. Materials: Timber (fast, weak), Stone, Alloy (slow, tough).

## Building
Walls, floors, ramps and roofs on a 4 m grid, 10 materials each. Pieces start weak and build
up; unsupported structures collapse; walls can be edited into doors/windows. The whole map is
made of the same pieces (map buildings are anchored and don't collapse).

## Economy & progression
- XP: survival, placement, eliminations, caches, supply drops, damage, support, building, first
  match of the day, challenges.
- Levels (curve 1,000 + 150/level), 40-tier **Surge Pass** (Season 1: *Surge Rising*),
  3 daily + 4 weekly challenges, currency **Glimmer** earned only by playing, daily shop
  rotation. No paid items and no gameplay advantages from cosmetics.
- Cosmetics: 13 outfits (e.g. Rookie Runner, Tidecaller, Ember Scout, Neon Nomad, Circuit
  Knight, Frostbyte, Glitch Pop, Midnight Fox, Sunflare Ace), headwear (Ballcap, Beat Cans, Fox
  Ears, Victory Crown…), backpacks (Fizzle Pack, Turtle Shell, Road Guitar, Tiny Wings…), gliders
  (Delta Wing, Parafoil, Box Kite, Maple Drifter, Manta Ray), trails and 7 emotes.

## Audio direction
Everything is synthesized: punchy filtered-noise gunshots with sub thumps per class, HRTF
positional audio with distance low-pass muffling, surface-aware footsteps (grass, wood, stone,
metal, sand, snow, water), plucky building knocks per material, harvesting hits, sparkling
cache hums and openings, soft wind/ocean/bird ambience, a rumbling Surge that swells near the
wall, engine drones for Rovers and the Skywhale, bright victory fanfare and a gentle generative
menu theme.
