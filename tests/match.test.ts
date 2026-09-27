import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../src/server/config';
import { Match } from '../src/server/match';
import { generateMap } from '../src/shared/mapdata';
import { Terrain } from '../src/shared/terrain';
import { Mode } from '../src/shared/sim';

const terrain = new Terrain();
const map = generateMap(terrain);

function cfg(over: Partial<ServerConfig> = {}): ServerConfig {
  return { port: 0, dataDir: 'data-test', maxPlayers: 16, lobbyTime: 3, queueWait: 0, stormScale: 0.35, botSkill: 0.6, fillBots: true, maxMatches: 1, devCommands: false, ...over };
}

function runToEnd(m: Match, maxTicks: number) {
  const phases = new Set<string>();
  let t = 0;
  for (; t < maxTicks && m.phase !== 'ended'; t++) {
    m.update();
    phases.add(m.phase);
  }
  return { ticks: t, phases };
}

describe('bot-only match simulation', () => {
  it('runs a full solo match from lobby to a single winner', () => {
    const m = new Match({ mode: 'solo', cfg: cfg(), island: { terrain, map }, profiles: null, seed: 1234, allowBotOnly: true });
    m.fillBots();
    expect(m.players.size).toBe(16);
    const t0 = Date.now();
    const { ticks, phases } = runToEnd(m, 30 * 60 * 12);
    const elapsed = Date.now() - t0;
    console.log(`solo match: ${ticks} ticks (${(ticks / 30).toFixed(0)}s game time) in ${elapsed}ms, winner team ${m.winnerTeam}`);
    expect(phases.has('bus')).toBe(true);
    expect(phases.has('play')).toBe(true);
    expect(m.phase).toBe('ended');
    const alive = [...m.players.values()].filter((p) => p.alive);
    expect(alive.length).toBeLessThanOrEqual(1);
    const kills = [...m.players.values()].reduce((a, p) => a + p.stats.kills, 0);
    const chests = [...m.players.values()].reduce((a, p) => a + p.stats.chests, 0);
    const picked = [...m.players.values()].filter((p) => p.sim.inv.slots.some((s, i) => i > 0 && s)).length;
    console.log(`kills=${kills} chests=${chests} playersWithItems=${picked}`);
    expect(kills).toBeGreaterThan(0);
  }, 120000);

  it('runs a squads match with downs, and ends with one team', () => {
    const m = new Match({ mode: 'squads', cfg: cfg({ maxPlayers: 16 }), island: { terrain, map }, profiles: null, seed: 99, allowBotOnly: true });
    m.fillBots();
    expect(m.teams.size).toBe(4);
    let downs = 0;
    const orig = m.broadcast.bind(m);
    m.broadcast = (ev: unknown, opt?: Parameters<Match['broadcast']>[1]) => {
      const e = ev as { e?: string; kn?: number };
      if (e.e === 'feed' && e.kn) downs++;
      orig(ev, opt);
    };
    runToEnd(m, 30 * 60 * 12);
    expect(m.phase).toBe('ended');
    expect(m.aliveTeams().length).toBeLessThanOrEqual(1);
    console.log(`squads: downs=${downs}`);
  }, 120000);

  it('players in the bus can jump once doors open', () => {
    const m = new Match({ mode: 'solo', cfg: cfg({ maxPlayers: 4 }), island: { terrain, map }, profiles: null, seed: 5, allowBotOnly: true });
    m.fillBots();
    while (m.phase === 'lobby') m.update();
    expect([...m.players.values()].every((p) => p.sim.mode === Mode.Bus)).toBe(true);
    for (let i = 0; i < 30 * 60 && m.phase === 'bus'; i++) m.update();
    expect([...m.players.values()].every((p) => p.sim.mode !== Mode.Bus)).toBe(true);
  });
});
