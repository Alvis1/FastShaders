/**
 * Static guards on the lesson data (`tutorialDefs.ts`): every type is a node
 * the DEFAULT palette offers, every handle exists on its def, every role is
 * introduced before it is used, every hidden Output channel is exposed before
 * a wire reaches it (the Output has no drag-reveal), every stored key is one a
 * user can actually set, and the strings fit the panel. Babel-free on purpose:
 * this file imports the leaf and the registry, never the parser.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TUTORIALS } from './tutorialDefs';
import { MAX_CAPTION_CHARS, MAX_HINT_CHARS, MAX_TUTORIAL_STEPS, OUT_ROLE } from './tutorialTypes';
import type { TutorialDef } from './tutorialTypes';
import { NODE_REGISTRY, getEditorDefinitions } from '@/registry/nodeRegistry';
import { DEFAULT_OPTIONAL_CATEGORIES, hiddenOptionalCategories } from '@/registry/optionalCategories';
import { OUTPUT_DEFAULT_EXPOSED, usesExposedPorts } from '@/utils/exposedPorts';
import { formatRampStops, isRampInterp, parseRampStops } from '@/utils/colorRamp';
import { hasTutorialShade } from './tutorialShades';

const SRC = fileURLToPath(new URL('./', import.meta.url));
const read = (f: string) => readFileSync(SRC + f, 'utf8');

/** Keys a `set` may name beyond the def's inputs and defaultValues. */
const STORED_KEYS: Record<string, readonly string[]> = {
  perlin: ['signed'], perlinVec3: ['signed'], fbm: ['signed'], fbmVec3: ['signed'],
  colorRamp: ['stops', 'interp'],
  color: ['hex'], property_color: ['hex'],
};

const NEVER_ADDED = new Set(['output', 'imageNode', 'soundNode', 'dataNode', 'raymarchOutput', 'splatOutput']);
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const outputDef = NODE_REGISTRY.get('output')!;
const offered = new Set(getEditorDefinitions(hiddenOptionalCategories(DEFAULT_OPTIONAL_CATEGORIES)).map((d) => d.type));

/** role → registry type, in authoring order; `out` is the Output. */
function roleTypes(def: TutorialDef): Map<string, string> {
  const roles = new Map<string, string>([[OUT_ROLE, 'output']]);
  for (const s of def.steps) if (s.kind === 'add') roles.set(s.role, s.type);
  return roles;
}

const each = it.each(TUTORIALS.map((d) => [d.id, d] as const));

describe('the lesson list', () => {
  it('has unique tut-* ids and a recipe name exactly where it has a recipe', () => {
    const ids = TUTORIALS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of TUTORIALS) {
      expect(d.id).toMatch(/^tut-[a-z0-9-]+$/);
      expect(!!d.recipeId).toBe(!!d.recipeName);
      if (d.recipeId) expect(d.recipeId).toMatch(/^recipe-/);
      if (d.byteExact) expect(d.recipeId, `${d.id}: byteExact needs a recipe`).toBeTruthy();
    }
  });

  it('is a LEAF: tutorialDefs.ts imports types only and nothing dynamically', () => {
    const src = read('tutorialDefs.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const imports = [...src.matchAll(/^import\b[^\n]*/gm)].map((m) => m[0]);
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line, line).toMatch(/^import type\b/);
    expect(src).not.toMatch(/\bimport\(/);
  });
});

