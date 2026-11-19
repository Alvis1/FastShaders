/**
 * What a generator may build: the CALLABLE FORMS of the editor's own nodes,
 * read from the registry at run time — never a hand-written list, which would
 * drift from the parser on the next registry change.
 *
 * This is an ADD SURFACE (docs/dev/discovery-and-i18n.md): hidden nodes and
 * switched-off optional categories are never offered, so the list comes from
 * `getEditorDefinitions(hiddenOptionalCategories(flags))` — written literally,
 * the form the add-surface sweeps in optionalCategories.test.ts accept — and
 * is intersected with `TSL_FUNCTION_TO_DEF`, so it can never offer a function
 * the parser cannot read back.
 *
 * Keyed on how a node is WRITTEN, not on registry entries: the colour uniform
 * `uniform(color(0x…))` is the form 22 of the 24 presets use, yet the function
 * map leaves `property_color` out on purpose; Output, Split and Append are
 * types the parser makes ITSELF (the return, a swizzle, a short vector) and
 * are never offered as calls.
 */
import { getEditorDefinitions, TSL_FUNCTION_TO_DEF, growsOperands, displayDescription } from '@/registry/nodeRegistry';
import { hiddenOptionalCategories, type OptionalCategoryFlags } from '@/registry/optionalCategories';
import type { NodeDefinition } from '@/types';

/** Types offered nowhere in a generated program, each with why. */
export const GENERATION_EXCLUDED_TYPES: ReadonlyMap<string, string> = new Map([
  ['output', 'the program\'s return makes it'],
  ['split', 'a one-letter swizzle (a.x) makes it'],
  ['append', 'a full vecN(…) is written instead; a short one is re-shaped by the parser'],
  ['property_float', 'written as uniform(<number>)'],
  ['vertexColor', 'white on every built-in shape, so a program built on it shows nothing'],
  ['tangentLocal', 'zero on the built-in shapes, which carry no tangents'],
  ['rayDirection', 'only meaningful inside an SDF Output, which a parked group cannot keep'],
  // The dialect has no strings, and these nodes are written with one: their
  // stops or curves are a canonical string argument (codeToGraph
  // HELPER_ARG_READERS) inside a plain-JS module helper the walker cannot read.
  ['colorRamp', 'its stops are a string argument, and the dialect has no strings'],
  ['rgbCurves', 'its curves are a string argument, and the dialect has no strings'],
]);

/** Whole categories left out of the first version: an SDF program needs the
 *  SDF Output, and adding a group drops every Output it carries. */
export const GENERATION_EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set(['sdf']);

/** Perlin-family noise is SIGNED (−1…1); cell and Worley are already 0…1 and
 *  must never carry the unsigned remap (docs/dev/node-types.md). */
const SIGNED_NOISE_TYPES = new Set(['perlin', 'perlinVec3', 'fbm', 'fbmVec3']);

export type CatalogueEntry =
  /** A bare input written without parentheses (`positionWorld`, `time`). */
  | { kind: 'global'; name: string; type: string; def: NodeDefinition }
  /** `uv()` — and its tiled form `mul(uv(), vec2(a, b))`. */
  | { kind: 'uv'; name: 'uv'; type: string; def: NodeDefinition }
  /** `float(n)`, `int(n)`, `color(0xRRGGBB)`. */
  | { kind: 'ctor'; name: string; type: string; def: NodeDefinition; arity: number }
  /** A noise function: ONE position argument, optionally `.mul(scale)`. */
  | { kind: 'noise'; name: string; type: string; def: NodeDefinition; signed: boolean }
  /** An ordinary function call over the node's input ports. */
  | {
    kind: 'call';
    name: string;
    type: string;
    def: NodeDefinition;
    /** Port ids, in argument order. */
    ports: string[];
    /** The value TSL ITSELF uses for a left-out trailing argument — only
     *  clamp's and remap's last two have one (MathNode.js, Remap.js); any
     *  other missing argument becomes 0.0 in three r184, NOT the registry's
     *  port default, so leaving it out is refused rather than filled. */
    defaults: (number | undefined)[];
    minArgs: number;
    maxArgs: number;
    /** Folds any number of operands (add/sub/mul/div). */
    chainable: boolean;
  };

export interface Catalogue {
  entries: CatalogueEntry[];
  byName: ReadonlyMap<string, CatalogueEntry>;
  /** Registry types a generated graph may contain, the parser-made ones included. */
  types: ReadonlySet<string>;
  /** A registry TYPE name written as a call (`perlin(p)`) → its function. */
  typeAliases: ReadonlyMap<string, string>;
}

