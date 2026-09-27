# Development phases

Each phase lists its **architecture**, **required components** (with source files), **data
structures**, **networking considerations**, **core gameplay logic**, **implementation steps**
(✅ done in this prototype · ⏭ next step) and **testing requirements** (with the tests that
cover them today).

---

## Phase 1 — Core player controller

**Architecture.** A pure, deterministic function `stepSim(state, input, dt, ctx, events)`
(`src/shared/sim.ts`) advances one player by a fixed 1/60 s. The server runs it
authoritatively; the client runs the same code for prediction and replay. Movement is a small
state machine over `Mode`: `Walk, Skydive, Glide, Swim, Mantle, Bus, Vehicle, Downed, Dead`.
Crouch, sprint, slide and airborne are flags inside `Walk`.

**Required components.**
- `shared/sim.ts` — state, step, movement modes, collision response.
- `shared/collision.ts` — `CollisionWorld`: spatial hash of AABB / ramp / roof colliders + terrain;
  `groundAt`, `overlaps`, `raycast`.
- `shared/terrain.ts` — heightmap with holes (bunker shafts), triangle-exact sampling.
- `client/input.ts` — keyboard/mouse (pointer lock), touch joystick/buttons, gamepad polling.
- `client/game.ts` — third-person camera (shoulder pivot, collision pull-in, ADS zoom, FOV kick).
- `client/render/characters.ts` — procedural animation for every mode.

**Data structures.**
```ts
InputCmd { seq, mx, mz, yaw, pitch, buttons /* JUMP SPRINT CROUCH FIRE ADS RELOAD USE BUILD */, slot, viewTick }
SimState { x,y,z, vx,vy,vz, yaw,pitch, mode, grounded, crouch, sprint, ads, slideT, slideCd,
           mantleT, m0*/m1* (mantle path), canGlide, airT, prevButtons, ...equipment, hp, shield, inv }
Collider { shape: Box|Ramp|Roof, min/max, dir, y0, ownerKind: Static|Prop|Piece, ownerId, blocksShots }
```

**Networking considerations.** Inputs are quantized (`quantizeInput`) before the client uses
them so both sides simulate identical values; the server quantizes state to f32 after each step
(`quantizeSim`). Self state is sent in full each snapshot for reconciliation; others get compact
entity records (position, yaw/pitch, mode, flags, held item, speed).

**Core gameplay logic.** Ground acceleration model with per-state speeds (run 6.2, sprint 8.4,
crouch 3.2, ADS 3.9 m/s); axis-separated collision with 0.6 m step-up and ground snapping;
terrain as a slope-limited blocker; jump with coyote time; slide (boost, slope-aware friction,
cooldown); mantle detection (blocked at body height + free ledge within reach + headroom);
fall damage above 17 m/s; swim when water depth > 1.45 m; skydive (dive by pitching down) with
auto-deploy at 85 m and manual deploy; glider steering; launch pads switch to skydive with lift.

**Implementation steps.**
1. ✅ Heightmap terrain + spatial-hash collision world.
2. ✅ Walk/run/sprint/crouch, jump, step-up, ground snap, slopes.
3. ✅ Slide, mantle, fall damage, swim, skydive, glide, launch pads.
4. ✅ Third-person camera with collision; ADS; recoil offset; camera shake.
5. ✅ Keyboard/mouse, touch, gamepad, toggle sprint/crouch settings.
6. ✅ Procedural animation state machine incl. emotes.
7. ⏭ IK foot placement; two-bone limbs; blended animation layers.

**Testing requirements.** Deterministic unit tests for each movement mode; replay determinism
server vs client; collision edge cases (walls, ramps, ledges, water).
Covered by `tests/sim.test.ts` (run speed, sprint, jump, wall blocking, ramp climbing, mantle,
skydive→glide→land, swimming) and `tests/systems.test.ts` (bit-identical client replay).

---

## Phase 2 — Weapons and combat

