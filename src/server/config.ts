// Server configuration (env overridable).
import { MATCH_DEFAULTS } from '../shared/constants';

export interface ServerConfig {
  port: number;
  dataDir: string;
  maxPlayers: number; // per match, humans + bots
  lobbyTime: number;
  queueWait: number; // seconds to gather humans before starting a match
  stormScale: number; // multiplies storm timings (e.g. 0.3 for quick test matches)
  botSkill: number; // 0..1 average bot skill
  fillBots: boolean;
  maxMatches: number;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export function loadConfig(): ServerConfig {
  const e = process.env;
  return {
    port: num(e.PORT, 8080),
    dataDir: e.DATA_DIR || 'data',
    maxPlayers: Math.max(2, Math.min(64, num(e.MAX_PLAYERS, MATCH_DEFAULTS.maxPlayers))),
    lobbyTime: num(e.LOBBY_TIME, MATCH_DEFAULTS.lobbyTime),
    queueWait: num(e.QUEUE_WAIT, 4),
    stormScale: num(e.STORM_SCALE, 1),
    botSkill: Math.max(0, Math.min(1, num(e.BOT_SKILL, 0.5))),
    fillBots: e.FILL_BOTS !== '0',
    maxMatches: num(e.MAX_MATCHES, 8),
  };
}
