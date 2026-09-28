// WebSocket client: JSON control messages + binary inputs/snapshots, with auto-reconnect.
import { ByteReader, ByteWriter } from '../shared/binary';
import { MSG_SNAPSHOT, Snapshot, decodeSnapshot, encodeInputs } from '../shared/protocol';
import type { InputCmd } from '../shared/sim';

export type MsgHandler = (msg: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/** What the game needs from a connection: the WebSocket client below, or LocalNet (offline). */
export interface NetLike {
  onMessage: MsgHandler;
  onSnapshot: (s: Snapshot) => void;
  onOpen: () => void;
  onClose: () => void;
  readonly connected: boolean;
  readonly rtt: number;
  connect(): void;
  send(msg: unknown): void;
  sendInputs(list: InputCmd[]): void;
}

export class Net implements NetLike {
  private ws: WebSocket | null = null;
  private writer = new ByteWriter(512);
  onMessage: MsgHandler = () => {};
  onSnapshot: (s: Snapshot) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};
  connected = false;
  rtt = 0;
  bytesIn = 0;
  private pingTimer = 0;
  private retry = 0;
  everConnected = false;
  private stopped = false;
  /** Called when a connection attempt fails before the first successful open. */
  onFirstFailure: () => void = () => {};

  constructor(private url: string) {}

  /** Stop for good (switching to offline mode). */
  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      if (!this.everConnected) this.onFirstFailure();
      else setTimeout(() => this.connect(), Math.min(8000, 500 * 2 ** this.retry++));
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.everConnected = true;
      this.retry = 0;
      this.onOpen();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
    };
    ws.onclose = () => {
      if (this.stopped) return;
      this.connected = false;
      clearInterval(this.pingTimer);
      if (!this.everConnected) {
        this.onFirstFailure();
        if (this.stopped) return;
      } else this.onClose();
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.bytesIn += ev.data.length;
        const msg = JSON.parse(ev.data);
        if (msg.t === 'pong') {
          const r = performance.now() - msg.c;
          this.rtt = this.rtt ? this.rtt * 0.8 + r * 0.2 : r;
          return;
        }
        this.onMessage(msg);
        return;
      }
      const buf = ev.data as ArrayBuffer;
      this.bytesIn += buf.byteLength;
      const r = new ByteReader(buf);
      if (r.u8() === MSG_SNAPSHOT) this.onSnapshot(decodeSnapshot(r));
    };
  }

  send(msg: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendInputs(list: InputCmd[]) {
    if (!list.length || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < list.length; i += 30) {
      const bytes = encodeInputs(this.writer, list.slice(i, i + 30));
      this.ws.send(bytes);
    }
  }
}
