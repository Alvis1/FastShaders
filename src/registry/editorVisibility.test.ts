import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  getAllDefinitions,
  getEditorDefinitions,
  categoryEmptiedByHiding,
  searchNodes,
} from '@/registry/nodeRegistry';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import {
  HIDDEN_NODE_TYPES,
  HIDDEN_TEXTURE_IDS,
  isNodeHiddenFromEditor,
  readEditorVisibility,
} from '@/registry/editorVisibility';
import visibilityJson from '@/registry/editorVisibility.json';

/**
 * The "In editor" checkbox in node-editor.html, from both ends.
 *
 * Hiding an unfinished node is a one-line edit to a JSON file, which makes it
 * exactly the kind of feature that rots quietly: the file keeps a key for a node
 * that was later renamed (hiding nothing, forever, with nothing to notice it),
 * or a NEW list of addable nodes gets written against `getAllDefinitions()` and
 * the hidden node walks back into the UI through it. Neither shows up in a
 * screenshot — the palette just looks right.
 *
 * So this file pins three things:
 *   • the JSON's shape and that every key still names something real;
 *   • that hiding actually filters — proved by mocking a non-empty file, since
 *     the shipped one is empty and would make every assertion vacuous;
 *   • that hiding CANNOT reach the registry, the parser or an existing graph.
 *
 * Plus the mechanical guard: no add surface may call `getAllDefinitions()`.
 */

const registryDir = fileURLToPath(new URL('.', import.meta.url));
const srcDir = fileURLToPath(new URL('..', import.meta.url));

/**
 * Drop comments before grepping. The surfaces EXPLAIN why they call the filtered
 * accessor ("getEditorDefinitions, not getAllDefinitions: …"), and a guard that
 * fails on its own justification teaches the next author to delete the comment.
 */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Every non-test source file under `dir`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = dir + name;
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full + '/'));
    else if (/\.tsx?$/.test(name) && !name.includes('.test.')) out.push(full);
  }
  return out;
}

describe('editorVisibility.json', () => {
  it('holds two string arrays, deduped and sorted', () => {
    const file = visibilityJson as { nodes: string[]; textures: string[] };
    for (const [label, list] of [['nodes', file.nodes], ['textures', file.textures]] as const) {
      expect(Array.isArray(list), `${label} must be an array`).toBe(true);
      expect(list.every((k) => typeof k === 'string' && k.trim() !== ''), `${label} entries`).toBe(true);
      // Sorted + deduped keeps a toggle to a one-line diff. The dev endpoint
      // normalizes on write; this catches a hand edit that didn't.
      expect(list, `${label} must be sorted`).toEqual([...list].sort());
      expect(new Set(list).size, `${label} must be deduped`).toBe(list.length);
    }
  });

  it('names only nodes and textures that still exist', () => {
    // The failure this catches: a node is hidden, later renamed in the registry,
    // and the stale key silently stops hiding anything. Also the reverse — a key
    // typed by hand that never matched.
    const types = new Set(getAllDefinitions().map((d) => d.type));
    for (const key of HIDDEN_NODE_TYPES) {
      expect(types.has(key), `hidden node "${key}" is not in the registry`).toBe(true);
    }
    const ids = new Set(getBuiltinTextures().map((t) => t.id));
    for (const key of HIDDEN_TEXTURE_IDS) {
      expect(ids.has(key), `hidden texture "${key}" is not a built-in texture`).toBe(true);
    }
  });

  it('re-serializes to the same lists it was read from', () => {
    const file = visibilityJson as { nodes: string[]; textures: string[] };
    expect(readEditorVisibility()).toEqual({ nodes: [...file.nodes].sort(), textures: [...file.textures].sort() });
  });
});

