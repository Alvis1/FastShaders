/**
 * The preview's model notices and the canvas model drop, pinned from SOURCE.
 *
 * The vitest env is `node` — ShaderPreview (an iframe, postMessage and
 * localStorage in a ~2600-line component) and NodeEditor's onDrop have never
 * had a rendering test — so what can be checked is that the code still says
 * what the design says (the previewRebuild.test.ts pattern). The logic behind
 * each pin is tested for real in utils/ (previewMesh, previewMeshMessage,
 * previewMeshCache, previewModelDrop, idbSafe).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import lv from '@/i18n/lv.json';

const PREVIEW = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');
const PREVIEW_CSS = readFileSync(resolve(__dirname, 'ShaderPreview.css'), 'utf8');
const NODE_EDITOR = readFileSync(resolve(__dirname, '../NodeEditor/NodeEditor.tsx'), 'utf8');
const STORE = readFileSync(resolve(__dirname, '../../store/useAppStore.ts'), 'utf8');

/** The text of a `const name = useCallback(` … up to its first `}, [` dep list. */
function callbackBody(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`);
  expect(at, `${name} was renamed`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf('}, [', at));
}

/** The declarations of one CSS rule (exact selector). */
function cssBlock(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} is gone`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

describe('ShaderPreview drop notice', () => {
  it('stays 12 s, through one constant, and nothing still says 6 s', () => {
    expect(PREVIEW).toContain('const DROP_NOTICE_MS = 12000');
    const body = callbackBody(PREVIEW, 'showDropNotice');
    expect(body).toContain('DROP_NOTICE_MS');
    expect(body).not.toContain('6000');
  });

  it('has a translated close button', () => {
    const at = PREVIEW.indexOf('className="shader-preview__drop-notice-close"');
    expect(at).toBeGreaterThan(-1);
    const button = PREVIEW.slice(at, PREVIEW.indexOf('</button>', at));
    expect(button).toContain("title={t('Dismiss', language)}");
    expect(button).toContain("aria-label={t('Dismiss', language)}");
    expect(button).toContain('onClick={dismissDropNotice}');
  });

  it('keeps the notice click-through and opts only the button back in', () => {
    expect(cssBlock(PREVIEW_CSS, '.shader-preview__drop-notice')).toContain('pointer-events: none');
    expect(cssBlock(PREVIEW_CSS, '.shader-preview__drop-notice-close')).toContain('pointer-events: auto');
  });
});

describe('ShaderPreview model path', () => {
  const load = callbackBody(PREVIEW, 'loadMeshFile');
  // The post-read half moved into applyModelBytes (GLB Phase 5 Step 9): the
  // ONE constructor, the refusal, the geometry switch and the KTX2 line, so
  // the dialog's "Model only" answer and every unoffered model share it.
  const apply = callbackBody(PREVIEW, 'applyModelBytes');

  it('translates every refusal through the structured MeshRefusal', () => {
    // The pre-read gate's refusal (modelDropGate.test.ts pins the gate call).
    expect(load).toContain('meshRefusalMessage(preRead, language)');
    expect(apply).toContain('meshRefusalMessage(result.refusal, language)');
    expect(PREVIEW).not.toContain("t('Model too large'");
  });

  it('says so when the drop-time pre-check reports a KTX2 fallback, as an info line', () => {
    // Unreachable under the bundled transcoder (it decodes them), and kept for
    // a caller passing a lesser support set; the live line comes from the
    // sandbox's count instead — see below.
    expect(apply).toMatch(/if \(result\.ktx2Fallback\) showDropNotice\(t\(MESH_KTX2_FALLBACK_KEY, language\), 'info'\)/);
  });

  it('loads a model the canvas hands over, through the same loadMeshFile', () => {
    const at = PREVIEW.indexOf('window.addEventListener(PREVIEW_MODEL_FILE_EVENT');
    expect(at).toBeGreaterThan(-1);
    const effect = PREVIEW.slice(PREVIEW.lastIndexOf('useEffect(', at), at);
    expect(effect).toContain('previewModelDropOf(ev)');
    expect(effect).toContain('void loadMeshFile(d.file, { offerBuild: !d.pairedWithShader })');
  });

  it('shows the cache-full line only for the mesh still on screen', () => {
    const at = PREVIEW.indexOf('window.addEventListener(MESH_CACHE_FULL_EVENT');
    expect(at).toBeGreaterThan(-1);
    const effect = PREVIEW.slice(PREVIEW.lastIndexOf('useEffect(', at), at);
    expect(effect).toContain('meshCacheFullIdOf(ev)');
    expect(effect).toContain('previewMesh?.id !== id');
    expect(effect).toContain('t(MESH_CACHE_FULL_KEY, language)');
  });
});

describe('ShaderPreview fs:model-ktx2 (what the transcode really did)', () => {
  const at = PREVIEW.indexOf("if (data.type === 'fs:model-ktx2')");
  // Up to the branch that follows it, so the whole handler is in view.
  const branch = PREVIEW.slice(at, PREVIEW.indexOf("if (data.type === 'fs:backend')", at));

  it('has the branch, inside the handler that already checks the iframe is ours', () => {
    expect(at).toBeGreaterThan(-1);
    // The one message listener verifies e.source before any branch runs.
    const listener = PREVIEW.indexOf("if (e.source !== iframeRef.current?.contentWindow) return;");
    expect(listener).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(listener);
  });

  it('believes it only for the model THIS document was built for, once per model', () => {
    expect(branch).toContain('const key = modelKeyRef.current;');
    expect(branch).toContain('if (data.geometry !== key || ktx2ReportedRef.current.has(key)) return;');
    expect(branch).toContain('ktx2ReportedRef.current.add(key);');
    expect(PREVIEW).toContain('const ktx2ReportedRef = useRef<Set<string>>(new Set());');
  });

  it('coerces and clamps the two counts, and raises ONE info line naming both', () => {
    expect(branch).toContain('Math.min(Math.max(Number(v) | 0, 0), 1024)');
    expect(branch).toMatch(/count\(data\.fallbacks\) > 0\) lines\.push\(t\(MESH_KTX2_FALLBACK_KEY, lang\)\)/);
    expect(branch).toMatch(/count\(data\.missing\) > 0\) lines\.push\(t\(MESH_KTX2_MISSING_KEY, lang\)\)/);
    // The two sentences are joined and shown ONCE: showDropNotice replaces the
    // notice (one useState, one timer), so a second call from this handler
    // would drop the first sentence unseen, and the model is already marked
    // reported so no later document could repeat it.
    expect(branch).toMatch(/if \(lines\.length > 0\) showDropNotice\(lines\.join\(' '\), 'info'\)/);
    expect(branch.match(/showDropNotice\(/g) ?? []).toHaveLength(1);
    // The effect binds once, so the language is read live, not closed over.
    expect(branch).toContain('const lang = useAppStore.getState().language;');
  });

  it('MESH_KTX2_MISSING_KEY has a Latvian entry that differs from the English', () => {
    const en = "Some of this model's KTX2 textures could not be decoded and are not shown.";
    const ui = (lv as { ui: Record<string, string> }).ui;
    expect(ui[en]).toBeTruthy();
    expect(ui[en]).not.toBe(en);
  });
});

