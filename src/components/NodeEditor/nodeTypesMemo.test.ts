/**
 * Every React Flow node type is memoized IGNORING its absolute position
 * (flowTypes.ts, `samePropsExceptPosition`).
 *
 * React Flow's NodeWrapper hands every custom node `positionAbsoluteX/Y`, and a
 * drag mints new internals for each moved node and every child of a moved
 * group, so under the components' default `memo` compare every dragged card
 * re-rendered on every pointermove (measured 2026-10-11: 168 card renders per
 * move on a select-all drag of 171 nodes, 55.5 → 31.7 ms of script per move at
 * 4x once skipped). That is only correct while no card READS those two props —
 * the second half of this file holds the source to it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { nodeTypes, rawNodeTypes, samePropsExceptPosition } from './flowTypes';

const SRC = join(__dirname, '../..');

/** React's memo element: `{ $$typeof: Symbol.for('react.memo'), type, compare }`. */
interface MemoShape { $$typeof: symbol; type: unknown; compare: unknown }

describe('nodeTypes — each entry wrapped ONCE in the position-blind memo', () => {
  it('names exactly the raw flow types', () => {
    expect(Object.keys(nodeTypes)).toEqual(Object.keys(rawNodeTypes));
  });

  for (const [type, C] of Object.entries(nodeTypes)) {
    it(`${type}: memo(raw component, samePropsExceptPosition)`, () => {
      const m = C as unknown as MemoShape;
      expect(m.$$typeof).toBe(Symbol.for('react.memo'));
      expect(m.compare).toBe(samePropsExceptPosition);
      expect(m.type).toBe(rawNodeTypes[type as keyof typeof rawNodeTypes]);
    });
  }

  it('is built once: the module hands out the same objects every read', async () => {
    const again = await import('./flowTypes');
    expect(again.nodeTypes).toBe(nodeTypes);
    for (const k of Object.keys(nodeTypes) as (keyof typeof nodeTypes)[]) expect(again.nodeTypes[k]).toBe(nodeTypes[k]);
  });
});

describe('samePropsExceptPosition', () => {
  const data = { registryType: 'mul' };
  const base = {
    id: 'n1', data, type: 'shader', selected: false, dragging: false,
    positionAbsoluteX: 10, positionAbsoluteY: 20, width: 100, height: 40,
  };

  it('a move alone is NOT a change', () => {
    expect(samePropsExceptPosition(base, { ...base, positionAbsoluteX: 11, positionAbsoluteY: -5 })).toBe(true);
    expect(samePropsExceptPosition(base, { ...base })).toBe(true);
  });

  it('every other prop is compared by identity', () => {
    expect(samePropsExceptPosition(base, { ...base, selected: true })).toBe(false);
    expect(samePropsExceptPosition(base, { ...base, dragging: true })).toBe(false);
    expect(samePropsExceptPosition(base, { ...base, data: { ...data } })).toBe(false);
    expect(samePropsExceptPosition(base, { ...base, width: 101 })).toBe(false);
    // Object.is, not ===: NaN equals itself, +0 and -0 differ.
    expect(samePropsExceptPosition({ ...base, width: NaN }, { ...base, width: NaN })).toBe(true);
    expect(samePropsExceptPosition({ ...base, width: 0 }, { ...base, width: -0 })).toBe(false);
  });

  it('a prop that appears, disappears or is swapped for another is a change', () => {
    expect(samePropsExceptPosition(base, { ...base, parentId: 'g1' })).toBe(false);
    const { height: _h, ...noHeight } = base;
    expect(samePropsExceptPosition(base, noHeight)).toBe(false);
    // Same key COUNT, different keys, both values undefined.
    expect(samePropsExceptPosition({ ...noHeight, a: undefined }, { ...noHeight, b: undefined })).toBe(false);
  });
});

describe('no node component reads positionAbsoluteX/Y from its props', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
  }

  it('no source file but flowTypes.ts names either prop', () => {
    // A card that needs where it is reads the store (ColorNode's
    // `internals.positionAbsolute`), which the memo does not gate. Reading the
    // PROP would freeze on the first value, because a move no longer renders.
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(join('NodeEditor', 'flowTypes.ts')))
      .filter((f) => /\bpositionAbsolute[XY]\b/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('the scan is not vacuous: it does see flowTypes.ts', () => {
    expect(readFileSync(join(__dirname, 'flowTypes.ts'), 'utf8')).toMatch(/\bpositionAbsoluteX\b/);
  });
});