describe('the editor accessor', () => {
  it('returns the same array identity as getAllDefinitions when nothing is hidden', () => {
    // The shipped state. Identity matters: ContentBrowser/AddNodeMenu memoize on
    // it, so a fresh array every call would make this feature cost a re-render
    // in a build where it does nothing at all.
    if (HIDDEN_NODE_TYPES.size === 0) {
      expect(getEditorDefinitions()).toBe(getAllDefinitions());
    } else {
      expect(getEditorDefinitions().length).toBe(getAllDefinitions().length - HIDDEN_NODE_TYPES.size);
    }
  });

  it('agrees with the predicate', () => {
    for (const def of getEditorDefinitions()) expect(isNodeHiddenFromEditor(def.type)).toBe(false);
  });

  it('never hides `output` — the graph cannot be compiled without it', () => {
    // Not a rule the endpoint enforces (nothing would break at save time); it is
    // a rule about what a shipped build must still be able to do.
    expect(isNodeHiddenFromEditor('output')).toBe(false);
  });

  it('searchNodes with an empty query returns the editor set, not everything', () => {
    expect(searchNodes('')).toBe(getEditorDefinitions());
  });

  it('reports a category as emptied exactly when the file emptied it', () => {
    // Derived, not pinned to the empty shipped state: hiding every node of a
    // category is a SUPPORTED use (it is how an unfinished family stays out of
    // the palette), so an assertion that no category is ever emptied would turn
    // the release workflow's test job red the first time someone used it.
    for (const cat of new Set(getAllDefinitions().map((d) => d.category))) {
      const addable = getAllDefinitions().filter((d) => d.category === cat && d.type !== 'output');
      const expected = addable.length > 0 && addable.every((d) => isNodeHiddenFromEditor(d.type));
      expect(categoryEmptiedByHiding(cat), cat).toBe(expected);
    }
  });
});

describe('hiding actually filters (mocked non-empty file)', () => {
  afterEach(() => {
    vi.doUnmock('./editorVisibility.json');
    vi.resetModules();
  });

  it('drops the type from every add surface while leaving the registry whole', async () => {
    vi.resetModules();
    vi.doMock('./editorVisibility.json', () => ({
      default: { nodes: ['sin', 'perlin'], textures: ['marble'] },
    }));

    const reg = await import('@/registry/nodeRegistry');
    const vis = await import('@/registry/editorVisibility');

    // Hidden from the two accessors every add surface goes through…
    const editorTypes = reg.getEditorDefinitions().map((d) => d.type);
    expect(editorTypes).not.toContain('sin');
    expect(editorTypes).not.toContain('perlin');
    expect(reg.searchNodes('sin').map((d) => d.type)).not.toContain('sin');
    // …including a query that matches the node's own name exactly, which is the
    // one search tier that would otherwise rank it first.
    expect(reg.searchNodes('perlin').map((d) => d.type)).not.toContain('perlin');
    // A hidden node must not drag its neighbours out with it.
    expect(reg.searchNodes('cos').map((d) => d.type)).toContain('cos');

    // …but still fully registered: this is what keeps a saved .fastshader, a
    // code→graph parse, the built-in presets and the Node Designer working.
    expect(reg.NODE_REGISTRY.get('sin')).toBeDefined();
    expect(reg.getAllDefinitions().map((d) => d.type)).toContain('sin');
    expect(reg.TSL_FUNCTION_TO_DEF.get('sin')).toBeDefined();

    expect(vis.isTextureHiddenFromEditor('marble')).toBe(true);
    expect(vis.isTextureHiddenFromEditor('wood')).toBe(false);

    // Identity must stay stable WHILE HIDING IS ACTIVE, not just in the empty
    // shipped state. A per-call `allDefinitions.filter(...)` reads as correct,
    // passes every content assertion, and silently makes each consumer's
    // `useMemo` recompute — and gives one render two different "the editor set"
    // arrays. The empty-state test cannot see it: there the filter never runs.
    expect(reg.getEditorDefinitions()).toBe(reg.getEditorDefinitions());
    expect(reg.searchNodes('')).toBe(reg.getEditorDefinitions());
  });

  it('reports a category as emptied only when its last node goes', async () => {
    vi.resetModules();
    const reg0 = await import('@/registry/nodeRegistry');
    const noise = reg0.getAllDefinitions().filter((d) => d.category === 'noise').map((d) => d.type);
    expect(noise.length).toBeGreaterThan(1);

    vi.resetModules();
    vi.doMock('./editorVisibility.json', () => ({ default: { nodes: noise.slice(1), textures: [] } }));
    const partial = await import('@/registry/nodeRegistry');
    expect(partial.categoryEmptiedByHiding('noise')).toBe(false);

    vi.resetModules();
    vi.doMock('./editorVisibility.json', () => ({ default: { nodes: noise, textures: [] } }));
    const full = await import('@/registry/nodeRegistry');
    expect(full.categoryEmptiedByHiding('noise')).toBe(true);
    // Presets/Textures render built-in graphs, not defs — "no visible defs" is
    // their permanent state and must never read as emptied, or hiding any node
    // anywhere would delete the two asset tabs.
    expect(full.categoryEmptiedByHiding('presets')).toBe(false);
    expect(full.categoryEmptiedByHiding('texture')).toBe(false);
  });
});

