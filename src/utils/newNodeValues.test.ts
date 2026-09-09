import { describe, it, expect } from 'vitest';
import {
  initialNodeValues,
  randomColorHex,
  randomGroupColor,
  nextGroupLabel,
  NEW_COLOR_PALETTE,
  GROUP_COLOR_PALETTE,
  GROUP_COLOR_DIM,
} from './newNodeValues';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { hexToRgb, dimColor } from '@/utils/colorUtils';
import { makeNode } from '@/test-utils';
import type { AppNode, NodeDefinition } from '@/types';

const def = (type: string): NodeDefinition => {
  const d = NODE_REGISTRY.get(type);
  if (!d) throw new Error(`missing registry def: ${type}`);
  return d;
};

/** Deterministic stand-in for Math.random — cycles the given values. */
const seeded = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe('NEW_COLOR_PALETTE', () => {
  it('is the Vibrant Color Fiesta palette, in order', () => {
    // Pinned against the source: coolors.co encodes the palette in its own URL
    // — https://coolors.co/palette/ffbe0b-fb5607-ff006e-8338ec-3a86ff
    expect([...NEW_COLOR_PALETTE]).toEqual([
      '#ffbe0b', '#fb5607', '#ff006e', '#8338ec', '#3a86ff',
    ]);
  });

  it('is all 6-digit lowercase hex, with no duplicates', () => {
    for (const c of NEW_COLOR_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(NEW_COLOR_PALETTE).size).toBe(NEW_COLOR_PALETTE.length);
  });

  it('is vivid enough to read as a swatch on either canvas', () => {
    // Why a curated palette at all: no entry may be a near-black, near-white,
    // or a grey, since those are useless as a starting colour.
    for (const c of NEW_COLOR_PALETTE) {
      const [r, g, b] = hexToRgb(c);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      expect(max).toBeGreaterThan(60);
      expect(max - min).toBeGreaterThan(40);
    }
  });
});

describe('randomColorHex', () => {
  it('only ever returns palette entries', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(randomColorHex());
    for (const c of seen) expect(NEW_COLOR_PALETTE).toContain(c);
  });

  it('can reach every entry', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(randomColorHex());
    expect(seen.size).toBe(NEW_COLOR_PALETTE.length);
  });

  it('is driven entirely by the injected rand (no hidden entropy)', () => {
    expect(randomColorHex(seeded(0.1))).toBe(randomColorHex(seeded(0.1)));
    expect(randomColorHex(seeded(0.1))).not.toBe(randomColorHex(seeded(0.9)));
  });

  it('stays in range at rand() === 1 (the exclusive-upper-bound edge)', () => {
    // Math.random() never returns 1, but an injected rand might — and an
    // unclamped floor would index one past the end.
    expect(randomColorHex(seeded(1))).toBe(NEW_COLOR_PALETTE[NEW_COLOR_PALETTE.length - 1]);
  });
});

