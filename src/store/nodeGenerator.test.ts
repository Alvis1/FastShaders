/**
 * The "Generate nodes from text" opt-in (`fs:nodeGenerator`) as the STORE
 * holds it — the allowManyMaterials.test.ts pattern: a localStorage stub per
 * test, undone in afterAll, the store's own setter. The leaf's reading rules
 * (exact '1', when it is offered) are utils/generatorFlag.test.ts.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { useAppStore } from './useAppStore';
import { GENERATOR_FLAG_KEY } from '@/utils/generatorFlag';

afterAll(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ nodeGenerator: false });
});

describe('nodeGenerator — the opt-in in the store', () => {
  let ls: Map<string, string>;
  beforeEach(() => {
    ls = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => { ls.set(k, String(v)); },
      removeItem: (k: string) => { ls.delete(k); },
    });
    useAppStore.setState({ nodeGenerator: false });
  });

  it('defaults to OFF (nothing stored under node: the boot read finds no "1")', () => {
    expect(useAppStore.getState().nodeGenerator).toBe(false);
  });

  it('persists both ways under fs:nodeGenerator', () => {
    useAppStore.getState().setNodeGenerator(true);
    expect(useAppStore.getState().nodeGenerator).toBe(true);
    expect(ls.get(GENERATOR_FLAG_KEY)).toBe('1');
    useAppStore.getState().setNodeGenerator(false);
    expect(useAppStore.getState().nodeGenerator).toBe(false);
    expect(ls.get(GENERATOR_FLAG_KEY)).toBe('0');
  });

  it('survives storage being unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(() => useAppStore.getState().setNodeGenerator(true)).not.toThrow();
    expect(useAppStore.getState().nodeGenerator).toBe(true);
    useAppStore.getState().setNodeGenerator(false);
    expect(useAppStore.getState().nodeGenerator).toBe(false);
  });

  it('the boot read goes through the leaf, never a coercing read', () => {
    const src = readFileSync('src/store/useAppStore.ts', 'utf8');
    expect(src).toContain('nodeGenerator: generatorEnabledFrom(loadString(GENERATOR_FLAG_KEY, \'0\')),');
  });
});
