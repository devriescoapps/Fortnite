# Architecture

## Overview

```
 Browser client (per player)                          Node game server (one process)
┌──────────────────────────────────────┐            ┌───────────────────────────────────────────┐
│ Input (KBM / touch / gamepad)         │            │ main.ts  HTTP static + WebSocket gateway  │
│   └─► InputCmd @60Hz ──────────────── binary ───►  │   rate limits, message validation         │
│ Prediction: stepSim (shared) ◄─┐      │            │ Matchmaker: queues, parties, lobbies      │
│ Reconciliation (once per frame)│      │            │ Match (x N) ── fixed 30 Hz tick ────────┐ │
│ Interpolation of remote players│      │  ◄── binary snapshots (30 Hz, per-client interest) │ │
│ Three.js renderer + HTML HUD   │      │  ◄── JSON events (batched per tick)               │ │
│ WebAudio synth                 │      │            │  inputs+actions queue ─► stepSim         │ │
└────────────────────────────────┘      │            │  combat (lag comp), building, loot,     │ │
          shared/ (identical code) ─────┴────────────│  storm, vehicles, projectiles, bots     │ │
                                                     │ ProfileStore (JSON) — XP, pass, shop    │ │
                                                     └───────────────────────────────────────────┘
```

The single most important decision: **gameplay code lives in `src/shared/` and runs on both
sides.** The island is generated deterministically from a fixed seed (`MAP_SEED`), so both sides
build byte-identical terrain, structures, props and collision without transferring map data.
Per-match variety (loot rolls, chest presence, storm circles, transport path, vehicle spawns,
supply drops) comes from a per-match seed on the server and is replicated as events.

## Networking model

### Transport
One WebSocket per client (TCP: ordered + reliable).
- **Binary** for high-frequency traffic: input batches (21 bytes/command) and snapshots
  (`protocol.ts`, `binary.ts`).
- **JSON** for low-frequency reliable events, batched once per tick into `{t:'ev', l:[...]}`.

### Inputs as the only authority channel
Clients never send positions, hits or inventory results. They send:
- `InputCmd { seq, mx, mz, yaw, pitch, buttons, slot, viewTick }` at 60 Hz.
- `Action`s (build, pickup, drop, swap, interact, emote, ping, ...) that are **queued in the same
  per-player queue as inputs**, so the server applies them against exactly the state the client
  predicted.

### Server simulation
- Each match ticks at 30 Hz (`TICK_RATE`); each player's queued commands are simulated with the
  shared `stepSim` at a fixed 1/60 s step.
- **Input budget** (anti speed-hack): each player earns 1/30 s of simulation time per tick; a
  command costs 1/60 s. A client cannot run faster than real time.
- **Idle filler**: if a client stops sending (tab hidden, lag), the server keeps simulating it
  with idle inputs (gravity, storm damage apply). Real inputs that arrive later replace the
  fillers' time slots (`fillerDebt`) so a stalled client catches up without being throttled —
  fillers carry zero movement, so this cannot be used to gain speed.
- After every step the server rounds the simulation state to 32-bit floats (`quantizeSim`),
  which is exactly what the client receives. Client replays are therefore **bit-identical** to the
  server (verified by `tests/systems.test.ts`).

### Client prediction & reconciliation (`client/game.ts`)
1. Each 1/60 s the client samples input, stores it in `pending`, sends it, and runs `stepSim`
   locally (instant movement, firing, reloads, consumables, building ghosts).
2. Snapshots carry the full authoritative self state plus `ack` = last processed `seq`.
   Only the newest snapshot is kept; once per frame the client resets to it and replays all
   commands newer than `ack`.
3. Any residual difference is hidden with an exponentially decaying visual offset (snap if > 3 m).
4. Transport, vehicle and dead states are server-driven (not predicted).

### Remote entities
Rendered `INTERP_DELAY` = 100 ms in the past, interpolating between buffered snapshots
(position, yaw, pitch; discrete flags from the nearer sample). The client clock tracks server time
with a smoothed offset.

### Lag-compensated hit detection
- Every input carries `viewTick` = the server tick the client was rendering.
- The server keeps a ring buffer of each player's position/crouch/mode per tick
  (`ServerPlayer.record/posAt`) and rewinds targets to `viewTick` (clamped to `MAX_LAG_COMP` =
  300 ms) when testing hitscan rays and melee.
- Shot directions (including spread and shotgun pellets) are derived from a seed
  `hash(playerId, shotSeq)`, so client tracers and server hits agree without sending directions.

### Interest management & bandwidth
- Snapshots include players within 420 m (always teammates and the spectated player), vehicles
  and projectiles within 450 m. Enemy health is never sent (only teammates/spectated).
- Spatially relevant events (shots, sounds, harvest FX) are only sent within a radius.
- Typical snapshot: ~30 bytes per visible player; a 32-player match is a few KB/s per client.

### Reliability & sessions
- Profiles are keyed by a random token stored in `localStorage`.
- Disconnects mid-match leave the character in the world for `reconnectGrace` (45 s);
  reconnecting with the same token resumes control (`tests/net.test.ts`).
- Leaving mid-match eliminates the character and applies provisional results.

## Anti-cheat summary

| Threat | Mitigation |
|---|---|
| Teleport / speed hacks | Server simulates movement from inputs only; real-time input budget; client positions are never trusted |
| Fire-rate / infinite ammo | Weapon state machine (cooldown, mag, reload) runs on the server |
| Aimbot-style impossible hits | Hits resolved server-side from server positions; rewind window capped at 300 ms |
| Shooting/looting through walls | World raycasts block hitscan; line-of-sight required for pickups and caches |
| Build spam / illegal pieces | Rate limit, material cost, range, grid validity and support checks |
| Inventory tampering | Inventory only changes on the server; clients receive it in snapshots |
| Wallhacks via replication | Interest radius, no enemy health in snapshots |
| XP / currency tampering | All rewards computed server-side from server-side match stats |
| Flooding | Message rate limit (300/s), 16 KB payload cap, input queue cap, duplicate `seq` rejection |

## Performance

**Client**
- Instanced props split into 256 m regions (frustum + distance culled per region).
- Build pieces use growable instanced pools per (piece shape × material): ~3,000 pieces in ~30
  draw calls. Typical frame: 150–300 draw calls.
- Terrain: 100 indexed chunks with baked vertex colors (frustum culled).
- Character LOD: far players render as a single capsule; tags/numbers are pooled DOM.
- Pooled effects: one LineSegments for all tracers, one Points system for all particles.
- Quality presets: shadows (off/1024/2048), pixel ratio, draw distance, antialiasing; mobile
  defaults to low.
- Fixed-step simulation catches up to 250 ms per frame, so slow devices keep real-time speed.

**Server**
- Spatial hash (8 m cells) for all colliders; 2D DDA raycasts; terrain ray-march with bisection.
- Bots think at ~5 Hz with budgeted line-of-sight checks.
- A 16-bot match simulates its full 5–8 minutes in under 1 s of CPU (`tests/match.test.ts`).
