import { describe, it, expect } from 'vitest';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { resetNodeValues, isAtDefaultValues, hasResettableValues } from './resetNodeValues';
import { makeDataNodeData } from './dataNode';

const def = (type: string) => NODE_REGISTRY.get(type)!;

describe('resetNodeValues', () => {
  it('restores the registry defaults', () => {
    expect(resetNodeValues(def('slider'), { value: 0.9, min: -5, max: 20 })).toEqual({
      value: 0.5,
      min: 0.0,
      max: 1.0,
    });
  });

  it('drops keys the registry does not declare', () => {
    // The dataviz family stores settings ONLY in `values` and relies on
    // code-gen fallbacks, so removing the key IS the reset.
    expect(resetNodeValues(def('colormap'), { map: 'turbo', reverse: 1, levels: 8 })).toEqual({});
    expect(resetNodeValues(def('dataRange'), { mode: 'symlog', domainMin: -3 })).toEqual({});
    expect(resetNodeValues(def('dataviz'), { radial: 1, midpoint: 0.2, lowColor: '#123456' })).toEqual(
      def('dataviz').defaultValues,
    );
  });

  it('keeps a property node\'s uniform NAME', () => {
    // The name is in the generated code, the exported schema and the
    // name-keyed persisted uniform values. Resetting it detaches all three and
    // can collide with another property already called `property1`.
    const out = resetNodeValues(def('property_float'), { value: 7, name: 'radius' });
    expect(out.name).toBe('radius');
    expect(out.value).toBe(1.0);
  });

  it('keeps a Data node\'s CSV payload while resetting nothing else away', () => {
    const values = makeDataNodeData(
      { columnNames: ['a', 'b'], columns: [[1, 2], [3, 4]], rowCount: 2 },
      2,
      'measurements.csv',
    ).values;
    const out = resetNodeValues(def('dataNode'), values);
    for (const key of ['columnNames', 'rowCount', 'columnCount', 'dataB64', 'fileName']) {
      expect(out[key], key).toEqual(values[key]);
    }
  });

  it('keeps an Image node\'s picture but resets its UV settings', () => {
    const out = resetNodeValues(def('imageNode'), {
      imageB64: 'data:image/webp;base64,AAAA',
      fileName: 'map.png',
      originId: 'abc123',
      srcWidth: 1920,
      srcHeight: 1080,
      tileX: 4,
      offsetY: 0.5,
      repeat: 0,
      colorSpace: 'data',
      flipX: 1,
    });
    expect(out.imageB64).toBe('data:image/webp;base64,AAAA');
    expect(out.originId).toBe('abc123');
    expect(out.srcWidth).toBe(1920);
    expect(out.tileX).toBe(1);
    expect(out.offsetY).toBe(0);
    // Settings with no registry entry go away so code-gen's own default wins.
    expect(out.repeat).toBeUndefined();
    expect(out.colorSpace).toBeUndefined();
    expect(out.flipX).toBeUndefined();
  });

  it('keeps an Unknown node\'s captured expression', () => {
    const out = resetNodeValues(def('unknown'), {
      functionName: 'mystery',
      rawExpression: 'mystery(uv(), 2.0)',
    });
    expect(out).toEqual({ functionName: 'mystery', rawExpression: 'mystery(uv(), 2.0)' });
  });

  it('is idempotent', () => {
    const once = resetNodeValues(def('slider'), { value: 9 });
    expect(resetNodeValues(def('slider'), once)).toEqual(once);
  });

  it('produces a fresh object rather than mutating the node\'s values', () => {
    const current = { value: 9 };
    const out = resetNodeValues(def('slider'), current);
    expect(out).not.toBe(current);
    expect(current).toEqual({ value: 9 });
  });
});

describe('isAtDefaultValues', () => {
  it('is true for values equal to the defaults', () => {
    expect(isAtDefaultValues(def('slider'), { value: 0.5, min: 0, max: 1 })).toBe(true);
  });

  it('compares loosely across number/string storage', () => {
    // The registry declares 1.0; a menu edit or an imported project may store
    // "1". A strict compare would leave the button enabled forever with
    // nothing to do.
    expect(isAtDefaultValues(def('property_float'), { value: '1', name: 'property1' })).toBe(true);
  });

  it('is false when any setting differs, including an undeclared extra', () => {
    expect(isAtDefaultValues(def('slider'), { value: 0.5, min: 0, max: 2 })).toBe(false);
    expect(isAtDefaultValues(def('colormap'), { map: 'turbo' })).toBe(false);
    expect(isAtDefaultValues(def('colormap'), {})).toBe(true);
  });

  it('ignores preserved payload and identity', () => {
    // A renamed property or a loaded CSV must not read as "modified" — a reset
    // would not change them, so offering one would be a lie.
    expect(isAtDefaultValues(def('property_float'), { value: 1.0, name: 'radius' })).toBe(true);
    expect(
      isAtDefaultValues(def('imageNode'), {
        imageB64: 'data:image/webp;base64,AAAA',
        tileX: 1,
        tileY: 1,
        offsetX: 0,
        offsetY: 0,
      }),
    ).toBe(true);
  });
});

describe('hasResettableValues', () => {
  it('is false for nodes that carry no settings at all', () => {
    for (const type of ['add', 'positionGeometry', 'normalize', 'output']) {
      expect(hasResettableValues(def(type), {}), type).toBe(false);
    }
  });

  it('is true for any node the registry gives defaults to', () => {
    // `uv` counts: its tiling/rotation are registry defaultValues.
    for (const type of ['slider', 'float', 'color', 'property_float', 'isolines', 'stripes', 'uv']) {
      expect(hasResettableValues(def(type), {}), type).toBe(true);
    }
  });

  it('is true for a values-only node once it holds a setting, false while bare', () => {
    // Colormap and Data Range declare no defaultValues — everything lives in
    // `values` — so the action appears exactly when there is something to undo.
    expect(hasResettableValues(def('colormap'), {})).toBe(false);
    expect(hasResettableValues(def('colormap'), { map: 'vik' })).toBe(true);
  });

  it('does not count preserved payload as a resettable setting', () => {
    // An untouched Unknown node holds only its captured expression; offering a
    // reset there would promise something the action cannot do.
    expect(
      hasResettableValues(def('unknown'), { functionName: 'x', rawExpression: 'x()' }),
    ).toBe(false);
  });

  it('is false for a missing definition', () => {
    expect(hasResettableValues(undefined, { value: 1 })).toBe(false);
  });
});

describe('resetNodeValues — the noise range flag is payload, not a setting', () => {
  // Dropping this key does not restore a neutral default: an ABSENT key means
  // the legacy signed range, so a reset would silently turn a 0-1 node back
  // into a -1…1 one and change the picture.
  it('preserves signed:0 across a reset', () => {
    const out = resetNodeValues(def('perlin'), { pos: 'positionGeometry', scale: 4, signed: 0 });
    expect(out.signed).toBe(0);
    // …while still resetting the actual settings.
    expect(out.scale).toBe(1);
  });

  it('does not report a legacy noise node as dirty', () => {
    // A false dirty flag here would light the destructive Reset row on every
    // noise member of every built-in preset and texture.
    expect(isAtDefaultValues(def('perlin'), { pos: 'positionGeometry', scale: 1 })).toBe(true);
  });
});