**Architecture.** The weapon/consumable state machine is part of `stepSim` (`stepEquipment`),
so fire rate, bursts, reloads, bloom and consumable channels are predicted by the client and
enforced by the server. The sim emits events (`shot`, `melee`, `rocket`, `throw`, `used`, ...);
the server resolves them (`server/match.ts`), the client renders them.

**Required components.** `shared/items.ts` (definitions, rarity scaling, falloff),
`shared/sim.ts` (`stepEquipment`, `spreadDegrees`, `shotDirections`, `aimRay`),
`server/match.ts` (`fireHitscan`, `rayPlayers`, `doMelee`, projectiles, `explode`,
`applyDamage`, `knockDown`, `eliminate`), `server/player.ts` (lag-comp history),
`client/render/effects.ts` (tracers, muzzle flash, particles, explosions, smoke, damage numbers),
`client/audio.ts` (per-class gun synthesis).

**Data structures.**
```ts
WeaponStats { cls, ammo, damage, headMult, interval, auto, burst, burstInterval, pellets, mag, reload,
              spreadHip, spreadAds, bloomPerShot, bloomMax, bloomRecover, recoil, range,
              falloffStart, falloffEnd, falloffMin, structureMult, zoom, equipTime, projectile?, meleeRange?, knockback?,
              ballistic?: { speed, gravity } }
ItemStack { code, rarity, count, mag }
Hitbox by mode: standing body box 0–1.45 m + head sphere (r 0.3 @ 1.62 m); crouch/downed/swim variants.
```
Rarity multipliers: damage ×1.00–1.22, reload ×1.00–0.80, spread ×1.00–0.82.

**Networking considerations.** No hit claims from clients. Each input carries `viewTick`; the
server rewinds other players' hitboxes (≤ 300 ms) for hitscan and melee. Spread/pellets use a
deterministic per-shot seed (`hash(playerId, shotSeq)`) so tracers match server hits. Remote
players receive `shot` events (origin + impact points) within 400 m. Sniper rounds are
**ballistic**: the server spawns a bullet projectile (speed + gravity) that it steps at 60 Hz,
and every step tests targets rewound to the shooter's `viewTick` timeline (shot tick − the
shooter's view lag), so what the shooter saw is what the bullet flies through. The shooter
predicts its own bullet locally (same origin/velocity) and is left out of that projectile's
replication; everyone else sees it via snapshots and gets impact sparks. The shooter receives
`hit` confirmations (damage numbers, headshot markers); victims receive `hurt` with the
attacker direction.

**Core gameplay logic.** 13 weapons across AR, SMG, shotgun, sniper, pistol, explosive, melee;
throwables (frag, smoke) and utility (Spring Pad, Pop Fort). Hip spread + movement/air/crouch
multipliers + bloom; ADS zoom; semi-auto requires fresh presses; auto-reload on empty; headshot
multipliers; linear damage falloff; shields absorb first (storm and fall bypass shields); build
pieces take `damage × structureMult`; explosions with line-of-sight falloff damage players,
structures, props and vehicles; no friendly fire or self-damage; in team modes a lethal hit
knocks down (crawl, 3 hp/s bleed, revive), otherwise eliminates (drops all loot).

**Implementation steps.** ✅ weapon data + rarities · ✅ state machine (fire/burst/reload/equip)
· ✅ hitscan + lag compensation · ✅ projectiles (rocket, bouncing grenades, smoke) · ✅ melee +
knockback · ✅ damage model (shield, head, falloff, structures) · ✅ knock/revive/eliminate ·
✅ feedback (tracers, flashes, hit markers, damage numbers, direction indicator, kill feed,
recoil, sounds) · ✅ ballistic sniper bullets (travel time + drop, shooter-timeline lag
compensation, client-predicted bullet, bots lead and compensate drop) · ⏭ weapon attachments /
per-weapon recoil patterns.

**Testing requirements.** Fire-rate/reload/ammo accounting; deterministic pellet spread;
lag-comp rewind hits the past position and misses the current one; shield-first damage;
elimination awards and loot drops; knock → revive → team wipe; sniper bullets are not instant,
fall under gravity and hit after their flight time.
Covered by `tests/sim.test.ts` (fire rate, reload, pellet determinism) and
`tests/systems.test.ts` (rewind, ballistic bullets, shields/eliminations/results, revive/wipe).

