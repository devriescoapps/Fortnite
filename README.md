# SURGEFALL

An original, stylized **third-person multiplayer battle royale** that runs in the browser.
Drop from a flying whale-blimp onto a handcrafted island, loot, build, fight and outlast
**the Surge** — a violet energy storm that shrinks the playable zone.

SURGEFALL is inspired by the *genre* (drop → loot → build → fight → shrinking zone → last
one standing). All names, characters, map, weapons, UI, art and sounds are original — every
model is built from code primitives, every texture is drawn procedurally at runtime and every
sound is synthesized with WebAudio. There are no external art or audio assets.

| | |
|---|---|
| **Client** | TypeScript + Three.js, HTML/CSS UI, WebAudio synthesis, keyboard/mouse, touch and gamepad |
| **Server** | Node.js + `ws`, authoritative 30 Hz simulation, binary snapshots, bots |
| **Shared** | Deterministic simulation code used by both sides (movement, weapons, building, collision, map) |
| **Tests** | 31 Vitest tests (unit, full-match simulations, networked integration) + Playwright browser e2e |

## Quick start

```bash
npm install
npm run play          # build + start on http://localhost:8080
```

Open http://localhost:8080, press **PLAY**. Open seats are filled with bots, so a single
player gets a full match. Open a second tab (or share your LAN address) for real multiplayer;
use **Create party** + a party code to queue on the same team.

Development: `npm run dev` (esbuild watch) in one terminal and `npm start` in another.

### Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | HTTP + WebSocket port |
| `MAX_PLAYERS` | 32 | Players per match (humans + bots) |
| `LOBBY_TIME` | 20 | Seconds in the pre-game Skyport |
| `QUEUE_WAIT` | 4 | Seconds to gather humans before creating a match |
| `STORM_SCALE` | 1 | Multiplies all storm timings (e.g. `0.4` for quick matches) |
| `BOT_SKILL` | 0.5 | Average bot skill 0..1 |
| `FILL_BOTS` | 1 | `0` disables bot fill |
| `MAX_MATCHES` | 8 | Concurrent matches per server |
| `DATA_DIR` | `data` | Profile storage |
| `DEV_COMMANDS` | off | `1` enables test-only teleport/give commands. Never enable in production. |

## How to play

| Action | Keyboard / mouse | Gamepad | Touch |
|---|---|---|---|
| Move / look | WASD / mouse | Left / right stick | Left joystick / drag right side |
| Jump · mantle · deploy glider | Space | A | JUMP |
| Sprint | Shift (hold or toggle) | L3 | RUN or push stick far |
| Crouch · slide (while sprinting) | C / Ctrl | B | CROUCH |
| Fire · aim down sights | LMB · RMB | RT · LT | FIRE · AIM |
| Reload | R | X | R |
| Interact / pick up / open / revive / drive | E (hold for caches, revives) | X (hold) | USE |
| Exit vehicle | F | | |
| Harvest tool / slots | 1 · 2–6 · wheel | LB / RB | tap hotbar |
| Build mode · pieces · material · edit wall | Q · F1–F4 · G · T | Y · LB/RB · D-pad up | BUILD · WALL/FLOOR/RAMP/ROOF/MAT |
| Drop held item | X | D-pad down | inventory |
| Inventory · map · ping · emotes | Tab · M · V / MMB · B, N | Menu buttons | BAG · MAP |

**Match flow:** Main menu → Play → matchmaking → **Skyport** (pre-game warm-up; building is
free) → the **Skywhale** flies across the island (jump when you like) → skydive → auto-deploy
glider → loot → fight → Surge phases shrink the map → last team standing wins
(**Surge Survivor**) → results with XP breakdown → back to lobby.

