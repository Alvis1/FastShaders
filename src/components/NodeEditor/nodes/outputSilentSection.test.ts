/**
 * A material section that SETS NOTHING says so.
 *
 * The defect (owner, 2026-09-18: "when I add a section and choose the mesh to
 * apply to, it does not assign the color, only after I change it"):
 * `buildShaderModule` drops a `parts` entry with no channels
 * (`props.length > 0`), so a freshly added section — every "+ Add output"
 * starts with one, seeded with a free mesh — changes nothing in the preview,
 * while the node drew its unwired Color row at the CHANNEL DEFAULT, a white
 * the shader never paints. Setting a colour then made it work, which reads as
 * the mesh assignment having failed.
 *
 * The rule is `addedMaterialContributes` (pure, below). The two surfaces that
 * carry the mark are SOURCE-pinned: the vitest env is `node`, so a React node
 * cannot be rendered here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode } from '@/test-utils';
import { graphToCode } from '@/engine/graphToCode';
import { buildShaderModule } from '@/engine/tslCodeProcessor';
import { addedMaterialContributes } from '@/utils/outputMaterials';
import { SECTION_SILENT_KEY, PARKED_KEY } from './sectionLabelText';
import lv from '@/i18n/lv.json';

const NODE_SRC = readFileSync(resolve(__dirname, 'OutputNode.tsx'), 'utf8');
const PICKER_SRC = readFileSync(resolve(__dirname, 'MeshTargetPicker.tsx'), 'utf8');
const PICKER_CSS = readFileSync(resolve(__dirname, 'MeshTargetPicker.css'), 'utf8');

describe('the cause: a channel-less part is dropped', () => {
  it('a section that names a mesh but sets nothing reaches no module', () => {
    const out = makeNode('out', 'output');
    (out.data as { materials?: unknown }).materials = [{ meshTargets: ['Body'] }];
    const gen = graphToCode([out], []);
    // graphToCode DOES emit the entry (the parse needs it to re-create the
    // section) …
    expect(gen.code).toContain('"Body": {  }');
    // … and the module drops it, so the mesh keeps whatever it had.
    expect(buildShaderModule(gen.code)).not.toContain('"Body"');
  });
});

describe('addedMaterialContributes', () => {
  it('is false for a freshly added section', () => {
    expect(addedMaterialContributes({ meshTargets: ['Body'] }, false)).toBe(false);
    expect(addedMaterialContributes(undefined, false)).toBe(false);
    expect(addedMaterialContributes({ meshTargets: ['Body'], values: {} }, false)).toBe(false);
  });

  it('is true once a channel is wired, whatever the values say', () => {
    expect(addedMaterialContributes({ meshTargets: ['Body'] }, true)).toBe(true);
  });

  it('is true once a stored value EMITS', () => {
    expect(addedMaterialContributes({ values: { color: '#112233' } }, false)).toBe(true);
    // The no-op values graphToCode emits nothing for (storedValueEmits).
    expect(addedMaterialContributes({ values: { discard: 0 } }, false)).toBe(false);
    expect(addedMaterialContributes({ values: { position: 0 } }, false)).toBe(false);
    // `normal` is not in OUTPUT_DEFAULT_EXPOSED, so it counts only once the
    // section exposes it — the exposure gate below, stated on a channel whose
    // no-op value (the identity texel) is the interesting half.
    expect(addedMaterialContributes({ exposedPorts: ['normal'], values: { normal: '#8080ff' } }, false)).toBe(false);
    expect(addedMaterialContributes({ exposedPorts: ['normal'], values: { normal: '#90a0ff' } }, false)).toBe(true);
  });

  it('is exposure-gated, exactly as emission is', () => {
    // A tampered value on a HIDDEN channel emits nothing, so it must not make
    // the section look live either.
    expect(addedMaterialContributes({ exposedPorts: [], values: { color: '#ff0000' } }, false)).toBe(false);
    expect(addedMaterialContributes({ exposedPorts: ['color'], values: { color: '#ff0000' } }, false)).toBe(true);
    expect(addedMaterialContributes({ exposedPorts: ['roughness'], values: { color: '#ff0000' } }, false)).toBe(false);
  });

  it('survives junk out of a .fastshader', () => {
    for (const junk of [null, 5, 'x', []]) {
      expect(addedMaterialContributes({ values: junk } as never, false), String(junk)).toBe(false);
    }
  });
});

describe('the node marks it', () => {
  it('derives the mark from that one predicate, at NODE scale', () => {
    // A material is a NODE since the per-material split, so "an ADDED section
    // that sets nothing" became "a TARGETED node that sets nothing" — the same
    // predicate over the node's own material and its own wires. Scoping it to
    // `index !== 0`, as it had to be while a node held a stack, would have made
    // the mark unreachable: every node's material IS material 0 now, so the
    // defect this file is about (point an Output at a mesh, nothing happens)
    // would have come back silently and un-marked.
    expect(NODE_SRC).toContain('addedMaterialContributes(material, anyWired)');
    expect(NODE_SRC).toContain('const silent = !isDefault && !parked && !selfContributes;');
    expect(NODE_SRC).not.toContain('sectionSilent');
  });

  it('excludes the two states that have their OWN mark', () => {
    // The DEFAULT contributing nothing emits the red sentinel (`emitsNothing`),
    // and a PARKED node is not in the module at all — each says something
    // different about why nothing is painted, so neither may borrow this one.
    expect(NODE_SRC).toContain('const parked = isUntargetedOutput(selfNode) && !isDefault;');
    expect(NODE_SRC).toContain('if (!isDefault) return false;');
  });

  it('passes it to the mesh picker', () => {
    expect(NODE_SRC).toContain('silent={silent}');
    expect(NODE_SRC).toContain('parked={parked}');
  });

  it('shows the UNSET swatch instead of the channel default', () => {
    // Both marks reach the swatch: a silent node's part is dropped and a parked
    // node is not in the module, so in EITHER state an unwired channel paints
    // nothing and the channel default would promise a white the preview never
    // renders.
    expect(NODE_SRC).toContain(
      "value={typeof stored === 'string' ? stored : ((silent || parked) ? '' : channelDefault)}",
    );
    expect(NODE_SRC).toContain('title={silent ? t(SECTION_SILENT_KEY, language) : parked ? t(PARKED_KEY, language) : undefined}');
  });

  it('the picker carries the class and the same sentence', () => {
    expect(PICKER_SRC).toContain("silent && !unassigned ? ' mesh-picker--silent' : ''");
    expect(PICKER_SRC).toContain('? t(SECTION_SILENT_KEY, language)');
    expect(PICKER_CSS).toContain('.mesh-picker--silent {');
    // The PARKED mark is the picker's own word, ahead of `unused`: "All
    // meshes" is exactly what a parked node is NOT doing.
    expect(PICKER_SRC).toContain("parked ? ' mesh-picker--parked' : ''");
    expect(PICKER_SRC).toContain("t(parked ? 'Not rendered' : unused ? 'Nothing left' : 'All meshes', language)");
    expect(PICKER_SRC).toContain('? t(PARKED_KEY, language)');
    expect(PICKER_CSS).toContain('.mesh-picker--parked {');
  });

  it('is translated', () => {
    const ui = (lv as { ui: Record<string, string> }).ui;
    for (const k of [SECTION_SILENT_KEY, PARKED_KEY, 'Not rendered']) {
      expect(ui[k], k).toBeTruthy();
      expect(ui[k], k).not.toBe(k);
    }
  });
});
