import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { useAppStore } from '@/store/useAppStore';
import { makeNode } from '@/test-utils';

const SOURCE = path.join(__dirname, 'DragNumberInput.tsx');

/**
 * DragNumberInput opens the store's history bracket on the first pointer MOVE
 * (a press that turns out to be a click-to-edit must not push a no-op entry),
 * so every teardown that closes it must close ONLY a bracket this widget
 * actually opened — tracked in `dragRef.current.bracketed`, not inferred from
 * `moved` (which survives pointerup, and a pointerup can land on this element
 * with no pointerdown of its own: a pane pan slides nodes under the cursor).
 *
 * `endInteraction` is a global nesting counter with no ownership: at depth 1 an
 * unpaired end closes whatever bracket another gesture is riding, and
 * `useHistoryBracket`'s `openedRef` stays true so it never re-opens — the rest
 * of that gesture then pushes a full-graph structuredClone per frame and evicts
 * the user's undo history (MAX_HISTORY 50).
 *
 * Half 1 pins the STORE semantics that make an unpaired end destructive (real
 * code under test). Half 2 is a source guard on the component, which the `node`
 * vitest env cannot render.
 */

const scrubFrame = (v: number) =>
  useAppStore.getState().updateNodeData('n1', { values: { value: v } } as never);

describe('endInteraction has no ownership — an unpaired close is destructive', () => {
  beforeEach(() => {
    useAppStore.setState({
      nodes: [makeNode('n1', 'float', { value: 0 })],
      edges: [],
      past: [],
      future: [],
      isUndoRedo: false,
      coalescingHistory: false,
      interactionDepth: 0,
    });
  });

  // isolate: false shares this worker's globals with later files — never leave
  // a bracket open (same discipline as newGraph.test.ts's afterAll cleanup).
  afterEach(() => {
    useAppStore.setState({ coalescingHistory: false, interactionDepth: 0 });
  });

  it('one foreign end closes a depth-1 bracket outright (and clamps at 0)', () => {
    useAppStore.getState().beginInteraction();
    expect(useAppStore.getState().interactionDepth).toBe(1);

    useAppStore.getState().endInteraction(); // the unpaired close
    expect(useAppStore.getState().coalescingHistory).toBe(false);
    expect(useAppStore.getState().interactionDepth).toBe(0);

    useAppStore.getState().endInteraction(); // never goes negative
    expect(useAppStore.getState().interactionDepth).toBe(0);
  });

  it('a stolen bracket floods history: 20 frames become 20 entries, not 1', () => {
    useAppStore.getState().beginInteraction();
    scrubFrame(1);
    expect(useAppStore.getState().past).toHaveLength(1);

    useAppStore.getState().endInteraction(); // theft
    for (let i = 2; i <= 21; i++) scrubFrame(i);

    expect(useAppStore.getState().past).toHaveLength(21);
  });
});

describe('DragNumberInput source guards', () => {
  const src = readFileSync(SOURCE, 'utf8');

  it('opens the bracket exactly once, on the first move, and records ownership', () => {
    expect((src.match(/beginInteraction\(\)/g) ?? []).length).toBe(1);
    expect(
      src,
      'the open must set the ownership flag in the same branch',
    ).toMatch(/useAppStore\.getState\(\)\.beginInteraction\(\);\s*dragRef\.current\.bracketed = true;/);
  });

  it('has exactly ONE endInteraction call site, guarded by the ownership flag', () => {
    // NB: this counts TEXT — never write `endInteraction` + parens in a comment here.
    expect(
      (src.match(/endInteraction\(\)/g) ?? []).length,
      'every close must funnel through endBracket()',
    ).toBe(1);
    expect(src).toMatch(
      /if \(!dragRef\.current\.bracketed\) return;\s*dragRef\.current\.bracketed = false;\s*useAppStore\.getState\(\)\.endInteraction\(\);/,
    );
  });

  it('every teardown routes through endBracket (pointerup, pointercancel, unmount)', () => {
    // pointerup + pointercancel call it; the unmount effect RETURNS it as its
    // cleanup (the shape useHistoryBracket.ts:54 uses).
    expect((src.match(/endBracket\(\)/g) ?? []).length).toBe(2);
    expect(src, 'the unmount cleanup must be endBracket itself').toMatch(
      /useEffect\(\(\) => endBracket, \[endBracket\]\)/,
    );
  });

  it('a fresh gesture never inherits the previous gesture ownership flag', () => {
    // pointerdown rebuilds dragRef wholesale; the flag must be in that literal.
    expect(src).toMatch(/isDown: true,\s*bracketed: false,/);
  });
});
