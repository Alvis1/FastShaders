import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SHADER_NODE = readFileSync(new URL('./ShaderNode.tsx', import.meta.url), 'utf8');
const SHADER_CSS = readFileSync(new URL('./ShaderNode.css', import.meta.url), 'utf8');
const GRAPH_TO_CODE = readFileSync(new URL('../../../engine/graphToCode.ts', import.meta.url), 'utf8');

describe('the Image node card shows its flips', () => {
  it('mirrors the thumbnail per axis', () => {
    // A checkbox in a menu you have to close before you can see its effect is
    // a guess; the card is where the picture is.
    expect(SHADER_NODE).toMatch(/flipThumbX = Number\(data\.values\?\.flipX \?\? 0\) >= 0\.5/);
    expect(SHADER_NODE).toMatch(/flipThumbY = Number\(data\.values\?\.flipY \?\? 0\) >= 0\.5/);
    expect(SHADER_NODE).toMatch(/transform: `scale\(\$\{flipThumbX \? -1 : 1\}, \$\{flipThumbY \? -1 : 1\}\)`/);
  });

  it('reads the flags the way CODEGEN reads them', () => {
    // The sign convention is the trap. graphToCode bakes the 1-u correction in
    // when flipX is UNCHECKED (`mirrorX = flipX < 0.5`), so the DEFAULT is the
    // file-matching orientation and each ticked box mirrors what the card
    // draws — which is only true if both sides use the same >= 0.5 threshold.
    expect(GRAPH_TO_CODE).toMatch(/const mirrorX = numVal\('flipX', 0\) < 0\.5;/);
    expect(GRAPH_TO_CODE).toMatch(/const mirrorY = numVal\('flipY', 0\) >= 0\.5;/);
  });
});

describe('the Image node card shows Nearest filtering', () => {
  it('draws the thumbnail pixelated exactly when codegen samples nearest', () => {
    // Otherwise the browser smooths a small stored image (an 8 px rung) into
    // a blur the shader never draws. Both sides read the same exact string.
    expect(SHADER_NODE).toMatch(/const nearestThumb = data\.values\?\.filter === 'nearest';/);
    expect(SHADER_NODE).toMatch(/nearestThumb \? \{ imageRendering: 'pixelated' as const \}/);
    expect(GRAPH_TO_CODE).toMatch(/const nearest = nv\.filter === 'nearest';/);
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
