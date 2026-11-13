/**
 * The SuperWXR embed bridge (embed/EmbedBridge.tsx) is a second way to change
 * the graph and a second way out for EXPORT, so the shape that keeps it safe is
 * pinned here, on the source:
 *
 *   - the switch (embed/embedMode.ts) is a LEAF sampled once, and never true
 *     without a window — every node suite runs an un-embedded app;
 *   - App.tsx mounts the bridge only behind that switch AND outside a study,
 *     as a lazy chunk: an ordinary boot never imports it (bootWave.test.ts
 *     walks the static graph; this pins the reason the edge is dynamic);
 *   - the bridge answers the PARENT window at the page's own origin only;
 *   - exportShader.ts hands EXPORT's bytes to the host at that origin instead
 *     of the download folder, and only when embedded;
 *   - every message names its document (embedDocument.ts has the rules and
 *     their own suite), and the id moves only where the document does;
 *   - embedded, the stored document — graph, name, viewport, model — is
 *     neither read nor written: the host's copy is the only one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isEmbedMode, EMBED_PARAM } from './embedMode';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('embed mode', () => {
  it('is never on without a window, and the switch module is a leaf', () => {
    expect(isEmbedMode()).toBe(false);
    expect(EMBED_PARAM).toBe('embed');
    const src = read('./embedMode.ts');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).toMatch(/window\.parent !== window/);
  });

  it('App.tsx mounts the bridge lazily, behind the switch and outside a study', () => {
    const app = read('../App.tsx');
    expect(app).not.toMatch(/from '\.\/embed\/EmbedBridge'/);
    expect(app).toMatch(/import\('\.\/embed\/EmbedBridge'\)/);
    expect(app).toMatch(/isEmbedMode\(\) && !isEvalMode\(\) && \(/);
  });

  it('embedded, only the canvas pane mounts: no toolbar, no preview, no code pane, no intro', () => {
    const layout = read('../components/Layout/AppLayout.tsx');
    expect(layout).toMatch(/isEmbedMode\(\) \? <EmbeddedLayout \/> : <FullLayout \/>/);
    const embedded = layout.match(/function EmbeddedLayout\(\) \{[\s\S]*?\n\}/)![0];
    expect(embedded).toMatch(/CANVAS_PANE/);
    expect(embedded).not.toMatch(/TOOLBAR|PREVIEW_PANE|CODE_PANE/);
    expect(read('../App.tsx')).toMatch(/introVia && !desktopBooting && !isEmbedMode\(\) && \(/);
  });

  it('the bridge accepts messages from the parent at its own origin only', () => {
    const bridge = read('./EmbedBridge.tsx');
    expect(bridge).toMatch(/e\.source !== window\.parent \|\| e\.origin !== embedTargetOrigin\(\)/);
    expect(bridge).toMatch(/typeof data\.module !== 'string'/);
    expect(bridge).toMatch(/window\.parent\.postMessage\(message, embedTargetOrigin\(\)\)/);
  });

  it('dedupes on ONE slot, the text the host holds, so editing back to an opened module still posts it', () => {
    const bridge = read('./EmbedBridge.tsx');
    // A second "last opened" slot suppressed X after open X → edit to Y → undo
    // to X, leaving the host on Y.
    expect(bridge).not.toMatch(/lastOpened/);
    expect(bridge).toMatch(/const key = embedModuleKey\(text\);\s*if \(key === lastPosted\) return;\s*lastPosted = key;/);
    const onMessage = bridge.match(/const onMessage = [\s\S]*?\n {4}\};/)![0];
    expect(onMessage).toMatch(/lastPosted = embedModuleKey\(text\);/);
  });

  it('every message names its document, and says which protocol it speaks', () => {
    const bridge = read('./EmbedBridge.tsx');
    expect(bridge).toMatch(/post\(\{ type: 'superwxr:ready', protocol: EMBED_PROTOCOL \}\)/);
    expect(bridge).toMatch(/type: 'superwxr:module', module: text, name: [^}]*\.\.\.embedDocumentFields\(\) \}/);
    expect(read('../engine/exportShader.ts')).toMatch(/type: 'superwxr:export',[^}]*id: embedDocument\(\)\.id \}/);
  });

  it('the graph becomes the host\'s document only once its import succeeded', () => {
    const bridge = read('./EmbedBridge.tsx');
    const onMessage = bridge.match(/const onMessage = [\s\S]*?\n {4}\};/)![0];
    // A throwing open (a corrupt project block) leaves the OLD document in the
    // editor: taking the new id first would send that document's edits to the
    // shader the host asked for.
    expect(onMessage).toMatch(/try \{\s*importShaderText\([^;]*;[\s\S]*?embedDocumentOpened\(id\);\s*lastPosted = /);
    expect(onMessage).not.toMatch(/embedDocumentOpened\(id\)[\s\S]*importShaderText\(/);
    expect(onMessage).toMatch(/const id = hostDocumentId\(data\.id\);/);
  });

  it('a document replaced inside the editor stops being the host\'s, but the bridge\'s own open does not count', () => {
    const bridge = read('./EmbedBridge.tsx');
    expect(bridge).toMatch(/const onReplaced = \(\) => \{\s*if \(opening\) return;\s*embedDocumentReplaced\(\);\s*schedule\(\);\s*\};/);
    for (const event of ['fs:graph-imported', 'fs:graph-new']) {
      expect(bridge).toContain(`window.addEventListener('${event}', onReplaced);`);
      expect(bridge).toContain(`window.removeEventListener('${event}', onReplaced);`);
    }
    // The flag brackets the import and is dropped even when it throws.
    expect(bridge).toMatch(/opening = true;\s*try \{[\s\S]*?\} finally \{\s*opening = false;\s*\}/);
    // Both events are still what the paths that REPLACE a document dispatch.
    expect(read('../engine/projectImport.ts')).toMatch(/new CustomEvent\('fs:graph-imported'\)/);
    expect(read('../store/useAppStore.ts')).toMatch(/new CustomEvent\('fs:graph-new'\)/);
  });

  it('embedded, the stored document is neither read nor written', () => {
    const store = read('../store/useAppStore.ts');
    // The graph autosave starts OFF, with no call for an entry to forget.
    expect(store).toMatch(/const DOCUMENT_STORED = !isEmbedMode\(\);\s*let graphPersistence = DOCUMENT_STORED;/);
    // Its name: read once at init, written by NEW and by a rename.
    expect(store).toMatch(/shaderName: DOCUMENT_STORED \? loadString\('fs:shaderName', DEFAULT_SHADER_NAME\) : DEFAULT_SHADER_NAME,/);
    expect(store.match(/saveString\('fs:shaderName'/g)).toHaveLength(2);
    expect(store.match(/if \(DOCUMENT_STORED\) saveString\('fs:shaderName'/g)).toHaveLength(2);
    // Its model: every `superwxr:open` clears the session mesh, and that clear
    // must not reach the mirror a full FastShaders tab restores from.
    expect(store).toMatch(/if \(opts\?\.persist !== false && DOCUMENT_STORED\) \{\s*void savePreviewMeshToCache\(/);
    expect(store.match(/savePreviewMeshToCache\(/g)).toHaveLength(1);
    // The boot graph, and the viewport that belongs to the stored one.
    expect(read('../App.tsx')).toMatch(/const saved = isEmbedMode\(\) \? null : loadGraph\(\);/);
    const viewport = read('../utils/viewportMemory.ts');
    expect(viewport).toMatch(/export function readStoredViewport\(\)[^{]*\{[^}]*?if \(isEmbedMode\(\)\) return null;/);
    expect(viewport).toMatch(/export function writeStoredViewport\([^{]*\{[^}]*?if \(isEmbedMode\(\)\) return;\s*try \{\s*localStorage\.setItem\(VIEWPORT_KEY/);
  });

  it('EXPORT posts its bytes to the host instead of downloading, only when embedded', () => {
    const exp = read('../engine/exportShader.ts');
    expect(exp).toMatch(/if \(isEmbedMode\(\)\) \{[\s\S]*?type: 'superwxr:export'[\s\S]*?embedTargetOrigin\(\),?\s*\);[\s\S]*?\} else \{[\s\S]*?downloadBlob\(/);
  });
});
