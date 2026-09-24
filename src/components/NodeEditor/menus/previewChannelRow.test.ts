/**
 * The Image (Texture) node's settings menu, top and bottom (2026-09-19):
 *
 *  - the TOP carries "Preview Channel" plus one button per output socket,
 *    where the generic menu prints the node's own name;
 *  - the shared footer's five `Preview <socket>` rows are OFF for this node
 *    and on for every other, through an explicit prop — the risk being that
 *    someone "simplifies" the opt-out into a predicate and silently strips
 *    Preview from toHsl, Split and the Data node's columns;
 *  - the two lines that spelled "Image" (the generic menu's node-name line and
 *    ImageNodeSettings' own category heading) are gone, the divider stays.
 *
 * No jsdom in this suite, so the component itself is pinned by source text —
 * the house style for a React surface (nodeVisualParity, imageOutputRows).
 * What IS asserted behaviourally is the part that can be: the store field both
 * controls is one field, the labels come from the real i18n path, and every
 * previewable socket of the node gets a button.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { previewableOutputs } from '@/utils/nodePreview';
import { portLabel, t } from '@/i18n';
import type { AppNode } from '@/types';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const ROW = read('./PreviewChannelRow.tsx');
const MENU = read('./NodeSettingsMenu.tsx');
const SHARED = read('./menuShared.tsx');
const IMAGE_SETTINGS = read('./ImageNodeSettings.tsx');

const imageNode = {
  id: 'img1',
  type: 'shader',
  position: { x: 0, y: 0 },
  data: { registryType: 'imageNode', label: 'Image', cost: 0, values: {} },
} as unknown as AppNode;

describe('one button per previewable socket', () => {
  it('covers every output the Image node offers — Color included', () => {
    const ports = previewableOutputs(imageNode);
    expect(ports.map((p) => p.id)).toEqual(['out', 'r', 'g', 'b', 'alpha']);
    // The row maps over exactly this list, so "one button per socket" holds
    // by construction; what a test can still catch is the list going empty.
    expect(ROW).toMatch(/ports\.map\(\(port\) => \{/);
    expect(ROW).toContain('previewableOutputs(node)');
    expect(ROW).toMatch(/if \(ports\.length === 0\) return null;/);
  });

  it('prints the socket names, with `alpha` alone abbreviated', () => {
    const ports = previewableOutputs(imageNode);
    const shown = ports.map((p) => {
      const name = portLabel(p.label, 'en');
      return p.id === 'alpha' ? [...name][0] : name;
    });
    expect(shown).toEqual(['Color', 'R', 'G', 'B', 'A']);
    // Latvian keeps its own spelling of Color rather than being cut to one
    // letter — the abbreviation is by socket ID, never by length.
    const lv = ports.map((p) => {
      const name = portLabel(p.label, 'lv');
      return p.id === 'alpha' ? [...name][0] : name;
    });
    expect(lv[0]).toBe(portLabel('Color', 'lv'));
    expect(lv[0].length).toBeGreaterThan(1);
    expect(lv[4]).toBe('A');
    expect(ROW).toContain("new Set(['alpha'])");
  });

  it('the header and its hint are translated', () => {
    expect(t('Preview Channel', 'lv')).not.toBe('Preview Channel');
    const hint =
      'Show one of this texture’s channels on the 3D preview in place of the Output’s wiring — click the lit one to stop. ⌘/Ctrl+click the node previews its Color.';
    expect(ROW).toContain(hint);
    expect(t(hint, 'lv')).not.toBe(hint);
  });
});

describe('it is the same preview mode, not a second one', () => {
  it('writes the ONE store field and clears it by pressing the lit button', () => {
    expect(ROW).toContain('setNodePreview(active ? null : { nodeId, handleId: port.id })');
    // The active test is the same equality the footer rows use.
    expect(ROW).toContain("nodePreview?.nodeId === nodeId && nodePreview.handleId === port.id");
    expect(SHARED).toContain("nodePreview?.nodeId === nodeId && nodePreview.handleId === port.id");
  });

  it('marks the live channel for assistive tech as well as by eye', () => {
    expect(ROW).toMatch(/aria-pressed=\{active\}/);
  });

  it('closes the menu, like every other action in it', () => {
    expect(ROW).toContain('closeContextMenu()');
  });
});

describe('the footer opt-out is explicit and defaults to today', () => {
  it('NodeActions keeps its rows unless a caller says otherwise', () => {
    expect(SHARED).toMatch(/NodeActions\(\{ nodeId, preview = true \}/);
    expect(SHARED).toMatch(/\{preview && previewPorts\.length > 0 && \(/);
  });

  it('exactly ONE call site turns them off, and only for the Image node', () => {
    expect(MENU).toContain('<NodeActions nodeId={nodeId} preview={!imageNode} />');
    // The five other menus render the footer plainly — a `preview={` appearing
    // in any of them means the opt-out has started spreading.
    for (const f of [
      './RaymarchSettingsMenu.tsx',
      './StripesSettingsMenu.tsx',
      './DataVizSettingsMenu.tsx',
      './ColormapSettingsMenu.tsx',
      './DataRangeSettingsMenu.tsx',
    ]) {
      const src = read(f);
      expect(src, f).toContain('<NodeActions nodeId={nodeId} />');
      expect(src, f).not.toContain('preview={');
    }
  });

  it('the flag is a node-type test, never a port-count heuristic', () => {
    // toHsl (h/s/l), Split (x/y/z/w) and every Data node column need those
    // rows; a rule like "more than one output" would take them away.
    expect(MENU).toContain("const imageNode = node.data.registryType === 'imageNode';");
    expect(SHARED).not.toMatch(/previewPorts\.length > 2/);
  });
});

describe('the two “Image” subheaders are gone, the divider stays', () => {
  it('the generic menu prints the node name for every type EXCEPT this one', () => {
    expect(MENU).toContain('formatNodeLabel(def.label, node.data.registryType, language)');
    expect(MENU).toMatch(/\{imageNode \? \(\s*<PreviewChannelRow nodeId=\{nodeId\} \/>\s*\) : \(/);
  });

  it('ImageNodeSettings opens on a divider and no heading', () => {
    // The RENDER, not the word: the file keeps a scar comment naming the
    // heading it used to draw, which is what stops it being re-added.
    expect(IMAGE_SETTINGS).not.toContain('className="context-menu__category"');
    expect(IMAGE_SETTINGS).toContain('<div className="context-menu__divider" />');
    expect(IMAGE_SETTINGS).not.toMatch(/t\('Image', language\)/);
  });

  it('the orphaned Latvian entry went with the call site', () => {
    // The i18n header's rule: a key whose only caller is deleted is deleted
    // too, and there is deliberately no CI guard — so this is the guard.
    const lv = JSON.parse(read('../../../i18n/lv.json')) as { ui?: Record<string, string> };
    const flat = JSON.stringify(lv);
    expect(flat).not.toContain('"Image":');
    // The NODE's label is a different table and is untouched.
    expect(NODE_REGISTRY.get('imageNode')!.label).toBe('Image');
  });
});
