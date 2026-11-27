import { describe, it, expect } from 'vitest';
import { getBuiltinPresets, isRecipe } from './builtinPresets';
import { getBuiltinTextures } from './builtinTextures';
import { getEditorDefinitions } from './nodeRegistry';
import { DEFAULT_OPTIONAL_CATEGORIES, hiddenOptionalCategories } from './optionalCategories';
import { codeToGraph } from '@/engine/codeToGraph';
import { graphToCode } from '@/engine/graphToCode';
import { getNodeValues, type AppNode } from '@/types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The original library — the "Presets 2" tab (tiers 1–3). */
const original = () => getBuiltinPresets().filter((p) => !isRecipe(p));
/** The beginner recipes — the Presets tab (tier 0). */
const recipes = () => getBuiltinPresets().filter(isRecipe);
/** Shader members: everything in the frame but the frame and its note. */
const shaderMembers = (p: { nodes: AppNode[] }) =>
  p.nodes.filter((n) => n.type !== 'group' && n.type !== 'note');

describe('builtinPresets', () => {
  const presets = getBuiltinPresets();

  it('ships the 13 recipes and the full three-tier library, with unique ids', () => {
    expect(presets.length).toBe(37);
    expect(new Set(presets.map((p) => p.id)).size).toBe(37);
    expect(recipes()).toHaveLength(13);
    expect(original()).toHaveLength(24);
    // Ordered easy→advanced: tiers never decrease along the list, so the
    // recipes (tier 0) come first.
    const tiers = presets.map((p) => p.tier);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    for (const tier of [0, 1, 2, 3]) expect(tiers).toContain(tier);
    // Recipe ids are namespaced, so one can never take an original's id (the
    // asset id is what the study's asset-drop events record).
    for (const r of recipes()) expect(r.id).toMatch(/^recipe-/);
    for (const p of original()) expect(p.id).not.toMatch(/^recipe-/);
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
      // A recipe is one idea in one to five nodes (plus its note); the original
      // library spells its effect out in at least four.
      if (isRecipe(preset)) {
        expect(shaderMembers(preset).length).toBeGreaterThanOrEqual(1);
        expect(shaderMembers(preset).length).toBeLessThanOrEqual(5);
      } else {
        expect(members.length).toBeGreaterThanOrEqual(5);
      }
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

  it.each(recipes().map((p) => [p.id, p] as const))(
    'recipe %s keeps its values on its nodes and uses only nodes the palette offers',
    (_id, recipe) => {
      // No Property nodes: a beginner scrubs the value where they are already
      // looking, and the graph stays one idea wide.
      const props = recipe.nodes.filter((n) =>
        n.data.registryType === 'property_float' || n.data.registryType === 'property_color',
      );
      expect(props).toEqual([]);
      // Rebuildable from the DEFAULT palette — no hidden node, and none from a
      // switched-off optional category (SDF, Textures).
      const offered = new Set(
        getEditorDefinitions(hiddenOptionalCategories(DEFAULT_OPTIONAL_CATEGORIES)).map((d) => d.type),
      );
      for (const m of shaderMembers(recipe)) {
        expect(offered.has(String(m.data.registryType)), `${recipe.id}: ${m.data.registryType}`).toBe(true);
      }
      // Pressing it wires it into the Output: it must name at least one socket.
      expect(recipe.outputEdges.length).toBeGreaterThan(0);
    },
  );

  it.each(original().map((p) => [p.id, p] as const))(
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

  it('prices every preset AND every texture, so the cost sort is total and every tile shows a badge', () => {
    // Both ready-made strips are ordered by price (ContentBrowser's `byCost`:
    // `assetCostPoints`, which is `totalCost` on the shipped table —
    // assetCostPoints.test.ts), and AssetCostBadge renders nothing at cost <= 0 — so a
    // zero-cost asset would both clump at the head of its strip and show no
    // badge to explain why it is there.
    for (const p of original()) {
      expect(p.totalCost, `${p.id} has no cost`).toBeGreaterThan(0);
    }
    // The ONE exception is deliberate: Solid Color is a single Color node,
    // which genuinely costs nothing — exactly as a Color node's own tile shows
    // no badge — and the head of the Presets strip is where the first recipe
    // belongs. Every other recipe pays for something.
    for (const r of recipes()) {
      if (r.id === 'recipe-solid') expect(r.totalCost).toBe(0);
      else expect(r.totalCost, `${r.id} has no cost`).toBeGreaterThan(0);
    }
    for (const t of getBuiltinTextures()) {
      expect(t.totalCost, `${t.id} has no cost`).toBeGreaterThan(0);
    }
  });

  it('sorts BOTH ready-made asset strips by the price their tiles print', () => {
    // Display-layer sorts live in ContentBrowser, which the node test env
    // cannot render — so this is a source pin, the same shape as
    // assetCardGeometry.test.ts. Textures joined presets on `byCost`: a strip
    // ordered by something its own tiles do not show reads as unordered, and
    // the number a tile shows is its price.
    const src = readFileSync(
      resolve(__dirname, '../components/NodeEditor/ContentBrowser.tsx'),
      'utf8',
    );
    // Both preset strips: the recipes (Presets) and the original library
    // (Presets 2) — each a slice of the ONE list, each by price.
    expect(src).toMatch(/getBuiltinPresets\(\)\.filter\(isRecipe\)\.sort\(byCost\)/);
    expect(src).toMatch(/getBuiltinPresets\(\)\.filter\(\(p\) => !isRecipe\(p\)\)\.sort\(byCost\)/);
    expect(src).toMatch(/getBuiltinTextures\(\)[\s\S]{0,120}\.sort\(byCost\)/);
    // byCost must sort on the SAME price AssetCostBadge draws, or a strip
    // contradicts the numbers on it: the group repriced under the selected
    // device's table (`assetCostPoints`), never the build-time `totalCost`
    // snapshot, which a device change leaves behind.
    expect(src).toMatch(/priceOf\(a\.nodes\) - priceOf\(b\.nodes\)/);
    expect(src).toMatch(/prices\.set\(nodes, \(price = assetCostPoints\(nodes\)\)\)/);
    expect(src).not.toMatch(/a\.totalCost - b\.totalCost/);
    const badge = readFileSync(
      resolve(__dirname, '../components/NodeEditor/AssetCostBadge.tsx'),
      'utf8',
    );
    expect(badge).toContain('const cost = assetCostPoints(nodes);');
    // The retired member-count comparator must not linger unused — and if it
    // ever comes back it must not be what a ready-made strip sorts by.
    expect(src).not.toMatch(/\bbySize\b/);
  });

  it('keeps the built-in textures building through the shared group builder', () => {
    const textures = getBuiltinTextures();
    expect(textures.length).toBe(9);
    for (const tex of textures) {
      const [group, ...members] = tex.nodes;
      expect(group.id).toBe(`builtin-texture-${tex.id}`);
      expect(members.length).toBeGreaterThan(0);
      for (const m of members) expect(m.parentId).toBe(group.id);
    }
  });
});
