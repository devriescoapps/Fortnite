// Random identifiers from Web Crypto (available in browsers and Node >= 19), so server code
// can also run inside the browser for offline play.
export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += b.toString(16).padStart(2, '0');
  return s;
}
