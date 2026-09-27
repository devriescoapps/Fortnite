// End-to-end smoke test: drives the real game in headless Chromium against a running server.
// Usage: node scripts/e2e.mjs [url] [outDir]
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
const out = process.argv[3] ?? 'screenshots';
mkdirSync(out, { recursive: true });

const browser = await playwright.chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const quality = process.env.QUALITY || 'medium';
await page.addInitScript((q) => {
  try {
    const s = JSON.parse(localStorage.getItem('surgefall.settings.v1') || '{}');
    s.quality = q;
    s.showFps = true;
    localStorage.setItem('surgefall.settings.v1', JSON.stringify(s));
  } catch {}
}, quality);
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const shot = async (name) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('screenshot', name);
};
const state = () => page.evaluate(() => {
  const g = window.game;
  const m = g.m;
  return m ? { state: g.state, phase: m.phase, build: m.buildMode, kills: m.kills, mats: m.sim.inv.mats.join('/'), mode: m.sim.mode, y: m.sim.y, x: m.sim.x, z: m.sim.z, hp: m.sim.hp, alive: m.alive, remotes: m.remotes.size, pending: m.pending.length, slots: m.sim.inv.slots.map((s) => s && s.code) } : { state: g.state };
});

await page.goto(url);
await page.waitForSelector('.play-btn', { timeout: 30000 });
await page.waitForFunction(() => window.game?.profile, null, { timeout: 15000 });
await page.waitForTimeout(800);
await shot('01-menu');

await page.click('.tab[data-tab=locker]');
await page.waitForTimeout(300);
await shot('02-locker');
await page.click('.tab[data-tab=play]');

const mode = process.env.MODE || 'solo';
await page.click(`[data-mode=${mode}]`);
await page.waitForTimeout(200);
await page.click('#play');
await page.waitForFunction(() => window.game?.state === 'match', null, { timeout: 30000 });
await page.waitForTimeout(1500);
console.log('lobby', await state());
await shot('03-lobby');

// walk around the skyport and build a wall
await page.keyboard.down('KeyW');
await page.waitForTimeout(700);
await page.keyboard.up('KeyW');
await page.keyboard.press('KeyQ');
await page.waitForTimeout(200);
await page.evaluate(() => { window.game.input.lmb = true; });
await page.waitForTimeout(150);
await page.evaluate(() => { window.game.input.lmb = false; });
await page.waitForTimeout(500);
await shot('04-build');
await page.keyboard.press('KeyQ');

// wait for the transport
await page.waitForFunction(() => window.game?.m?.phase === 'bus', null, { timeout: 40000 });
await page.waitForFunction(() => { const m = window.game.m; return m.bus && window.game.serverNow() > m.bus.t0 + 3.5; }, null, { timeout: 20000 });
// wait until the transport is over the middle of the island
await page.waitForFunction(() => { const b = window.game.m.busPos; return b && Math.hypot(b.x, b.z) < 260; }, null, { timeout: 40000 });
console.log('bus', await state());
await shot('05-transport');
await page.keyboard.down('Space');
await page.waitForTimeout(150);
await page.keyboard.up('Space');
await page.waitForFunction(() => window.game?.m?.sim.mode === 1 || window.game?.m?.sim.mode === 2, null, { timeout: 30000 });
await page.waitForTimeout(1500);
console.log('skydive', await state());
await shot('06-skydive');
// steer toward the nearest named location, like a player picking a drop spot
await page.evaluate(() => {
  const g = window.game;
  const pois = [[150, -20], [-130, 190], [-270, -290], [330, 360], [10, -410], [-380, 320], [-400, -20], [-10, 110]];
  window.__steer = setInterval(() => {
    const s = g.m.sim;
    let best = pois[0], bd = 1e9;
    for (const p of pois) { const d = Math.hypot(p[0] - s.x, p[1] - s.z); if (d < bd) { bd = d; best = p; } }
    g.view.yaw = Math.atan2(-(best[0] - s.x), -(best[1] - s.z));
    g.view.pitch = bd < 40 ? -1.2 : -0.3;
  }, 100);
});
await page.keyboard.down('KeyW');
await page.waitForFunction(() => window.game?.m?.sim.mode === 2, null, { timeout: 30000 });
await page.waitForTimeout(1500);
await shot('07-glide');
await page.waitForFunction(() => (window.game?.m?.sim.mode === 0 && window.game?.m?.sim.grounded) || window.game?.m?.sim.mode === 3, null, { timeout: 90000 });
await page.keyboard.up('KeyW');
await page.evaluate(() => { clearInterval(window.__steer); window.game.view.pitch = -0.05; });
await page.waitForTimeout(1500);
console.log('landed', await state());
await shot('08-landed');

