/**
 * The parent-side, selectable/copyable mirror of the iframe's own red
 * `#error` text (tslToPreviewHTML.ts). The iframe's copy is
 * `pointer-events: none` inside a sandboxed, opaque-origin document, so it
 * can never be selected or copied there — see ShaderPreview.tsx's
 * `previewErrorMessage` comment. These are SOURCE pins (vitest's env is
 * `node`; ShaderPreview has no rendering test — see previewRebuild.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');

describe('previewErrorMessage: captured from fs:preview-error, cleared on success', () => {
  it('fs:preview-error sets it from the posted message', () => {
    const at = SRC.indexOf("data.type === 'fs:preview-error'");
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, SRC.indexOf("data.type === 'fs:preview-ready'", at));
    expect(block).toMatch(/setPreviewErrorMessage\(data\.message\)/);
  });

  it('fs:preview-ready (every success, boot and hot-swap alike) clears it', () => {
    const at = SRC.indexOf("data.type === 'fs:preview-ready'");
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 400);
    expect(block).toContain('setPreviewErrorMessage(null)');
  });

  it('a cold document rebuild clears it too — a fresh document starts with no error of its own', () => {
    const at = SRC.indexOf('setCompiling(true);\n    // A fresh document starts with no error');
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 200)).toContain('setPreviewErrorMessage(null)');
  });

  it('renders a selectable text node plus a Copy button, not just the iframe overlay', () => {
    const at = SRC.indexOf('previewErrorMessage && (');
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, SRC.indexOf('{dropVeil &&', at));
    expect(block).toContain('shader-preview__error-notice-text');
    expect(block).toContain('shader-preview__error-notice-copy');
    expect(block).toContain('onClick={handleCopyError}');
  });

  it('handleCopyError follows the app-wide navigator.clipboard.writeText pattern (Toolbar/FeedbackModal)', () => {
    const at = SRC.indexOf('const handleCopyError = useCallback(');
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 400);
    expect(block).toContain('navigator.clipboard.writeText(previewErrorMessage)');
    expect(block).toContain('setErrorCopied(true)');
  });
});

describe('.shader-preview__error-notice CSS', () => {
  const CSS = readFileSync(resolve(__dirname, 'ShaderPreview.css'), 'utf8');

  it('is OPAQUE (unlike drop-notice) so it fully covers the iframe copy instead of doubling it', () => {
    const at = CSS.indexOf('.shader-preview__error-notice {');
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('}', at));
    expect(block).toMatch(/background:\s*#1c1c1c/);
  });

  it('the text span opts back into pointer-events and selection; the plate itself stays click-through', () => {
    expect(CSS).toMatch(/\.shader-preview__error-notice\s*{[^}]*pointer-events:\s*none/);
    expect(CSS).toMatch(/\.shader-preview__error-notice-text\s*{[^}]*pointer-events:\s*auto[^}]*user-select:\s*text/s);
  });
});