---

## Phase 3 — Inventory and loot

**Architecture.** Inventory lives inside `SimState` (`inv`: 6 slots incl. harvest tool, ammo
reserves, materials) so the client can predict mag/reserve/consumable use, while all
structural changes (pickup, drop, swap) are server actions applied in input order. Loot is
rolled per match on the server (`server/loot.ts`) from fixed spawn points in `mapdata.ts`.

**Required components.** `shared/items.ts`, `shared/sim.ts` (`Inventory`), `server/loot.ts`,
`server/match.ts` (`spawnLoot`, `pickup`, `dropSlot`, `swapSlots`, containers, supply drops,
`dropAll`), `client/ui/hud.ts` (hotbar, inventory screen with drag & drop and stat bars),
`client/render/worldview.ts` (`LootRenderer`: ground items with rarity rings and beams,
caches with glow, ammo crates, balloon supply drops).

**Data structures.**
```ts
Inventory { slots: (ItemStack|null)[6], ammo: number[5], mats: number[3] }
GroundItem { id, code, rarity, count, mag, x,y,z, owner? /* rebirth chip */ }
Container { id, kind: 'chest'|'ammo'|'supply', x,y,z, rot, open, tier, land?, y0? }
Spot { x,y,z, tier } // loot spots, cache spots, ammo spots (per-location tier)
```

**Networking considerations.** Ground items/containers are sent in `MatchInit` and then as
`i+ / i- / ic / c+ / co` events; inventory changes arrive in the self snapshot. Pickup and cache
interactions are validated for range **and line of sight** (no looting through walls). Holding
interactions (caches 0.4 s, supply 1 s, revive 5 s, spire 4 s) are server-side channels kept
alive by the USE button bit in the input stream.

**Core gameplay logic.** Rarity roll weights biased by location tier (`w × tier^(1.6·rarity)`);
floor spawns (72 %) roll weapon+ammo / consumable / ammo / materials; caches always give a
weapon (≥ Uncommon) + consumable + ammo + materials; ammo crates; supply drops (phases 1–5)
contain two Epic/Legendary weapons. Ammo and materials auto-pickup and don't use slots;
consumables stack; weapons auto-equip when holding the harvest tool; full inventory swaps with
the held item. Eliminated players drop everything.

**Implementation steps.** ✅ item defs · ✅ spawn points · ✅ loot tables + tiers · ✅ caches,
ammo crates, supply drops · ✅ pickup/drop/swap/stack/auto-equip · ✅ inventory screen with stats
· ✅ LOS validation · ⏭ vaults requiring keys · ⏭ loot-quality heat map tooling.

**Testing requirements.** Rarity distribution vs tier; caches always contain a weapon; pickup
range/LOS; stacking; swap-with-held; drop-on-elimination.
Covered by `tests/systems.test.ts` (tiers, caches, drop on elimination), bot matches
(`tests/match.test.ts`: bots open caches and arm themselves) and the browser e2e (cache →
Longshot pickup).

---

## Phase 4 — Map and points of interest

**Architecture.** The island is generated deterministically (`MAP_SEED`) on both sides:
`terrain.ts` builds the heightmap (island mask, fBm hills, ridged mountain, terraced mesas, lake,
POI plateaus aligned to the build grid, road beds); `mapdata.ts` builds structures out of
**build pieces** (so all houses are destructible and harvestable), scatters props by biome and
registers loot/cache/vehicle/spire/launch-pad spots.

**Required components.** `shared/pois.ts`, `shared/terrain.ts`, `shared/mapdata.ts`,
`client/render/environment.ts` (terrain chunks with baked biome colors, animated water shader,
sky dome, clouds, Skyport), `client/render/worldview.ts` (instanced props), `client/ui/minimap.ts`.

