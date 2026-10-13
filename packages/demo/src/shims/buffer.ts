// Minimal Buffer for the server code running in the browser: the subset Ritrovo uses (utf8, base64, base64url, hex).
const HEX = '0123456789abcdef';

function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class Buffer extends Uint8Array {
  static override from(value: unknown, encoding?: unknown): Buffer {
    if (typeof value === 'string') {
      const enc = String(encoding ?? 'utf8').toLowerCase();
      let bytes: Uint8Array;
      if (enc === 'base64' || enc === 'base64url') bytes = decodeBase64(value);
      else if (enc === 'hex') bytes = Uint8Array.from(value.match(/../g) ?? [], (h) => parseInt(h, 16));
      else bytes = new TextEncoder().encode(value);
      return Buffer.wrap(bytes);
    }
    if (value instanceof ArrayBuffer) return Buffer.wrap(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return Buffer.wrap(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
    return Buffer.wrap(Uint8Array.from(value as ArrayLike<number>));
  }

  static wrap(bytes: Uint8Array): Buffer {
    const b = new Buffer(bytes.length);
    b.set(bytes);
    return b;
  }

  static isBuffer(value: unknown): value is Buffer {
    return value instanceof Buffer;
  }

  static alloc(size: number): Buffer {
    return new Buffer(size);
  }

  static byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
  }

  static concat(list: Uint8Array[]): Buffer {
    const out = new Buffer(list.reduce((n, b) => n + b.length, 0));
    let offset = 0;
    for (const b of list) {
      out.set(b, offset);
      offset += b.length;
    }
    return out;
  }

  override toString(encoding = 'utf8'): string {
    const enc = encoding.toLowerCase();
    if (enc === 'hex') {
      let s = '';
      for (const byte of this) s += HEX[byte >> 4]! + HEX[byte & 15]!;
      return s;
    }
    if (enc === 'base64') return encodeBase64(this);
    if (enc === 'base64url') return encodeBase64(this).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return new TextDecoder().decode(this);
  }

  equals(other: Uint8Array): boolean {
    return this.length === other.length && this.every((v, i) => v === other[i]);
  }
}

export default { Buffer };
