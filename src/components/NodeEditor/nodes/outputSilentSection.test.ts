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
import { SECTION_SILENT_KEY } from './sectionLabelText';
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
  it('derives the mark from that one predicate, never material 0', () => {
    expect(NODE_SRC).toContain('const sectionSilent = (index: number): boolean => {');
    expect(NODE_SRC).toContain('if (index === 0) return false;');
    expect(NODE_SRC).toContain('return !addedMaterialContributes(materials[index], wired);');
  });

  it('passes it to the mesh picker', () => {
    expect(NODE_SRC).toContain('const silent = sectionSilent(index);');
    expect(NODE_SRC).toContain('silent={silent}');
  });

  it('shows the UNSET swatch instead of the channel default', () => {
    expect(NODE_SRC).toContain(
      "value={typeof stored === 'string' ? stored : (silent ? '' : channelDefault)}",
    );
    expect(NODE_SRC).toContain('title={silent ? t(SECTION_SILENT_KEY, language) : undefined}');
  });

  it('the picker carries the class and the same sentence', () => {
    expect(PICKER_SRC).toContain("silent && !unassigned ? ' mesh-picker--silent' : ''");
    expect(PICKER_SRC).toContain('? t(SECTION_SILENT_KEY, language)');
    expect(PICKER_CSS).toContain('.mesh-picker--silent {');
  });

  it('is translated', () => {
    expect((lv as { ui: Record<string, string> }).ui[SECTION_SILENT_KEY]).toBeTruthy();
  });
});
