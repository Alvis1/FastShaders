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
  MINTED_ID_PREFIX,
  embedDocument,
  embedDocumentFields,
  embedDocumentOpened,
  embedDocumentReplaced,
  embedModuleKey,
  hostDocumentId,
} from './embedDocument';

// The suite shares one module registry (isolate: false): leave the boot state behind.
afterEach(() => embedDocumentOpened(null));

describe('the embedded document', () => {
  it('is a leaf: exportShader.ts stamps the id without pulling the bridge chunk', () => {
    const src = readFileSync(fileURLToPath(new URL('./embedDocument.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(EMBED_PROTOCOL).toBe(2);
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