/** The most operands a generated chain call may take. */
export const MAX_CHAIN_ARGS = 8;

/** Constructors that store their value on the node (vecN has real ports and is an ordinary call). */
const CTOR_ARITY: Record<string, number> = { float: 1, int: 1, color: 1 };

/** TSL's own defaults for left-out TRAILING arguments, three r184 — pinned
 *  against the source by catalogue.test.ts. */
export const TSL_TRAILING_DEFAULTS: Readonly<Record<string, readonly number[]>> = {
  clamp: [0, 1],
  remap: [0, 1],
};

function isBareInput(def: NodeDefinition): boolean {
  // ensureBareInputNode's rule: an input with no ports, and either no stored
  // values or only Time's speed.
  return def.category === 'input' && def.inputs.length === 0 && (!def.defaultValues || def.type === 'time');
}

function entryFor(def: NodeDefinition): CatalogueEntry | null {
  const name = def.tslFunction;
  if (name === 'uv') return { kind: 'uv', name: 'uv', type: def.type, def };
  if (name in CTOR_ARITY && def.category === 'type') return { kind: 'ctor', name, type: def.type, def, arity: CTOR_ARITY[name] };
  if (def.category === 'noise') return { kind: 'noise', name, type: def.type, def, signed: SIGNED_NOISE_TYPES.has(def.type) };
  if (isBareInput(def)) return { kind: 'global', name, type: def.type, def };
  if (def.inputs.length === 0) return null;
  const ports = def.inputs.map((p) => p.id);
  const tail = TSL_TRAILING_DEFAULTS[name] ?? [];
  const defaults = ports.map((_, i) => tail[i - (ports.length - tail.length)]);
  const minArgs = ports.length - tail.length;
  const chainable = def.chainable === true;
  if (growsOperands(def) && !chainable) return null;
  return {
    kind: 'call', name, type: def.type, def, ports, defaults,
    minArgs: chainable ? 2 : Math.max(1, minArgs),
    maxArgs: chainable ? MAX_CHAIN_ARGS : ports.length,
    chainable,
  };
}

/** Pure: the catalogue over a given definition list (tests pass their own). */
export function catalogueFrom(defs: readonly NodeDefinition[]): Catalogue {
  const entries: CatalogueEntry[] = [];
  for (const def of defs) {
    if (!def.tslFunction || TSL_FUNCTION_TO_DEF.get(def.tslFunction) !== def) continue;
    if (GENERATION_EXCLUDED_TYPES.has(def.type) || GENERATION_EXCLUDED_CATEGORIES.has(def.category)) continue;
    const e = entryFor(def);
    if (e) entries.push(e);
  }
  const byName = new Map(entries.map((e) => [e.name, e] as const));
  const types = new Set(entries.map((e) => e.type));
  // Made by the parser itself, never called.
  for (const t of ['output', 'split', 'append', 'property_float', 'property_color']) types.add(t);
  const typeAliases = new Map<string, string>();
  for (const e of entries) if (e.type !== e.name && !byName.has(e.type)) typeAliases.set(e.type, e.name);
  return { entries, byName, types, typeAliases };
}

/** The catalogue for the user's current optional-category switches. */
export function buildCatalogue(flags: OptionalCategoryFlags): Catalogue {
  return catalogueFrom(getEditorDefinitions(hiddenOptionalCategories(flags)));
}

/** First sentence of a node's description — the prompt's one-line gloss. */
export function blurbOf(def: NodeDefinition): string {
  const text = displayDescription(def) ?? def.label;
  return text.split(/(?<=\.)\s/)[0];
}

/** How the prompt writes an entry's call (`mix(a, b, t)`, `color(0xRRGGBB)`). */
export function signatureOf(e: CatalogueEntry): string {
  switch (e.kind) {
    case 'global': return e.name;
    case 'uv': return 'uv()';
    case 'noise': return `${e.name}(position)`;
    case 'ctor':
      if (e.name === 'color') return 'color(0xRRGGBB)';
      return `${e.name}(number)`;
    // Every port is written out: the walker fills a left-out trailing one from
    // the registry default, but a prompt that shows them optional invites
    // `mix(a)`.
    case 'call': return `${e.name}(${e.chainable ? 'a, b, …' : e.ports.join(', ')})`;
  }
}
