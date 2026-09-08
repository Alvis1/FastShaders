import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import { SINGLETON_NODE_TYPES, isSingletonNodeType, findSingletonNode } from './singletonNodes';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';

/**
 * The Sound node is a SINGLETON on the canvas (2026-09-08): there is one
 * capture session and one analyser, so a second node would carry a second
 * source picker pointed at the same sound and emit a second set of uniforms
 * driven by it — two controls for one scope.
 *
 * The pure helpers are unit-tested below. The two ADD SURFACES are
 * source-pinned, and that pin is the only thing standing between this feature
 * and a silent regression: nothing throws, nothing fails to compile and nothing
 * renders wrong when a second Sound node appears. You simply get one, and the
 * shader reacts through whichever node's uniforms the pump happened to drive.
 * There is no runtime assertion that could catch it either, because a graph
 * legitimately MAY hold two — a pre-fold or hand-edited `.fastshader` does, and
 * nothing deletes one behind the user's back. This is an add-surface rule, so
 * the add surfaces are where it has to be checked.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('the singleton set', () => {
  it('holds the Sound node', () => {
    expect(isSingletonNodeType('soundNode')).toBe(true);
    expect(SINGLETON_NODE_TYPES.has('soundNode')).toBe(true);
  });

  it('names only types the registry actually defines', () => {
    // A typo'd or retired entry is inert — the type never matches a real node,
    // so the add surfaces never find one and the rule silently stops applying.
    for (const type of SINGLETON_NODE_TYPES) {
      expect(NODE_REGISTRY.get(type), type).toBeTruthy();
    }
  });

  it('says no to every ordinary type', () => {
    for (const t of ['float', 'time', 'output', 'imageNode', 'dataNode', 'raymarchOutput']) {
      expect(isSingletonNodeType(t), t).toBe(false);
    }
  });

  it('says no to the retired audioInput type', () => {
    // It folds into `soundNode` on every restore path
    // (registry/legacyNodeTypes.ts), so by the time an add surface asks, the
    // type cannot be in the graph. Listing it here as well would be dead
    // weight that later reads as meaningful.
    expect(isSingletonNodeType('audioInput')).toBe(false);
  });

  it('tolerates the non-string values a caller can hand it', () => {
    for (const t of [undefined, null, '']) {
      expect(isSingletonNodeType(t as string | undefined | null)).toBe(false);
    }
    // `registryType` arrives from `.fastshader` files, so a Set is what keeps a
    // prototype member from resolving as a hit — the documented Record-vs-Map
    // trap, in its Set form.
    for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isSingletonNodeType(t), t).toBe(false);
    }
  });
});

describe('findSingletonNode', () => {
  const mic = (id: string) => makeNode(id, 'soundNode');

  it('finds the existing Sound node', () => {
    const nodes: AppNode[] = [makeNode('f1', 'float'), mic('m1'), makeNode('out', 'output')];
    expect(findSingletonNode(nodes, 'soundNode')?.id).toBe('m1');
  });

  it('returns null when there is none yet — the add proceeds normally', () => {
    expect(findSingletonNode([makeNode('f1', 'float')], 'soundNode')).toBeNull();
    expect(findSingletonNode([], 'soundNode')).toBeNull();
  });

  it('returns the FIRST match when a graph somehow holds several', () => {
    // A pre-fold or hand-edited file really can carry two. First in array order
    // is the same deterministic rule the capture pump applies when it decides
    // whose settings drive the one analyser, so the node an add gesture glides
    // to is the node that is actually in charge — not an arbitrary twin.
    const nodes: AppNode[] = [makeNode('f1', 'float'), mic('m1'), mic('m2')];
    expect(findSingletonNode(nodes, 'soundNode')?.id).toBe('m1');
  });

  it('returns null for a NON-singleton type even when such nodes exist', () => {
    // Not "the first float" — the caller asks this one question and branches on
    // the answer, so a truthy result for an ordinary type would make every
    // second Float an unaddable "take me to it".
    const nodes: AppNode[] = [makeNode('f1', 'float'), makeNode('f2', 'float')];
    expect(findSingletonNode(nodes, 'float')).toBeNull();
    expect(findSingletonNode([makeNode('o1', 'output')], 'output')).toBeNull();
  });

  it('survives a node whose `data` is missing', () => {
    // Every graph-shaped payload here is treated as adversarial, and this runs
    // on a store array that a `.fastshader` filled.
    const nodes = [{ id: 'x', type: 'shader', position: { x: 0, y: 0 } }] as unknown as AppNode[];
    expect(() => findSingletonNode(nodes, 'soundNode')).not.toThrow();
    expect(findSingletonNode(nodes, 'soundNode')).toBeNull();
  });
});

/**
 * BOTH add surfaces must consult the set. There are exactly two paths that mint
 * a node from a definition: NodeEditor's `placeTilePayload` (palette tile drag,
 * tile click/Enter, wire-drop) and AddNodeMenu's add handler (right-click,
 * Shift+A, the search box). Miss either and that one surface quietly adds a
 * second Sound node while the other refuses.
 */
describe('both add surfaces consult the singleton set', () => {
  const surfaces: [string, string][] = [
    ['NodeEditor.tsx', 'NodeEditor.tsx'],
    ['menus/AddNodeMenu.tsx', 'menus/AddNodeMenu.tsx'],
  ];

  for (const [label, rel] of surfaces) {
    it(`${label} asks findSingletonNode and glides instead of adding`, () => {
      const src = read(rel);
      expect(src, `${label} must import the helper`).toMatch(
        /import \{[^}]*findSingletonNode[^}]*\} from '\.{1,2}\/singletonNodes'/,
      );
      expect(src, `${label} must call it`).toContain('findSingletonNode(');
      // The glide is the other half of the rule: refusing the add without
      // taking the user to the node that already exists reads as the palette
      // tile being broken. Same framing as the cost pill and the F key.
      expect(src, `${label} must glide via focusNode`).toContain('focusNode(');
    });

    it(`${label} returns early on a hit, before it mints a node`, () => {
      // Order is what makes this correct rather than merely present. Both
      // surfaces do work between "which def is this" and "add it" — a
      // drag-connect commit in NodeEditor, a wire-drop auto-connect in
      // AddNodeMenu — and both would otherwise wire a previewed socket to a
      // node that is never created.
      //
      // Checked as "a `return;` lies between the guard and the NEXT
      // `generateId()`", not "the guard precedes the first `generateId()` in
      // the file": NodeEditor.tsx is ~94 KB and mints ids in several unrelated
      // handlers, so a whole-file position comparison pins nothing about this
      // one.
      const src = read(rel);
      const guard = src.indexOf('findSingletonNode(');
      expect(guard, `${label}: no findSingletonNode call`).toBeGreaterThan(-1);
      const mint = src.indexOf('generateId()', guard);
      expect(mint, `${label}: no node creation after the guard`).toBeGreaterThan(-1);
      expect(
        src.slice(guard, mint),
        `${label}: the singleton guard must bail before the handler mints a node`,
      ).toMatch(/\breturn;/);
    });
  }
});
