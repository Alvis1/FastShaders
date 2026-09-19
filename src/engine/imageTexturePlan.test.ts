import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createImageTexturePlanner,
  imageTextureSetupLines,
  imageTextureSpecKey,
  readImageTextureSpec,
  type ImageTextureSpec,
} from './imageTexturePlan';
import * as specModule from '@/utils/imageTextureSpec';

const PLAN_SRC = readFileSync(new URL('./imageTexturePlan.ts', import.meta.url), 'utf8');
const CODEGEN = readFileSync(new URL('./graphToCode.ts', import.meta.url), 'utf8');

const A = 'data:image/webp;base64,' + btoa('abc');
const base: Record<string, string | number> = { imageB64: A, width: 2, height: 2, fileName: 'x.webp' };
const v = (extra: Record<string, string | number> = {}) => ({ ...base, ...extra });

describe('createImageTexturePlanner: who shares', () => {
  it('groups on the exact decoded payload, whatever the stored dimensions say', () => {
    const p = createImageTexturePlanner();
    p.place('a', v());
    const b = p.place('b', v({ width: 4, height: 4 }))!;
    expect(b.textureOwner).toBe('a');
    expect(b.ownsTexture).toBe(false);
    expect(p.textureCount).toBe(1);
  });

  it('does not share the same bytes under a different declared MIME', () => {
    const p = createImageTexturePlanner();
    p.place('a', v());
    const b = p.place('b', v({ imageB64: 'data:image/png;base64,' + btoa('abc') }))!;
    expect(b.textureOwner).toBe('b');
    expect(p.textureCount).toBe(2);
  });

  it('shares across every uv-expression setting', () => {
    const p = createImageTexturePlanner();
    p.place('a', v());
    const b = p.place('b', v({ tileX: 2, tileY: 3, offsetX: 0.5, offsetY: 0.25, flipX: 1, flipY: 1, uv: 1 }))!;
    expect(b.textureOwner).toBe('a');
    expect(b.imageOwner).toBe('a');
  });

  it('splits on every texture-object setting', () => {
    const splits: Record<string, string | number>[] = [{ colorSpace: 'data' }, { filter: 'nearest' }, { repeat: 0 }];
    for (const extra of splits) {
      const p = createImageTexturePlanner();
      p.place('a', v());
      const b = p.place('b', v(extra))!;
      expect(b.textureOwner, JSON.stringify(extra)).toBe('b');
      expect(b.ownsTexture).toBe(true);
    }
  });

  it('records nothing for an undecodable payload, so a later valid node owns', () => {
    const p = createImageTexturePlanner();
    expect(p.place('bad', v({ imageB64: '' }))).toBeNull();
    expect(p.get('bad')).toBeUndefined();
    expect(p.textureCount).toBe(0);
    expect(p.place('good', v())!.textureOwner).toBe('good');
  });

  it('is idempotent per id', () => {
    const p = createImageTexturePlanner();
    const first = p.place('a', v());
    expect(p.place('a', v())).toBe(first);
    expect(p.get('a')).toBe(first);
    expect(p.textureCount).toBe(1);
  });

  it('makes the first node placed the owner, and counts distinct objects', () => {
    const p = createImageTexturePlanner();
    expect(p.place('a', v())!.ownsTexture).toBe(true);
    expect(p.place('b', v())!.textureOwner).toBe('a');
    expect(p.place('c', v({ colorSpace: 'data' }))!.textureOwner).toBe('c');
    expect(p.place('d', v({ imageB64: 'data:image/png;base64,' + btoa('xyz') }))!.textureOwner).toBe('d');
    expect(p.textureCount).toBe(3);
    // a, b and c hold one picture, d another: two Image elements.
    expect(p.imageCount).toBe(2);
  });

  it('keys the Image element by the payload alone: one per distinct payload', () => {
    const p = createImageTexturePlanner();
    p.place('a', v());
    const b = p.place('b', v())!;
    const d = p.place('d', v({ imageB64: 'data:image/png;base64,' + btoa('xyz') }))!;
    expect(b.imageOwner).toBe('a');
    expect(b.ownsImage).toBe(false);
    expect(d.imageOwner).toBe('d');
    expect(d.ownsImage).toBe(true);
  });

  it('shares the Image element across every texture-object setting, never the texture', () => {
    const splits: Record<string, string | number>[] = [{ colorSpace: 'data' }, { filter: 'nearest' }, { repeat: 0 }];
    for (const extra of splits) {
      const p = createImageTexturePlanner();
      p.place('a', v());
      const b = p.place('b', v(extra))!;
      expect(b.imageOwner, JSON.stringify(extra)).toBe('a');
      expect(b.ownsImage).toBe(false);
      expect(b.textureOwner).toBe('b');
      expect(b.ownsTexture).toBe(true);
      expect(p.imageCount).toBe(1);
      expect(p.textureCount).toBe(2);
    }
  });

  it('keeps the first node placed as the image owner, whichever texture a later node joins', () => {
    const p = createImageTexturePlanner();
    p.place('a', v({ colorSpace: 'data' }));
    const b = p.place('b', v())!;
    const c = p.place('c', v())!;
    expect(c.textureOwner).toBe('b');
    expect(c.imageOwner).toBe('a');
    expect(b.imageOwner).toBe('a');
  });

  it('treats prototype-named node ids as plain ids', () => {
    const p = createImageTexturePlanner();
    p.place('__proto__', v());
    expect(p.place('constructor', v())!.textureOwner).toBe('__proto__');
    expect(p.get('__proto__')!.ownsTexture).toBe(true);
    expect(p.get('toString')).toBeUndefined();
  });
});

