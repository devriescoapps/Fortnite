// Global tunables shared by client and server. Units: meters, seconds, radians.

export const GAME_NAME = 'SURGEFALL';
export const PROTOCOL_VERSION = 3;

// ---- Simulation timing ----
export const TICK_RATE = 30; // server world ticks per second
export const TICK_DT = 1 / TICK_RATE;
export const INPUT_RATE = 60; // player input commands per second (fixed step)
export const INPUT_DT = 1 / INPUT_RATE;
export const INTERP_DELAY = 0.1; // seconds remote entities are rendered in the past
export const MAX_LAG_COMP = 0.3; // max rewind for lag compensation (seconds)

// ---- World ----
export const MAP_HALF = 640; // island region spans [-MAP_HALF, MAP_HALF] on X and Z
export const MAP_SIZE = MAP_HALF * 2;
export const TERRAIN_RES = 4; // meters between heightmap samples
export const TERRAIN_N = MAP_SIZE / TERRAIN_RES + 1; // samples per side
export const WATER_LEVEL = 0;
export const GRID = 4; // build grid cell size (and level height)
export const MAP_SEED = 0x5ea5f011; // fixed island layout seed

// Pre-game waiting area ("Skyport") floats south of the island.
export const SKYPORT = { x: 0, y: 70, z: 860, halfX: 36, halfZ: 28 };

// ---- Player ----
export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.2;
export const DOWNED_HEIGHT = 0.8;
export const EYE_HEIGHT = 1.6;
export const CROUCH_EYE = 1.05;
export const STEP_HEIGHT = 0.6;
export const MAX_HEALTH = 100;
export const MAX_SHIELD = 100;
export const DOWNED_HEALTH = 100;
export const DOWNED_BLEED = 3; // hp/s while downed
export const REVIVE_TIME = 5;
export const REVIVE_HEALTH = 30;

export const MOVE = {
  run: 6.2,
  sprint: 8.4,
  crouch: 3.2,
  ads: 3.9,
  downed: 1.4,
  swim: 3.6,
  groundAccel: 70,
  airAccel: 14,
  gravity: 22,
  jumpVel: 7.4,
  slideBoost: 11,
  slideFriction: 5.5,
  slideMinSpeed: 4.2,
  slideCooldown: 1.2,
  mantleTime: 0.32,
  skydiveFall: 32,
  skydiveDiveFall: 55,
  skydiveHoriz: 13,
  glideFall: 7.5,
  glideHoriz: 15,
  glideAutoDeploy: 85, // meters above ground
  minManualDeploy: 22,
  terminalFall: 60,
  fallDamageSpeed: 17, // landing speed above which fall damage applies
  fallDamagePerMps: 6,
  launchPadVel: 30,
};

// ---- Building ----
export const BUILD_RANGE = 10;
export const BUILD_COST = 10;
export const BUILD_INTERVAL = 0.1; // min seconds between placements
export const MAX_MATERIAL = 500;

// ---- Inventory ----
export const INVENTORY_SLOTS = 5; // plus the harvest tool in slot 0
export const PICKUP_RANGE = 3.2;
export const INTERACT_RANGE = 3.2;

// ---- Match ----
export const MATCH_DEFAULTS = {
  maxPlayers: 32,
  lobbyTime: 20, // seconds in the pre-game waiting area
  busTime: 55, // seconds the transport flies before force-ejecting everyone
  busDoorsOpen: 3,
  busSpeed: 34,
  busAltitude: 190,
  endLinger: 12, // seconds after victory before match is closed
  reconnectGrace: 45,
  rebirthWindowPhase: 4, // rebirth spires work until this storm phase
  chipLifetime: 90,
};

export type Mode = 'solo' | 'duos' | 'squads';
export const TEAM_SIZE: Record<Mode, number> = { solo: 1, duos: 2, squads: 4 };

export const TEAM_COLORS = ['#ffd23f', '#3fd0ff', '#ff5fa2', '#7dff6a'];
