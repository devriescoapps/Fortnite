// Build script: bundles the browser client and the Node game server with esbuild.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

const client = {
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  outfile: 'dist/client/game.js',
  // classic script (not a module) so the build also runs from file:// and any static host
  format: 'iife',
  target: ['es2022'],
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
};

const server = {
  entryPoints: ['src/server/main.ts'],
  bundle: true,
  platform: 'node',
  outfile: 'dist/server.js',
  format: 'esm',
  target: ['node20'],
  sourcemap: true,
  packages: 'external',
  logLevel: 'info',
};

if (watch) {
  const c1 = await esbuild.context(client);
  const c2 = await esbuild.context(server);
  await Promise.all([c1.watch(), c2.watch()]);
  console.log('watching for changes...');
} else {
  await Promise.all([esbuild.build(client), esbuild.build(server)]);
}
