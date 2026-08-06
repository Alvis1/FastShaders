import { describe, it, expect } from 'vitest';
import { originIdFor, payloadToRecord, recordToPayload } from './imageOriginCache';

/**
 * Only the PURE codec is exercised here (the node env has no IndexedDB).
 * That codec is the trust boundary: a stashed record is untrusted on read —
 * another script on this origin, a half-written upgrade, a record from a
 * future version — so it re-enters through the same whitelist that guards the
 * live payload, exactly like previewMeshCache re-validates cached mesh bytes.
 */

const URL_PNG = 'data:image/png;base64,iVBORw0KGgo=';
const URL_WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQ';

const rec = (over: Record<string, unknown> = {}) => ({
  ...payloadToRecord({ dataUrl: URL_PNG, width: 64, height: 32, fileName: 'cat.png' }, 1),
  ...over,
});

describe('originIdFor', () => {
  it('is a stable hex digest of the payload', () => {
    expect(originIdFor(URL_PNG)).toMatch(/^[0-9a-f]{32}$/);
    expect(originIdFor(URL_PNG)).toBe(originIdFor(URL_PNG));
  });

  it('separates different payloads — including one-character differences', () => {
    expect(originIdFor(URL_PNG)).not.toBe(originIdFor(URL_WEBP));
    expect(originIdFor(URL_PNG)).not.toBe(originIdFor(URL_PNG + 'A'));
    // Content-keying is what makes the record survive Ctrl+D / paste (which
    // mint new node ids but clone `data` unchanged) and makes a re-drop under
    // a different device cap a DIFFERENT record instead of silently
    // overwriting the one an existing node points at.
    expect(originIdFor('data:image/png;base64,AAAA')).not.toBe(originIdFor('data:image/png;base64,AAAB'));
  });
});

describe('payloadToRecord', () => {
  it('builds a v1 record keyed by its own payload', () => {
    const r = payloadToRecord({ dataUrl: URL_PNG, width: 64, height: 32, fileName: 'cat.png' }, 123);
    expect(r).not.toBeNull();
    expect(r!.v).toBe(1);
    expect(r!.originId).toBe(originIdFor(URL_PNG));
    expect(r!.savedAt).toBe(123);
  });

  it('refuses anything that is not a whitelisted data: URL', () => {
    expect(payloadToRecord({ dataUrl: 'https://evil.example/a.png', width: 1, height: 1, fileName: '' }, 1)).toBeNull();
    expect(payloadToRecord({ dataUrl: '', width: 1, height: 1, fileName: '' }, 1)).toBeNull();
    expect(payloadToRecord({ dataUrl: 'data:image/svg+xml;base64,AAAA', width: 1, height: 1, fileName: '' }, 1)).toBeNull();
  });

  it('refuses non-integer or non-positive dimensions', () => {
    expect(payloadToRecord({ dataUrl: URL_PNG, width: 0, height: 32, fileName: '' }, 1)).toBeNull();
    expect(payloadToRecord({ dataUrl: URL_PNG, width: 64.5, height: 32, fileName: '' }, 1)).toBeNull();
    expect(payloadToRecord({ dataUrl: URL_PNG, width: 64, height: -1, fileName: '' }, 1)).toBeNull();
  });

  it('bounds the display-only file name', () => {
    const r = payloadToRecord({ dataUrl: URL_PNG, width: 1, height: 1, fileName: 'x'.repeat(500) }, 1);
    expect(r!.fileName).toHaveLength(64);
  });
});

describe('recordToPayload', () => {
  const id = originIdFor(URL_PNG);

  it('round-trips a good record', () => {
    expect(recordToPayload(rec(), id)).toEqual({
      dataUrl: URL_PNG,
      width: 64,
      height: 32,
      fileName: 'cat.png',
    });
  });

  it('misses on a version it does not know', () => {
    expect(recordToPayload(rec({ v: 2 }), id)).toBeNull();
    expect(recordToPayload(rec({ v: undefined }), id)).toBeNull();
  });

  it('misses when the record is not the one that was asked for', () => {
    expect(recordToPayload(rec(), 'deadbeef')).toBeNull();
    expect(recordToPayload(rec({ originId: 'deadbeef' }), id)).toBeNull();
  });

  it('misses when the bytes no longer hash to the key — tampered or truncated', () => {
    // The id IS a digest of the payload, so this catches a record whose
    // dataUrl was swapped while keeping the key that a node still points at.
    expect(recordToPayload(rec({ dataUrl: URL_WEBP }), id)).toBeNull();
  });

  it('misses on a non-whitelisted payload', () => {
    const hostile = 'data:text/html;base64,PHNjcmlwdD4=';
    expect(recordToPayload(rec({ dataUrl: hostile, originId: originIdFor(hostile) }), originIdFor(hostile))).toBeNull();
  });

  it('misses on out-of-range dimensions', () => {
    expect(recordToPayload(rec({ width: 0 }), id)).toBeNull();
    expect(recordToPayload(rec({ height: 99999 }), id)).toBeNull();
    expect(recordToPayload(rec({ width: 'big' }), id)).toBeNull();
  });

  it('misses on junk instead of throwing', () => {
    expect(recordToPayload(null, id)).toBeNull();
    expect(recordToPayload(undefined, id)).toBeNull();
    expect(recordToPayload('a string', id)).toBeNull();
    expect(recordToPayload(42, id)).toBeNull();
    expect(recordToPayload({}, id)).toBeNull();
  });

  it('bounds a hostile file name rather than rejecting the record', () => {
    const out = recordToPayload(rec({ fileName: 'y'.repeat(1000) }), id);
    expect(out!.fileName).toHaveLength(64);
    expect(recordToPayload(rec({ fileName: 42 }), id)!.fileName).toBe('');
  });
});
