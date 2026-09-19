import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDigestMemo } from './digestMemo';

/** A hasher that counts its calls and never scans the string (so 6M-char
 *  inputs stay cheap to test with). */
function counting() {
  let calls = 0;
  const hash = (s: string) => {
    calls++;
    return `h${s.length}:${s.charCodeAt(0) || 0}`;
  };
  return { hash, calls: () => calls };
}

describe('createDigestMemo', () => {
  it('hashes a string once and answers repeats from the memo', () => {
    const c = counting();
    const memo = createDigestMemo(c.hash, 8, 1_000);
    const a = memo.get('payload');
    const b = memo.get('payload');
    expect(a).toBe(b);
    expect(a).toBe(c.hash('payload'));
    expect(c.calls()).toBe(2); // one miss + the direct call just above
    expect(memo.size).toBe(1);
  });

  it('answers an equal string that is a different object', () => {
    const c = counting();
    const memo = createDigestMemo(c.hash, 8, 1_000);
    const s = 'x'.repeat(40);
    memo.get(s);
    memo.get((' ' + s).slice(1)); // equal content, separate string
    expect(c.calls()).toBe(1);
  });

  it('evicts by COUNT in LRU order, keeping the entry just inserted', () => {
    const c = counting();
    const memo = createDigestMemo(c.hash, 2, 1_000);
    memo.get('a');
    memo.get('b');
    memo.get('a'); // refresh: 'b' is now the oldest
    memo.get('c'); // evicts 'b'
    expect(memo.size).toBe(2);
    expect(c.calls()).toBe(3);
    memo.get('a');
    memo.get('c');
    expect(c.calls()).toBe(3); // both still held
    memo.get('b');
    expect(c.calls()).toBe(4); // 'b' was evicted and re-hashed
  });

  it('evicts by CHARACTERS, keeping the entry just inserted even when it alone is over', () => {
    const c = counting();
    const memo = createDigestMemo(c.hash, 100, 5);
    const big = 'y'.repeat(8); // over the 5-char budget on its own
    memo.get(big);
    memo.get(big);
    expect(c.calls()).toBe(1); // kept, so not re-hashed
    expect(memo.size).toBe(1);
    memo.get('zz'); // 10 chars held > 5: the oldest (big) goes, 'zz' stays
    expect(memo.size).toBe(1);
    memo.get('zz');
    expect(c.calls()).toBe(2);
    memo.get(big);
    expect(c.calls()).toBe(3);
  });

  it('counts the KEY lengths, so small digests do not hide large retained keys', () => {
    const c = counting();
    const memo = createDigestMemo(c.hash, 100, 10);
    memo.get('aaaa'); // 4
    memo.get('bbbb'); // 8
    memo.get('cccc'); // 12 > 10: 'aaaa' goes
    expect(memo.size).toBe(2);
    memo.get('bbbb');
    memo.get('cccc');
    expect(c.calls()).toBe(3);
  });

  // Why the character cap is sized per platform: two payloads that do not both
  // fit evict each other on every lookup, so the memo turns into pure overhead.
  it('a 6M and a 3M payload alternating: 2 hashes under 40M, 20 under 4M', () => {
    const six = 'a'.repeat(6_000_000);
    const three = 'b'.repeat(3_000_000);
    for (const [maxChars, expected] of [
      [40_000_000, 2],
      [4_000_000, 20],
    ] as const) {
      const c = counting();
      const memo = createDigestMemo(c.hash, 128, maxChars);
      for (let i = 0; i < 10; i++) {
        memo.get(six);
        memo.get(three);
      }
      expect(c.calls(), `maxChars ${maxChars}`).toBe(expected);
    }
  });

  it('clear() forgets every entry and the character count', () => {
    const c = counting();
    const memo = createDigestMemo(c.hash, 100, 10);
    memo.get('aaaaaaaa'); // 8 of 10
    memo.clear();
    expect(memo.size).toBe(0);
    memo.get('aaaaaaaa');
    expect(c.calls()).toBe(2);
    // Had clear() kept the old 8 chars, this 8-char key would push the total to
    // 16 and evict the entry above.
    memo.get('bbbbbbbb');
    expect(memo.size).toBe(1); // 16 > 10 still evicts, from the fresh count
    memo.clear();
    memo.get('cc');
    memo.get('dd');
    expect(memo.size).toBe(2); // 4 ≤ 10: nothing stale counted against it
  });

  it('is a zero-import leaf and holds no hash round of its own', () => {
    const src = readFileSync(join(__dirname, 'digestMemo.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toContain('0x01000193');
    expect(src).not.toContain('Math.imul');
  });
});
