// WebSocket client: JSON control messages + binary inputs/snapshots, with auto-reconnect.
import { ByteReader, ByteWriter } from '../shared/binary';
import { MSG_SNAPSHOT, Snapshot, decodeSnapshot, encodeInputs } from '../shared/protocol';
import type { InputCmd } from '../shared/sim';

export type MsgHandler = (msg: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

export class Net {
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

  constructor(private url: string) {}

  connect() {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.onOpen();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
    };
    ws.onclose = () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      this.onClose();
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