describe('NodeEditor canvas model drop', () => {
  it('partitions models out BEFORE images', () => {
    const model = NODE_EDITOR.indexOf('detectMeshKind(f.name) !== null) models.push(f)');
    const image = NODE_EDITOR.indexOf('isImageFile(f)) images.push(f)');
    expect(model).toBeGreaterThan(-1);
    expect(image).toBeGreaterThan(model);
  });

  it('hands the first model to the preview on both branches, and never counts it as ignored', () => {
    // The project branch pairs the model with the shader it arrived beside
    // (never offered to the GLB import dialog); the no-project branch does not.
    expect(NODE_EDITOR.split('requestPreviewModelLoad(models[0], { pairedWithShader: true })')).toHaveLength(2);
    expect(NODE_EDITOR.split('requestPreviewModelLoad(models[0])')).toHaveLength(2);
    const ignored = NODE_EDITOR.slice(NODE_EDITOR.indexOf('const ignored ='), NODE_EDITOR.indexOf(';', NODE_EDITOR.indexOf('const ignored =')));
    expect(ignored).not.toContain('models');
  });
});

describe('store: the cache-full announcement', () => {
  it('fires only for a storage-full save of the mesh still loaded', () => {
    expect(STORE).toMatch(
      /r === 'storage-full' && mesh && get\(\)\.previewMesh === mesh\) announceMeshCacheFull\(mesh\.id\)/,
    );
  });
});