// With DEV_COMMANDS=1 on the server, hop next to the closest unopened cache so the looting
// part of the test is deterministic (otherwise the random drop spot decides what's nearby).
await page.evaluate(() => {
  const g = window.game, s = g.m.sim;
  let best = null, bd = 1e9;
  for (const c of g.loot.containers.values()) {
    if (c.info.open || c.info.kind !== 'chest') continue;
    const d = Math.hypot(c.info.x - s.x, c.info.z - s.z);
    if (d < bd) { bd = d; best = c.info; }
  }
  if (best) g.net.send({ t: 'dev', cmd: 'teleport', x: best.x - 1.3, z: best.z - 1.3 });
});
await page.waitForTimeout(1500);
// Auto-loot bot: steer toward the nearest reachable pickup/cache (clear line of sight preferred),
// hammer through walls when blocked, press E when close, shoot enemies when armed.
await page.evaluate(() => {
  const g = window.game;
  let last = null, stuck = 0, target = null, targetT = 0;
  const black = new Set();
  window.__picked = 0;
  window.__loot = setInterval(() => {
    const m = g.m;
    if (!m || m.eliminated) return;
    const s = m.sim;
    const sp = last ? Math.hypot(s.x - last.x, s.z - last.z) / 0.12 : 9;
    last = { x: s.x, z: s.z };
    const now = performance.now();
    const list = [];
    for (const it of m.itemInfo.values()) list.push({ key: 'i' + it.id, x: it.x, y: it.y, z: it.z });
    for (const c of g.loot.containers.values()) if (!c.info.open) list.push({ key: 'c' + c.info.id, x: c.info.x, y: c.info.y, z: c.info.z });
    if (!target || now - targetT > 12000 || (now - targetT > 1500 && !list.some((t) => t.key === target.key))) {
      if (target && now - targetT > 12000) black.add(target.key);
      let best = null, bs = 1e9;
      for (const t of list) {
        if (black.has(t.key) || Math.abs(t.y - s.y) > 3) continue;
        const dx = t.x - s.x, dy = t.y + 0.4 - (s.y + 1.0), dz = t.z - s.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > 70) continue;
        const hit = g.world.raycast(s.x, s.y + 1.0, s.z, dx / d, dy / d, dz / d, d, undefined, true);
        const score = d + (hit ? 40 : 0);
        if (score < bs) { bs = score; best = t; }
      }
      target = best;
      targetT = now;
    }
    if (target) {
      const d = Math.hypot(target.x - s.x, target.z - s.z);
      g.view.yaw = Math.atan2(-(target.x - s.x), -(target.z - s.z));
      g.view.pitch = -0.15;
      if (d < 2.0) {
        g.input.keys.delete('KeyW');
        if (m.target) { g.input.push('use'); window.__picked++; }
        g.input.keys.add('KeyE');
        if (now - targetT > 4000) black.add(target.key), (target = null);
      } else { g.input.keys.add('KeyW'); g.input.keys.delete('KeyE'); }
    }
    stuck = sp < 1.0 && g.input.keys.has('KeyW') ? stuck + 1 : Math.max(0, stuck - 1);
    let foe = null, fd = 1e9;
    for (const r of m.remotes.values()) {
      if (r.info.team === m.team || r.cur.mode === 8 || r.cur.mode === 5) continue;
      const d = Math.hypot(r.pos.x - s.x, r.pos.y - s.y, r.pos.z - s.z);
      if (d < fd) { fd = d; foe = r; }
    }
    const wi = s.inv.slots.findIndex((x, i) => i > 0 && x && (x.mag > 0 || x.count > 0) && x.code < 20);
    if (wi > 0 && foe && fd < 35) {
      if (s.slot !== wi) m.slotReq = wi;
      g.view.yaw = Math.atan2(-(foe.pos.x - s.x), -(foe.pos.z - s.z));
      g.view.pitch = Math.atan2(foe.pos.y + 1.1 - (s.y + 1.6), fd);
      g.input.lmb = !g.input.lmb;
      window.__shots = (window.__shots || 0) + 1;
    } else if (stuck > 3) {
      if (s.slot !== 0) m.slotReq = 0;
      g.view.pitch = 0;
      g.input.lmb = !g.input.lmb;
      window.__hammered = (window.__hammered || 0) + 1;
    } else g.input.lmb = false;
  }, 120);
});
await page.waitForTimeout(45000);
await page.evaluate(() => { clearInterval(window.__loot); const g = window.game; g.input.keys.clear(); g.input.lmb = false; });
console.log('after looting', await state(), await page.evaluate(() => ({ hammer: window.__hammered || 0, uses: window.__picked, shots: window.__shots || 0 })));
await shot('09-looting');
// armed combat: give a rifle (dev) and let the harness shoot the nearest opponent for a while
await page.evaluate(() => {
  const g = window.game;
  if (g.m && !g.m.eliminated) {
    g.net.send({ t: 'dev', cmd: 'give', id: 'vanguard', rarity: 3 });
    g.net.send({ t: 'dev', cmd: 'give', id: 'ammo_medium' });
  }
});
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const g = window.game;
  window.__fight = setInterval(() => {
    const m = g.m;
    if (!m || m.eliminated) return;
    const s = m.sim;
    let foe = null, fd = 1e9;
    for (const r of m.remotes.values()) {
      if (r.info.team === m.team || r.cur.mode === 8 || r.cur.mode === 5) continue;
      const d = Math.hypot(r.pos.x - s.x, r.pos.y - s.y, r.pos.z - s.z);
      if (d < fd) { fd = d; foe = r; }
    }
    const wi = s.inv.slots.findIndex((x) => x && x.code === 1);
    if (wi > 0 && s.slot !== wi) m.slotReq = wi;
    if (foe) {
      g.view.yaw = Math.atan2(-(foe.pos.x - s.x), -(foe.pos.z - s.z));
      g.view.pitch = Math.atan2(foe.pos.y + 1.1 - (s.y + 1.6), fd);
      g.input.lmb = fd < 60;
      g.input.keys.toggle?.('KeyW');
      if (fd > 25) g.input.keys.add('KeyW'); else g.input.keys.delete('KeyW');
    }
  }, 100);
});
await page.waitForTimeout(20000);
await page.evaluate(() => { clearInterval(window.__fight); window.game.input.lmb = false; window.game.input.keys.clear(); });
console.log('after fight', await state());
await shot('10-fight');
// Vehicles: hop next to a Rover, get in, drive (client-predicted), get out
const drove = await page.evaluate(async () => {
  const g = window.game, m = g.m;
  if (!m || m.eliminated || m.vehicles.size === 0) return null;
  const s = m.sim;
  let best = null, bd = 1e9;
  for (const [id, v] of m.vehicles) { const d = Math.hypot(v.x - s.x, v.z - s.z); if (d < bd) { bd = d; best = { id, ...v }; } }
  g.net.send({ t: 'dev', cmd: 'teleport', x: best.x + 2.2, z: best.z });
  await new Promise((r) => setTimeout(r, 1500));
  g.net.send({ t: 'act', a: { a: 'interact', kind: 'vehicle', id: best.id } });
  await new Promise((r) => setTimeout(r, 1500));
  const start = { x: m.sim.x, z: m.sim.z, mode: m.sim.mode, predicted: !!m.drive };
  g.input.keys.add('KeyW');
  await new Promise((r) => setTimeout(r, 3000));
  g.input.keys.delete('KeyW');
  const end = { x: m.sim.x, z: m.sim.z, mode: m.sim.mode, predicted: !!m.drive };
  return { start, end, moved: Math.hypot(end.x - start.x, end.z - start.z) };
});
console.log('vehicle', JSON.stringify(drove));
await shot('10-vehicle');
await page.keyboard.press('KeyF');
await page.waitForTimeout(800);
await page.keyboard.press('KeyM');
await page.waitForTimeout(400);
await shot('10-map');
console.log('team rows', await page.evaluate(() => document.querySelectorAll('.team-row').length), 'tags', await page.evaluate(() => document.querySelectorAll('#tags .tag').length));
await page.keyboard.press('KeyM');
await page.keyboard.press('Tab');
await page.waitForTimeout(300);
await shot('11-inventory');
await page.keyboard.press('Tab');
console.log('final', await state());

