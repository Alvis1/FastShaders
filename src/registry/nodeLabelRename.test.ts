/**
 * Node DISPLAY-LABEL renaming (Node Designer "Name" field).
 *
 * Two halves, and the second is the important one:
 *
 *  1. The splice mechanics — `locateRegistryLabels` addresses the same two syntactic
 *     forms `locateRegistryDescriptions` does, and a rename rewrites one literal and
 *     nothing else.
 *
 *  2. The SAFETY INVARIANT that makes renaming allowable at all: a node's `label` is
 *     display-only. `type` is the registry key, the `registryType` stored in every
 *     saved graph, and what codeToGraph matches on; `label` reaches no generated code,
 *     no persisted payload and no lookup. These tests pin that separation so a future
 *     change that starts keying anything off `label` fails HERE rather than silently
 *     turning a cosmetic rename into a graph-corrupting one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import {
  locateRegistryLabels,
  locateRegistryDescriptions,
  spliceDescriptions,
  assertValidNodeLabels,
  MAX_NODE_LABEL_LENGTH,
} from './descriptionSplice';
import {
  getAllDefinitions,
  getEditorDefinitions,
  NODE_REGISTRY,
  searchNodes,
  nodeMatchRank,
} from './nodeRegistry';
import nodeI18n from '../i18n/node-i18n.json';
import { nodeLabelLV } from '../i18n';

// Read the REAL source, like descriptionSplice.test.ts: the point of the splicer is
// that it survives this file's exact formatting, so a fixture would make the suite
// pass while the tool broke.
const REGISTRY_PATH = resolve(__dirname, 'nodeRegistry.ts');
const registrySource = readFileSync(REGISTRY_PATH, 'utf-8');

// Same CJS/ESM interop shim descriptionSplice.ts uses.
const traverse = (
  typeof (_traverse as unknown as { default: typeof _traverse }).default === 'function'
    ? (_traverse as unknown as { default: typeof _traverse }).default
    : _traverse
) as typeof _traverse;

/** The nine unary-math nodes that reach the registry via the `.map()` tuple spread. */
const TUPLE_KEYS = ['sin', 'cos', 'abs', 'sqrt', 'exp', 'log2', 'floor', 'round', 'fract'];

