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
 *     of the download folder, and only when embedded.
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

  it('the bridge accepts messages from the parent at its own origin only', () => {
    const bridge = read('./EmbedBridge.tsx');
    expect(bridge).toMatch(/e\.source !== window\.parent \|\| e\.origin !== embedTargetOrigin\(\)/);
    expect(bridge).toMatch(/typeof data\.module !== 'string'/);
    expect(bridge).toMatch(/window\.parent\.postMessage\(message, embedTargetOrigin\(\)\)/);
  });

  it('EXPORT posts its bytes to the host instead of downloading, only when embedded', () => {
    const exp = read('../engine/exportShader.ts');
    expect(exp).toMatch(/if \(isEmbedMode\(\)\) \{[\s\S]*?type: 'superwxr:export'[\s\S]*?embedTargetOrigin\(\),?\s*\);[\s\S]*?\} else \{[\s\S]*?downloadBlob\(/);
  });
});