**Data structures.**
```ts
Poi { id, name, kind, x, z, r /*flatten*/, h /*grid-aligned*/, lootTier, blurb }
MapData { props: PropInst[], pieces: MapPiece[], lootSpots, chestSpots, ammoSpots, vehicleSpots,
          launchPads, spires, statics (Skyport), lights, undervault }
PropInst { id, t (type), x,y,z, rot, s (scale), tint }  // trees, rocks, cars, containers...
```

**Networking considerations.** Nothing about the static map is transmitted. Only changes are:
destroyed map pieces, damaged pieces, removed props (sent in `MatchInit` for late joiners /
reconnects and as events afterwards).

**Core gameplay logic.** Nine locations, each with its own look and combat style: vertical glass
towers (Glasspoint City), gable-roof farm town + barn loft (Haybale Hollow), warehouse roofs and
stacked containers (Rustworks), lighthouse + docks with water-exit ramps (Saltwind Harbor),
summit outpost with launch pads (Frostpeak Lookout), broken labs + the underground
**Undervault** (stair shaft through a terrain hole into a bunker with a vault), adobe homes on
mesa terraces (Sunscorch Mesa), timber lodge in the densest forest by Mirror Lake (Mossgrove),
gas station with canopy and Rovers (Pitstop Junction). Higher-tier locations drop better loot;
roads and launch pads encourage rotations.

**Implementation steps.** ✅ terrain + biomes + roads + lake · ✅ POI generators ·
✅ underground bunker (terrain holes) · ✅ scatter (≈3,700 props) · ✅ harvestable props ·
✅ minimap/full map with labels · ⏭ hand-authored map editor/export · ⏭ dynamic POI events.

**Testing requirements.** Deterministic generation (server == client), map piece support,
walkability of stairs/ramps, no spawn points inside colliders, performance budget of generation.
Covered by determinism of shared code (both sides call the same generator; replay test), bots
navigating and looting all POIs in simulated matches, e2e landings at several POIs.
⏭ Add an automated "spawn point reachability" scan.

---

## Phase 5 — Building

**Architecture.** A 4 m grid with four piece types. `BuildGrid` (`shared/build.ts`) stores
pieces, maps slot keys → ids, and maintains an **edge graph** (grid edges each piece touches)
for connectivity. Colliders are registered in the shared `CollisionWorld`, so building affects
movement, bullets and prediction immediately.

**Required components.** `shared/build.ts` (specs, colliders, edges, grounding, `canPlace`,
`findUnsupported`, `buildTarget`), `server/match.ts` (`processBuild`, `processEdit`,
`damagePiece`, `destroyPieces`, build-up), `client/game.ts` (ghost, placement, prediction),
`client/render/worldview.ts` (`PieceRenderer`: instanced pools, build-up tint, hit flashes).

**Data structures.**
```ts
PieceSpec { type: 'wall'|'floor'|'ramp'|'roof', i, j, k, d }   // d: wall axis / ramp rise dir
Piece extends PieceSpec { id, variant /*solid|window|door*/, mat, hp, maxHp, owner, team,
                          anchored, grounded, tint, buildStart, buildTime, colliderIds }
slot keys: w{i,j,k,d} | f{i,j,k} | r{i,j,k} | c{i,j,k}
Materials: Timber 150hp/2.5s · Stone 300hp/5s · Alloy 500hp/8s (+ map materials)
```

**Networking considerations.** Build requests are actions ordered with inputs. The client adds
a **predicted piece** immediately (so ramp-rushing is instant) keyed by slot; the server
answers with `p+` (replaces the prediction) or `bf` with a reason (prediction removed).
Destruction and collapse are broadcast as `p-` id lists; damage as batched `php`.

**Core gameplay logic.** Crosshair/position-based targeting (front cell by dominant facing;
looking up/down selects above/below; standing on an up-ramp targets the next level for ramp
rushing). Validation: slot free, height limits, material ≥ 10, rate ≤ 10/s, range ≤ 10.6 m,
supported (touches terrain or shares a grid edge with an existing piece). Pieces start at 10 %
HP and build up over the material's build time. When pieces are destroyed, a BFS from their
neighbours removes every component that lost its path to the ground — for player builds and map
buildings alike (only the indestructible bunker plates are anchored); loot resting on collapsed
floors falls to whatever is below.
Wall edits cycle solid → door → window. Pop Fort builds an instant alloy box.

