/**
 * Which document an embedded editor's graph is (embed/embedDocument.ts): the
 * id every bridge message carries, so the host files a module by what it IS
 * and never by what happens to be selected when it arrives.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EMBED_ID_MAX,
  EMBED_PROTOCOL,
  EMBED_REASON_MAX,
  MINTED_ID_PREFIX,
  OPEN_FAILED_FALLBACK,
  embedDocument,
  embedDocumentFields,
  embedDocumentOpened,
  embedDocumentReplaced,
  embedModuleKey,
  hostDocumentId,
  openFailedReason,
} from './embedDocument';

// The suite shares one module registry (isolate: false): leave the boot state behind.
afterEach(() => embedDocumentOpened(null));

describe('the embedded document', () => {
  it('is a leaf: exportShader.ts stamps the id without pulling the bridge chunk', () => {
    const src = readFileSync(fileURLToPath(new URL('./embedDocument.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it('speaks protocol 3, and says what 3 adds over 2 where hosts read the number', () => {
    // A host decides on this number whether the editor takes a look and a
    // rename, and whether its canvas can be seen through.
    expect(EMBED_PROTOCOL).toBe(3);
    const src = readFileSync(fileURLToPath(new URL('./embedDocument.ts', import.meta.url)), 'utf8');
    const doc = src.slice(src.lastIndexOf('/**', src.indexOf('export const EMBED_PROTOCOL')), src.indexOf('export const EMBED_PROTOCOL'));
    for (const claim of ['2: every message names its document', '3 adds, over 2', '`superwxr:appearance`', '`superwxr:rename`', 'arrival order', 'fresh undo history', 'own `ui` block', '`superwxr:open-failed` (with `retry`)']) {
      expect(doc, claim).toContain(claim);
    }
  });

  it('takes a host id only as a non-empty bounded string', () => {
    expect(hostDocumentId('asset-7')).toBe('asset-7');
    expect(hostDocumentId('x'.repeat(EMBED_ID_MAX))).toHaveLength(EMBED_ID_MAX);
    for (const bad of ['', 'x'.repeat(EMBED_ID_MAX + 1), 7, null, undefined, {}, ['a'], true]) {
      expect(hostDocumentId(bad)).toBeNull();
    }
  });

  it('the graph the editor starts with came from no open and replaced nothing', () => {
    expect(embedDocument()).toEqual({ id: null });
    // No `replaced` KEY at all: that is how a host tells the boot graph (ignore
    // it) from a file opened before anything else was (`replaced: null`).
    expect(Object.keys(embedDocumentFields())).toEqual(['id']);
  });

  it('an open makes the graph that document, and the fields say only that', () => {
    embedDocumentOpened('asset-7');
    expect(embedDocumentFields()).toEqual({ id: 'asset-7' });
    expect('replaced' in embedDocumentFields()).toBe(false);
    embedDocumentOpened('asset-8');
    expect(embedDocumentFields()).toEqual({ id: 'asset-8' });
  });

  it('a file opened inside the editor is ANOTHER document: a minted id, naming what it replaced', () => {
    embedDocumentOpened('asset-7');
    embedDocumentReplaced();
    const first = embedDocumentFields();
    expect(first.id).toMatch(new RegExp(`^${MINTED_ID_PREFIX}`));
    expect(first.id).not.toBe('asset-7');
    expect(first.replaced).toBe('asset-7');
    // Every later edit of that document names the SAME thing.
    expect(embedDocumentFields()).toEqual(first);

    // A second file over the first: a new id again, replacing the minted one.
    embedDocumentReplaced();
    const second = embedDocumentFields();
    expect(second.id).not.toBe(first.id);
    expect(second.replaced).toBe(first.id);
  });

  it('a file opened over the boot graph replaced nothing the host knows', () => {
    embedDocumentReplaced();
    const fields = embedDocumentFields();
    expect(fields.id).toMatch(new RegExp(`^${MINTED_ID_PREFIX}`));
    expect(fields).toHaveProperty('replaced', null);
  });

  it('…nor one opened while a host-opened bare module\'s graph is on its way, which is no document\'s', () => {
    // The bridge makes the graph nobody's from a bare module's import to the
    // decision (EmbedBridge.tsx `bareLanded`): the document before it is
    // gone, and this one is not there yet.
    embedDocumentOpened('asset-B');
    embedDocumentOpened(null);
    embedDocumentReplaced();
    expect(embedDocumentFields()).toHaveProperty('replaced', null);
  });

  it('the host opening a document ends a minted one', () => {
    embedDocumentOpened('asset-7');
    embedDocumentReplaced();
    embedDocumentOpened('asset-9');
    expect(embedDocumentFields()).toEqual({ id: 'asset-9' });
  });

  it('a host that sends no id gets none back', () => {
    embedDocumentOpened('asset-7');
    embedDocumentOpened(null);
    expect(embedDocumentFields()).toEqual({ id: null });
  });

  it('dedupes on the document AND the text', () => {
    embedDocumentOpened('asset-7');
    const held = embedModuleKey('module text');
    expect(embedModuleKey('module text')).toBe(held);
    expect(embedModuleKey('module text 2')).not.toBe(held);
    // The same text under another document is a different post: a file dropped
    // onto the editor that already shows it must still reach the host.
    embedDocumentReplaced();
    expect(embedModuleKey('module text')).not.toBe(held);
    embedDocumentOpened('asset-8');
    expect(embedModuleKey('module text')).not.toBe(held);
  });
});

describe('why an open failed, as the host is told (superwxr:open-failed\'s reason)', () => {
  it('is one plain line: an Error\'s message or a string, its breaks and control characters spaces', () => {
    expect(openFailedReason(new Error('the shader converter could not be loaded'))).toBe('the shader converter could not be loaded');
    expect(openFailedReason('  two\nlines\r\n\tand\u0000a tab  ')).toBe('two lines and a tab');
    expect(openFailedReason('a\u2028b\u2029c\u0085d')).toBe('a b c d');
  });

  it('is never markup: the angle brackets a quoted input brings are drawn as ‹ ›', () => {
    const reason = openFailedReason(new SyntaxError('Unexpected token \'<\', "<img src=x onerror=alert(1)>" is not valid JSON'));
    expect(reason).not.toMatch(/[<>]/);
    expect(reason).toBe('Unexpected token \'‹\', "‹img src=x onerror=alert(1)›" is not valid JSON');
  });

  it('drops a parser\'s trailing (line:column): it counts lines of the CONVERTED module, which the host never sees', () => {
    // MEASURED: SuperWXR's New shader with a comma missing on line 9 parses to
    // `(4:25)`, the line scriptToTSL moved it to.
    expect(openFailedReason('Unexpected token, expected "," (4:25)')).toBe('Unexpected token, expected ","');
    expect(openFailedReason('Unterminated string constant. (12:3)')).toBe('Unterminated string constant.');
    // Only at the end, and only that shape.
    expect(openFailedReason('a (1:2) b')).toBe('a (1:2) b');
    expect(openFailedReason('expected (1)')).toBe('expected (1)');
  });

  it('is at most EMBED_REASON_MAX characters, cut with an ellipsis and never inside a surrogate pair', () => {
    expect(EMBED_REASON_MAX).toBe(200);
    const long = openFailedReason('x'.repeat(500));
    expect(long).toHaveLength(EMBED_REASON_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(openFailedReason('y'.repeat(EMBED_REASON_MAX))).toBe('y'.repeat(EMBED_REASON_MAX));
    // A pair straddling the cut is dropped whole, not halved.
    const astral = openFailedReason(`${'z'.repeat(EMBED_REASON_MAX - 2)}😀😀😀`);
    expect(astral.length).toBeLessThanOrEqual(EMBED_REASON_MAX);
    expect(astral).toBe(`${'z'.repeat(EMBED_REASON_MAX - 2)}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(astral)).toBe(false);
  });

  it('says something when its cause says nothing usable', () => {
    for (const cause of [undefined, null, 7, {}, { message: 5 }, '', '   ', new Error(''), '(3:4)']) {
      expect(openFailedReason(cause)).toBe(OPEN_FAILED_FALLBACK);
    }
  });
});