**Modes:** Solo · Duos · Squads. Team modes add knock-downs, revives and *Rebirth Chips*
(carry a fallen teammate's chip to a Rebirth Spire to bring them back, until Surge phase 4).

## Feature overview

- **Island** (1.28 km): 9 named locations with distinct identity — Glasspoint City (glass
  towers), Haybale Hollow (farm town & barn), Rustworks (warehouses & container yard), Saltwind
  Harbor (lighthouse & docks), Frostpeak Lookout (snowy summit), Site Null (abandoned facility)
  with **The Undervault** bunker below it, Sunscorch Mesa (desert terraces), Mossgrove Lodge
  (dense forest & Mirror Lake), Pitstop Junction (gas station & Rovers). Roads, beaches, a lake,
  cliffs, ~3,700 props and ~3,000 destructible building pieces.
- **Everything is destructible & harvestable**: map buildings are made of the same build pieces
  as player structures (with the same structural integrity — knock out the ground floor and the
  floors above collapse, loot falls); smash them (and trees, rocks, cars) with the Pry Hammer
  for Timber / Stone / Alloy.
- **Building**: walls, floors, ramps, roofs on a 4 m grid; snapping previews (blue/red), build-up
  health, material cost, rate limit, range and support validation, structural collapse, wall
  editing (door/window), instant client-side prediction for ramp rushing.
- **Combat**: ARs, burst rifle, SMGs, pump & auto shotguns, bolt sniper & DMR, pistols,
  revolver, rocket launcher, grenades, smoke, melee bat; rarity tiers (Common → Legendary)
  scale damage/reload/spread; hip-fire bloom vs aim-down-sights, recoil, headshots, damage
  falloff, shields, tracers, hit markers, damage numbers, knock-downs. Sniper rounds are
  ballistic (travel time and bullet drop) with lag compensation along the shooter's timeline.
- **Loot**: floor loot, caches (with hum audio + glow), ammo crates, supply drops by balloon,
  rare-loot locations (Undervault vault, city spire roof, lighthouse, summit).
- **Movement**: sprint, crouch, slide, jump, mantle, fall damage, skydive with dive control,
  glider, swimming, launch pads & Spring Pads (glider redeploy), Dune Rover vehicles.
- **The Surge**: 7 phases, randomized circles fully inside the previous one, rising damage,
  on-map next circle + safe-zone line + timer + distance.
- **Progression**: levels, season pass (40 tiers), daily/weekly challenges, currency
  (*Glimmer*) earned by playing, rotating cosmetic shop, locker (outfits, headwear,
  backpacks, gliders, trails, emotes). Cosmetics never affect hitboxes or stats.
- **Multiplayer**: server-authoritative everything, client prediction + reconciliation (also for
  the vehicle you drive),
  interpolation, lag-compensated hitscan and bullets, interest management, binary snapshots,
  reconnect, spectating, parties, bots that use the exact same input pipeline as humans.
- **Platforms**: desktop (keyboard/mouse, gamepad), mobile (touch controls, auto low quality),
  quality presets (shadows, draw distance, pixel ratio).

## Project layout

```
src/shared/   deterministic game code used by both server and client
  constants.ts  tunables         sim.ts       player movement + weapon state machine
  terrain.ts    heightmap        collision.ts spatial-hash collision + raycasts
  mapdata.ts    island content   build.ts     build grid, support graph, targeting
  items.ts      weapons & items  storm.ts     shrinking zone
  vehicle.ts    Rover physics    protocol.ts  binary + JSON wire formats
  progression.ts levels/pass/challenges/cosmetics
src/server/   authoritative server
  main.ts  http+ws gateway, loop     matchmaker.ts queues, parties, matches
  match.ts match lifecycle, combat, loot, storm, vehicles, replication
  bot.ts   AI players                profiles.ts   persistence + rewards
src/client/   browser client
  game.ts  prediction, interpolation, camera, events   input.ts audio.ts net.ts
  render/  environment, world view, characters, models, effects
  ui/      hud, menus, minimap
tests/        vitest suites        scripts/  build + browser e2e
docs/         design documents
```

## Testing

```bash
npm run typecheck
npm test                      # 31 tests: sim, systems, full bot matches, networked play
DEV_COMMANDS=1 npm start &    # then, in another shell:
QUALITY=low npm run e2e -- http://localhost:8080 screenshots
```

The e2e script drives the real game in headless Chromium: menu → locker → lobby → build →
transport → jump → skydive/glide → land → loot a cache → harvest → fight → fire a ballistic
DMR → drive a Rover →
map → inventory → results/spectate → back to lobby with XP applied, saving screenshots of each
step. Options: `MODE=duos|squads`, `FORCE_ELIM=1` (exercise results/spectating), `QUALITY=low|medium|high`.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system architecture, networking model, anti-cheat, performance
- [docs/PHASES.md](docs/PHASES.md) — the 10 development phases, each with architecture, components,
  data structures, networking, gameplay logic, implementation steps and testing requirements
- [docs/GAME_DESIGN.md](docs/GAME_DESIGN.md) — the original game bible: world, locations, weapons,
  items, economy, progression, art and audio direction

## Status and honest limitations

This is a playable, tested prototype, not a shipped product. Notable gaps (tracked in
[docs/PHASES.md](docs/PHASES.md)): the underground bunker has no special lighting pass; bots navigate with local avoidance rather than
a navmesh; persistence is a JSON file (swap for a database for real deployments); a single
server process hosts all matches (no horizontal scaling/region routing); there is no
skill-based matchmaking.
