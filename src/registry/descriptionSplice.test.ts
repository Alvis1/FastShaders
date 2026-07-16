import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';
import {
  locateRegistryDescriptions,
  locateTextureDescriptions,
  spliceDescriptions,
  splitAliases,
  joinAliases,
} from './descriptionSplice';
import { getAllDefinitions } from './nodeRegistry';
import { getBuiltinTextures } from './builtinTextures';

// These tests deliberately read the REAL source files off disk rather than a fixture:
// the whole point of the splicer is that it survives THIS file's exact formatting, so
// a fixture that drifted from the real registry would make the suite pass while the
// tool broke.
const REGISTRY_PATH = resolve(__dirname, 'nodeRegistry.ts');
const TEXTURES_PATH = resolve(__dirname, 'builtinTextures.ts');
const registrySource = readFileSync(REGISTRY_PATH, 'utf-8');
const texturesSource = readFileSync(TEXTURES_PATH, 'utf-8');

/** The nine unary-math nodes that reach the registry via the `.map()` tuple spread. */
const TUPLE_KEYS = ['sin', 'cos', 'abs', 'sqrt', 'exp', 'log2', 'floor', 'round', 'fract'];

describe('locateRegistryDescriptions', () => {
  const slots = locateRegistryDescriptions(registrySource);
  const defs = getAllDefinitions();

  it('finds one slot per definition, keyed by node type', () => {
    // 68 = getAllDefinitions().length. NODE_REGISTRY.size is 71 because the three
    // hidden defs (unknown/dataNode/imageNode) are separate consts outside the
    // `definitions` array, so they are correctly not located here.
    expect(slots).toHaveLength(68);
    expect(defs).toHaveLength(68);
    expect(new Set(slots.map(s => s.key))).toEqual(new Set(defs.map(d => d.type)));
  });

  it('classifies exactly the nine unary-math nodes as tuple form', () => {
    const tuple = slots.filter(s => s.form === 'tuple').map(s => s.key);
    expect(tuple).toHaveLength(9);
    expect(new Set(tuple)).toEqual(new Set(TUPLE_KEYS));
  });

  it('decodes values identical to the live registry (locator reads what the app reads)', () => {
    const byType = new Map(defs.map(d => [d.type, d.description]));
    for (const slot of slots) {
      expect(slot.value, `description mismatch for "${slot.key}"`).toBe(byType.get(slot.key));
    }
  });

  it('spans the literal including its quotes', () => {
    for (const slot of slots) {
      const raw = registrySource.slice(slot.start, slot.end);
      expect(raw[0]).toMatch(/['"]/);
      expect(raw[raw.length - 1]).toBe(raw[0]);
    }
  });
});

describe('locateTextureDescriptions', () => {
  const slots = locateTextureDescriptions(texturesSource);

  it('finds all 8 textures, keyed by id, with values matching the live entries', () => {
    expect(slots).toHaveLength(8);
    const textures = getBuiltinTextures();
    expect(new Set(slots.map(s => s.key))).toEqual(new Set(textures.map(t => t.id)));

    const byId = new Map(textures.map(t => [t.id, t.description]));
    for (const slot of slots) {
      expect(slot.value, `description mismatch for "${slot.key}"`).toBe(byId.get(slot.key));
    }
    expect(slots.every(s => s.form === 'property')).toBe(true);
  });
});

describe('spliceDescriptions — no-op identity', () => {
  // The key property: rewriting every slot with the value it already holds must
  // reproduce the file byte-for-byte. Any stray reformatting, comment loss, or
  // off-by-one range shows up here.
  //
  // This only means something because the splicer preserves each literal's quote
  // style and does NOT filter unchanged values — every slot really is re-serialized
  // and spliced. If it ever short-circuits on `patch[key] === slot.value`, these two
  // assertions silently stop testing anything (the function would return `source` by
  // identity), so the round-trip test below deliberately uses DISTINCT values.
  it('is byte-identical for nodeRegistry.ts', () => {
    const slots = locateRegistryDescriptions(registrySource);
    const patch = Object.fromEntries(slots.map(s => [s.key, s.value]));
    expect(spliceDescriptions(registrySource, slots, patch)).toBe(registrySource);
  });

  it('is byte-identical for builtinTextures.ts', () => {
    const slots = locateTextureDescriptions(texturesSource);
    const patch = Object.fromEntries(slots.map(s => [s.key, s.value]));
    expect(spliceDescriptions(texturesSource, slots, patch)).toBe(texturesSource);
  });

  // Identity alone cannot catch a right-to-left ordering bug: every replacement is
  // the same length, so no offset ever shifts. Patching every slot at once with
  // values of DIFFERENT lengths does shift them, so a wrong sort order corrupts the
  // output and this fails.
  it('round-trips all slots at once with distinct, differently-sized values', () => {
    const slots = locateRegistryDescriptions(registrySource);
    const patch = Object.fromEntries(
      slots.map((s, i) => [s.key, `Desc ${i} for ${s.key}${'!'.repeat(i % 7)}`]),
    );
    const out = spliceDescriptions(registrySource, slots, patch);

    const after = locateRegistryDescriptions(out);
    expect(after.length).toBe(slots.length);
    for (const slot of after) expect(slot.value).toBe(patch[slot.key]);

    // The file must still be parseable and structurally untouched: same line count,
    // same comments. A shifted range would corrupt surrounding code.
    expect(out.split('\n').length).toBe(registrySource.split('\n').length);
    expect(out).toContain('// ===== MATH (unary) =====');
  });

  it('leaves untouched slots alone when patching a subset', () => {
    const slots = locateRegistryDescriptions(registrySource);
    const out = spliceDescriptions(registrySource, slots, { sin: 'Changed.' });
    const after = locateRegistryDescriptions(out);
    for (const slot of after) {
      if (slot.key === 'sin') continue;
      const before = slots.find(s => s.key === slot.key)!;
      expect(slot.value).toBe(before.value);
    }
  });
});

describe('spliceDescriptions — minimality', () => {
  it('changes exactly one line for a single property-form edit', () => {
    const slots = locateRegistryDescriptions(registrySource);
    const out = spliceDescriptions(registrySource, slots, {
      positionGeometry: 'A brand new description.',
    });

    const before = registrySource.split('\n');
    const after = out.split('\n');
    expect(after).toHaveLength(before.length);

    const changed = before.map((l, i) => (l === after[i] ? -1 : i)).filter(i => i >= 0);
    expect(changed).toHaveLength(1);
    expect(after[changed[0]]).toContain('A brand new description.');
  });

  it('lands a tuple-form edit inside the tuple, not elsewhere', () => {
    const slots = locateRegistryDescriptions(registrySource);
    const sinSlot = slots.find(s => s.key === 'sin')!;
    expect(sinSlot.form).toBe('tuple');

    const out = spliceDescriptions(registrySource, slots, { sin: 'Tuple edit landed.' });

    const before = registrySource.split('\n');
    const after = out.split('\n');
    const changed = before.map((l, i) => (l === after[i] ? -1 : i)).filter(i => i >= 0);
    expect(changed).toHaveLength(1);

    // The edited line must still be the sin tuple itself, with type/label intact.
    const line = after[changed[0]];
    expect(line).toContain("'sin'");
    expect(line).toContain("'Sine'");
    expect(line).toContain('Tuple edit landed.');

    // And re-locating must read the new value back for sin and only sin.
    const relocated = locateRegistryDescriptions(out);
    expect(relocated.find(s => s.key === 'sin')!.value).toBe('Tuple edit landed.');
    expect(relocated.find(s => s.key === 'cos')!.value).toBe(
      slots.find(s => s.key === 'cos')!.value,
    );
  });
});

describe('splitAliases / joinAliases', () => {
  const defs = getAllDefinitions();
  const tailed = defs.filter(d => d.description?.includes('Also:'));

  it('27 definitions carry an "Also:" tail', () => {
    // Measured against the live registry; separator is uniformly " Also: ".
    expect(tailed).toHaveLength(27);
  });

  it('round-trips every tailed description byte-exactly', () => {
    for (const def of tailed) {
      const full = def.description!;
      const { description, aliases } = splitAliases(full);
      expect(aliases).not.toBe('');
      expect(description).not.toContain('Also:');
      expect(joinAliases(description, aliases), `round-trip failed for "${def.type}"`).toBe(full);
    }
  });

  it('round-trips untailed descriptions unchanged', () => {
    for (const def of defs.filter(d => d.description && !d.description.includes('Also:'))) {
      const full = def.description!;
      const { description, aliases } = splitAliases(full);
      expect(aliases).toBe('');
      expect(description).toBe(full);
      expect(joinAliases(description, aliases)).toBe(full);
    }
  });

  it('head matches what the tooltip shows (displayDescription semantics)', () => {
    for (const def of tailed) {
      const full = def.description!;
      expect(splitAliases(full).description).toBe(full.split(/\s*Also:/)[0].trim());
    }
  });
});

describe('spliceDescriptions — rejections', () => {
  const slots = locateRegistryDescriptions(registrySource);

  it('throws on an unknown patch key rather than silently skipping', () => {
    expect(() => spliceDescriptions(registrySource, slots, { notANode: 'x' })).toThrow(
      /no description slot for key "notANode"/,
    );
  });

  it('throws on newline / carriage return / control characters', () => {
    expect(() => spliceDescriptions(registrySource, slots, { sin: 'a\nb' })).toThrow(/control/i);
    expect(() => spliceDescriptions(registrySource, slots, { sin: 'a\rb' })).toThrow(/control/i);
    expect(() => spliceDescriptions(registrySource, slots, { sin: 'a\u0000b' })).toThrow(/control/i);
    expect(() => spliceDescriptions(registrySource, slots, { sin: 'a\tb' })).toThrow(/control/i);
  });

  it('rejects before writing anything (no partial splice)', () => {
    expect(() =>
      spliceDescriptions(registrySource, slots, { sin: 'fine', cos: 'bad\nvalue' }),
    ).toThrow();
  });
});

describe('escaped-apostrophe safety', () => {
  // tangentLocal's source literal is single-quoted with an escaped apostrophe
  // ('The geometry\'s tangent...'), so its bytes and its decoded value differ —
  // the splice must work off the located range, not a naive string search.
  it('handles a value containing quotes, apostrophes and backslashes', () => {
    const slots = locateRegistryDescriptions(registrySource);
    const tangent = slots.find(s => s.key === 'tangentLocal')!;
    expect(tangent.value).toContain("'");
    expect(registrySource.slice(tangent.start, tangent.end)).toContain("\\'");

    const nasty = `It's a "quoted" C:\\path\\to — don't 'break' \\" it`;
    const out = spliceDescriptions(registrySource, slots, { tangentLocal: nasty });

    // The result must still be parseable TypeScript...
    expect(() => parse(out, { sourceType: 'module', plugins: ['typescript'] })).not.toThrow();

    // ...and must decode back to exactly the value we asked for.
    const relocated = locateRegistryDescriptions(out);
    expect(relocated.find(s => s.key === 'tangentLocal')!.value).toBe(nasty);
    expect(relocated).toHaveLength(68);

    // Still a single-line edit.
    const changed = registrySource
      .split('\n')
      .map((l, i) => (l === out.split('\n')[i] ? -1 : i))
      .filter(i => i >= 0);
    expect(changed).toHaveLength(1);
  });
});