**Implementation steps.** ✅ grid, colliders, edge graph · ✅ targeting + ghost · ✅ validation ·
✅ build-up · ✅ structural collapse · ✅ prediction & reconciliation of pieces · ✅ edits ·
✅ harvesting all map structures · ⏭ multi-tile edits (arches, half walls) · ⏭ turbo-build
tuning with ping-aware prediction windows.

**Testing requirements.** Support rules and collapse cascade; rejection reasons (mats, rate,
range, occupied); build-up HP curve; target selection for common facings; walking up ramps.
Covered by `tests/sim.test.ts` (support/collapse, targeting, ramp climb) and
`tests/systems.test.ts` (server validation reasons, collapse via damage, build-up, map building
collapse with loot settling).

---

## Phase 6 — Storm ("the Surge")

**Architecture.** A server-side phase machine (`Match.updateStorm`) over `STORM_PHASES`
(`shared/storm.ts`). The replicated `StormState` contains the current and next circles and the
stage's start/end times; clients interpolate the circle locally, so no per-tick storm traffic is
needed.

**Required components.** `shared/storm.ts`, `server/match.ts` (`startPlay`, `nextCircle`,
`updateStorm`, supply drops at shrink start), `client/render/environment.ts` (animated wall
shader, next-circle marker, fog tint), `client/ui/minimap.ts` (storm overlay, safe-zone line),
`client/ui/hud.ts` (phase, timer, distance to safety), `client/audio.ts` (storm rumble by
distance).

**Data structures.**
```ts
StormPhaseDef { wait, shrink, radius, dps }          // 7 phases: 380 → 230 → 130 → 70 → 35 → 14 → 0 m
StormState { phase, stage: 'idle'|'wait'|'shrink'|'done', t0, t1, from: Circle, to: Circle, dps }
```

**Networking considerations.** `storm` events only on stage changes (≈14 per match);
`stormScale` shortens all timings for tests and quick modes.

**Core gameplay logic.** Starts when the transport run ends. Each next circle is random but
fully inside the previous circle, biased to stay on land. Damage is applied once per second of
exposure, bypasses shields, rises every phase, and also bleeds downed players. Supply drops fall
into the next circle at the start of phases 1–5. Rebirth Spires go dark from phase 4.

**Implementation steps.** ✅ phases + random circles · ✅ damage · ✅ visuals, map overlay,
HUD timer/distance · ✅ audio · ✅ supply drops · ⏭ moving final circles · ⏭ storm forecast
items.

**Testing requirements.** Every next circle inside the previous; damage monotonic across phases;
damage only outside; match always converges to an end.
Covered by `tests/systems.test.ts` (containment, damage ordering) and `tests/match.test.ts`
(full matches always finish).

---

## Phase 7 — Multiplayer matchmaking & match flow

**Architecture.** `server/main.ts` (HTTP + WebSocket gateway, rate limiting, drift-corrected
30 Hz loop) → `server/matchmaker.ts` (per-mode queues, parties, lobby late-join, match
creation/closing) → `server/match.ts` (lifecycle). Profiles persist in `server/profiles.ts`.

**Required components.** Gateway, matchmaker, match, profiles, bots (`server/bot.ts`), client
`net.ts` (auto-reconnect), `game.ts` (menu → queue → match → results → menu).

**Data structures.**
```ts
Conn { id, profile, state: 'menu'|'queue'|'match', match, player, party, queueMode }
Party { code, leader, members }      QueueEntry { conns, mode, since }
MatchPhase: 'lobby' → 'bus' → 'play' → 'ended'
ServerPlayer { sim, queue (inputs+actions), budget, fillerDebt, alive/downed/eliminated,
               placement, stats, channel, history ring, spectating, chips, vehicle/seat, ... }
```

