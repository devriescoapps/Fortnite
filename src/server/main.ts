// SURGEFALL game server: static file hosting + WebSocket gateway + fixed-rate simulation loop.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { ByteReader } from '../shared/binary';
import { GAME_NAME, PROTOCOL_VERSION, TICK_RATE } from '../shared/constants';
import { generateMap } from '../shared/mapdata';
import { MSG_INPUT, decodeInputs } from '../shared/protocol';
import { Terrain } from '../shared/terrain';
import { loadConfig } from './config';
import { Conn, Matchmaker } from './matchmaker';
import { ProfileStore, publicProfile, sanitizeName } from './profiles';

const cfg = loadConfig();
const t0 = Date.now();
const terrain = new Terrain();
const map = generateMap(terrain);
console.log(`[${GAME_NAME}] island generated in ${Date.now() - t0}ms: ${map.pieces.length} structure pieces, ${map.props.length} props`);

const profiles = new ProfileStore(cfg.dataDir);
const mm = new Matchmaker(cfg, { terrain, map }, profiles);

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const ROOT = resolve('.');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.map': 'application/json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function resolveStatic(url: string): string | null {
  const path = decodeURIComponent(url.split('?')[0]);
  const rel = path === '/' ? '/index.html' : path;
  const candidates = [join(ROOT, 'public', rel), join(ROOT, 'dist', 'client', rel)];
  for (const c of candidates) {
    const n = normalize(c);
    if (!n.startsWith(join(ROOT, 'public')) && !n.startsWith(join(ROOT, 'dist', 'client'))) continue;
    if (existsSync(n) && statSync(n).isFile()) return n;
  }
  return null;
}

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, matches: mm.matches.size, uptime: process.uptime() }));
    return;
  }
  const file = resolveStatic(req.url ?? '/');
  if (!file) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------------------
// WebSocket gateway
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
let nextConnId = 1;

wss.on('connection', (ws: WebSocket) => {
  let msgCount = 0;
  let windowStart = Date.now();
  let lastInputSeq = 0;
  const conn: Conn = {
    id: nextConnId++,
    profile: null,
    profileId: null,
    state: 'menu',
    match: null,
    player: null,
    party: null,
    queueMode: null,
    get open() {
      return ws.readyState === WebSocket.OPEN;
    },
    send(msg: unknown) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    sendBin(data: Uint8Array) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    },
  };

  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      msgCount = 0;
    }
    if (++msgCount > 300) {
      ws.close(1008, 'rate limit');
      return;
    }
    try {
      if (isBinary) {
        const buf = data as Buffer;
        const r = new ByteReader(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        if (r.u8() !== MSG_INPUT || !conn.player || conn.state !== 'match') return;
        for (const cmd of decodeInputs(r)) {
          if (cmd.seq <= lastInputSeq) continue; // replayed / duplicate
          lastInputSeq = cmd.seq;
          conn.player.queue.push({ kind: 'input', cmd });
        }
        return;
      }
      const msg = JSON.parse(data.toString());
      handle(conn, msg, () => (lastInputSeq = 0));
    } catch (err) {
      console.warn('[ws] bad message', (err as Error).message);
    }
  });

  ws.on('close', () => mm.onDisconnect(conn));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(c: Conn, msg: any, resetSeq: () => void) {
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t === 'hello') {
    let p = profiles.get(msg.token);
    if (!p) p = profiles.create(msg.name);
    else if (msg.name && typeof msg.name === 'string' && sanitizeName(msg.name) !== p.name) p.name = sanitizeName(msg.name);
    profiles.rollChallenges(p);
    c.profile = p;
    c.profileId = p.id;
    c.send({ t: 'welcome', token: p.token, profile: publicProfile(p), version: PROTOCOL_VERSION, tickRate: TICK_RATE });
    const active = mm.findActive(p.id);
    if (active && (!active.p.link || !active.p.link.open)) {
      c.state = 'match';
      c.match = active.m;
      c.player = active.p;
      resetSeq();
      active.m.reconnect(active.p, c);
      c.send({ t: 'msg', text: 'Reconnected to your match' });
    }
    return;
  }
  if (!c.profile) return;
  switch (msg.t) {
    case 'queue':
      if (c.state === 'menu') {
        resetSeq();
        mm.enqueue(c, msg.mode);
      }
      break;
    case 'cancel':
      mm.cancel(c);
      break;
    case 'act':
      if (c.player && c.state === 'match' && msg.a && typeof msg.a === 'object') c.player.queue.push({ kind: 'action', act: msg.a });
      break;
    case 'leave':
      if (c.match && c.player) c.match.leave(c.player);
      c.state = 'menu';
      c.match = null;
      c.player = null;
      c.send({ t: 'profile', profile: publicProfile(c.profile) });
      break;
    case 'equip':
      profiles.equip(c.profile, msg.loadout ?? {});
      c.send({ t: 'profile', profile: publicProfile(c.profile) });
      break;
    case 'buy': {
      const err = profiles.buy(c.profile, String(msg.id));
      if (err) c.send({ t: 'error', text: err });
      c.send({ t: 'profile', profile: publicProfile(c.profile) });
      break;
    }
    case 'rename':
      c.profile.name = sanitizeName(msg.name);
      profiles.markDirty();
      c.send({ t: 'profile', profile: publicProfile(c.profile) });
      break;
    case 'profile':
      c.send({ t: 'profile', profile: publicProfile(c.profile) });
      break;
    case 'party.create':
      mm.createParty(c);
      break;
    case 'party.join':
      mm.joinParty(c, msg.code);
      break;
    case 'party.leave':
      mm.leaveParty(c);
      break;
    case 'ping':
      c.send({ t: 'pong', c: msg.c, s: Date.now() });
      break;
    case 'dev':
      if (cfg.devCommands && c.match && c.player) c.match.dev(c.player, msg);
      break;
  }
}

// ---------------------------------------------------------------------------
// Fixed-rate loop (drift-corrected)
// ---------------------------------------------------------------------------

const TICK_MS = 1000 / TICK_RATE;
let next = performance.now();
function loop() {
  const now = performance.now();
  let n = 0;
  while (now >= next && n < 5) {
    mm.tick();
    next += TICK_MS;
    n++;
  }
  if (now - next > 250) next = now; // we fell far behind; skip ahead rather than spiral
  setTimeout(loop, Math.max(0, next - performance.now()));
}
loop();

server.listen(cfg.port, () => {
  console.log(`[${GAME_NAME}] listening on http://localhost:${cfg.port}  (max ${cfg.maxPlayers} players/match, bots ${cfg.fillBots ? 'on' : 'off'})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    profiles.flush();
    process.exit(0);
  });
}
