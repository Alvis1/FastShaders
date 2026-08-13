import { describe, it, expect } from 'vitest';
import { collectShaderProperties } from './exportShader';
import { makeNode } from '@/test-utils';

/**
 * `collectShaderProperties` is the ONE property-list implementation: the
 * Download-Shader bundle and the code panel's Output tab both read it (the tab
 * used to hold a byte-for-byte hand copy, which was a live drift site — the tab
 * could have started describing a file the user never gets). These pin the four
 * fallbacks and the ordering both surfaces now inherit from it.
 */
describe('collectShaderProperties', () => {
  it('applies the documented fallbacks for empty values (shared by the Output tab and the download)', () => {
    const nodes = [
      makeNode('p1', 'property_float'),
      makeNode('c1', 'property_color'),
      makeNode('f1', 'float', { value: 2 }), // not a property node — ignored
    ];
    expect(collectShaderProperties(nodes)).toEqual([
      { name: 'property1', type: 'float', defaultValue: 1 },
      { name: 'color1', type: 'color', defaultValue: '#ff0000' },
    ]);
  });

  it('keeps nodes-array order', () => {
    // Order is load-bearing downstream: buildShaderModule's duplicate-name
    // disambiguation and buildHeader's dedupe both walk this list in order, so
    // two same-named properties resolve by position.
    const nodes = [
      makeNode('c1', 'property_color', { name: 'tint', hex: '#00ff00' }),
      makeNode('p1', 'property_float', { name: 'speed', value: 0.25 }),
    ];
    expect(collectShaderProperties(nodes).map((p) => p.name)).toEqual(['tint', 'speed']);
  });
});
