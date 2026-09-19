/**
 * The mesh-highlight hint's LIST form (GLB Phase 5 Step 10): the names an
 * index-section chip hands the preview are validated here, and the sandbox
 * script's own cap agrees. Pure; no global is stubbed (the dispatch is a
 * no-op without a window).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_HIGHLIGHT_NAMES, highlightMesh, highlightMeshes, sanitizeHighlightNames } from './meshHighlight';

describe('sanitizeHighlightNames', () => {
  it('keeps non-empty strings, each once, in order, capped', () => {
    expect(sanitizeHighlightNames(['a', 'b', 'a', '', 5, null, 'c'])).toEqual(['a', 'b', 'c']);
    expect(sanitizeHighlightNames('a')).toEqual([]);
    expect(sanitizeHighlightNames(undefined)).toEqual([]);
    const many = Array.from({ length: MAX_HIGHLIGHT_NAMES + 10 }, (_, i) => `m${i}`);
    expect(sanitizeHighlightNames(many)).toHaveLength(MAX_HIGHLIGHT_NAMES);
  });

  it('the sandbox script caps at the same number', () => {
    const src = readFileSync(resolve(__dirname, '../engine/tslToPreviewHTML.ts'), 'utf8');
    expect(src).toContain(`k < raw.length && k < ${MAX_HIGHLIGHT_NAMES}`);
  });

  it('both senders are no-ops without a window (node env)', () => {
    expect(() => highlightMesh('a')).not.toThrow();
    expect(() => highlightMeshes(['a', 'b'])).not.toThrow();
  });
});

describe('the chip and the forwarder', () => {
  const chip = readFileSync(resolve(__dirname, '../components/NodeEditor/nodes/IndexSectionChip.tsx'), 'utf8');
  const preview = readFileSync(resolve(__dirname, '../components/Preview/ShaderPreview.tsx'), 'utf8');

  it('hovering the chip lights its meshes and leaving clears; nothing else is bound', () => {
    expect(chip).toContain('highlightMeshes(effective.meshes)');
    expect(chip).toContain('onPointerLeave={() => highlightMesh(null)}');
    expect(chip).not.toContain('onClick');
    expect(chip).not.toContain('onPointerDown');
  });

  it('the forwarder posts the validated list beside the single name', () => {
    expect(preview).toContain('const names = sanitizeHighlightNames(detail?.names);');
    expect(preview).toContain("win.postMessage({ type: 'fs:highlight-mesh', name, names }, '*');");
  });
});