describe('no add surface reads the unfiltered registry', () => {
  it('nothing under components/NodeEditor imports getAllDefinitions', () => {
    // The whole feature is one accessor swap, so the only way it regresses is a
    // new (or reverted) list built from getAllDefinitions(). Everything in this
    // directory that lists definitions is a surface the user can add from.
    const offenders = sourceFiles(srcDir + 'components/NodeEditor/').filter((f) =>
      /\bgetAllDefinitions\b/.test(codeOnly(readFileSync(f, 'utf8')))
    );
    expect(offenders.map((f) => f.slice(srcDir.length))).toEqual([]);
  });

  it('the content browser filters the Textures tab', () => {
    const src = codeOnly(readFileSync(srcDir + 'components/NodeEditor/ContentBrowser.tsx', 'utf8'));
    expect(src).toMatch(/isTextureHiddenFromEditor/);
    // `getEditorDefinitions(hidden)` — the call carries the user's optional
    // category switches (registry/optionalCategories.ts); the regex allows the
    // argument and optionalCategories.test.ts pins that it is always passed.
    expect(src).toMatch(/getEditorDefinitions\(/);
  });

  it('searchNodes ranks the editor set rather than the raw list', () => {
    const src = codeOnly(readFileSync(registryDir + 'nodeRegistry.ts', 'utf8'));
    const body = src.slice(src.indexOf('export function searchNodes'), src.indexOf('export function getAllDefinitions'));
    expect(body).toMatch(/getEditorDefinitions\(/);
    // `allDefinitions` here would re-open the search box as a way back in.
    expect(body).not.toMatch(/\ballDefinitions\b/);
  });

  it('no engine, store or util module can even see the hidden set', () => {
    // The strongest form of "hiding is not a registry filter": if codegen, the
    // parser, the evaluator or the store cannot IMPORT the visibility module,
    // a hidden node cannot change what a shader compiles to. Stated as a test
    // because the alternative — noticing it in review — is how the opposite
    // gets introduced ("skip hidden nodes in graphToCode" sounds reasonable).
    const offenders: string[] = [];
    for (const dir of ['engine/', 'store/', 'utils/', 'hooks/']) {
      for (const f of sourceFiles(srcDir + dir)) {
        if (/editorVisibility|getEditorDefinitions|HIDDEN_NODE_TYPES/.test(codeOnly(readFileSync(f, 'utf8')))) {
          offenders.push(f.slice(srcDir.length));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Node Designer keeps designing hidden nodes', () => {
    // You hide a node BECAUSE it is unfinished, so the tool for finishing it
    // must still list it. ndData.test.ts can't catch a regression here: it
    // derives both sides of its comparison from the same accessor.
    const src = codeOnly(readFileSync(srcDir + 'nodeDesigner/ndData.ts', 'utf8'));
    expect(src).toMatch(/getAllDefinitions\(\)/);
    expect(src).not.toMatch(/getEditorDefinitions|editorVisibility/);
  });

  it('the overview page still sees every definition', () => {
    // The inverse guard: node-editor.html is where a hidden node is switched
    // back on, so filtering ITS rows would strand the node permanently off.
    const src = codeOnly(readFileSync(srcDir + 'components/Graphs/GraphsPage.tsx', 'utf8'));
    expect(src).toMatch(/getAllDefinitions\(\)/);
    expect(src).not.toMatch(/getEditorDefinitions/);
  });
});