**Networking considerations.** Hello → welcome (token + profile). Queue status messages;
`MatchInit` snapshot of the whole dynamic world on join/reconnect; then snapshots + events.
Disconnect keeps the character for 45 s; reconnect with the same token resumes. Parties are
placed on one team; partial squads are filled with other players (or bots).

**Core gameplay logic.** Lobby (Skyport warm-up, free building, no damage) → the **Skywhale**
crosses the island on a random line (doors open after 3 s, everyone ejected at the end) →
play → the last team with a standing member wins; placements are assigned as teams are
eliminated; results and rewards are sent per player; spectating follows the killer/teammates;
matches linger 12 s after victory and close. Bots fill open seats and use the same inputs as
humans (drop choice near the flight path, looting with local obstacle avoidance and
wall-breaking, storm rotation timing, weapon choice by range, aim error that shrinks while
tracking, strafing, grenades, building cover, healing, reviving and rebirthing teammates).

**Implementation steps.** ✅ gateway + rate limits · ✅ queues, parties, late join ·
✅ lifecycle + transport · ✅ placements, results, victory · ✅ spectating · ✅ reconnect ·
✅ bots · ⏭ skill-based matchmaking / MMR · ⏭ multi-process match servers + region routing ·
⏭ server-side replays.

**Testing requirements.** Full match simulation to a single winner (solo and squads); network
flow queue → match → transport → jump; parties share a team; reconnect resumes; leaving
applies results.
Covered by `tests/match.test.ts`, `tests/net.test.ts`, and the browser e2e.

---

## Phase 8 — Vehicles and traversal

**Architecture.** `shared/vehicle.ts` holds arcade vehicle physics (throttle, brake, reverse,
handbrake, steering scaled by speed, terrain following with pitch/roll, obstacle hits). The
server steps vehicles each tick with the driver's latest input; occupants are attached to seat
positions. Traversal extras (launch pads, Spring Pads, mantling, gliding) live in `sim.ts`.

**Required components.** `shared/vehicle.ts`, `server/match.ts` (`updateVehicles`,
`enterVehicle`, `exitVehicle`, run-over damage, vehicle damage/explosions), `client/render/
worldview.ts` (`VehicleRenderer`, wheel spin, interpolation), `client/audio.ts` (engine loops).

**Data structures.**
```ts
VehicleDef { maxSpeed 27, reverseSpeed, accel, brake, steer, hp 700, radius, seats[4] }
VehicleState { id, type, x,y,z, yaw, pitch, roll, speed, vy, hp, seats: playerId[] }
```

**Networking considerations.** Vehicles are replicated in snapshots (≤ 450 m) and
interpolated for everyone except the driver. The driven vehicle is **predicted**: the server
steps it once per driver input (not per tick), quantizes it to f32 and sends its full state in
the driver's snapshot (`DriveSnap`); the client resets to it and replays unacknowledged inputs,
exactly like player movement. Empty vehicles coast/settle on the server tick.

**Core gameplay logic.** Enter/seat/exit actions; driver input drives the Rover; ramming
structures at speed damages them; running over enemies deals speed-scaled damage and
knockback; vehicles can be shot and explode (occupants ejected and damaged). Launch pads on
the summit and city roof, and deployable Spring Pads, launch players into skydive with glider
redeploy.

**Implementation steps.** ✅ Rover physics · ✅ seats, enter/exit · ✅ collisions, run-over,
damage, explosion · ✅ engine audio · ✅ launch/Spring Pads · ✅ client-side prediction of the
driven vehicle · ⏭ boats for the harbor · ⏭ ziplines.

**Testing requirements.** Enter → drive → exit; speed limits; collision damage; passenger
attachment; launch pad trajectory.
Covered by `tests/systems.test.ts` (enter/drive/exit, bit-identical vehicle replay) and the
browser e2e (drive a Rover with prediction active). ⏭ Add ramming and explosion tests.

---

## Phase 9 — UI and progression

