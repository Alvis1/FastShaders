/**
 * The built-in libraries' layouts are measured in the selected device's
 * pricing (cards scale with their price as a share of the budget), so their
 * cache is keyed on it (codeGroupBuilder `layoutPricingKey`): a device change
 * rebuilds them once, and an unchanged device never does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getBuiltinPresets } from './builtinPresets';
import { getBuiltinTextures } from './builtinTextures';
import { layoutPricingKey } from './codeGroupBuilder';
import { setCostOverrides, costOverridesKey } from '@/utils/costTable';
import { setDeviceBudget } from '@/utils/budgetPoints';
import { VR_HEADSETS } from '@/registry/vrHeadsets';

afterEach(() => {
  setCostOverrides(null);
  setDeviceBudget(VR_HEADSETS[0].maxPoints);
});

describe('the built-in libraries follow the selected device\'s pricing', () => {
  it('keeps one build while the pricing holds, even across re-applying the same table', () => {
    const presets = getBuiltinPresets();
    const textures = getBuiltinTextures();
    setCostOverrides(null);                 // a re-selection of the same device
    setDeviceBudget(VR_HEADSETS[0].maxPoints);
    expect(getBuiltinPresets()).toBe(presets);
    expect(getBuiltinTextures()).toBe(textures);
  });

  it('rebuilds after the prices or the budget move, and the key says which', () => {
    const before = getBuiltinTextures();
    const key = layoutPricingKey();
    setCostOverrides({ voronoi: 174, perlin: 25 });
    expect(costOverridesKey()).toBe('perlin:25,voronoi:174');   // order-free
    expect(layoutPricingKey()).not.toBe(key);
    const repriced = getBuiltinTextures();
    expect(repriced).not.toBe(before);
    setCostOverrides(null);
    setDeviceBudget(100);
    expect(getBuiltinTextures()).not.toBe(repriced);
    setDeviceBudget(VR_HEADSETS[0].maxPoints);
    expect(layoutPricingKey()).toBe(key);
  });
});
