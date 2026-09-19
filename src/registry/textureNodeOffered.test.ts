/**
 * The Texture (Image) node is OFFERED — the owner's decision, 2026-09-18.
 *
 * It shipped hidden through `editorVisibility.json` while it was unfinished
 * (GLB Phase 4), so the palette, the Add-node menu and the search box did not
 * carry it and the only way to get one was to drop an image file. The owner
 * asked for the node itself ("Why there is no texture node, where I can select
 * from existing?"), and its picker — the settings menu's Texture row — already
 * offers every image the project holds, GLB-imported ones included.
 *
 * This is the ONE file that pins the node's shipped visibility, and it does so
 * for `imageNode` ALONE. Everything else about visibility still follows the
 * file: `imageNodeAddable.test.ts` reads `isNodeHiddenFromEditor` and asserts
 * against it in both directions, and `contentBrowserVirtual.test.ts` derives
 * its boot counts the same way, so the "In editor" checkbox stays usable for
 * every OTHER node without reddening CI (the rule CLAUDE.md states). Re-hiding
 * THIS node is now a decision rather than a tick, and this assertion is where
 * that decision would be recorded — delete it here first, deliberately.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getEditorDefinitions, searchNodes, NODE_REGISTRY } from './nodeRegistry';
import { isNodeHiddenFromEditor } from './editorVisibility';
import { hiddenOptionalCategories, DEFAULT_OPTIONAL_CATEGORIES } from './optionalCategories';

const JSON_PATH = new URL('./editorVisibility.json', import.meta.url).pathname;
const has = (list: readonly { type: string }[]) => list.some((d) => d.type === 'imageNode');

describe('the Texture (Image) node is offered by the add surfaces', () => {
  it('editorVisibility.json does not hide it', () => {
    expect(isNodeHiddenFromEditor('imageNode')).toBe(false);
    // Read the file too: the module derives from it, so a mocked module in
    // another suite could not make this pass against a re-hidden file.
    const file = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as { nodes?: unknown };
    expect(Array.isArray(file.nodes) ? file.nodes : []).not.toContain('imageNode');
  });

  it('it is in the editor set, with and without the default optional switches', () => {
    expect(has(getEditorDefinitions())).toBe(true);
    expect(has(getEditorDefinitions(hiddenOptionalCategories(DEFAULT_OPTIONAL_CATEGORIES)))).toBe(true);
  });

  it('the search box finds it by "texture" as well as by its own name', () => {
    // "Texture" reaches it through the `Also:` alias tail, which is what the
    // owner would type; the settings row that fills it is called Texture too.
    expect(has(searchNodes('texture'))).toBe(true);
    expect(has(searchNodes('texture', hiddenOptionalCategories(DEFAULT_OPTIONAL_CATEGORIES)))).toBe(true);
    expect(has(searchNodes('image'))).toBe(true);
    expect(NODE_REGISTRY.get('imageNode')!.description).toContain('Also: texture');
  });

  it('an empty node names the control that fills it', async () => {
    // The card's own affordance: `ImageThumbEmpty`'s title. A node added from
    // the palette carries no payload, so this sentence is the whole answer to
    // "I added it and nothing happened".
    const { IMAGE_EMPTY_HINT } = await import('@/components/NodeEditor/nodes/ShaderNode');
    expect(IMAGE_EMPTY_HINT).toContain('Texture');
  });
});
