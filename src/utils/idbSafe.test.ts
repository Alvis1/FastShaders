/**
 * `idbSafe` is DOM-only apart from `classifyIdbFailure` (the vitest env is
 * `node`, which has no IndexedDB), so the one pure half is pinned directly and
 * the transaction plumbing is pinned from source: the outcome `idbWrite`
 * REPORTS is what lets the preview-model cache tell the user when storage is
 * full, and a regression there would fail silently — the cache would simply go
 * back to saying nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyIdbFailure } from './idbSafe';

const SRC = readFileSync(resolve(__dirname, 'idbSafe.ts'), 'utf8');

describe('classifyIdbFailure', () => {
  it('reads a real quota error, in both engine spellings', () => {
    expect(classifyIdbFailure(new DOMException('x', 'QuotaExceededError'))).toBe('quota');
    expect(classifyIdbFailure({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe('quota');
  });

  it('calls everything else a plain failure', () => {
    expect(classifyIdbFailure(new DOMException('x', 'AbortError'))).toBe('failed');
    for (const junk of [null, undefined, {}, { name: 42 }, 'QuotaExceededError', 7]) {
      expect(classifyIdbFailure(junk)).toBe('failed');
    }
  });

  it('never throws on a hostile object', () => {
    const trap = Object.defineProperty({}, 'name', { get() { throw new Error('boom'); } });
    expect(classifyIdbFailure(trap)).toBe('failed');
  });
});

describe('idbWrite reports its outcome and never rejects (source pins)', () => {
  const body = SRC.slice(SRC.indexOf('export function idbWrite('), SRC.indexOf('export function idbGet('));

  it('resolves an IdbWriteResult, with a timeout as its own outcome', () => {
    expect(body).toMatch(/Promise<IdbWriteResult>/);
    expect(body).toMatch(/'timeout',\s*\)/);
    expect(body).toContain("tx.oncomplete = () => resolve('complete')");
  });

  it('classifies onerror and onabort instead of swallowing them', () => {
    expect(body).toMatch(/tx\.onerror = \(ev\) => \{[\s\S]*?resolve\(classifyIdbFailure\(e\)\)/);
    expect(body).toContain('tx.onabort = () => resolve(classifyIdbFailure(tx.error))');
    expect(body).not.toMatch(/reject\(/);
  });
});