describe('locateRegistryLabels', () => {
  const slots = locateRegistryLabels(registrySource);
  const defs = getAllDefinitions();

  it('finds one slot per definition, keyed by node type', () => {
    expect(slots).toHaveLength(defs.length);
    expect(new Set(slots.map(s => s.key))).toEqual(new Set(defs.map(d => d.type)));
  });

  it('decodes values identical to the live registry (locator reads what the app reads)', () => {
    const byType = new Map(defs.map(d => [d.type, d.label]));
    for (const slot of slots) {
      expect(slot.value, `label mismatch for "${slot.key}"`).toBe(byType.get(slot.key));
    }
  });

  it('classifies exactly the nine unary-math nodes as tuple form', () => {
    const tuple = slots.filter(s => s.form === 'tuple').map(s => s.key);
    expect(new Set(tuple)).toEqual(new Set(TUPLE_KEYS));
  });

  it('addresses the NODE label, never a socket label', () => {
    // nodeRegistry.ts has ~3x more `label:` tokens than node definitions, because every
    // input/output port carries one. A locator that matched a port would corrupt socket
    // names — and silently drop their lv.json translations, which are keyed by English
    // text.
    //
    // Checking the VALUE is not enough and was the first version of this test: 9 port
    // labels are also node labels ('Position', 'Normal', 'Tangent', 'Time', 'UV',
    // 'Color', 'Output', 'Min', 'Max'), so a locator that grabbed the Output node's
    // `outputs: [{ label: 'Color' }]` would still land on a legal-looking node label and
    // pass. The real invariant is POSITIONAL, so assert it positionally: no located byte
    // range may fall inside any `inputs:`/`outputs:` array literal.
    const ast = parse(registrySource, { sourceType: 'module', plugins: ['typescript'] });
    const portRanges: Array<[number, number]> = [];
    traverse(ast, {
      ObjectProperty(path) {
        const key = path.node.key;
        const name = key.type === 'Identifier' ? key.name
          : key.type === 'StringLiteral' ? key.value : '';
        if ((name === 'inputs' || name === 'outputs') && path.node.value.start != null) {
          portRanges.push([path.node.value.start!, path.node.value.end!]);
        }
      },
    });
    expect(portRanges.length).toBeGreaterThan(50);   // the guard itself must have teeth

    for (const slot of slots) {
      for (const [lo, hi] of portRanges) {
        expect(
          slot.start >= lo && slot.end <= hi,
          `slot "${slot.key}" (${slot.start}) landed inside an inputs/outputs array`,
        ).toBe(false);
      }
    }
  });

  it('spans the literal including its quotes', () => {
    for (const slot of slots) {
      const raw = registrySource.slice(slot.start, slot.end);
      expect(raw[0]).toMatch(/['"]/);
      expect(raw[raw.length - 1]).toBe(raw[0]);
    }
  });

  it('does not overlap the description slots', () => {
    // Both locators walk the same definitions array; an index mix-up (label at tuple
    // [1], description at [2]) would make them address the same bytes, and a label
    // rename would overwrite a description.
    const descs = locateRegistryDescriptions(registrySource);
    for (const l of locateRegistryLabels(registrySource)) {
      for (const d of descs) {
        expect(l.start < d.end && d.start < l.end, `${l.key} label overlaps ${d.key} desc`)
          .toBe(false);
      }
    }
  });
});

describe('renaming through spliceDescriptions', () => {
  const slots = locateRegistryLabels(registrySource);

  it('is byte-identical when every label is rewritten with its own value', () => {
    const patch = Object.fromEntries(slots.map(s => [s.key, s.value]));
    expect(spliceDescriptions(registrySource, slots, patch, 'label')).toBe(registrySource);
  });

  it('changes exactly one line for a property-form rename', () => {
    const out = spliceDescriptions(registrySource, slots, { mul: 'Times' }, 'label');
    const before = registrySource.split('\n');
    const after = out.split('\n');
    expect(after).toHaveLength(before.length);

    const changed = before.map((l, i) => (l === after[i] ? -1 : i)).filter(i => i >= 0);
    expect(changed).toHaveLength(1);
    expect(after[changed[0]]).toContain("label: 'Times'");
    expect(locateRegistryLabels(out).find(s => s.key === 'mul')!.value).toBe('Times');
  });

  it('lands a tuple-form rename inside the tuple, leaving type and description intact', () => {
    const sinSlot = slots.find(s => s.key === 'sin')!;
    expect(sinSlot.form).toBe('tuple');

    const out = spliceDescriptions(registrySource, slots, { sin: 'Sin' }, 'label');
    const before = registrySource.split('\n');
    const after = out.split('\n');
    const changed = before.map((l, i) => (l === after[i] ? -1 : i)).filter(i => i >= 0);
    expect(changed).toHaveLength(1);

    const line = after[changed[0]];
    expect(line).toContain("'sin'");                       // type untouched
    expect(line).toContain("'Sin'");                       // label rewritten
    expect(line).toContain('Sine wave of the input');      // description untouched

    // The description locator must still read sin's ORIGINAL description back — the
    // regression this guards is a label splice eating the neighbouring tuple element.
    const descAfter = locateRegistryDescriptions(out).find(s => s.key === 'sin')!;
    const descBefore = locateRegistryDescriptions(registrySource).find(s => s.key === 'sin')!;
    expect(descAfter.value).toBe(descBefore.value);
  });

  it('round-trips every label at once with distinct, differently-sized values', () => {
    // Identity alone cannot catch a right-to-left ordering bug (equal-length swaps shift
    // no offsets). Differently-sized values do shift them.
    const patch = Object.fromEntries(
      slots.map((s, i) => [s.key, `Nm${i}${'x'.repeat(i % 5)}`]),
    );
    const out = spliceDescriptions(registrySource, slots, patch, 'label');

    for (const slot of locateRegistryLabels(out)) expect(slot.value).toBe(patch[slot.key]);
    expect(out.split('\n')).toHaveLength(registrySource.split('\n').length);
    expect(out).toContain('// ===== MATH (unary) =====');
    expect(() => parse(out, { sourceType: 'module', plugins: ['typescript'] })).not.toThrow();
  });

  it('escapes a label containing quotes and backslashes into valid TypeScript', () => {
    // The designer's Name field is free text and lands in executable source. This is the
    // injection boundary: an unescaped `'` would close the literal.
    const nasty = `It's a "quoted" C:\\path — don't 'break' it`;
    const out = spliceDescriptions(registrySource, slots, { mul: nasty }, 'label');
    expect(() => parse(out, { sourceType: 'module', plugins: ['typescript'] })).not.toThrow();
    expect(locateRegistryLabels(out).find(s => s.key === 'mul')!.value).toBe(nasty);
    expect(locateRegistryLabels(out)).toHaveLength(slots.length);
  });

  it('cannot inject code through a crafted label', () => {
    const attack = `x', description: 'pwned', tslFunction: 'evil`;
    const out = spliceDescriptions(registrySource, slots, { mul: attack }, 'label');
    const relocated = locateRegistryLabels(out);
    // The whole payload must come back as ONE label value, not as new properties.
    expect(relocated.find(s => s.key === 'mul')!.value).toBe(attack);
    expect(relocated).toHaveLength(slots.length);
    expect(locateRegistryDescriptions(out).find(s => s.key === 'mul')!.value)
      .toBe(locateRegistryDescriptions(registrySource).find(s => s.key === 'mul')!.value);
  });

  it('throws on an unknown key rather than silently skipping', () => {
    expect(() => spliceDescriptions(registrySource, slots, { notANode: 'x' }, 'label'))
      .toThrow(/no label slot for key "notANode"/);
  });
});

describe('assertValidNodeLabels', () => {
  it('accepts the live registry as-is (no existing duplicate or over-long label)', () => {
    const live = Object.fromEntries(getAllDefinitions().map(d => [d.type, d.label]));
    expect(() => assertValidNodeLabels(live)).not.toThrow();
  });

  it('accepts the live Latvian labels as-is', () => {
    expect(() => assertValidNodeLabels(nodeI18n.nodes as Record<string, string>, 'lv label'))
      .not.toThrow();
  });

  it('rejects a duplicate, case-insensitively, naming BOTH sides', () => {
    // Both keys must appear. Callers hand in the whole post-patch map, iterated in
    // registry order rather than "patched key last", so the surviving `owner` is just
    // whichever node sits earlier in the file — naming only that one produced
    // "Multiply is already used by positionGeometry" for a user renaming
    // positionGeometry, i.e. the node blaming itself.
    expect(() => assertValidNodeLabels({ a: 'Multiply', b: 'Multiply' }))
      .toThrow(/"b".*collides with "a"|"a".*collides with "b"/);
    // nodeMatchRank lowercases before matching, so these two collide there while
    // looking distinct in the file.
    expect(() => assertValidNodeLabels({ a: 'Multiply', b: 'multiply' }))
      .toThrow(/collides with/);
  });

  it('rejects zero-width characters, which trim() cannot see', () => {
    // U+200B is not in trim()'s WhiteSpace set, so "​Multiply" passed both the
    // empty check and the collision fold and produced a second, visually identical
    // "Multiply" row in the Add-node menu. Copy-paste from a web page supplies these.
    expect(() => assertValidNodeLabels({ a: '\u200bMultiply' })).toThrow(/invisible character/);
    expect(() => assertValidNodeLabels({ a: '\u200b' })).toThrow(/invisible character|empty/);
    expect(() => assertValidNodeLabels({ a: 'Mul\u2060tiply' })).toThrow(/invisible character/);
    expect(() => assertValidNodeLabels({ a: 'A\ufeffB' })).toThrow(/invisible character/);
  });

  it('rejects U+2028/U+2029, which are legal inside a JS string literal', () => {
    // ES2019 made them legal in string literals, so they splice in, re-parse cleanly and
    // leave split('\n').length unchanged — while every editor and `git diff` renders the
    // definition broken across two lines mid-literal.
    expect(() => assertValidNodeLabels({ a: 'A\u2028B' })).toThrow(/control character U\+2028/);
    expect(() => assertValidNodeLabels({ a: 'A\u2029B' })).toThrow(/control character U\+2029/);
  });

  it('rejects empty, whitespace-only and untrimmed labels', () => {
    expect(() => assertValidNodeLabels({ a: '' })).toThrow(/must not be empty/);
    expect(() => assertValidNodeLabels({ a: '   ' })).toThrow(/must not be empty/);
    expect(() => assertValidNodeLabels({ a: ' Multiply' })).toThrow(/whitespace/);
    expect(() => assertValidNodeLabels({ a: 'Multiply ' })).toThrow(/whitespace/);
  });

  it('rejects control characters and over-long labels', () => {
    expect(() => assertValidNodeLabels({ a: 'a\nb' })).toThrow(/control character/);
    expect(() => assertValidNodeLabels({ a: 'a\tb' })).toThrow(/control character/);
    expect(() => assertValidNodeLabels({ a: 'x'.repeat(MAX_NODE_LABEL_LENGTH + 1) }))
      .toThrow(new RegExp(`max ${MAX_NODE_LABEL_LENGTH}`));
    expect(() => assertValidNodeLabels({ a: 'x'.repeat(MAX_NODE_LABEL_LENGTH) })).not.toThrow();
  });

  it('rejects a non-string, so a JSON body cannot smuggle an object through', () => {
    expect(() => assertValidNodeLabels({ a: 3 as unknown as string })).toThrow(/must be a string/);
  });
});

describe('SAFETY: a label is display-only', () => {
  const defs = getAllDefinitions();

  it('every definition has a distinct type', () => {
    expect(new Set(defs.map(d => d.type)).size).toBe(defs.length);
  });

  it('no engine module reads a `label` at all', () => {
    // The engine is what turns a graph into code and back. If any of these ever start
    // reading a definition's `label`, a cosmetic rename becomes a codegen change — and
    // every shader exported before the rename would stop round-tripping.
    //
    // The first version of this test matched /\bdef(?:inition)?\.label\b/, which was
    // close to unfalsifiable: it cannot match `uvDef.label` (the `\b` fails inside the
    // identifier), and codeToGraph already names its definition locals exactly that way
    // — outputDef, appendDef, colorDef, unknownDef, uvDef, timeDef, splitDef. It also
    // missed `NODE_REGISTRY.get(t)?.label` and `const { label } = def`.
    //
    // So match any property READ of `.label` on ANY receiver, plus destructuring.
    // WRITES are deliberately not matched: `label: <expr>` and the shorthand `label,`
    // in codeToGraph's `createNode(id, def, label)` STORE the parsed var name into node
    // data — which is exactly why a parsed graph never carries a registry label at all.
    // Matching the bare word `label` instead was too broad: it also hit the word inside
    // string literals that tslToPreviewHTML emits into the generated preview HTML.
    const READ = /\.label\b/;
    const DESTRUCTURE = /\{[^}]*\blabel\b[^}]*\}\s*=/;
    // Empty today. A legitimate PORT-label read here would go in with a note saying why
    // it is not a node label.
    const ALLOWED: Record<string, RegExp[]> = {};
    const engine = [
      'graphToCode.ts', 'codeToGraph.ts', 'tslToShaderModule.ts', 'tslToPreviewHTML.ts',
      'scriptToTSL.ts', 'exportShader.ts', 'fastShadersProject.ts', 'projectImport.ts',
      'cpuEvaluator.ts', 'topologicalSort.ts',
    ];
    for (const file of engine) {
      const src = readFileSync(resolve(__dirname, '..', 'engine', file), 'utf-8');
      const hits = src
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(h => READ.test(h.line) || DESTRUCTURE.test(h.line))
        .filter(h => !h.line.startsWith('//') && !h.line.startsWith('*'))
        .filter(h => !(ALLOWED[file] ?? []).some(re => re.test(h.line)));
      expect(
        hits.map(h => `${file}:${h.n} ${h.line}`),
        `${file} reads a .label — a rename may no longer be display-only`,
      ).toEqual([]);
    }
  });

  it('the Latvian overlay is keyed by type, so an English rename cannot orphan it', () => {
    // Every key must be a real node type. That is the whole property: lv.json's PORT
    // map is keyed by English text and would lose a translation on rename, but the node
    // map is not, so an English rename can never orphan a Latvian name.
    //
    // Deliberately NOT asserting "no key equals any English label": nothing forbids a
    // label equal to some node's type, so that assertion would turn a legal rename
    // (Multiply → "time") into a red suite reported under an i18n heading, pointing the
    // reader at the wrong subsystem entirely.
    const lvNodes = nodeI18n.nodes as Record<string, string>;
    for (const key of Object.keys(lvNodes)) {
      expect(NODE_REGISTRY.has(key), `node-i18n.json has a stale key "${key}"`).toBe(true);
    }
  });

  it('a RENAMED node is still reachable, and first, by its new name', () => {
    // The behavioural contract a rename must preserve: the name you type is the name
    // that wins. This has to actually perform renames — asserting over the untouched
    // registry would pass identically before this feature existed.
    //
    // nodeMatchRank is pure over a definition, so a renamed COPY exercises the real
    // ranker without mutating the shared registry.
    // nodeMatchRank takes an ALREADY-LOWERCASED query (it lowercases the names, not q).
    for (const def of defs) {
      const renamed = { ...def, label: 'Zzq' + def.type };
      // Exact-name tier (0) on the new name...
      expect(nodeMatchRank(renamed, renamed.label.toLowerCase()), def.type).toBe(0);
      // ...and the OLD name no longer wins the top tier through `label`. It may still
      // rank 0 via type/tslFunction/Latvian name, which is correct and has nothing to do
      // with the label, so those cases are exempt.
      const old = def.label.toLowerCase();
      const stillAName = [def.type, def.tslFunction, nodeLabelLV(def.type)].some(
        n => n && n.toLowerCase() === old,
      );
      if (!stillAName) expect(nodeMatchRank(renamed, old), `${def.type} old label`).not.toBe(0);
    }
  });

  it('every node is findable by its current name (no pre-existing shadowing)', () => {
    // Two halves, deliberately scoped differently. Ranking is a property of the
    // LABEL and holds for every definition. Being reachable through the search
    // box is a property of the EDITOR set: a node switched off in
    // node-editor.html is meant to be unfindable (registry/editorVisibility.ts),
    // so asserting it over the full list would make using that feature fail the
    // release workflow's test job.
    const offered = new Set(getEditorDefinitions().map(d => d.type));
    for (const def of defs) {
      expect(nodeMatchRank(def, def.label.toLowerCase()), def.type).toBe(0);
      if (!offered.has(def.type)) continue;
      expect(searchNodes(def.label)[0], `no search hit for "${def.label}"`).toBeDefined();
    }
  });
});
