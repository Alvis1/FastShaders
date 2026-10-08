import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readImagePlacement } from '@/utils/imagePlacement';
import { valueNum } from '@/utils/valueCoerce';

const SHADER_NODE = readFileSync(new URL('./ShaderNode.tsx', import.meta.url), 'utf8');
const SHADER_CSS = readFileSync(new URL('./ShaderNode.css', import.meta.url), 'utf8');
const NODE_VISUAL = readFileSync(new URL('./NodeVisual.tsx', import.meta.url), 'utf8');
const GRAPH_TO_CODE = readFileSync(new URL('../../../engine/graphToCode.ts', import.meta.url), 'utf8');
const PLACEMENT = readFileSync(new URL('../../../utils/imagePlacement.ts', import.meta.url), 'utf8');
const TEXTURE_SPEC = readFileSync(new URL('../../../utils/imageTextureSpec.ts', import.meta.url), 'utf8');
const IMAGE_PLAN = readFileSync(new URL('../../../engine/imageTexturePlan.ts', import.meta.url), 'utf8');

describe('the Image node card shows its flips', () => {
  it('mirrors the thumbnail per axis', () => {
    // A checkbox in a menu you have to close before you can see its effect is
    // a guess; the card is where the picture is.
    expect(SHADER_NODE).toMatch(/flipThumbX = valueNum\(data\.values\?\.flipX \?\? 0\) >= 0\.5/);
    expect(SHADER_NODE).toMatch(/flipThumbY = valueNum\(data\.values\?\.flipY \?\? 0\) >= 0\.5/);
    expect(SHADER_NODE).toMatch(/transform: `scale\(\$\{flipThumbX \? -1 : 1\}, \$\{flipThumbY \? -1 : 1\}\)`/);
  });

  it('reads the flags the way CODEGEN reads them', () => {
    // The sign convention was the trap. Until 2026-10-08 graphToCode baked a
    // 1-u "correction" in while flipX was UNCHECKED (`mirrorX = flipX < 0.5`
    // under the app orientation), which read MIRRORED on three's primitives —
    // and an unticked card next to a mirrored mesh. Now each ticked box
    // mirrors its axis in BOTH orientations and nothing else mirrors, so the
    // card and codegen use one rule: the same >= 0.5 threshold on both axes.
    // Codegen takes the flags from the ONE placement reader, which the
    // restore fold shares.
    expect(GRAPH_TO_CODE).toMatch(/const placement = readImagePlacement\(nv\);/);
    expect(GRAPH_TO_CODE).toMatch(/const \{ mirrorX, mirrorY \} = placement;/);
    expect(PLACEMENT).toMatch(/const flipX = stored\(values, 'flipX', 0\) >= 0\.5;/);
    expect(PLACEMENT).toMatch(/const flipY = stored\(values, 'flipY', 0\) >= 0\.5;/);
    expect(PLACEMENT).toMatch(/mirrorX: flipX,/);
    expect(PLACEMENT).toMatch(/mirrorY: flipY,/);
    // The baked default may not come back in any spelling.
    expect(PLACEMENT).not.toMatch(/mirrorX: [^,]*!flipX/);
    expect(PLACEMENT).not.toMatch(/mirrorX: gltf/);
  });

  it('mirrors exactly what the shader mirrors, in BOTH orientations', () => {
    // The card's own read (source-pinned above) against codegen's reader, over
    // every finite value a file may store — a non-finite one is the documented
    // junk case (docs/dev/images-and-textures.md), where the reader falls back
    // to the default.
    const card = (v: unknown) => valueNum(v ?? 0) >= 0.5;
    const values: unknown[] = [0, 1, 0.49, 0.5, 2, -1, '1', '0', '', ' 1 ', true, false, null, undefined];
    for (const orientation of [undefined, 'gltf']) {
      for (const fx of values) {
        for (const fy of values) {
          const v = { ...(orientation ? { orientation } : {}), flipX: fx, flipY: fy } as Record<string, unknown>;
          const p = readImagePlacement(v);
          expect([p.mirrorX, p.mirrorY], JSON.stringify(v)).toEqual([card(fx), card(fy)]);
        }
      }
    }
    // An untouched node: an unmirrored card over an unmirrored sample.
    expect(readImagePlacement({})).toMatchObject({ mirrorX: false, mirrorY: false });
  });
});

describe('the Image node card shows Nearest filtering', () => {
  it('draws the thumbnail pixelated exactly when codegen samples nearest', () => {
    // Otherwise the browser smooths a small stored image (an 8 px rung) into
    // a blur the shader never draws. Both sides read the same exact string;
    // codegen places each image through the texture planner, which reads it
    // through the ONE texture-spec normaliser.
    expect(SHADER_NODE).toMatch(/const nearestThumb = data\.values\?\.filter === 'nearest';/);
    expect(SHADER_NODE).toMatch(/nearestThumb \? \{ imageRendering: 'pixelated' as const \}/);
    expect(GRAPH_TO_CODE).toMatch(/imagePlanner\.place\(node\.id, nv\)/);
    expect(IMAGE_PLAN).toMatch(/const spec = readImageTextureSpec\(values\);/);
    expect(IMAGE_PLAN).toMatch(/const nearest = spec\.nearest;/);
    expect(TEXTURE_SPEC).toMatch(/const nearest = values\.filter === 'nearest';/);
  });
});

describe('the source filename follows the card into dark mode', () => {
  it('is node INK, not a literal grey', () => {
    // It was `#555555`, correct while a node body was always light and
    // measured at 1.82:1 once `--node-bg` learned to flip — invisible.
    const css = SHADER_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = /\.shader-node__file-name \{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/color: rgba\(var\(--node-ink-rgb\), 0\.7\)/);
    expect(block![1]).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

describe('the empty image slot', () => {
  it('is drawn by the canvas whenever the node has no valid payload', () => {
    // A node added empty from the palette, or one whose payload a restore path
    // stripped. The `else` of the thumbnail, never a restructure of the <img>
    // itself — the flip and filter pins above read that element's JSX. Both
    // live INSIDE the port region since 2026-09-19 (nodes/edgePorts.ts): the
    // sockets are centred on that region, so the picture is in it.
    expect(SHADER_NODE).toMatch(/\{imageThumbUrl \? \(/);
    expect(SHADER_NODE).toMatch(/\) : \(\s*\/\*[\s\S]*?\*\/\s*<ImageThumbEmpty language=\{language\} \/>/);
  });

  it('is drawn by every replica — a replica never carries a payload', () => {
    expect(NODE_VISUAL).toMatch(/def\.type === 'imageNode' && <ImageThumbEmpty/);
  });

  it('is node INK, carries no literal colour, and keeps its title live', () => {
    const css = SHADER_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = /\.shader-node__image-empty \{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block![1]).toContain('rgba(var(--node-ink-rgb)');
    expect(block![1]).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    // The hint is its `title`; TooltipLayer finds hosts via elementFromPoint,
    // so a pointer-events: none element's title never fires.
    expect(block![1]).not.toMatch(/pointer-events:\s*none/);
  });
});
