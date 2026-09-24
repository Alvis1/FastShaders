/**
 * The Image (Texture) node is an ordinary registry definition since GLB
 * Phase 4 Step 4 — addable EMPTY from the palette and the Add-node menu, and
 * shipped HIDDEN through editorVisibility.json until it is finished.
 *
 * Every assertion about visibility follows the FILE, never a hardcoded state:
 * the owner unhides the node by ticking "In editor" in node-editor.html, and
 * the suite must stay green in both states (release.yml runs `npm test`
 * before it builds — a test that only holds hidden would block the unhide).
 */
import { describe, it, expect } from 'vitest';
import {
  NODE_REGISTRY,
  getAllDefinitions,
  getEditorDefinitions,
  getFlowNodeType,
  searchNodes,
  categoryEmptiedByHiding,
} from './nodeRegistry';
import { isNodeHiddenFromEditor } from './editorVisibility';
import {
  isOptionalCategory,
  hiddenOptionalCategories,
  DEFAULT_OPTIONAL_CATEGORIES,
} from './optionalCategories';
import { initialNodeValues } from '@/utils/newNodeValues';
import { IMAGE_CHANNEL_COMPONENTS } from '@/utils/imageChannels';

const def = NODE_REGISTRY.get('imageNode')!;

describe('the Image node is a registry definition', () => {
  it('is in getAllDefinitions, ShaderNode-rendered, category input (not optional)', () => {
    expect(getAllDefinitions()).toContain(def);
    expect(getFlowNodeType(def)).toBe('shader');
    expect(def.category).toBe('input');
    // `texture` is an OPTIONAL category, off by default: a def there would be
    // unofferable until the user found the switch.
    expect(isOptionalCategory(def.category)).toBe(false);
  });

  it('sits right after UV in registry order (the Add-node tie-break)', () => {
    const types = getAllDefinitions().map((d) => d.type);
    expect(types.indexOf('imageNode')).toBe(types.indexOf('uv') + 1);
  });

  it('no definition is left in the texture category — it is the asset-only Textures tab', () => {
    expect([...NODE_REGISTRY.values()].filter((d) => d.category === 'texture')).toEqual([]);
  });

  it('keeps the output contract: Color first, then the channel table', () => {
    expect(def.outputs[0]).toMatchObject({ id: 'out', label: 'Color', dataType: 'vec3' });
    expect(def.outputs.map((o) => o.id)).toEqual(['out', ...IMAGE_CHANNEL_COMPONENTS.keys()]);
    expect(def.outputs.map((o) => o.label)).toEqual(['Color', 'R', 'G', 'B', 'Alpha']);
  });
});

describe('its visibility follows editorVisibility.json, not the category', () => {
  const hidden = isNodeHiddenFromEditor('imageNode');
  const has = (list: { type: string }[]) => list.some((d) => d.type === 'imageNode');

  it('the editor set agrees with the file, with and without the default optional switches', () => {
    expect(has(getEditorDefinitions())).toBe(!hidden);
    expect(has(getEditorDefinitions(hiddenOptionalCategories(DEFAULT_OPTIONAL_CATEGORIES)))).toBe(!hidden);
  });

  it('the search box agrees too — a hidden node cannot be typed back into existence', () => {
    expect(has(searchNodes('image'))).toBe(!hidden);
    expect(has(searchNodes('texture', hiddenOptionalCategories(DEFAULT_OPTIONAL_CATEGORIES)))).toBe(!hidden);
  });

  it('hidden is never unreachable: the registry still resolves it, and the Input tab stays', () => {
    expect(NODE_REGISTRY.get('imageNode')).toBe(def);
    expect(categoryEmptiedByHiding('input')).toBe(false);
  });
});

describe('an add lands in the empty state', () => {
  it('a fresh node carries no payload', () => {
    const values = initialNodeValues(def, []);
    expect('imageB64' in values).toBe(false);
    expect(values).toEqual({ tileX: 1, tileY: 1, offsetX: 0, offsetY: 0 });
  });
});
