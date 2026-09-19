/**
 * The project block's additive `imageRefs` field (engine/projectImageRefs.ts):
 * the module literal scanner, the READER every import runs, and the WRITER
 * that stays behind EXPORT_IMAGE_REFS = false.
 *
 * Pure: no store, no stubbed globals.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeNode, makeEdge } from '@/test-utils';
import { getNodeValues, type AppNode } from '@/types';
import { decodeImageNode, HARD_MAX_IMAGE_ENCODED_CHARS } from '@/utils/imageNode';
import { IMAGE_REF_RE, imageRefFor, newRefBudget } from '@/utils/imagePayloadRefs';
import { safeJsonReviver } from '@/utils/safeJson';
import { graphToCode } from './graphToCode';
import { imageAssetFor, inlineImageAssetsFromNodes } from './imageAssets';
import { embedProjectState, extractProjectState, type FastShadersProject } from './fastShadersProject';
import {
  EXPORT_IMAGE_REFS,
  MAX_IMAGE_REFS,
  MAX_MODULE_IMAGE_LITERALS,
  moduleImageLiterals,
  referenceImagesInModule,
  referenceImagesInSet,
  resolveProjectImageRefs,
  splitImageLosses,
} from './projectImageRefs';

const PNG = 'data:image/png;base64,AAAA';
const WEBP = `data:image/webp;base64,${btoa('abc')}`;
// A real FNV-1a collision of equal length (payloadDigest.test.ts): one key.
const CP = 'data:image/png;base64,L8zt5mTG';
const CQ = 'data:image/png;base64,E6b4siKM';

const img = (id: string, values: Record<string, string | number> = {}): AppNode =>
  makeNode(id, 'imageNode', { width: 1, height: 1, fileName: 't.png', colorSpace: 'color', ...values });

function project(nodes: AppNode[], extra: Record<string, unknown> = {}): FastShadersProject {
  return { version: 1, shaderName: 's', graph: { nodes, edges: [] }, preview: {}, ui: {}, ...extra } as FastShadersProject;
}

const moduleWith = (...lits: string[]) =>
  `export default function () {}\n${lits.map((l, i) => `const s${i} = "${l}";`).join('\n')}\n`;

/** Candidates that must never be read. */
const untouchable = (): Iterable<string> => ({
  [Symbol.iterator]() {
    throw new Error('candidates were iterated');
  },
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

const payload = (p: FastShadersProject, id: string) =>
  getNodeValues(p.graph.nodes.find((n) => n.id === id)!).imageB64;

describe('the key is the storage ref format (one function for both)', () => {
  it('imageRefFor is deterministic, well-formed and length-aware', () => {
    expect(imageRefFor(PNG)).toBe(imageRefFor(PNG));
    expect(IMAGE_REF_RE.test(imageRefFor(PNG))).toBe(true);
    expect(imageRefFor(PNG)).not.toBe(imageRefFor(`${PNG}AAAA`));
    // The fixture pair really collides, or the poison tests below prove nothing.
    expect(imageRefFor(CP)).toBe(imageRefFor(CQ));
  });
});

describe('moduleImageLiterals', () => {
  it('finds only double-quoted whitelisted literals, in text order', () => {
    const text = `a("${PNG}"); b('${WEBP}'); c = "${WEBP}"; "data:image/gif;base64,AAAA"; ${PNG};`;
    expect([...moduleImageLiterals(text)]).toEqual([PNG, WEBP]);
  });

  it('skips a literal over the 8M hard ceiling', () => {
    const huge = `data:image/png;base64,${'A'.repeat(HARD_MAX_IMAGE_ENCODED_CHARS)}`;
    expect([...moduleImageLiterals(`"${huge}" "${PNG}"`)]).toEqual([PNG]);
  });

  it(`stops after ${MAX_MODULE_IMAGE_LITERALS} literals`, () => {
    const text = Array.from({ length: MAX_MODULE_IMAGE_LITERALS + 6 }, () => `"${PNG}"`).join(',');
    expect([...moduleImageLiterals(text)]).toHaveLength(MAX_MODULE_IMAGE_LITERALS);
  });

  it('is linear on unclosed runs', () => {
    const t0 = performance.now();
    expect([...moduleImageLiterals(`"data:image/png;base64,${'A'.repeat(5_000_000)}`)]).toEqual([]);
    expect([...moduleImageLiterals('"data:image/png;base64,AAAA '.repeat(200_000))]).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('the READER: resolveProjectImageRefs', () => {
  it('a block without imageRefs is returned as is, and the candidates are never read', () => {
    const p = project([img('a')]);
    const r = resolveProjectImageRefs(p, untouchable());
    expect(r.project).toBe(p);
    expect(r.unresolvedIds.size).toBe(0);
  });

  it('junk imageRefs are ignored the same way', () => {
    for (const junk of [[imageRefFor(PNG)], 5, null, 'img1-00000000-q', true]) {
      const p = project([img('a')], { imageRefs: junk });
      expect(resolveProjectImageRefs(p, untouchable()).project).toBe(p);
    }
  });

  it('nothing wanted (every image node has a payload) never reads the candidates', () => {
    const p = project([img('a', { imageB64: PNG })], { imageRefs: { a: imageRefFor(WEBP) } });
    const r = resolveProjectImageRefs(p, untouchable());
    expect(r.project).toBe(p);
    expect(payload(r.project, 'a')).toBe(PNG);
  });

  it('a ref resolves to the matching literal without mutating the input', () => {
    const p = deepFreeze(project([img('a'), img('b', { imageB64: WEBP })], { imageRefs: { a: imageRefFor(PNG) } }));
    const r = resolveProjectImageRefs(p, moduleImageLiterals(moduleWith(WEBP, PNG)));
    expect(r.unresolvedIds.size).toBe(0);
    expect(payload(r.project, 'a')).toBe(PNG);
    expect(payload(r.project, 'b')).toBe(WEBP);
    expect(r.project.graph.nodes[1]).toBe(p.graph.nodes[1]);
    expect(getNodeValues(p.graph.nodes[0]).imageB64).toBeUndefined();
  });

  it('a missing literal leaves the node untouched and counts it', () => {
    const p = project([img('a')], { imageRefs: { a: imageRefFor(PNG) } });
    const r = resolveProjectImageRefs(p, moduleImageLiterals(moduleWith(WEBP)));
    expect([...r.unresolvedIds]).toEqual(['a']);
    expect(r.project).toBe(p);
  });

  it('two DIFFERENT literals under one key poison it (a collision never binds the wrong image)', () => {
    const k = imageRefFor(CP);
    const p = project([img('a'), img('b')], { imageRefs: { a: k, b: k } });
    const r = resolveProjectImageRefs(p, [CP, CQ]);
    expect([...r.unresolvedIds].sort()).toEqual(['a', 'b']);
    expect(r.project).toBe(p);
    // The same literal twice is not a conflict.
    const same = resolveProjectImageRefs(p, [CP, CP]);
    expect(same.unresolvedIds.size).toBe(0);
    expect(payload(same.project, 'b')).toBe(CP);
  });

  it('malformed refs, over-long ids and reserved ids are never resolved', () => {
    const refs: Record<string, unknown> = { a: 'i1-q-0ce4918c', b: 42, [`x${'y'.repeat(300)}`]: imageRefFor(PNG) };
    for (const reserved of ['__proto__', 'constructor']) {
      Object.defineProperty(refs, reserved, { value: imageRefFor(PNG), enumerable: true });
    }
    const nodes = [img('a'), img('b'), img(`x${'y'.repeat(300)}`), img('__proto__'), img('constructor')];
    const p = project(nodes, { imageRefs: refs });
    const r = resolveProjectImageRefs(p, untouchable());
    expect(r.project).toBe(p);
    expect(r.unresolvedIds.size).toBe(0);
  });

  it(`reads at most ${MAX_IMAGE_REFS} refs`, () => {
    const nodes = Array.from({ length: MAX_IMAGE_REFS + 6 }, (_, i) => img(`n${i}`));
    const imageRefs = Object.fromEntries(nodes.map((n) => [n.id, imageRefFor(PNG)]));
    const r = resolveProjectImageRefs(project(nodes, { imageRefs }), [PNG]);
    const resolved = r.project.graph.nodes.filter((n) => getNodeValues(n).imageB64 === PNG);
    expect(resolved).toHaveLength(MAX_IMAGE_REFS);
    expect(r.unresolvedIds.size).toBe(0);
  });

  it('a ref on a non-image node is ignored', () => {
    const p = project([makeNode('f', 'float', { value: 1 })], { imageRefs: { f: imageRefFor(PNG) } });
    expect(resolveProjectImageRefs(p, untouchable()).project).toBe(p);
  });

  it('stops at the shared budget; the rest stay unresolved', () => {
    const budget = newRefBudget(PNG.length);
    const k = imageRefFor(PNG);
    const r = resolveProjectImageRefs(project([img('a'), img('b')], { imageRefs: { a: k, b: k } }), [PNG], budget);
    expect(payload(r.project, 'a')).toBe(PNG);
    expect(payload(r.project, 'b')).toBeUndefined();
    expect([...r.unresolvedIds]).toEqual(['b']);
    expect(budget.refChars).toBe(PNG.length);
  });
});

describe('splitImageLosses counts each empty node ONCE', () => {
  it('an unresolved node still empty is missing; if it also carried a dangling imageRef that is subtracted', () => {
    const before = [img('a', { imageRef: 'img1-00000000-q' }), img('b')];
    const after = [img('a', { imageB64: '' }), img('b')];
    expect(splitImageLosses(before, after, new Set(['a', 'b']))).toEqual({ missing: 2, alsoDangling: 1 });
  });

  it('an unresolved node the in-node pass filled is not missing', () => {
    expect(splitImageLosses([img('a')], [img('a', { imageB64: PNG })], new Set(['a']))).toEqual({ missing: 0, alsoDangling: 0 });
  });
});

describe('the WRITER: referenceImagesInModule (owner-gated)', () => {
  const src = (n: AppNode) => {
    const p = getNodeValues(n).imageB64;
    return typeof p === 'string' && p.length > 0 ? p : null;
  };

  it('referenced nodes lose imageB64, the input is not mutated, and imageRefs is the LAST key', () => {
    const p = deepFreeze(project([img('a', { imageB64: PNG }), img('b', { imageB64: PNG }), img('c', { imageB64: WEBP })]));
    const out = referenceImagesInModule(p, moduleWith(PNG, WEBP), src);
    expect(out.imageRefs).toEqual({ a: imageRefFor(PNG), b: imageRefFor(PNG), c: imageRefFor(WEBP) });
    expect(lastKey(out)).toBe('imageRefs');
    for (const n of out.graph.nodes) expect(Object.prototype.hasOwnProperty.call(getNodeValues(n), 'imageB64')).toBe(false);
    expect(payload(p, 'a')).toBe(PNG);
  });

  it('a node whose payload is not a literal in the module keeps imageB64', () => {
    const p = project([img('a', { imageB64: PNG }), img('b', { imageB64: WEBP })]);
    expect(referenceImagesInModule(p, '// Export error: x', src)).toBe(p);
    const partial = referenceImagesInModule(p, moduleWith(WEBP), src);
    expect(partial.imageRefs).toEqual({ b: imageRefFor(WEBP) });
    expect(payload(partial, 'a')).toBe(PNG);
  });

  it('duplicate and reserved ids keep imageB64', () => {
    const p = project([img('a', { imageB64: PNG }), img('a', { imageB64: PNG }), img('constructor', { imageB64: PNG })]);
    expect(referenceImagesInModule(p, moduleWith(PNG), src)).toBe(p);
  });

  it('a key two different payloads share is poisoned: both keep imageB64', () => {
    const p = project([img('a', { imageB64: CP }), img('b', { imageB64: CQ })]);
    expect(referenceImagesInModule(p, moduleWith(CP, CQ), src)).toBe(p);
  });

  it('no image nodes (or no canonical src) → the SAME project', () => {
    const p = project([makeNode('f', 'float', { value: 1 })]);
    expect(referenceImagesInModule(p, moduleWith(PNG), src)).toBe(p);
    const q = project([img('a', { imageB64: PNG })]);
    expect(referenceImagesInModule(q, moduleWith(PNG), () => null)).toBe(q);
  });

  it('an imageRefs key already on the input is replaced, and still last', () => {
    const p = project([img('a', { imageB64: PNG })], { imageRefs: { z: 'junk' } });
    const out = referenceImagesInModule(p, moduleWith(PNG), src);
    expect(out.imageRefs).toEqual({ a: imageRefFor(PNG) });
    expect(lastKey(out)).toBe('imageRefs');
  });
});

function lastKey(o: object): string | undefined {
  const keys = Object.keys(o);
  return keys[keys.length - 1];
}

describe('the single-GLB WRITER: referenceImagesInSet (one body with referenceImagesInModule)', () => {
  const src = (n: AppNode) => {
    const p = getNodeValues(n).imageB64;
    return typeof p === 'string' && p.length > 0 ? p : null;
  };

  it('references exactly the nodes whose canonical src is in the set, imageRefs last', () => {
    const p = deepFreeze(project([img('a', { imageB64: PNG }), img('b', { imageB64: WEBP })]));
    const out = referenceImagesInSet(p, new Set([WEBP]), src);
    expect(out.imageRefs).toEqual({ b: imageRefFor(WEBP) });
    expect(lastKey(out)).toBe('imageRefs');
    expect(payload(out, 'a')).toBe(PNG);
    expect(Object.prototype.hasOwnProperty.call(getNodeValues(out.graph.nodes[1]), 'imageB64')).toBe(false);
    expect(payload(p, 'b')).toBe(WEBP);
  });

  it('the SAME project when the set names nothing, and the module writer\'s output for the module\'s own literals', () => {
    const p = project([img('a', { imageB64: PNG }), img('b', { imageB64: WEBP })]);
    expect(referenceImagesInSet(p, new Set(), src)).toBe(p);
    expect(referenceImagesInSet(p, new Set(['data:image/png;base64,ZZZZ']), src)).toBe(p);
    const fromModule = referenceImagesInModule(p, moduleWith(PNG, WEBP), src);
    expect(referenceImagesInSet(p, new Set([PNG, WEBP]), src)).toEqual(fromModule);
  });

  it('shares the writer\'s exceptions: duplicate ids, reserved ids and a poisoned key keep imageB64', () => {
    const dup = project([img('a', { imageB64: PNG }), img('a', { imageB64: PNG }), img('constructor', { imageB64: PNG })]);
    expect(referenceImagesInSet(dup, new Set([PNG]), src)).toBe(dup);
    const collide = project([img('a', { imageB64: CP }), img('b', { imageB64: CQ })]);
    expect(referenceImagesInSet(collide, new Set([CP, CQ]), src)).toBe(collide);
  });
});

describe('round trip on the real engine', () => {
  const SRC = `data:image/webp;base64,${btoa('abc')}`;
  const nodes = () => [
    img('img1', { imageB64: SRC, width: 2, height: 2, fileName: 'a.webp' }),
    img('img2', { imageB64: SRC, width: 2, height: 2, fileName: 'b.webp' }),
    makeNode('out1', 'output'),
  ];

  function exported() {
    const ns = nodes();
    const { code } = graphToCode(ns, [makeEdge('img1', 'out', 'out1', 'color')]);
    const script = inlineImageAssetsFromNodes(code, ns);
    const canonical = (n: AppNode) => imageAssetFor(n.id, getNodeValues(n))?.src ?? null;
    const written = referenceImagesInModule(project(ns), script, canonical);
    return { script, written, text: embedProjectState(script, written) };
  }

  it('writer → embed → extract → reader recovers every payload', () => {
    const { script, written, text } = exported();
    // One Image element per distinct payload (P2b C3): one literal in the module.
    expect(script.split(`"${SRC}"`).length - 1).toBe(1);
    expect(written.imageRefs).toEqual({ img1: imageRefFor(SRC), img2: imageRefFor(SRC) });
    const ext = extractProjectState(text)!;
    const r = resolveProjectImageRefs(ext.project, moduleImageLiterals(ext.stripped));
    expect(r.unresolvedIds.size).toBe(0);
    for (const id of ['img1', 'img2']) {
      const values = getNodeValues(r.project.graph.nodes.find((n) => n.id === id)!);
      expect(values.imageB64).toBe(SRC);
      expect(Array.from(decodeImageNode(values)!.bytes)).toEqual([97, 98, 99]);
    }
  });

  it('negative control: what 0.3.33 sees — the block alone decodes to NO image', () => {
    const { text } = exported();
    const begin = text.indexOf('/* FASTSHADERS_PROJECT_V1') + '/* FASTSHADERS_PROJECT_V1'.length;
    const json = text.slice(begin, text.indexOf('END_FASTSHADERS_PROJECT */'));
    const block = JSON.parse(json, safeJsonReviver) as FastShadersProject;
    for (const id of ['img1', 'img2']) {
      expect(decodeImageNode(getNodeValues(block.graph.nodes.find((n) => n.id === id)!))).toBeNull();
    }
  });
});

describe('source pins', () => {
  const SRC_DIR = join(__dirname, '..');
  const read = (rel: string) => readFileSync(join(SRC_DIR, rel), 'utf8');

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it('EXPORT_IMAGE_REFS is false — flipping it is the owner decision (0.3.33 opens such files black)', () => {
    expect(EXPORT_IMAGE_REFS).toBe(false);
    expect(read('engine/projectImageRefs.ts')).toContain('export const EXPORT_IMAGE_REFS = false as const;');
  });

  it('only exportShader.ts imports the gate', () => {
    // Comments elsewhere may NAME it; only an import can read it.
    const importsGate = /import\s*\{[^}]*\bEXPORT_IMAGE_REFS\b[^}]*\}\s*from/;
    const users = walk(SRC_DIR)
      .filter((p) => importsGate.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC_DIR, p).split('\\').join('/'))
      .sort();
    expect(users).toEqual(['engine/exportShader.ts']);
  });

  it('projectImageRefs.ts imports neither imageAssets nor the store', () => {
    const src = read('engine/projectImageRefs.ts');
    expect(src).not.toMatch(/from ['"]\.\/imageAssets['"]/);
    expect(src).not.toMatch(/useAppStore|@\/store\//);
  });

  it('applyProjectToStore runs both ref passes on ONE budget, and gets the module text', () => {
    const src = read('engine/projectImport.ts');
    expect(src).toContain('const budget = newRefBudget();');
    expect(src).toContain('resolveProjectImageRefs(project, moduleImageLiterals(moduleText), budget)');
    expect(src).toContain('resolveImageRefs(fileRefs.project.graph.nodes, undefined, budget)');
    expect(src).toContain('applyProjectToStore(projectResult.project, projectResult.stripped)');
  });
});
