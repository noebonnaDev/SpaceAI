import { createHash as nodeHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Buffer as DemoBuffer } from './shims/buffer';
import { createHash, randomBytes, timingSafeEqual } from './shims/node-crypto';

describe('browser shims for Node modules', () => {
  it('SHA-256 matches Node for short, block-sized and long inputs', () => {
    for (const input of ['', 'abc', 'a'.repeat(55), 'a'.repeat(64), 'àèìòù token €'.repeat(40)]) {
      expect(createHash('sha256').update(input).digest('hex')).toBe(nodeHash('sha256').update(input).digest('hex'));
    }
  });

  it('Buffer encodes like Node for the encodings Ritrovo uses', () => {
    const bytes = Uint8Array.from({ length: 70 }, (_, i) => (i * 37) % 256);
    const ours = DemoBuffer.from(bytes);
    const node = Buffer.from(bytes);
    for (const enc of ['hex', 'base64', 'base64url'] as const) {
      expect(ours.toString(enc)).toBe(node.toString(enc));
      expect([...DemoBuffer.from(node.toString(enc), enc)]).toEqual([...bytes]);
    }
    expect(DemoBuffer.from('Sala Volta – 8 posti').toString()).toBe('Sala Volta – 8 posti');
  });

  it('random tokens have the requested size and compare safely', () => {
    const t = randomBytes(32);
    expect(t.length).toBe(32);
    expect(t.toString('base64url')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(timingSafeEqual(t, DemoBuffer.from(t))).toBe(true);
    expect(timingSafeEqual(t, randomBytes(32))).toBe(false);
  });
});
