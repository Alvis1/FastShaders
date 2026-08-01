import { describe, it, expect } from 'vitest';
import { getBuiltinPresets } from './builtinPresets';
import { getBuiltinTextures } from './builtinTextures';
import { codeToGraph } from '@/engine/codeToGraph';
import { graphToCode } from '@/engine/graphToCode';
import { getNodeValues } from '@/types';

describe('builtinPresets', () => {
  const presets = getBuiltinPresets();

  it('ships the full three-tier library with unique ids', () => {
    expect(presets.length).toBe(15);
    expect(new Set(presets.map((p) => p.id)).size).toBe(15);
    // Ordered easy→advanced: tiers never decrease along the strip.
    const tiers = presets.map((p) => p.tier);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    expect(tiers).toContain(1);
    expect(tiers).toContain(2);
    expect(tiers).toContain(3);
  });

  it.each(getBuiltinPresets().map((p) => [p.id, p] as const))(
    '%s parses cleanly from its TSL source',
    (_id, preset) => {
      const { nodes, errors } = codeToGraph(preset.code);
      // Zero errors AND zero warnings — a preset that parses with an unknown
      // node or a dropped statement is broken teaching material.
      expect(errors).toEqual([]);
      expect(nodes.filter((n) => n.data.registryType === 'unknown')).toEqual([]);
    },
  );

  it.each(getBuiltinPresets().map((p) => [p.id, p] as const))(
    '%s builds a well-formed group asset',
    (_id, preset) => {
      const [group, ...members] = preset.nodes;
      expect(group.id).toBe(`builtin-preset-${preset.id}`);
      expect(group.type).toBe('group');
      expect(members.length).toBeGreaterThanOrEqual(5);
      for (const m of members) {
        expect(m.parentId).toBe(group.id);
        expect(m.data.registryType).not.toBe('output');
      }
      const memberIds = new Set(members.map((m) => m.id));
      for (const e of preset.edges) {
        expect(memberIds.has(e.source)).toBe(true);
        expect(memberIds.has(e.target)).toBe(true);
      }
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    },
  );

  it.each(getBuiltinPresets().map((p) => [p.id, p] as const))(
    '%s exposes tunable named uniforms',
    (_id, preset) => {
      const propNames = preset.nodes
        .filter((n) =>
          n.data.registryType === 'property_float' || n.data.registryType === 'property_color',
        )
        .map((n) => getNodeValues(n).name);
      // Openable-preset pedagogy: every preset has 2–5 scrubbable parameters,
      // each carrying a real name (they surface in the Uniforms overlay).
      expect(propNames.length).toBeGreaterThanOrEqual(2);
      expect(propNames.length).toBeLessThanOrEqual(5);
      for (const name of propNames) {
        expect(typeof name).toBe('string');
        expect((name as string).length).toBeGreaterThan(0);
      }
      expect(new Set(propNames).size).toBe(propNames.length);
    },
  );

  it.each(getBuiltinPresets().map((p) => [p.id, p] as const))(
    '%s survives the graph→code→graph round trip that compiles the preview',
    (_id, preset) => {
      // After a drop the preset only exists as a GRAPH; the preview compiles
      // whatever graphToCode emits for it. Re-parse the raw snippet (with its
      // output node), emit, and re-parse the emission — any preset node type
      // the emitter mishandles surfaces here instead of in a black preview.
      const first = codeToGraph(preset.code);
      expect(first.errors).toEqual([]);
      const emitted = graphToCode(first.nodes, first.edges).code;
      const second = codeToGraph(emitted);
      expect(second.errors).toEqual([]);
      expect(second.nodes.filter((n) => n.data.registryType === 'unknown')).toEqual([]);
      // The tunable-parameter contract survives emission: same named uniforms.
      const names = (nodes: typeof second.nodes) => nodes
        .filter((n) =>
          n.data.registryType === 'property_float' || n.data.registryType === 'property_color',
        )
        .map((n) => getNodeValues(n).name)
        .sort();
      expect(names(second.nodes)).toEqual(names(first.nodes));
    },
  );

  it.each(getBuiltinPresets().map((p) => [p.id, p] as const))(
    '%s ships an explainer note inside the frame',
    (_id, preset) => {
      const notes = preset.nodes.filter((n) => n.type === 'note');
      expect(notes).toHaveLength(1);
      const [note] = notes;
      expect(note.parentId).toBe(preset.nodes[0].id);
      const heading = String(note.data.heading);
      const text = String(note.data.text);
      expect(heading.length).toBeGreaterThan(0);
      expect(heading.length).toBeLessThanOrEqual(26);
      expect(text.length).toBeGreaterThan(40);
      // The note box is sized for this budget — longer text scrolls out of
      // sight, and an unread explainer is worse than none.
      expect(text.length).toBeLessThanOrEqual(200);
      // Stored in a TS string literal and rendered in a fixed-size box.
      // eslint-disable-next-line no-control-regex
      expect(text).toMatch(/^[\x20-\x7E]+$/);
      expect(heading).toMatch(/^[\x20-\x7E]+$/);
      // It explains the STRUCTURE, so it must not just restate the card blurb.
      expect(text).not.toBe(preset.description);
      // Notes carry no wires.
      for (const e of preset.edges) {
        expect(e.source).not.toBe(note.id);
        expect(e.target).not.toBe(note.id);
      }
    },
  );

  it('gives every preset a distinct note', () => {
    const headings = getBuiltinPresets().map(
      (p) => String(p.nodes.find((n) => n.type === 'note')!.data.heading),
    );
    expect(new Set(headings).size).toBe(headings.length);
  });

  it('keeps uniform names unique ACROSS presets', () => {
    // Uniform values persist by NAME (the preview seeds only names not already
    // stored) and graphToCode uniquifies clashes by renaming — either way a
    // shared name breaks the second preset's card instructions. Names are the
    // presets' public API; keep them globally distinct.
    const seen = new Map<string, string>();
    for (const preset of presets) {
      for (const node of preset.nodes) {
        const rt = node.data.registryType;
        if (rt !== 'property_float' && rt !== 'property_color') continue;
        const name = String(getNodeValues(node).name);
        const owner = seen.get(name);
        expect(owner, `uniform "${name}" appears in both "${owner}" and "${preset.id}"`).toBeUndefined();
        seen.set(name, preset.id);
      }
    }
  });

  it('keeps the built-in textures building through the shared group builder', () => {
    const textures = getBuiltinTextures();
    expect(textures.length).toBe(8);
    for (const tex of textures) {
      const [group, ...members] = tex.nodes;
      expect(group.id).toBe(`builtin-texture-${tex.id}`);
      expect(members.length).toBeGreaterThan(0);
      for (const m of members) expect(m.parentId).toBe(group.id);
    }
  });
});
