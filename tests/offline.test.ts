// Offline mode: the whole server (gateway, matchmaker, match, bots, profiles) running in-process
// behind LocalNet, exactly as the static web build does in the browser.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalNet as LocalNetT } from '../src/client/local';
import { generateMap } from '../src/shared/mapdata';
import type { Snapshot } from '../src/shared/protocol';
import { BTN, InputCmd } from '../src/shared/sim';
import { Terrain } from '../src/shared/terrain';

// minimal browser globals used by LocalNet
const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
beforeAll(() => {
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  g.document = { hidden: false, addEventListener: () => {} };
  g.addEventListener = () => {};
});

let net: LocalNetT | null = null;
afterAll(() => net?.stop());

const until = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('offline mode (server in the browser)', () => {
  it('welcomes, matchmakes against bots, simulates inputs and saves the profile locally', async () => {
    const { LocalNet } = await import('../src/client/local');
    const terrain = new Terrain();
    const map = generateMap(terrain);
    net = new LocalNet({ terrain, map }, { maxPlayers: 6, lobbyTime: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs: any[] = [];
    const snaps: Snapshot[] = [];
    let opened = false;
    net.onMessage = (m) => msgs.push(m);
    net.onSnapshot = (s) => snaps.push(s);
    net.onOpen = () => (opened = true);
    net.connect();
    await until(() => opened, 1000);
    net.send({ t: 'hello', token: null, name: 'Solo' });
    await until(() => msgs.some((m) => m.t === 'welcome'), 1000);
    const welcome = msgs.find((m) => m.t === 'welcome');
    expect(welcome.profile.name).toBe('Solo');
    net.send({ t: 'queue', mode: 'solo' });
    await until(() => msgs.some((m) => m.t === 'match'), 3000);
    const init = msgs.find((m) => m.t === 'match');
    expect(init.players.length).toBe(6); // filled with bots
    await until(() => snaps.length > 5, 3000);
    // inputs flow through the same binary encoding as online and are acknowledged
    let seq = 0;
    const cmd = (): InputCmd => ({ seq: ++seq, mx: 0, mz: 1, yaw: 0, pitch: 0, buttons: BTN.SPRINT, slot: 255, viewTick: snaps[snaps.length - 1].tick });
    for (let i = 0; i < 30; i++) net.sendInputs([cmd(), cmd()]);
    await until(() => snaps[snaps.length - 1].ack >= 40, 3000);
    // snapshots are copies: two consecutive ones are distinct objects with increasing ticks
    const a = snaps[snaps.length - 2], b = snaps[snaps.length - 1];
    expect(b.tick).toBeGreaterThan(a.tick);
    // leaving applies results and persists the profile to localStorage
    net.send({ t: 'leave' });
    await until(() => msgs.some((m) => m.t === 'profile'), 2000);
    net.stop();
    const saved = JSON.parse(store.get('surgefall.offline.profiles.v1') ?? '[]');
    expect(saved.length).toBe(1);
    expect(saved[0].name).toBe('Solo');
  }, 20000);
});