describe('initialNodeValues', () => {
  it('gives a constant color node a palette color, not the registry default', () => {
    const values = initialNodeValues(def('color'), [], seeded(0.33));
    expect(NEW_COLOR_PALETTE).toContain(values.hex);
    expect(values.hex).not.toBe(def('color').defaultValues?.hex);
  });

  it('colors property_color too, and still auto-names it', () => {
    const values = initialNodeValues(def('property_color'), [], seeded(0.33));
    expect(NEW_COLOR_PALETTE).toContain(values.hex);
    expect(values.name).toBe('color1');
  });

  it('avoids colors already on the canvas', () => {
    // rand is pinned to 0, so without the used-filter this would return the
    // palette's first entry every time.
    const used: AppNode[] = [];
    const picked: unknown[] = [];
    for (let i = 0; i < NEW_COLOR_PALETTE.length; i++) {
      const hex = initialNodeValues(def('color'), used, seeded(0)).hex;
      picked.push(hex);
      used.push(makeNode(`c${i}`, 'color', { hex: hex as string }));
    }
    expect(new Set(picked).size).toBe(NEW_COLOR_PALETTE.length);
  });

  it('matches used colors case-insensitively', () => {
    const used = [makeNode('a', 'color', { hex: '#FFBE0B' })];
    expect(initialNodeValues(def('color'), used, seeded(0)).hex).not.toBe('#ffbe0b');
  });

  it('falls back to a plain roll once every palette color is taken', () => {
    const used = NEW_COLOR_PALETTE.map((hex, i) => makeNode(`c${i}`, 'color', { hex }));
    const hex = initialNodeValues(def('color'), used, seeded(0.5)).hex;
    expect(NEW_COLOR_PALETTE).toContain(hex);
  });

  it('leaves non-color, non-noise defs on their registry defaults', () => {
    expect(initialNodeValues(def('float'), [])).toEqual(def('float').defaultValues);
  });

  // The scope rule for the noise range flag: a USER-added Perlin/fBm defaults to
  // the 0-1 remap, and this is the ONLY place that stamps it — code→graph,
  // project import and the built-in textures/presets never call this, which is
  // what keeps every existing graph and shipped asset on the legacy signed range.
  it('stamps the 0-1 range flag on a newly added signed-noise node', () => {
    for (const type of ['perlin', 'perlinVec3', 'fbm', 'fbmVec3']) {
      const values = initialNodeValues(def(type), []);
      expect(values.signed, type).toBe(0);
      // A number, never a boolean: `values` is Record<string, string | number>
      // and the emitter's read is an exact identity test.
      expect(typeof values.signed, type).toBe('number');
    }
  });

  it('never stamps the flag on noise that is already [0, 1]', () => {
    // A remap here would halve a range that was already correct.
    for (const type of ['cellNoise', 'voronoi', 'voronoiVec2', 'voronoiVec3']) {
      expect(initialNodeValues(def(type), []), type).not.toHaveProperty('signed');
    }
  });

  it('does not mutate the registry default values', () => {
    const before = { ...def('color').defaultValues };
    initialNodeValues(def('color'), []);
    initialNodeValues(def('color'), []);
    expect(def('color').defaultValues).toEqual(before);
  });

  it('continues the shared property-name sequence across both property kinds', () => {
    const existing: AppNode[] = [
      makeNode('a', 'property_color', { name: 'color3', hex: '#ffffff' }),
    ];
    expect(initialNodeValues(def('property_color'), existing).name).toBe('color4');
    expect(initialNodeValues(def('property_float'), existing).name).toBe('property1');
  });
});

describe('GROUP_COLOR_PALETTE', () => {
  it('is the SAME palette, dimmed — one entry per colour, in order', () => {
    // The rule the owner asked for, pinned as a relationship rather than as a
    // second table of hexes: a literal list would let the two drift the first
    // time either is edited, which is exactly what deriving prevents.
    expect(GROUP_COLOR_PALETTE.length).toBe(NEW_COLOR_PALETTE.length);
    for (let i = 0; i < GROUP_COLOR_PALETTE.length; i++) {
      expect(GROUP_COLOR_PALETTE[i]).toBe(dimColor(NEW_COLOR_PALETTE[i], GROUP_COLOR_DIM));
    }
  });

  it('is DIMMER: lower chroma than its source, and never a flat grey', () => {
    for (let i = 0; i < GROUP_COLOR_PALETTE.length; i++) {
      const chroma = (hex: string) => {
        const [r, g, b] = hexToRgb(hex);
        return Math.max(r, g, b) - Math.min(r, g, b);
      };
      const dim = chroma(GROUP_COLOR_PALETTE[i]);
      expect(dim).toBeLessThan(chroma(NEW_COLOR_PALETTE[i]));
      // Still recognisably the hue — a group frame that dimmed all the way to
      // grey would be indistinguishable from the default and from every other
      // group, which is the sameness this exists to fix.
      expect(dim).toBeGreaterThan(30);
    }
  });

  it('keeps the source hue (the mix is toward a NEUTRAL, so the order of the channels holds)', () => {
    // Mixing toward mid grey moves every channel by the same fraction of its
    // own distance, so which channel is largest cannot change — that is what
    // makes "dimmer" a restatement of the palette rather than a new one.
    const rank = (hex: string) => {
      const [r, g, b] = hexToRgb(hex);
      return [r > g, g > b, r > b].join(',');
    };
    for (let i = 0; i < GROUP_COLOR_PALETTE.length; i++) {
      expect(rank(GROUP_COLOR_PALETTE[i])).toBe(rank(NEW_COLOR_PALETTE[i]));
    }
  });

  it('is all 6-digit lowercase hex, with no duplicates', () => {
    // Lower-case matters: randomGroupColor compares against lower-cased stored
    // colours, so an upper-case entry would never be seen as "already used".
    for (const c of GROUP_COLOR_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(GROUP_COLOR_PALETTE).size).toBe(GROUP_COLOR_PALETTE.length);
  });
});