// Force an elimination (dev command) to exercise results -> spectate -> lobby
if (process.env.FORCE_ELIM) {
  await page.evaluate(() => window.game.net.send({ t: 'dev', cmd: 'eliminate' }));
  await page.waitForTimeout(1500);
}
// If eliminated: results -> spectate -> back to lobby with XP applied
const died = await page.evaluate(() => window.game.m?.eliminated);
if (died) {
  await page.waitForSelector('#lobby', { timeout: 15000 }).catch(() => {});
  await shot('12-results');
  const spec = await page.$('#spec');
  if (spec) {
    await spec.click();
    await page.waitForTimeout(2500);
    console.log('spectating', await page.evaluate(() => ({ target: window.game.m?.spectating, name: document.querySelector('.spec-bar')?.textContent })));
    await shot('13-spectating');
  }
}
const xpBefore = await page.evaluate(() => window.game.profile?.xp + window.game.profile?.level * 100000);
await page.evaluate(() => window.game.leaveMatch(true));
await page.waitForFunction(() => window.game.state === 'menu', null, { timeout: 15000 });
await page.waitForTimeout(1500);
const prof = await page.evaluate(() => ({ level: window.game.profile?.level, xp: window.game.profile?.xp, matches: window.game.profile?.stats.matches, currency: window.game.profile?.currency }));
console.log('back in menu, profile', prof, 'xp changed', prof.xp + prof.level * 100000 !== xpBefore || prof.matches > 0);
await shot('14-menu-after');

const stats = await page.evaluate(() => {
  const g = window.game;
  return { fps: g.fpsAcc?.fps, info: g.renderer.info.render, mem: g.renderer.info.memory };
});
console.log('render stats', JSON.stringify(stats));
console.log('console errors:', errors.length ? errors.slice(0, 20) : 'none');
await browser.close();
