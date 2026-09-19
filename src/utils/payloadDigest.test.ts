import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fnv1a32Hex, fnv1a32Bytes } from './payloadDigest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('fnv1a32Hex', () => {
  it('computes the values the image placeholders already carry', () => {
    // These are the placeholder hashes 0.3.33 emitted: moving the function
    // must not move them.
    expect(fnv1a32Hex('data:image/png;base64,AAAA')).toBe('0ce4918c');
    expect(fnv1a32Hex('data:image/png;base64,BBBB')).toBe('c4690128');
  });

  it('is the FNV-1a offset basis on the empty string, always 8 hex digits', () => {
    expect(fnv1a32Hex('')).toBe('811c9dc5');
    for (const s of ['', 'a', 'abc', 'data:image/webp;base64,YWJj', 'x'.repeat(1000)]) {
      expect(fnv1a32Hex(s)).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('COLLIDES on a real pair of equal-length payloads — it is a bucket, not an identity', () => {
    const p = 'data:image/png;base64,L8zt5mTG';
    const q = 'data:image/png;base64,E6b4siKM';
    expect(p).not.toBe(q);
    expect(p.length).toBe(30);
    expect(q.length).toBe(30);
    expect(fnv1a32Hex(p)).toBe('61a5fde1');
    expect(fnv1a32Hex(q)).toBe('61a5fde1');
  });

  it('hashes UTF-16 code units, so a code unit above 255 is not truncated', () => {
    // 'ā' is U+0101: dropping its high byte would make it hash like U+0001.
    expect(fnv1a32Hex('\u0101')).not.toBe(fnv1a32Hex('\u0001'));
  });
});

describe('fnv1a32Bytes', () => {
  it('is the same round over bytes, unsigned', () => {
    expect(fnv1a32Bytes(new Uint8Array(0))).toBe(0x811c9dc5);
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    expect(fnv1a32Bytes(bytes)).toBe(parseInt(fnv1a32Hex('abc'), 16));
    const all = new Uint8Array(256).map((_, i) => i);
    const v = fnv1a32Bytes(all);
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(0xffffffff);
  });

  it('agrees with fnv1a32Hex over a string\'s Latin-1 bytes', () => {
    const s = 'data:image/png;base64,AAAAéÿ';
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
    expect(fnv1a32Bytes(bytes).toString(16).padStart(8, '0')).toBe(fnv1a32Hex(s));
  });

  it('does not mutate its input', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    fnv1a32Bytes(bytes);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
});

describe('payloadDigest: the ONE FNV-1a copy', () => {
  it('is a leaf: it imports nothing', () => {
    const src = read('utils/payloadDigest.ts');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
  });

  it('imageAssets hashes through it and carries no copy of its own', () => {
    const src = read('engine/imageAssets.ts');
    expect(src).toContain("from '@/utils/payloadDigest'");
    expect(src).toContain('fnv1a32Hex(');
    expect(src).not.toContain('Math.imul(h, 0x01000193)');
  });

  it('no other production module holds the FNV prime (imageOriginCache is a different, seeded 128-bit hash)', () => {
    const holders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name === '__snapshots__') continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) {
          if (/0x01000193|16777619/.test(readFileSync(p, 'utf8'))) {
            holders.push(p.slice(SRC.length).replace(/\\/g, '/').replace(/^\//, ''));
          }
        }
      }
    };
    walk(SRC);
    expect(holders.sort()).toEqual(['utils/imageOriginCache.ts', 'utils/payloadDigest.ts']);
  });
});
