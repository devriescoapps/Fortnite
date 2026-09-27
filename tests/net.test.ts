// Integration test: a scripted WebSocket client plays through matchmaking -> lobby -> transport
// -> jump against a real server process.
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ByteReader, ByteWriter } from '../src/shared/binary';
import { MSG_SNAPSHOT, Snapshot, decodeSnapshot, encodeInputs } from '../src/shared/protocol';
import { BTN, InputCmd, Mode } from '../src/shared/sim';

const PORT = 18000 + Math.floor(Math.random() * 1000);
let proc: ChildProcess;

beforeAll(async () => {
  const { execSync } = await import('node:child_process');
  execSync('node scripts/build.mjs', { stdio: 'ignore' });
  const dataDir = mkdtempSync(join(tmpdir(), 'sf-'));
  proc = spawn('node', ['dist/server.js'], { env: { ...process.env, PORT: String(PORT), LOBBY_TIME: '3', QUEUE_WAIT: '0', MAX_PLAYERS: '6', DATA_DIR: dataDir }, stdio: 'pipe' });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start')), 15000);
    proc.stdout!.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(t);
        res();
      }
    });
  });
}, 60000);

afterAll(() => {
  proc?.kill();
});

class Client {
  ws: WebSocket;
  msgs: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  snap: Snapshot | null = null;
  seq = 0;
  w = new ByteWriter();
  constructor() {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.ws.on('message', (data, bin) => {
      if (bin) {
        const b = data as Buffer;
        const r = new ByteReader(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
        if (r.u8() === MSG_SNAPSHOT) this.snap = decodeSnapshot(r);
      } else {
        const m = JSON.parse(String(data));
        if (m.t === 'ev') for (const e of m.l) this.msgs.push({ t: 'ev', ...e });
        else this.msgs.push(m);
      }
    });
  }
  open() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  input(buttons: number, mz = 0) {
    const cmd: InputCmd = { seq: ++this.seq, mx: 0, mz, yaw: 0, pitch: 0, buttons, slot: 255, viewTick: 0 };
    this.ws.send(encodeInputs(this.w, [cmd]));
  }
  async waitFor(pred: () => boolean, ms = 20000) {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

describe('network play', () => {
  it('matchmakes, rides the transport and jumps out', async () => {
    const c = new Client();
    await c.open();
    c.send({ t: 'hello', name: 'Tester' });
    await c.waitFor(() => c.msgs.some((m) => m.t === 'welcome'));
    const welcome = c.msgs.find((m) => m.t === 'welcome');
    expect(welcome.profile.level).toBe(1);
    c.send({ t: 'queue', mode: 'solo' });
    await c.waitFor(() => c.msgs.some((m) => m.t === 'match'));
    const match = c.msgs.find((m) => m.t === 'match');
    expect(match.players.length).toBe(6);
    // keep sending idle inputs like a real client
    const idle = setInterval(() => c.input(0), 16);
    await c.waitFor(() => c.snap?.self?.mode === Mode.Bus, 15000);
    await new Promise((r) => setTimeout(r, 3300)); // doors open after 3s
    clearInterval(idle);
    c.input(BTN.JUMP);
    c.input(0);
    const idle2 = setInterval(() => c.input(0), 16);
    await c.waitFor(() => c.snap?.self?.mode === Mode.Skydive || c.snap?.self?.mode === Mode.Glide, 5000);
    clearInterval(idle2);
    c.ws.close();
  }, 60000);
});
