// SURGEFALL game server: static file hosting + WebSocket gateway + fixed-rate simulation loop.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { GAME_NAME } from '../shared/constants';
import { generateMap } from '../shared/mapdata';
import { Terrain } from '../shared/terrain';
import { loadConfig } from './config';
import { Gateway, startLoop } from './gateway';
import { Matchmaker } from './matchmaker';
import { ProfileStore } from './profiles';
import { fileBackend } from './profiles-fs';

const cfg = loadConfig();
const t0 = Date.now();
const terrain = new Terrain();
const map = generateMap(terrain);
console.log(`[${GAME_NAME}] island generated in ${Date.now() - t0}ms: ${map.pieces.length} structure pieces, ${map.props.length} props`);

const profiles = new ProfileStore(fileBackend(cfg.dataDir));
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
// WebSocket gateway (session logic lives in gateway.ts, shared with offline play)
// ---------------------------------------------------------------------------

const gateway = new Gateway(cfg, mm, profiles);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws: WebSocket) => {
  const session = gateway.connect({
    get open() {
      return ws.readyState === WebSocket.OPEN;
    },
    send(msg: unknown) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    sendBin(data: Uint8Array) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    },
  });
  ws.on('message', (data, isBinary) => {
    try {
      let ok: boolean;
      if (isBinary) {
        const buf = data as Buffer;
        ok = session.binary(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      } else ok = session.text(JSON.parse(data.toString()));
      if (!ok) ws.close(1008, 'rate limit');
    } catch (err) {
      console.warn('[ws] bad message', (err as Error).message);
    }
  });
  ws.on('close', () => session.closed());
});

startLoop(() => mm.tick());

server.listen(cfg.port, () => {
  console.log(`[${GAME_NAME}] listening on http://localhost:${cfg.port}  (max ${cfg.maxPlayers} players/match, bots ${cfg.fillBots ? 'on' : 'off'})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    profiles.flush();
    process.exit(0);
  });
}
