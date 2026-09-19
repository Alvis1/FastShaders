/**
 * Source pins for decision 9 on the Output node's NAME sections (GLB Phase 5
 * Step 4). The vitest env is `node`, so the node, the picker and the menu
 * cannot be rendered; what is pinned is the shape every one of these rules
 * takes in source, because none of them fails loudly:
 *
 *  - "+ Add output" is RETIRED (owner decision D3, the per-material Output
 *    split): a material is a NODE now, so the palette tile and Shift+A add
 *    one and the mesh dropdown targets it. Its cap sentences named
 *    `MAX_ADDED_MATERIALS`, which stopped describing anything the moment a
 *    node stopped holding a stack of materials.
 *  - The picker's one refused row is an UNTICKED row past the per-section cap,
 *    `aria-disabled` and never `disabled` (WebKit drops the title).
 *  - The node's shadowed mark reads the same plan emission does.
 *  - ShaderSettingsMenu's scope line goes through the one section-label pair.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import lv from '@/i18n/lv.json';

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
/** Source with its comments removed. The "must be gone" sweeps below are about
 *  CODE: the comments that replaced these controls NAME them, which is the
 *  whole point of a retirement note, and a raw `toContain` would refuse the
 *  explanation along with the thing it explains. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const OUTPUT_NODE = read('OutputNode.tsx');
const PICKER = read('MeshTargetPicker.tsx');
const MENU = read('../menus/ShaderSettingsMenu.tsx');
const OUTPUT_CSS = read('OutputNode.css');
const PICKER_CSS = read('MeshTargetPicker.css');
const MATERIALS = read('../../../utils/outputMaterials.ts');

describe('"+ Add output" is retired, and stays retired', () => {
  it('leaves no button, no cap sentence and no stylesheet rule behind', () => {
    // A control that half-exists is worse than one that never did: the CSS
    // outliving the JSX is how a dead rule gets wired back up by someone
    // reading the stylesheet.
    for (const dead of [
      'output-node__add',
      'canAddMaterial',
      'addBlockedReason',
      'addMaterial',
      'An Output holds at most {max} mesh sections',
      'Every mesh already has its own section',
    ]) {
      expect(code(OUTPUT_NODE), `${dead} must be gone from the node`).not.toContain(dead);
    }
    expect(code(OUTPUT_CSS)).not.toContain('.output-node__add');
    // MAX_ADDED_MATERIALS was the number those sentences named. Nothing on the
    // node counts sections any more — a node IS one material.
    expect(code(OUTPUT_NODE)).not.toContain('MAX_ADDED_MATERIALS');
    expect(code(OUTPUT_NODE)).not.toContain('countSectionsAcross');
  });

  it('the ✕ that removed a material went with the stack it sat in', () => {
    // Removing a material is deleting a NODE now — the ordinary Delete /
    // context-menu path — so the node carries no removal control of its own,
    // and no handle-renumbering with it.
    expect(code(OUTPUT_NODE)).not.toContain('output-node__mesh-remove');
    expect(code(OUTPUT_NODE)).not.toContain('shiftMaterialHandles');
    expect(code(OUTPUT_NODE)).not.toContain('removeMaterial');
  });
});

describe('the node and emission share ONE first-claim plan', () => {
  it('the shadowed mark reads planNamedParts, and the old local loop is gone', () => {
    // The CROSS-NODE form over the CONTRIBUTING set — exactly the nodes
    // graphToCode walks — so the node's shadowed mark and the emitted `parts`
    // can never disagree about which mesh belongs to which node. Handing in
    // the node alone was right only while a mesh could only be claimed by a
    // sibling SECTION.
    // In the shared plans module since the O(N²) fix — the derivation moved,
    // the rule did not: the plan is still the CROSS-NODE one over the
    // contributing set, and the node still reads its own slice by id.
    expect(read('outputNodePlans.ts')).toContain('planNamedPartsAcross(contributing)');
    expect(OUTPUT_NODE).toContain('namedPlanAcross.shadowed.get(id) ?? EMPTY_SECTIONS');
    expect(OUTPUT_NODE).toContain('shadowedSections.has(SELF)');
    expect(code(OUTPUT_NODE)).not.toContain('claimedAbove');
    expect(code(OUTPUT_NODE)).not.toContain('selfOutputs');
  });

  it('the picker is handed the per-section cap', () => {
    expect(OUTPUT_NODE).toContain('maxNames={MAX_PARTS}');
  });
});

describe('the picker refuses exactly one row: an unticked one past the cap', () => {
  it('marks it capped and aria-disabled, never disabled', () => {
    expect(PICKER).toContain('const capped = !selectedSet.has(name) && selected.length >= maxNames;');
    expect(PICKER).toContain('mesh-picker__row--capped');
    expect(PICKER).toContain('aria-disabled={capped || undefined}');
    expect(PICKER).not.toMatch(/(?<![-\w])disabled=\{capped/);
    expect(PICKER).toContain('if (capped) return;');
    expect(PICKER).toContain("t('One section shades at most {max} meshes. Untick one first.', language)");
    expect(PICKER_CSS).toContain('.mesh-picker__row--capped');
  });

  it('defaults the cap to MAX_PARTS, the number materialTargetNames reads back', () => {
    expect(PICKER).toContain('maxNames = MAX_PARTS,');
  });
});

describe('ShaderSettingsMenu names a section the way the node does', () => {
  it('goes through sectionLabel + formatSectionLabel, and adds no selector', () => {
    expect(MENU).toContain('formatSectionLabel(sectionLabel(materials, 0, readModelSignature(outputData)), language)');
    expect(MENU).not.toContain('materialTargetNames(activeMaterial)');
    expect(MENU).not.toContain('`#${activeIndex}`');
    expect(MENU).not.toMatch(/<select[\s\S]{0,200}?setMaterialIndex/);
  });

  it('is scoped to the NODE, so the section selector and its seed are gone', () => {
    // One Output node is ONE material: there is nothing left to choose between
    // inside a node, and a menu that still tracked an index would silently edit
    // material 0 of whatever it was pointed at while calling it a section.
    for (const dead of ['materialIndex', 'setMaterialIndex', 'activeIndex', 'activeMaterial', 'seededIndex']) {
      expect(code(MENU), `${dead} must be gone`).not.toContain(dead);
    }
    // ...and so is the right-click walk that seeded it.
    expect(code(read('../NodeEditor.tsx'))).not.toContain('data-material-index');
    expect(code(OUTPUT_NODE)).not.toContain('data-material-index');
  });
});

describe('the restore sanitizer reports', () => {
  it('sanitizeOutputMaterials delegates to the counted report', () => {
    expect(MATERIALS).toContain('return sanitizeOutputMaterialsReport(nodes).nodes;');
  });
});

describe('Latvian', () => {
  const ui = (lv as { ui: Record<string, string> }).ui;
  it('carries every new string, each a translation rather than the English key', () => {
    for (const k of [
      'One section shades at most {max} meshes. Untick one first.',
    ]) {
      expect(ui[k], k).toBeTruthy();
      expect(ui[k]).not.toBe(k);
      // Placeholders survive the translation.
      for (const p of k.match(/\{\w+\}/g) ?? []) expect(ui[k]).toContain(p);
    }
  });
});
