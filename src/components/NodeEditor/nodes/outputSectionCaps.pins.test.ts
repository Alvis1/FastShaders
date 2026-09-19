/**
 * Source pins for decision 9 on the Output node's NAME sections (GLB Phase 5
 * Step 4). The vitest env is `node`, so the node, the picker and the menu
 * cannot be rendered; what is pinned is the shape every one of these rules
 * takes in source, because none of them fails loudly:
 *
 *  - "+ Add output" never vanishes at a cap: it stays, `aria-disabled`, with
 *    its reason in the title (a control that disappears is a cap that does not
 *    announce itself).
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
const OUTPUT_NODE = read('OutputNode.tsx');
const PICKER = read('MeshTargetPicker.tsx');
const MENU = read('../menus/ShaderSettingsMenu.tsx');
const OUTPUT_CSS = read('OutputNode.css');
const PICKER_CSS = read('MeshTargetPicker.css');
const MATERIALS = read('../../../utils/outputMaterials.ts');

describe('"+ Add output" announces its cap', () => {
  it('is rendered for every model, not gated on being able to add', () => {
    expect(OUTPUT_NODE).toContain('{hasMeshes && (');
    expect(OUTPUT_NODE).not.toMatch(/\{hasMeshes && [^(]*canAddMaterial && \(/);
  });

  it('is aria-disabled with its reason, never disabled, and a press does nothing', () => {
    expect(OUTPUT_NODE).toContain('aria-disabled={!canAddMaterial || undefined}');
    expect(OUTPUT_NODE).toContain('title={canAddMaterial ? t(\'Shade another mesh with its own material\', language) : addBlockedReason}');
    expect(OUTPUT_NODE).toContain('onClick={canAddMaterial ? addMaterial : undefined}');
    expect(OUTPUT_NODE).not.toMatch(/(?<![-\w])disabled=\{!canAddMaterial/);
    expect(OUTPUT_NODE).toContain("fillTemplate(t('An Output holds at most {max} mesh sections', language), { max: MAX_ADDED_MATERIALS })");
    expect(OUTPUT_NODE).toContain("t('Every mesh already has its own section', language)");
    expect(OUTPUT_CSS).toContain('.output-node__add--disabled');
  });
});

describe('the node and emission share ONE first-claim plan', () => {
  it('the shadowed mark reads planNamedParts, and the old local loop is gone', () => {
    expect(OUTPUT_NODE).toContain('planNamedParts(materials)');
    expect(OUTPUT_NODE).toContain('namedPlan.shadowed.has(index)');
    expect(OUTPUT_NODE).not.toContain('claimedAbove');
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
    expect(MENU).toContain('formatSectionLabel(sectionLabel(materials, activeIndex, readModelSignature(outputData)), language)');
    expect(MENU).not.toContain('materialTargetNames(activeMaterial)');
    expect(MENU).not.toContain('`#${activeIndex}`');
    expect(MENU).not.toMatch(/<select[\s\S]{0,200}?setMaterialIndex/);
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
      'An Output holds at most {max} mesh sections',
      'Every mesh already has its own section',
      'One section shades at most {max} meshes. Untick one first.',
    ]) {
      expect(ui[k], k).toBeTruthy();
      expect(ui[k]).not.toBe(k);
      // Placeholders survive the translation.
      for (const p of k.match(/\{\w+\}/g) ?? []) expect(ui[k]).toContain(p);
    }
  });
});
