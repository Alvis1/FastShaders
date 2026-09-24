import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SHADER_NODE = readFileSync(new URL('./ShaderNode.tsx', import.meta.url), 'utf8');
const SHADER_CSS = readFileSync(new URL('./ShaderNode.css', import.meta.url), 'utf8');
const NODE_VISUAL = readFileSync(new URL('./NodeVisual.tsx', import.meta.url), 'utf8');
const GRAPH_TO_CODE = readFileSync(new URL('../../../engine/graphToCode.ts', import.meta.url), 'utf8');
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
    // The sign convention is the trap. graphToCode bakes the 1-u correction in
    // when flipX is UNCHECKED (`mirrorX = flipX < 0.5`), so the DEFAULT is the
    // file-matching orientation and each ticked box mirrors what the card
    // draws — which is only true if both sides use the same >= 0.5 threshold.
    // Under the glTF orientation there is no baked correction (the texture is
    // uploaded unflipped), so each ticked box mirrors: the card and codegen
    // then use the same >= 0.5 threshold on both axes.
    expect(GRAPH_TO_CODE).toMatch(/const mirrorX = gltf \? numVal\('flipX', 0\) >= 0\.5 : numVal\('flipX', 0\) < 0\.5;/);
    expect(GRAPH_TO_CODE).toMatch(/const mirrorY = numVal\('flipY', 0\) >= 0\.5;/);
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
