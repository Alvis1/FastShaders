import { describe, expect, it } from 'vitest';
import { codeToGraph } from '@/engine/codeToGraph';
import { getEditorDefinitions, NODE_REGISTRY, TSL_FUNCTION_TO_DEF } from '@/registry/nodeRegistry';
import { DEFAULT_OPTIONAL_CATEGORIES, hiddenOptionalCategories } from '@/registry/optionalCategories';
import { readFileSync } from 'node:fs';
import { buildCatalogue, GENERATION_EXCLUDED_CATEGORIES, GENERATION_EXCLUDED_TYPES, signatureOf, TSL_TRAILING_DEFAULTS, type CatalogueEntry } from './catalogue';
import { gateProgram } from './gate';

const catalogue = buildCatalogue(DEFAULT_OPTIONAL_CATEGORIES);

describe('the generation catalogue', () => {
  it('every entry resolves through the function map to its own definition', () => {
    for (const e of catalogue.entries) expect(TSL_FUNCTION_TO_DEF.get(e.name), e.name).toBe(e.def);
  });

  it('accounts for every editor definition: offered, excluded with a reason, or not a callable the parser maps', () => {
    const offered = new Set(catalogue.entries.map((e) => e.type));
    for (const def of getEditorDefinitions(hiddenOptionalCategories(DEFAULT_OPTIONAL_CATEGORIES))) {
      const mapped = !!def.tslFunction && TSL_FUNCTION_TO_DEF.get(def.tslFunction) === def;
      const excluded = GENERATION_EXCLUDED_TYPES.has(def.type) || GENERATION_EXCLUDED_CATEGORIES.has(def.category);
      expect(offered.has(def.type) || excluded || !mapped, def.type).toBe(true);
    }
  });

  it('each exclusion names a real node type, with a reason', () => {
    for (const [type, why] of GENERATION_EXCLUDED_TYPES) {
      expect(NODE_REGISTRY.has(type), type).toBe(true);
      expect(why.length).toBeGreaterThan(10);
    }
  });

  it('offers no distance-field node, with the switch off or on (the first version has no SDF Output)', () => {
    for (const flags of [DEFAULT_OPTIONAL_CATEGORIES, { ...DEFAULT_OPTIONAL_CATEGORIES, sdf: true }]) {
      expect(buildCatalogue(flags).entries.filter((e) => e.def.category === 'sdf' || e.type === 'rayDirection')).toEqual([]);
    }
  });

  it('never offers the parser-made types as calls, and keeps the colour uniform form', () => {
    for (const name of ['output', 'split', 'append', 'uniform']) expect(catalogue.byName.has(name), name).toBe(false);
    for (const t of ['property_color', 'property_float', 'output', 'split']) expect(catalogue.types.has(t), t).toBe(true);
  });

  it('every input global parses bare into its own node type', () => {
    for (const e of catalogue.entries) {
      if (e.kind !== 'global') continue;
      const g = codeToGraph(`import { Fn } from "three/tsl";\nconst shader = Fn(() => {\n  const a = mul(${e.name}, 1);\n  return a;\n});\nexport default shader;`);
      expect(g.errors, e.name).toEqual([]);
      expect(g.nodes.map((n) => n.data.registryType), e.name).toContain(e.type);
    }
  });

  it('maps registry type names written as calls to their functions', () => {
    expect(catalogue.typeAliases.get('perlin')).toBe('mx_noise_float');
    expect(catalogue.typeAliases.get('voronoi')).toBe('mx_worley_noise_float');
  });

  it('lets only TSL\'s own trailing defaults be left out, and they match three r184', () => {
    const math = readFileSync('node_modules/three/src/nodes/math/MathNode.js', 'utf8');
    const remap = readFileSync('node_modules/three/src/nodes/utils/Remap.js', 'utf8');
    expect(math).toMatch(/export const clamp = \( value, low = 0, high = 1 \) =>/);
    expect(remap).toMatch(/outLowNode = float\( 0 \), outHighNode = float\( 1 \)/);
    expect(TSL_TRAILING_DEFAULTS).toEqual({ clamp: [0, 1], remap: [0, 1] });
    for (const e of catalogue.entries) {
      if (e.kind !== 'call' || e.chainable) continue;
      expect(e.minArgs, e.name).toBe(e.ports.length - (TSL_TRAILING_DEFAULTS[e.name]?.length ?? 0));
    }
  });

  it('offers only what the dialect can write: every entry, called by its own signature, passes the whole gate', () => {
    // The catalogue follows the registry automatically, so a node added later
    // whose emitted form the dialect cannot read (Color Ramp's stop string)
    // would be offered to the model and refused on every use.
    const ctx = { catalogue, takenNames: new Set<string>() };
    const programFor = (e: CatalogueEntry): string => {
      const lines = ['const u = uv();', 'const p = positionWorld;'];
      let call: string;
      switch (e.kind) {
        case 'global': call = e.name; break;
        case 'uv': call = 'uv()'; break;
        case 'noise': call = `${e.name}(p)`; break;
        case 'ctor': call = e.name === 'color' ? 'color(0xFF8800)' : `${e.name}(3)`; break;
        case 'call': {
          const args = e.ports.map((_, i) => {
            const type = e.def.inputs[i].dataType;
            return type === 'vec2' ? 'u' : type === 'vec3' || type === 'color' ? 'p' : 'u.x';
          });
          call = `${e.name}(${(e.chainable ? args.slice(0, 2) : args).join(', ')})`;
        }
      }
      lines.push(`const r = ${call};`);
      // A comparison is 0/1, never a colour to return.
      if (e.def.category === 'logic') lines.push('const o = select(r, color(0xFF0000), color(0x0000FF));');
      return `import { Fn } from "three/tsl";\nconst shader = Fn(() => {\n${lines.map((l) => `  ${l}\n`).join('')}  return ${e.def.category === 'logic' ? 'o' : 'r'};\n});\nexport default shader;`;
    };
    const refused = catalogue.entries.flatMap((e) => {
      const r = gateProgram(programFor(e), '', ctx);
      return r.ok ? [] : [`${e.name}: ${r.problems.join(' | ')}`];
    });
    expect(refused).toEqual([]);
    expect(catalogue.entries.length).toBeGreaterThan(40);
  });

  it('writes each signature the way the dialect reads it', () => {
    const sig = (n: string) => signatureOf(catalogue.byName.get(n)!);
    expect(sig('mix')).toBe('mix(a, b, t)');
    expect(sig('add')).toBe('add(a, b, …)');
    expect(sig('color')).toBe('color(0xRRGGBB)');
    expect(sig('vec3')).toBe('vec3(x, y, z)');
    expect(sig('mx_noise_float')).toBe('mx_noise_float(position)');
    expect(sig('positionWorld')).toBe('positionWorld');
    expect(sig('uv')).toBe('uv()');
  });
});
