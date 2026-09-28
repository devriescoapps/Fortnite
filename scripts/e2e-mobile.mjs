// Mobile end-to-end test: real multi-touch (via the Chrome DevTools protocol) on an emulated phone.
// Usage: node scripts/e2e-mobile.mjs [url] [outDir]
//   url should allow test helpers: a dev server (DEV_COMMANDS=1) or an offline build with ?dev=1.
// Env: DEVICE="iPhone 13 Pro Max landscape" (any Playwright device), EXPECT_OFFLINE=1.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node22/lib/node_modules/playwright');
}

const url = process.argv[2] ?? 'http://localhost:8080';
const out = process.argv[3] ?? 'screenshots/mobile';
const deviceName = process.env.DEVICE || 'iPhone 13 Pro Max landscape';
mkdirSync(out, { recursive: true });

const browser = await playwright.chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const device = playwright.devices[deviceName];
if (!device) throw new Error(`unknown device ${deviceName}`);
const context = await browser.newContext({ ...device });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/ERR_CERT|fonts\.g/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let failures = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  ${info}` : ''}`);
  if (!ok) failures++;
};
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const sleep = (ms) => page.waitForTimeout(ms);
/** Wait for a condition in the page (software-rendered frames can be slow); resolves true/false. */
const waitFor = (fn, arg, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
const g = (fn, arg) => page.evaluate(fn, arg);

// --- multi-touch helpers (CDP keeps a list of active points) ---
const active = new Map();
const pts = () => [...active.values()];
async function touchDown(id, x, y) {
  active.set(id, { x, y, id, radiusX: 8, radiusY: 8, force: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts() });
}
async function touchMove(id, x, y) {
  active.set(id, { ...active.get(id), x, y });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts() });
}
async function touchUp(id) {
  active.delete(id);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: pts() });
}
async function center(sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`no box for ${sel}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function press(sel, holdMs = 120) {
  const c = await center(sel);
  await touchDown(90, c.x, c.y);
  await sleep(holdMs);
  await touchUp(90);
}
const ctx = () => g(() => document.getElementById('touch')?.dataset.ctx);
const visible = (sel) => g((s) => {
  const e = document.querySelector(s);
  return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
}, sel);
const sim = () => g(() => {
  const m = window.game.m;
  return m && { x: m.sim.x, y: m.sim.y, z: m.sim.z, mode: m.sim.mode, slot: m.sim.slot, yaw: window.game.view.yaw, phase: m.phase, slots: m.sim.inv.slots.map((s) => s && s.code), mag: m.sim.inv.slots.map((s) => s && s.mag) };
});
const vw = device.viewport.width, vh = device.viewport.height;

/** Visible touch buttons and HUD blocks must not overlap each other. */
async function overlapCheck(label) {
  const pairs = await g(() => {
    const sels = ['#touch > .t-btn:not(.off)', '.hud-bc .hslot', '#minimap', '.hud-bl', '.storm-info', '.hud-stats', '#touch .t-build-row:not(.off) .t-btn'];
    const boxes = [];
    for (const s of sels) for (const e of document.querySelectorAll(s)) {
      if (getComputedStyle(e).display === 'none' || e.closest('.off, .hidden')) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      boxes.push({ n: `${e.className || e.id}`.trim().split(' ').slice(0, 2).join('.'), r, parent: s });
    }
    const hits = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 2 && h > 2 && boxes[i].parent !== boxes[j].parent) hits.push(`${boxes[i].n} × ${boxes[j].n}`);
      if (w > 2 && h > 2 && boxes[i].parent === boxes[j].parent && boxes[i].parent !== '.hud-bc .hslot') hits.push(`${boxes[i].n} × ${boxes[j].n}`);
    }
    const off = boxes.filter((b) => b.r.left < -1 || b.r.top < -1 || b.r.right > innerWidth + 1 || b.r.bottom > innerHeight + 1).map((b) => `${b.n} off-screen`);
    return [...hits, ...off];
  });
  check(`no overlapping/off-screen controls (${label})`, pairs.length === 0, pairs.slice(0, 6).join(', '));
}

// ---------------------------------------------------------------- menu
await page.goto(url);
await page.waitForSelector('.play-btn', { timeout: 40000 });
await page.waitForFunction(() => window.game?.profile, null, { timeout: 20000 });
await sleep(600);
await shot('m01-menu');
check('touch mode active', await g(() => window.game.touchMode && document.body.classList.contains('touch')));
if (process.env.EXPECT_OFFLINE) check('offline mode (server runs in the browser)', await g(() => window.game.offline === true));
const playBox = await page.locator('#play').boundingBox();
check('PLAY button fully visible without scrolling', !!playBox && playBox.y >= 0 && playBox.y + playBox.height <= vh + 1, JSON.stringify(playBox));
check('menu tabs stay on one row', await g(() => new Set([...document.querySelectorAll('.tab')].map((t) => t.offsetTop)).size === 1));
check('touch controls help shown', await g(() => document.querySelector('.menu-right')?.textContent.includes('Drag anywhere to look')));
await page.tap('.tab[data-tab=settings]');
await sleep(300);
check('touch settings present', await g(() => !!document.querySelector('[data-set=touchSensitivity]') && !!document.querySelector('[data-set=buttonScale]')));
await shot('m02-settings');
await page.tap('.tab[data-tab=play]');
await sleep(200);
await page.tap('#play');
await page.waitForFunction(() => window.game?.state === 'match', null, { timeout: 30000 });
await sleep(1800);
await shot('m03-lobby');
check('touch controls visible in match', await visible('#touch'));
check('walk controls in the Skyport', (await ctx()) === 'walk', await ctx());

// ---------------------------------------------------------------- stick, look, multi-touch
let s0 = await sim();
await touchDown(1, 90, vh - 90);
for (let i = 1; i <= 6; i++) {
  await touchMove(1, 90, vh - 90 - i * 10);
  await sleep(40);
}
await sleep(900);
let s1 = await sim();
await touchUp(1);
const moved = Math.hypot(s1.x - s0.x, s1.z - s0.z);
check('joystick moves the player', moved > 1, `${moved.toFixed(2)} m`);

s0 = await sim();
await touchDown(2, vw * 0.62, vh * 0.4);
for (let i = 1; i <= 8; i++) {
  await touchMove(2, vw * 0.62 - i * 15, vh * 0.4);
  await sleep(30);
}
await touchUp(2);
await sleep(200);
s1 = await sim();
check('dragging the right side turns the camera', Math.abs(s1.yaw - s0.yaw) > 0.2, `${(s1.yaw - s0.yaw).toFixed(2)} rad`);

s0 = await sim();
await touchDown(1, 90, vh - 90);
await touchDown(2, vw * 0.62, vh * 0.35);
for (let i = 1; i <= 8; i++) {
  await touchMove(1, 90 + i * 8, vh - 90);
  await touchMove(2, vw * 0.62 + i * 12, vh * 0.35);
  await sleep(50);
}
await sleep(600);
s1 = await sim();
await touchUp(2);
await touchUp(1);
check('move + look at the same time (two fingers)', Math.hypot(s1.x - s0.x, s1.z - s0.z) > 0.5 && Math.abs(s1.yaw - s0.yaw) > 0.2);

await overlapCheck('walk');

// ---------------------------------------------------------------- transport + drop
await page.waitForFunction(() => window.game?.m?.phase === 'bus' && window.game.m.sim.mode === 5, null, { timeout: 60000 });
await page.waitForFunction(() => { const m = window.game.m; return m.bus && window.game.serverNow() > m.bus.t0 + 3.5; }, null, { timeout: 20000 });
check('transport shows the DROP button', (await ctx()) === 'bus' && (await g(() => document.querySelector('#touch .t-jump').textContent)) === 'DROP');
await shot('m05-bus');
await press('#touch .t-jump');
await page.waitForFunction(() => [1, 2].includes(window.game.m.sim.mode), null, { timeout: 20000 });
check('DROP jumps out; air controls', (await ctx()) === 'air');
await shot('m06-air');

// land quickly next to Pitstop Junction and gear up (test helpers)
await g(() => window.game.net.send({ t: 'dev', cmd: 'teleport', x: -30, z: 150 }));
await page.waitForFunction(() => window.game.m.sim.mode === 0, null, { timeout: 30000 });
await g(() => {
  const n = window.game.net;
  n.send({ t: 'dev', cmd: 'give', id: 'vanguard', rarity: 2 });
  n.send({ t: 'dev', cmd: 'give', id: 'ammo_medium' });
  n.send({ t: 'dev', cmd: 'give', id: 'patch' });
  n.send({ t: 'dev', cmd: 'give', id: 'mat_timber' });
  n.send({ t: 'dev', cmd: 'god' }); // bots are live: keep the test player alive
});
await sleep(1200);

// ---------------------------------------------------------------- build (materials from the test helper)
await press('#touch .t-build');
await sleep(400);
check('BUILD switches to build controls', (await ctx()) === 'build' && (await visible('#touch .t-build-row')) && !(await visible('.hud-bc')));
await g(() => { window.game.view.pitch = -0.12; });
await sleep(300);
const piecesBefore = await g(() => window.game.grid.pieces.size + window.game.m.predicted.size);
await press('#touch .t-fire');
await sleep(900);
const piecesAfter = await g(() => window.game.grid.pieces.size + window.game.m.predicted.size);
check('PLACE builds a piece', piecesAfter > piecesBefore, `${piecesBefore} -> ${piecesAfter} mats ${await g(() => window.game.m.sim.inv.mats.join('/'))}`);
await shot('m04-build');
await overlapCheck('build');
await press('#touch .t-build');
await sleep(300);
check('back to weapons', (await ctx()) === 'walk' && (await visible('.hud-bc')));

// ---------------------------------------------------------------- hotbar + fire
await page.tap('.hud-bc .hslot[data-i="1"]');
await sleep(900);
let st = await sim();
check('tapping the hotbar equips the rifle', st.slot === 1, `slot ${st.slot}`);
const magBefore = st.mag[1];
await press('#touch .t-fire', 350);
await sleep(500);
st = await sim();
check('FIRE shoots', st.mag[1] < magBefore, `${magBefore} -> ${st.mag[1]}`);
await shot('m07-fire');

// ---------------------------------------------------------------- inventory (tap to move)
await page.tap('.hud-bc .hbag');
check('BAG opens the inventory', await waitFor(() => window.game.hud.inventoryOpen));
const before = (await sim()).slots;
await page.tap('.inv .islot[data-i="1"]');
await sleep(300);
await page.tap('#movesel');
await sleep(200);
await page.tap('.inv .islot[data-i="4"]');
await sleep(900);
const after = (await sim()).slots;
check('Move + tap swaps inventory slots', after[4] === before[1] && after[1] === before[4], `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
await shot('m08-inventory');
await page.tap('#invclose');
check('inventory close button', await waitFor(() => !window.game.hud.inventoryOpen));

// ---------------------------------------------------------------- map (tap minimap, tap to mark)
await page.tap('#minimap');
check('tapping the minimap opens the full map', await waitFor(() => window.game.hud.bigMapOpen));
const pingsBefore = await g(() => window.game.m.pings.length);
const mc = await center('.bigmap canvas');
await page.touchscreen.tap(mc.x + 20, mc.y - 20);
await sleep(700);
check('tapping the map places a marker', (await g(() => window.game.m.pings.length)) > pingsBefore);
await shot('m09-map');
await page.tap('.bigmap .close-x');
check('map close button', await waitFor(() => !window.game.hud.bigMapOpen));

// ---------------------------------------------------------------- contextual USE: open a cache
const caches = await g(() => {
  const s = window.game.m.sim, t = window.game.terrain;
  return [...window.game.loot.containers.values()]
    .filter((c) => !c.info.open && c.info.kind === 'chest' && Math.abs(c.info.y - t.heightAt(c.info.x, c.info.z)) < 1.2)
    .map((c) => ({ id: c.info.id, x: c.info.x, y: c.info.y, z: c.info.z, d: Math.hypot(c.info.x - s.x, c.info.z - s.z) }))
    .sort((a, b) => a.d - b.d).slice(0, 6);
});
let opened = false, label = '';
for (const cache of caches) {
  for (const [ox, oz] of [[1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4]]) {
    await g((c) => window.game.net.send({ t: 'dev', cmd: 'teleport', x: c.x, z: c.z }), { x: cache.x + ox, z: cache.z + oz });
    await sleep(1200);
    // teleports land on the highest surface: skip spots on a roof above a ground-floor cache
    if (await g((c) => Math.abs(window.game.m.sim.y - c.y) > 1.5, cache)) continue;
    await g((c) => { const s = window.game.m.sim; window.game.view.yaw = Math.atan2(-(c.x - s.x), -(c.z - s.z)); window.game.view.pitch = -0.3; }, cache);
    const ok = await waitFor(() => { const u = document.querySelector('#touch .t-use'); return !u.classList.contains('off') && u.textContent === 'OPEN'; }, null, 4000);
    label = await g(() => document.querySelector('#touch .t-use').textContent);
    if (!ok) continue;
    await shot('m10-use');
    await g(() => { const gm = window.game; window.__chan = []; const o = gm.onEvent.bind(gm); gm.onEvent = (e) => { if (e.e === 'chan' || e.e === 'chanx') window.__chan.push(JSON.stringify(e)); o(e); }; });
    for (let attempt = 0; attempt < 2 && !opened; attempt++) {
      await press('#touch .t-use', 2400);
      opened = await waitFor((id) => window.game.loot.containers.get(id)?.info.open === true, cache.id, 5000);
    }
    if (!opened) console.log('  channel events:', await g(() => window.__chan.join(' ')));
    break;
  }
  if (label === 'OPEN') break;
}
check('USE button appears with the action name', label === 'OPEN', `${label} ${JSON.stringify(await g(() => ({ ctx: document.getElementById('touch').dataset.ctx, elim: window.game.m?.eliminated, mode: window.game.m?.sim.mode, caches: window.game.loot.containers.size })))}`);
check('holding USE opens the cache', opened);

// ---------------------------------------------------------------- vehicle: DRIVE / EXIT
const rover = await g(() => {
  const s = window.game.m.sim;
  let best = null, bd = 1e9;
  for (const [id, v] of window.game.m.vehicles) { const d = Math.hypot(v.x - s.x, v.z - s.z); if (d < bd) { bd = d; best = { id, x: v.x, z: v.z }; } }
  return best;
});
if (rover) {
  await g((v) => window.game.net.send({ t: 'dev', cmd: 'teleport', x: v.x + 2.2, z: v.z }), rover);
  await sleep(1500);
  await page.waitForFunction(() => document.querySelector('#touch .t-use').textContent === 'DRIVE' && !document.querySelector('#touch .t-use').classList.contains('off'), null, { timeout: 8000 }).catch(() => {});
  check('USE offers DRIVE next to a Rover', (await g(() => document.querySelector('#touch .t-use').textContent)) === 'DRIVE');
  await press('#touch .t-use');
  await page.waitForFunction(() => window.game.m.sim.mode === 6, null, { timeout: 8000 }).catch(() => {});
  check('driving shows vehicle controls with EXIT', (await ctx()) === 'vehicle' && (await g(() => document.querySelector('#touch .t-use').textContent)) === 'EXIT');
  s0 = await sim();
  await touchDown(1, 90, vh - 90);
  for (let i = 1; i <= 6; i++) {
    await touchMove(1, 90, vh - 90 - i * 10);
    await sleep(40);
  }
  await sleep(2000);
  s1 = await sim();
  await touchUp(1);
  check('joystick drives the Rover', Math.hypot(s1.x - s0.x, s1.z - s0.z) > 3, `${Math.hypot(s1.x - s0.x, s1.z - s0.z).toFixed(1)} m`);
  await shot('m11-vehicle');
  await press('#touch .t-use');
  await page.waitForFunction(() => window.game.m.sim.mode === 0, null, { timeout: 8000 }).catch(() => {});
  check('EXIT leaves the vehicle', (await sim()).mode === 0);
} else check('found a Rover', false);

// ---------------------------------------------------------------- portrait hint, pause, leave
await page.setViewportSize({ width: vh, height: vw });
await sleep(500);
check('portrait shows the rotate hint', await visible('#rotate'));
await shot('m12-portrait');
await page.setViewportSize({ width: vw, height: vh });
await sleep(500);
check('landscape hides the rotate hint', !(await visible('#rotate')));
await overlapCheck('after rotate');

await press('#touch .t-menu');
await sleep(400);
check('☰ opens the pause menu', (await g(() => window.game.menus.overlayKind)) === 'pause');
await page.tap('#leave');
await page.waitForFunction(() => window.game.state === 'menu', null, { timeout: 15000 });
check('leave returns to the menu', true);
await shot('m13-menu-after');

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(failures ? `${failures} check(s) failed` : 'all mobile checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