describe('the texture spec the planner keys on', () => {
  it('is the ONE normaliser, re-exported', () => {
    expect(readImageTextureSpec).toBe(specModule.readImageTextureSpec);
    expect(imageTextureSpecKey).toBe(specModule.imageTextureSpecKey);
  });

  it('reproduces the historical reads on junk', () => {
    const rep = (x: unknown) => readImageTextureSpec(x === 'ABSENT' ? {} : { repeat: x }).repeat;
    expect(rep('ABSENT')).toBe(true);
    expect(rep('1')).toBe(true);
    for (const x of [null, '', 0]) expect(rep(x)).toBe(false);
    expect(readImageTextureSpec({ colorSpace: 'data' }).colorSpace).toBe('data');
    for (const x of ['DATA', 'Data', ' data', 1]) expect(readImageTextureSpec({ colorSpace: x }).colorSpace).toBe('color');
    expect(readImageTextureSpec({ filter: 'nearest' }).nearest).toBe(true);
    for (const x of ['Nearest', 'NEAREST', true]) expect(readImageTextureSpec({ filter: x }).nearest).toBe(false);
  });
});

describe('imageTextureSetupLines', () => {
  const specs: ImageTextureSpec[] = [];
  for (const colorSpace of ['color', 'data'] as const) {
    for (const nearest of [false, true]) {
      for (const repeat of [false, true]) specs.push({ colorSpace, nearest, repeat, flipY: true });
    }
  }
  const text = (s: ImageTextureSpec) => imageTextureSetupLines('_t', '_i', '_o', s).join('\n');

  it('is injective over spec keys', () => {
    expect(new Set(specs.map(text)).size).toBe(specs.length);
  });

  it('gives equal lines for equal keys', () => {
    for (const s of specs) expect(text({ ...s })).toBe(text(s));
    const fromValues = readImageTextureSpec({ tileX: 4, flipY: 1, colorSpace: 'color' });
    expect(text(fromValues)).toBe(text(readImageTextureSpec({})));
  });
});

describe('every image texture goes through the planner', () => {
  it('graphToCode builds no Texture and decodes no image itself', () => {
    expect(CODEGEN).not.toContain('new globalThis.THREE.Texture(');
    expect(CODEGEN).not.toContain('imageAssetFor(');
    expect(CODEGEN).toContain('imagePlanner.place(node.id, nv)');
  });

  it('the Environment channel reads the placement, not a second decode', () => {
    expect(CODEGEN).toMatch(/imagePlanner\.get\(envSrc\.id\)/);
  });

  it('a node planned into several march scopes emits its setup once', () => {
    expect(CODEGEN).toMatch(/if \(!imageSetupEmitted\.has\(node\.id\)\)/);
  });

  it('the planner imports no store module', () => {
    // A literal pin only. It still reaches the store transitively (imageAssets
    // -> feedbackReport -> edgeUtils -> store); what keeps that harmless is the
    // costTable rule: nothing here evaluates across the cycle at module scope.
    expect(PLAN_SRC).not.toMatch(/from '@\/store\//);
  });
});

describe('the glTF orientation in the planner', () => {
  it('splits a texture, but not the element', () => {
    const p = createImageTexturePlanner();
    p.place('a', v());
    const b = p.place('b', v({ orientation: 'gltf' }))!;
    expect(b.textureOwner).toBe('b');
    expect(b.imageOwner).toBe('a');
    expect(b.spec.flipY).toBe(false);
    expect(p.textureCount).toBe(2);
    expect(p.imageCount).toBe(1);
  });

  it('shares across the UV set, the transform and the green flip', () => {
    const p = createImageTexturePlanner();
    p.place('a', v());
    const b = p.place('b', v({ uvSet: 2, normalGreen: 'flip', xfScaleX: 2, xfRotation: 1, xfOffsetY: 0.5 }))!;
    expect(b.textureOwner).toBe('a');
  });

  it('writes flipY = false from the spec alone', () => {
    const lines = imageTextureSetupLines('t', 'i', 'o', { colorSpace: 'color', nearest: false, repeat: true, flipY: false });
    expect(lines).toContain('t.flipY = false;');
    expect(imageTextureSetupLines('t', 'i', 'o', readImageTextureSpec({}))).toContain('t.flipY = true;');
  });
});
