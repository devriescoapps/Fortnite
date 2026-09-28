// Export SURGEFALL for hosting:
//   export/surgefall-web.zip     static HTML5 build (index.html at the root). Upload it to itch.io,
//                                Netlify, GitHub Pages, Cloudflare Pages... It plays offline against
//                                bots: the game server runs inside the browser.
//   export/surgefall-server.zip  the real multiplayer server + client in one self-contained folder
//                                (no npm install needed). Run it with Node 20+ or Docker.
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipDir } from './zip.mjs';

const OUT = 'export';
const WEB = join(OUT, 'web');
const SRV = join(OUT, 'server');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(WEB, { recursive: true });
mkdirSync(join(SRV, 'dist', 'client'), { recursive: true });

const clientBuild = {
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'safari15'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
};

// ---- static web build (offline play) ----
// No game server on a static host: the bundle itself selects offline mode (no inline script,
// so hosts with a strict Content-Security-Policy work too).
await esbuild.build({ ...clientBuild, outfile: join(WEB, 'game.js'), banner: { js: 'window.SURGEFALL_MODE = window.SURGEFALL_MODE || "offline";' } });
cpSync('public', WEB, { recursive: true });

// ---- multiplayer server package ----
await esbuild.build({ ...clientBuild, outfile: join(SRV, 'dist', 'client', 'game.js') });
await esbuild.build({
  entryPoints: ['src/server/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs', // bundles `ws` too, so the folder runs without node_modules
  target: ['node20'],
  outfile: join(SRV, 'dist', 'server.cjs'),
  external: ['bufferutil', 'utf-8-validate'], // optional native speedups of ws
  minify: false,
  logLevel: 'warning',
});
cpSync('public', join(SRV, 'public'), { recursive: true });
writeFileSync(join(SRV, 'package.json'), JSON.stringify({
  name: 'surgefall-server', version: pkg.version, private: true, description: 'SURGEFALL multiplayer server (self-contained build)',
  engines: { node: '>=20' }, scripts: { start: 'node dist/server.cjs' },
}, null, 2) + '\n');
writeFileSync(join(SRV, 'Dockerfile'), `FROM node:22-alpine
WORKDIR /app
COPY . .
ENV PORT=8080
EXPOSE 8080
# profiles are stored in /app/data — mount a volume there to keep them across restarts
CMD ["node", "dist/server.cjs"]
`);
cpSync(join('docs', 'DEPLOY.md'), join(SRV, 'DEPLOY.md'));
writeFileSync(join(WEB, 'README.txt'), `SURGEFALL — static web build (${pkg.version})

Upload this folder (or surgefall-web.zip) to any static host. index.html is the entry point.
It plays offline: the game server runs in your browser and fills matches with bots.
For online multiplayer with friends, host surgefall-server.zip instead (see DEPLOY.md there).
`);

const web = zipDir(WEB, join(OUT, 'surgefall-web.zip'));
const srv = zipDir(SRV, join(OUT, 'surgefall-server.zip'));
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`export/surgefall-web.zip     ${web.files} files, ${kb(web.bytes)}  (static host / itch.io — offline vs bots)`);
console.log(`export/surgefall-server.zip  ${srv.files} files, ${kb(srv.bytes)}  (Node 20+ or Docker — online multiplayer)`);
if (!existsSync(join(WEB, 'index.html'))) throw new Error('missing index.html');
