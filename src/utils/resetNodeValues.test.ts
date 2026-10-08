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
    // A custom formula is a SETTING, not payload, so Reset drops it and the node
    // returns to its method's own chain — which is exactly the emitter's
    // documented fallback for an absent key. It is deliberately NOT in
    // PRESERVED_KEYS: unlike the noise `signed` flag, dropping it restores a
    // real default rather than changing what the node outputs. Undo brings it
    // back.
    expect(
      resetNodeValues(def('dataRange'), { mode: 'symlog', domainMin: -3, formula: 'v * 2' }),
    ).toEqual({});
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
      width: 1024,
      height: 512,
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
    // Payload METADATA, not settings: without them decodeImageNode returns
    // null (the image renders black) and the size-aware price falls back to
    // the flat table value — both silently, from one right-click.
    expect(out.width).toBe(1024);
    expect(out.height).toBe(512);
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

describe('resetNodeValues — a Splat Output\'s React to light is its mode, not a setting', () => {
  // Dropping `lit` switched the light off while any wired Light socket stayed:
  // a dead row on an unlit node, whose wire the next Apply deleted silently.
  // Switching the light off is setSplatLit's job (it takes the wires too).
  it('keeps replaceColor: true too — Reset restores numbers, it never flips paint back into tint', () => {
    const out = resetNodeValues(def('splatOutput'), { replaceColor: true, color: '#ff0000', opacity: 0.3 } as unknown as Record<string, string | number>);
    expect(out.replaceColor).toBe(true);
    expect(out).not.toHaveProperty('color');
  });

  it('keeps lit: true and resets the light\'s numbers and colours', () => {
    // `values` is typed string | number, but node data really holds these
    // booleans (getNodeValues keeps them) — which is what Reset receives.
    const out = resetNodeValues(def('splatOutput'), { lit: true, lightX: -2, lightColor: '#ff0000', opacity: 0.3, invert: true } as unknown as Record<string, string | number>);
    expect(out.lit).toBe(true);
    expect(out.lightX).toBe(0.6);
    expect(out).not.toHaveProperty('lightColor');
    expect(out.opacity).toBe(1);
  });

  it('a lit node at its default light is at defaults — Reset is not offered for the mode alone', () => {
    expect(isAtDefaultValues(def('splatOutput'), { opacity: 1, feather: 0, size: 1, lightX: 0.6, lightY: 0.8, lightZ: 0.5, lit: true } as unknown as Record<string, string | number>)).toBe(true);
  });
});

describe('resetNodeValues — an Image node keeps the facts about its picture, never its placement', () => {
  // Row order, UV set and the normal-map green flip describe how the picture
  // meets the model it came with, and only that file says what they were. The
  // placement — Tile, Offset, the turn, the Flips, a legacy `xf*` transform —
  // is a setting like any other, an imported texture's included (owner to
  // confirm), and Undo restores it.
  const PIC = 'data:image/webp;base64,AAAA';
  const facts: Record<string, string | number> = { orientation: 'gltf', normalGreen: 'flip', uvSet: 2 };

  it('keeps the three facts while every placement and sampling setting resets', () => {
    const out = resetNodeValues(def('imageNode'), {
      imageB64: PIC, width: 4, height: 4, ...facts,
      tileX: 3, tileY: 2, offsetX: 0.25, offsetY: -0.5, rotation: 0.4, flipX: 1, flipY: 1,
      xfOffsetX: 0.25, xfOffsetY: -0.5, xfRotation: 0.3, xfScaleX: 2, xfScaleY: 3,
      filter: 'nearest', colorSpace: 'data', repeat: 0,
    });
    expect(out).toEqual({ imageB64: PIC, width: 4, height: 4, ...facts, tileX: 1, tileY: 1, offsetX: 0, offsetY: 0 });
  });

  it('of the keys imageUvMapping defines, preserves exactly the three facts', async () => {
    const { UV_MAPPING_KEYS } = await import('./imageUvMapping');
    const kept = UV_MAPPING_KEYS.filter((k) => resetNodeValues(def('imageNode'), { [k]: 'x' })[k] === 'x');
    expect([...kept].sort()).toEqual(Object.keys(facts).sort());
    // The turn and the five legacy keys are placement: a Reset drops them.
    for (const k of UV_MAPPING_KEYS.filter((key) => !kept.includes(key))) {
      expect(resetNodeValues(def('imageNode'), { [k]: 0.5 }), k).not.toHaveProperty(k);
    }
  });

  it('an imported texture\'s placement resets too: it is plain Tile, Offset and Rotation', async () => {
    const { gltfTextureValues } = await import('./imageUvMapping');
    const imported = gltfTextureValues(
      { extensions: { KHR_texture_transform: { offset: [0.1, 0.2], rotation: Math.PI / 6, scale: [2, 1] } } },
      { normalGreenFlip: true },
    ).values;
    const node = { imageB64: PIC, width: 4, height: 4, ...imported };
    expect(isAtDefaultValues(def('imageNode'), node)).toBe(false);
    expect(resetNodeValues(def('imageNode'), node)).toEqual({
      imageB64: PIC, width: 4, height: 4, orientation: 'gltf', normalGreen: 'flip',
      tileX: 1, tileY: 1, offsetX: 0, offsetY: 0,
    });
  });

  it('a node carrying the facts and nothing else is not dirty; a turn or a legacy transform is', () => {
    const atDefault = { ...resetNodeValues(def('imageNode'), {}), ...facts };
    expect(isAtDefaultValues(def('imageNode'), atDefault)).toBe(true);
    expect(isAtDefaultValues(def('imageNode'), { ...atDefault, rotation: 0.5 })).toBe(false);
    expect(isAtDefaultValues(def('imageNode'), { ...atDefault, xfScaleX: 2 })).toBe(false);
  });
});