describe('each lesson', () => {
  each('%s: opens with the idea, closes with a Try, stays within the step cap', (_id, def) => {
    expect(def.steps.length).toBeGreaterThanOrEqual(3);
    expect(def.steps.length).toBeLessThanOrEqual(MAX_TUTORIAL_STEPS);
    expect(def.steps[0].kind).toBe('look');
    expect(def.steps[def.steps.length - 1].kind).toBe('look');
    expect(def.steps[def.steps.length - 1].caption).toMatch(/^Try:/);
    const ids = def.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  each('%s: adds only nodes the default palette offers, each role once, never the Output', (_id, def) => {
    const seen = new Set<string>([OUT_ROLE]);
    for (const s of def.steps) {
      if (s.kind !== 'add') continue;
      expect(NODE_REGISTRY.has(s.type), `${def.id}: ${s.type}`).toBe(true);
      expect(offered.has(s.type), `${def.id}: ${s.type} is not on the default palette`).toBe(true);
      expect(NEVER_ADDED.has(s.type), `${def.id}: ${s.type}`).toBe(false);
      expect(seen.has(s.role), `${def.id}: role ${s.role} defined twice`).toBe(false);
      seen.add(s.role);
    }
  });

  each('%s: every role is introduced before it is used', (_id, def) => {
    const live = new Set<string>([OUT_ROLE]);
    for (const s of def.steps) {
      const used = s.kind === 'add' ? [] : s.kind === 'wire' ? [s.from[0], s.to[0]] : s.kind === 'look' ? [] : [s.role];
      for (const r of used) expect(live.has(r), `${def.id}/${s.id}: role ${r}`).toBe(true);
      if (s.kind === 'add') live.add(s.role);
    }
  });

  each('%s: every wire runs from a real output handle to a real input handle', (_id, def) => {
    const roles = roleTypes(def);
    for (const s of def.steps) {
      if (s.kind !== 'wire') continue;
      const [fromRole, fromHandle] = s.from;
      const [toRole, toHandle] = s.to;
      expect(fromRole, `${def.id}/${s.id}: the Output has no outputs`).not.toBe(OUT_ROLE);
      expect(fromRole === toRole, `${def.id}/${s.id}: self-wire`).toBe(false);
      const fromDef = NODE_REGISTRY.get(roles.get(fromRole)!)!;
      expect(fromDef.outputs.map((p) => p.id), `${def.id}/${s.id}: from ${fromHandle}`).toContain(fromHandle);
      const toDef = NODE_REGISTRY.get(roles.get(toRole)!)!;
      const inputIds = toDef.inputs.map((p) => p.id);
      const paramIds = usesExposedPorts(toDef) ? Object.keys(toDef.defaultValues ?? {}) : [];
      expect([...inputIds, ...paramIds], `${def.id}/${s.id}: to ${toHandle}`).toContain(toHandle);
      // Variadic operands beyond `b` mount only once `b` is wired; lessons stay on a/b.
      if (toDef.chainable || toDef.variadic) expect(['a', 'b'], `${def.id}/${s.id}`).toContain(toHandle);
    }
  });

  each('%s: a hidden Output channel is exposed before a wire reaches it', (_id, def) => {
    const exposed = new Set(OUTPUT_DEFAULT_EXPOSED);
    for (const s of def.steps) {
      if (s.kind === 'expose') {
        expect(s.role).toBe(OUT_ROLE);
        expect(outputDef.inputs.map((p) => p.id)).toContain(s.handle);
        exposed.add(s.handle);
      }
      if (s.kind === 'wire' && s.to[0] === OUT_ROLE) {
        expect(exposed.has(s.to[1]), `${def.id}/${s.id}: ${s.to[1]} is hidden until exposed`).toBe(true);
      }
      if (s.kind === 'set' && s.role === OUT_ROLE) {
        expect(exposed.has(s.key), `${def.id}/${s.id}: ${s.key} has no number box until exposed`).toBe(true);
      }
    }
  });

  each('%s: every set names a key the user can edit, with a canonical value', (_id, def) => {
    const roles = roleTypes(def);
    const autoValues = new Map<string, Set<string>>();
    for (const s of def.steps) {
      if (s.kind === 'add' && s.values) autoValues.set(s.role, new Set(Object.keys(s.values)));
      if (s.kind !== 'set') continue;
      const type = roles.get(s.role)!;
      const d = NODE_REGISTRY.get(type)!;
      const keys = [...d.inputs.map((p) => p.id), ...Object.keys(d.defaultValues ?? {}), ...(STORED_KEYS[type] ?? [])];
      expect(keys, `${def.id}/${s.id}: ${type}.${s.key}`).toContain(s.key);
      // A value the lesson teaches is never also pre-filled by its add.
      expect(autoValues.get(s.role)?.has(s.key) ?? false, `${def.id}/${s.id}: ${s.key} is also in add.values`).toBe(false);
      if (typeof s.value === 'number') expect(Number.isFinite(s.value)).toBe(true);
      if (s.key === 'interp') {
        expect(isRampInterp(s.value)).toBe(true);
        expect(s.value, 'linear is the stored ABSENCE; never teach it as a set').not.toBe('linear');
      }
    }
    for (const s of def.steps) {
      if (s.kind !== 'add' || !s.values) continue;
      for (const [k, v] of Object.entries(s.values)) {
        if (k === 'hex') expect(v).toMatch(/^#[0-9a-f]{6}$/);
        if (k === 'stops') expect(formatRampStops(parseRampStops(v)!)).toBe(v);
        if (k === 'interp') expect(isRampInterp(v)).toBe(true);
      }
    }
  });

  each('%s: feeds the Output at least once', (_id, def) => {
    expect(def.steps.some((s) => s.kind === 'wire' && s.to[0] === OUT_ROLE)).toBe(true);
  });

  each('%s: has a picture of its result on the tile (its recipe\'s thumbnail, or its own)', (_id, def) => {
    expect(hasTutorialShade(def)).toBe(true);
  });

  each('%s: every string is trimmed printable ASCII within the panel\'s caps', (_id, def) => {
    const check = (s: string, cap: number, what: string) => {
      expect(s, what).toMatch(PRINTABLE_ASCII);
      expect(s.trim(), what).toBe(s);
      expect(s.length, `${what}: ${s.length} > ${cap}`).toBeLessThanOrEqual(cap);
    };
    check(def.title, 24, `${def.id} title`);
    check(def.summary, 200, `${def.id} summary`);
    for (const s of def.steps) {
      check(s.caption, MAX_CAPTION_CHARS, `${def.id}/${s.id} caption`);
      if (s.hint) check(s.hint, MAX_HINT_CHARS, `${def.id}/${s.id} hint`);
    }
  });
});
