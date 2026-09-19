/**
 * The EXPORT popover's KTX2 row and the flag behind it (Phase 8 Step 5),
 * pinned from SOURCE: the vitest env is `node`, so the Toolbar cannot be
 * rendered (the exportFormatUi.test.ts precedent beside it).
 *
 * What the pins are FOR, each a way this feature would go wrong quietly:
 *   - the row must not exist where no encoder is registered (every shipped
 *     build today) or in a study session;
 *   - the format gate must be aria-disabled, never `disabled` — WebKit drops a
 *     disabled control's title, and the title is the only explanation;
 *   - `exportKtx2` is SESSION-ONLY: a persisted "on" would keep spending
 *     encode time and bytes on exports nobody asked it for;
 *   - and the export passes `ktx2` only when the flag AND an encoder are both
 *     there, so a stale flag alone can never change the file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import lv from '@/i18n/lv.json';
import { GLB_EXPORT_KEYS } from '@/utils/glbExportCopy';
import { useAppStore } from '@/store/useAppStore';

const src = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');
const TOOLBAR = src('Toolbar.tsx');
const STORE = src('../../store/useAppStore.ts');
const EXPORT = src('../../engine/exportShader.ts');

describe('the KTX2 row in the EXPORT popover', () => {
  const at = TOOLBAR.indexOf('{hasKtx2Encoder() && !isEvalMode() && (');
  const row = TOOLBAR.slice(at, TOOLBAR.indexOf('</label>', at));

  it('renders only with an encoder registered and outside a study session', () => {
    expect(at).toBeGreaterThan(-1);
    // One gate, not two: a second copy could drift from this one.
    expect(TOOLBAR.split('hasKtx2Encoder()')).toHaveLength(2);
  });

  it('binds the session flag and gates the format with aria-disabled, never `disabled`', () => {
    expect(row).toContain('checked={exportKtx2}');
    expect(row).toContain("aria-disabled={exportFormat !== 'glb'}");
    expect(row).toContain('onChange={(e) => setExportKtx2(e.target.checked)}');
    // …and no `disabled` attribute of its own (aria-disabled only).
    expect(row).not.toMatch(/(?<!aria-)\bdisabled=/);
  });

  it('carries the note as a title, and the format reason when it cannot apply', () => {
    expect(row).toContain('GLB_EXPORT_KEYS.ktx2RowNote');
    expect(row).toContain('GLB_EXPORT_KEYS.ktx2RowGlbOnly');
    expect(row).toContain('{t(GLB_EXPORT_KEYS.ktx2Row, language)}');
  });

  it('its three sentences are translated', () => {
    const ui = (lv as { ui: Record<string, string> }).ui;
    for (const key of [GLB_EXPORT_KEYS.ktx2Row, GLB_EXPORT_KEYS.ktx2RowNote, GLB_EXPORT_KEYS.ktx2RowGlbOnly]) {
      expect(ui[key], key).toBeTruthy();
      expect(ui[key], key).not.toBe(key);
    }
  });
});

describe('exportKtx2 is session-only', () => {
  it('defaults to false and is absent from every persisted path', () => {
    expect(useAppStore.getState().exportKtx2).toBe(false);
    // The store writes localStorage through named keys; none of them is this
    // flag, and it rides no snapshot, history entry or project block.
    for (const file of ['../../store/useAppStore.ts', '../../engine/exportShader.ts', '../../engine/fastShadersProject.ts']) {
      const text = src(file);
      for (const line of text.split('\n')) {
        if (!line.includes('exportKtx2')) continue;
        expect(line, line).not.toMatch(/localStorage|setItem|partialize|snapshotOf|buildProjectState/);
      }
    }
    expect(STORE).not.toMatch(/fs:exportKtx2/);
  });

  it('sits beside exportIncludeMesh and exportAsGlb, the other two session-only export flags', () => {
    expect(STORE).toContain('  exportKtx2: boolean;');
    expect(STORE).toContain('  exportKtx2: false,');
    expect(STORE).toContain('setExportKtx2: (on) => set({ exportKtx2: on === true }),');
  });
});

describe('buildShaderExportChecked passes ktx2 only when both halves are there', () => {
  it('the flag AND a registered encoder', () => {
    expect(EXPORT).toContain('const encoder = getKtx2Encoder();');
    expect(EXPORT).toContain(
      'ktx2: s.exportKtx2 && encoder ? { encoder, onProgress: (d, t) => asks.glb.progress(d, t) } : null,',
    );
  });

  it("the 'no-ktx2' answer reaches build(), and its size is the one the dialog showed", () => {
    expect(EXPORT).toContain("if (c === 'no-ktx2') mode = 'no-ktx2';");
    expect(EXPORT).toContain("const shown = mode === 'no-ktx2' ? prepared.sizes.noKtx2 : prepared.sizes[mode];");
  });

  it('a build WITHOUT the copies reports nothing about them', () => {
    expect(EXPORT).toContain(
      "mode === 'no-ktx2' ? undefined : { written: prepared.ktx2Written, skipped: prepared.ktx2Skipped },",
    );
  });
});
