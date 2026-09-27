// Minimal growable binary writer/reader for high-frequency messages (inputs, snapshots).

export class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private u8: Uint8Array;
  pos = 0;

  constructor(size = 1024) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
  }

  private ensure(n: number) {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const nb = new ArrayBuffer(size);
    new Uint8Array(nb).set(this.u8);
    this.buf = nb;
    this.view = new DataView(nb);
    this.u8 = new Uint8Array(nb);
  }

  reset() {
    this.pos = 0;
    return this;
  }
  u8w(v: number) {
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }
  i8w(v: number) {
    this.ensure(1);
    this.view.setInt8(this.pos, v);
    this.pos += 1;
  }
  u16w(v: number) {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }
  i16w(v: number) {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }
  u32w(v: number) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }
  f32w(v: number) {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }
  f64w(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  bytes(): Uint8Array {
    return this.u8.slice(0, this.pos);
  }
}

export class ByteReader {
  private view: DataView;
  pos = 0;
  constructor(data: ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    else this.view = new DataView(data);
  }
  get remaining() {
    return this.view.byteLength - this.pos;
  }
  u8() {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  i8() {
    const v = this.view.getInt8(this.pos);
    this.pos += 1;
    return v;
  }
  u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16() {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
}