describe('randomGroupColor', () => {
  const groupNode = (id: string, color?: string): AppNode =>
    ({ id, type: 'group', position: { x: 0, y: 0 }, data: { registryType: 'group', label: 'Group', ...(color ? { color } : {}) } } as unknown as AppNode);

  it('only ever returns dimmed-palette entries', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(randomGroupColor([]));
    for (const c of seen) expect(GROUP_COLOR_PALETTE).toContain(c);
    expect(seen.size).toBe(GROUP_COLOR_PALETTE.length);
  });

  it('prefers a colour no group is already wearing', () => {
    const used = GROUP_COLOR_PALETTE.slice(0, 4);
    const nodes = used.map((c, i) => groupNode(`g${i}`, c));
    // Whatever the roll, only the one free entry is reachable.
    for (let i = 0; i < 50; i++) {
      expect(randomGroupColor(nodes)).toBe(GROUP_COLOR_PALETTE[4]);
    }
  });

  it('falls back to a plain roll once every entry is on the canvas', () => {
    const nodes = GROUP_COLOR_PALETTE.map((c, i) => groupNode(`g${i}`, c));
    expect(GROUP_COLOR_PALETTE).toContain(randomGroupColor(nodes, seeded(0.5)));
  });

  it('ignores NON-group nodes, and a group carrying no colour', () => {
    // A colour NODE wearing the vivid #ff006e must not make the dimmed group
    // hue read as taken — the two palettes are different sets of strings, and
    // the group scan is what would blur them.
    const nodes: AppNode[] = [
      makeNode('c1', 'color', { hex: NEW_COLOR_PALETTE[2] }),
      groupNode('g1'),
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(randomGroupColor(nodes));
    expect(seen.size).toBe(GROUP_COLOR_PALETTE.length);
  });

  it('matches a stored colour case-insensitively', () => {
    const nodes = GROUP_COLOR_PALETTE.slice(0, 4).map((c, i) =>
      groupNode(`g${i}`, c.toUpperCase()),
    );
    expect(randomGroupColor(nodes)).toBe(GROUP_COLOR_PALETTE[4]);
  });
});

describe('nextGroupLabel', () => {
  const g = (id: string, label?: string): AppNode =>
    ({ id, type: 'group', position: { x: 0, y: 0 }, data: { registryType: 'group', ...(label !== undefined ? { label } : {}) } } as unknown as AppNode);

  it('starts at 1 on a canvas with no groups', () => {
    expect(nextGroupLabel([])).toBe('Group 1');
  });

  it('counts up past the numbered groups already there', () => {
    expect(nextGroupLabel([g('a', 'Group 1'), g('b', 'Group 2')])).toBe('Group 3');
  });

  it('takes MAX + 1, so a deleted number is not handed out again', () => {
    // The number is a label, not an identity: reusing "Group 2" for something
    // unrelated is worse than a gap in the sequence.
    expect(nextGroupLabel([g('a', 'Group 1'), g('b', 'Group 5')])).toBe('Group 6');
  });

  it('ignores a RENAMED group — it neither counts nor blocks', () => {
    expect(nextGroupLabel([g('a', 'Fresnel'), g('b', 'Group 1')])).toBe('Group 2');
    expect(nextGroupLabel([g('a', 'Group 7 rim light')])).toBe('Group 1');
  });

  it('ignores the bare "Group" left by every group made before numbering', () => {
    expect(nextGroupLabel([g('a', 'Group'), g('b', 'Group')])).toBe('Group 1');
  });

  it('ignores non-group nodes and a missing/!string label', () => {
    const nodes: AppNode[] = [
      makeNode('n1', 'float', { value: 1 }),
      g('a'),
      ({ id: 'b', type: 'group', position: { x: 0, y: 0 }, data: { registryType: 'group', label: 9 } } as unknown as AppNode),
    ];
    expect(nextGroupLabel(nodes)).toBe('Group 1');
  });
});
