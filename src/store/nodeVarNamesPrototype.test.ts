/**
 * `nodeVarNames` must be a NULL-PROTOTYPE map at every moment it can be read.
 *
 * Node ids arrive verbatim from `.fastshader` files and the `fs:graph`
 * autosave, and seven node components read `s.nodeVarNames[id]` straight into
 * `varName ?? data.label`. On a plain `{}` an id spelling `constructor`,
 * `toString` or `valueOf` resolves to a FUNCTION rather than to undefined, the
 * `??` therefore keeps it, and rendering it throws inside NodeTitle — after
 * which the 300 ms autosave persists the poisoned graph, so every reload
 * repeats the crash.
 *
 * Two separate objects have to be safe and this pins BOTH, because fixing only
 * one leaves a real window open:
 *  - the map `useSyncEngine` builds after each graph→code pass, and
 *  - the store's INITIAL seed, which is what components read on the first paint
 *    of a freshly loaded graph — that paint happens before any sync effect has
 *    run, so a safe builder alone does not cover it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { useAppStore } from './useAppStore';

describe('nodeVarNames is prototype-poisoning-proof', () => {
  it('the store seeds it with a null-prototype object', () => {
    const seeded = useAppStore.getState().nodeVarNames;
    expect(Object.getPrototypeOf(seeded)).toBe(null);
  });

  it('a hostile node id reads as undefined on the seed, not as a function', () => {
    const seeded = useAppStore.getState().nodeVarNames;
    for (const id of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(seeded[id]).toBeUndefined();
      // The real failure was `varName ?? data.label` keeping a function.
      expect(typeof (seeded[id] ?? 'fallback')).toBe('string');
    }
  });

  it('survives a round trip through the setter', () => {
    const names = Object.create(null) as Record<string, string>;
    names.mul1 = 'mul1';
    useAppStore.getState().setNodeVarNames(names);
    const back = useAppStore.getState().nodeVarNames;
    expect(back.mul1).toBe('mul1');
    expect(back['constructor']).toBeUndefined();
  });

  it('both writers use a null prototype, in source', () => {
    const store = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8');
    const sync = readFileSync(new URL('../hooks/useSyncEngine.ts', import.meta.url), 'utf8');
    // The seed: a bare `nodeVarNames: {}` is the bug this file exists for.
    expect(store).not.toMatch(/nodeVarNames:\s*\{\}/);
    expect(store).toMatch(/nodeVarNames:\s*Object\.create\(null\)/);
    // The builder that replaces it a tick later.
    expect(sync).toMatch(/Object\.create\(null\)/);
  });
});
