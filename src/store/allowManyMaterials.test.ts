/**
 * The GLB import's material-gate override (`fs:allowManyMaterials`, GLB Phase
 * 5 Step 9) — the trackpadScroll.test.ts pattern: a localStorage stub per
 * test, undone in afterAll, the store's own setter.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { useAppStore } from './useAppStore';
import { ALLOW_MANY_MATERIALS_KEY, allowManyMaterialsFrom } from '@/utils/glbImportLimits';

afterAll(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ allowManyMaterials: false });
});

describe('allowManyMaterials — the N11 override', () => {
  let ls: Map<string, string>;
  beforeEach(() => {
    ls = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => { ls.set(k, String(v)); },
      removeItem: (k: string) => { ls.delete(k); },
    });
    useAppStore.setState({ allowManyMaterials: false });
  });

  it('defaults to OFF', () => {
    expect(useAppStore.getState().allowManyMaterials).toBe(false);
    expect(ALLOW_MANY_MATERIALS_KEY).toBe('fs:allowManyMaterials');
  });

  it('persists both ways under fs:allowManyMaterials', () => {
    useAppStore.getState().setAllowManyMaterials(true);
    expect(useAppStore.getState().allowManyMaterials).toBe(true);
    expect(ls.get('fs:allowManyMaterials')).toBe('1');
    useAppStore.getState().setAllowManyMaterials(false);
    expect(useAppStore.getState().allowManyMaterials).toBe(false);
    expect(ls.get('fs:allowManyMaterials')).toBe('0');
  });

  it('survives storage being unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(() => useAppStore.getState().setAllowManyMaterials(true)).not.toThrow();
    expect(useAppStore.getState().allowManyMaterials).toBe(true);
    useAppStore.getState().setAllowManyMaterials(false);
  });

  it('the stored value is validated, never coerced: only the exact "1" is on', () => {
    expect(allowManyMaterialsFrom('1')).toBe(true);
    for (const junk of ['true', ' 1', '1 ', '01', 'yes', '0', '', null, undefined, 1, true]) {
      expect(allowManyMaterialsFrom(junk), String(junk)).toBe(false);
    }
  });
});