**Architecture.** All UI is DOM over the WebGL canvas (`client/ui/*`, `public/style.css`) —
crisp at any resolution, easy to localize, and it keeps draw calls out of the 3D renderer.
Progression data and formulas are shared (`shared/progression.ts`) so the client can display
them, while all rewards are computed on the server (`ProfileStore.applyMatch`).

**Required components.** HUD (vitals, materials, hotbar, ammo/reload, build bar, minimap,
storm, alive/kills, team status, kill feed, prompts, channels, damage direction, hit markers,
toasts, spectate bar, scope, storm tint, victory), inventory screen, full map, menus (Play +
party, Locker, Challenges, Surge Pass, Shop, Career, Settings), matchmaking, pause and results
overlays, touch layout.

**Data structures.**
```ts
Profile { token, name, level, xp, seasonXp, currency, owned[], loadout, stats, challenges{day,week,progress,done}, lastMatchDay }
Cosmetic { id, slot: outfit|headwear|backpack|glider|trail|emote, rarity, source: default|level|tier|shop, colors?, style? }
MatchStats { kills, headshots, damage, chests, supplies, builds, harvested, healed, revives, rebirths, vehicleDist, landedPoi, phasesSurvived, placement, timeAlive, won, classKills }
```

**Networking considerations.** Profiles are sent on welcome and after changes; loadouts are
validated against owned items on the server; shop purchases use only earned currency.

**Core gameplay logic.** XP from survival time, placement, eliminations, caches, supply drops,
damage, team support and building, plus a first-match-of-the-day bonus and challenge rewards.
Level curve `1000 + 150·(level-1)` (capped 5,000). 40-tier season pass at 1,000 XP per tier
unlocks cosmetics and currency. Three daily + four weekly challenges rotate deterministically.
Cosmetics are purely visual (identical hitboxes).

**Implementation steps.** ✅ HUD · ✅ inventory · ✅ minimap/full map · ✅ menus & locker preview ·
✅ XP/levels/pass/challenges/currency/shop · ✅ results screen with XP breakdown · ✅ touch UI ·
⏭ accessibility pass (colorblind rarity palette, text scaling) · ⏭ localization.

**Testing requirements.** Reward math; level/tier rollovers; challenge progress; UI flows
(menu → match → results → menu).
Covered by `tests/systems.test.ts` (XP/levels/currency/shop) and the browser e2e (locker,
HUD, map, inventory, results, return with XP applied).

---

## Phase 10 — Optimization and polish

**Architecture & components.** See [ARCHITECTURE.md](ARCHITECTURE.md#performance).
Rendering: instancing, region culling, LOD, pooled FX, quality presets. Network: binary
snapshots, interest management, per-frame reconciliation, event batching. Server: spatial hash,
budgeted bot perception.

**Data structures.** Instance pools (`Pool`: ids ↔ instance indices, swap-remove, growth ×2);
region-split `InstancedMesh` for props; ring buffers for lag compensation; reusable byte writers.

**Networking considerations.** Snapshot size scales with visible players only; far entities are
culled; events are radius-filtered; reconnect and idle-filler handling keep flaky clients in sync.

**Core polish delivered.** Procedural audio for weapons, footsteps by surface, building,
harvesting, loot, UI, ambience (wind, birds, ocean), storm, vehicles, transport, cache hums,
victory/defeat music and menu music — all positional (HRTF) with distance muffling; hit
feedback; camera shake; FOV transitions; glider trails (cosmetic).

**Implementation steps.** ✅ instancing/culling/LOD · ✅ quality presets · ✅ binary protocol +
interest · ✅ reconciliation coalescing · ✅ slow-device catch-up · ⏭ web worker for map
generation · ⏭ texture atlases + GPU-driven culling · ⏭ delta-compressed snapshots ·
⏭ occlusion culling inside the city · ⏭ profiling budget CI job.

**Testing requirements.** Frame-time and draw-call budgets per quality tier (the e2e prints
`renderer.info`); server tick cost per player; bandwidth per client; soak tests with many bots.
Current reference numbers: 150–300 draw calls per frame; a 16-bot match simulates to completion
in < 1 s of CPU; 32 players ≈ 1 KB per snapshot per client.
