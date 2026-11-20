/**
 * The "Generate nodes from text" switch (`fs:nodeGenerator`) as the STORE
 * holds it — the allowManyMaterials.test.ts pattern: a localStorage stub per
 * test, undone in afterAll, the store's own setter — and the session-only
 * request that opens the dialog. The leaf's reading rules (three states, when
 * it is offered) are utils/generatorFlag.test.ts.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { useAppStore } from './useAppStore';
import { GENERATOR_FLAG_KEY } from '@/utils/generatorFlag';
import { HISTORY_IDLE } from '@/test-utils';

const RESET = { nodeGenerator: 'suggest', generatorRequest: null, generatorRouteReady: false, ...HISTORY_IDLE } as const;

afterAll(() => {
  vi.unstubAllGlobals();
  useAppStore.setState(RESET);
});

describe('nodeGenerator — the switch in the store', () => {
  let ls: Map<string, string>;
  beforeEach(() => {
    ls = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => { ls.set(k, String(v)); },
      removeItem: (k: string) => { ls.delete(k); },
    });
    useAppStore.setState(RESET);
  });

  it('defaults to SUGGEST (nothing stored under node: the boot read finds neither "1" nor "0")', () => {
    expect(useAppStore.getState().nodeGenerator).toBe('suggest');
  });

  it('persists both ways under fs:nodeGenerator', () => {
    useAppStore.getState().setNodeGenerator('on');
    expect(useAppStore.getState().nodeGenerator).toBe('on');
    expect(ls.get(GENERATOR_FLAG_KEY)).toBe('1');
    useAppStore.getState().setNodeGenerator('off');
    expect(useAppStore.getState().nodeGenerator).toBe('off');
    expect(ls.get(GENERATOR_FLAG_KEY)).toBe('0');
  });

  it('survives storage being unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(() => useAppStore.getState().setNodeGenerator('on')).not.toThrow();
    expect(useAppStore.getState().nodeGenerator).toBe('on');
    useAppStore.getState().setNodeGenerator('off');
    expect(useAppStore.getState().nodeGenerator).toBe('off');
  });

  it('the boot read goes through the leaf, never a coercing read', () => {
    const src = readFileSync('src/store/useAppStore.ts', 'utf8');
    expect(src).toContain('nodeGenerator: generatorModeFrom(loadString(GENERATOR_FLAG_KEY, \'\')),');
  });
});

describe('openGenerator — the one way into the dialog', () => {
  beforeEach(() => useAppStore.setState(RESET));

  it('opens empty, and closes', () => {
    useAppStore.getState().openGenerator();
    expect(useAppStore.getState().generatorRequest).toEqual({ prompt: '' });
    useAppStore.getState().closeGenerator();
    expect(useAppStore.getState().generatorRequest).toBeNull();
  });

  it('keeps the query, a finite canvas point and an explicit autostart — nothing else', () => {
    useAppStore.getState().openGenerator({ prompt: 'glowing lava', at: { x: 10, y: -4 }, autostart: true });
    expect(useAppStore.getState().generatorRequest).toEqual({ prompt: 'glowing lava', at: { x: 10, y: -4 }, autostart: true });
    useAppStore.getState().openGenerator({ prompt: 'x', at: { x: NaN, y: 0 } });
    expect(useAppStore.getState().generatorRequest).toEqual({ prompt: 'x' });
    useAppStore.getState().openGenerator({ prompt: 5 as unknown as string, autostart: 'yes' as unknown as boolean });
    expect(useAppStore.getState().generatorRequest).toEqual({ prompt: '' });
  });

  it('opening it is not an edit: no history entry, no storage', () => {
    const before = useAppStore.getState().past;
    useAppStore.getState().openGenerator({ prompt: 'x' });
    useAppStore.getState().setGeneratorRouteReady(true);
    expect(useAppStore.getState().past).toBe(before);
    expect(useAppStore.getState().generatorRouteReady).toBe(true);
  });
});
