/**
 * The preview's Gaussian-splat wiring on the PARENT side: the `fs:model-splat`
 * up-message, the study-session refusal, the per-kind model feed, the headset
 * and dropped-SH info lines and the Splat Output pane notice.
 *
 * ShaderPreview has no rendering test (the vitest env is `node` — an iframe,
 * postMessage and localStorage in a large component; see
 * modelDropNotices.test.ts for the pattern). So the rules are tested where they
 * LIVE — the report validator (`sanitizeSplatReport`) and the store field, for
 * real — and the component is pinned from SOURCE to call them in the right
 * place: the sender check first, the current mesh id, the study-session check
 * before the pre-read gate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useAppStore } from '@/store/useAppStore';
import { sanitizeSplatReport } from '@/utils/meshInventory';
import { createPreviewMesh, MESH_EXTENSIONS, MESH_SPLAT_EVAL_KEY } from '@/utils/previewMesh';
import { SPLAT_MAX_COUNT } from '@/utils/splatLimits';
import { t } from '@/i18n';
import { SINK_MODEL_ISSUE_KEY } from '@/utils/sinkModelCopy';
import { HISTORY_IDLE, splatRows } from '@/test-utils';

const PREVIEW = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');
const STORE = readFileSync(resolve(__dirname, '../../store/useAppStore.ts'), 'utf8');

/** The text of a `const name = useCallback(` … up to its first `}, [` dep list. */
function callbackBody(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = useCallback(`);
  expect(at, `${name} was renamed`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf('}, [', at));
}

/** The `fs:model-splat` branch of the iframe message handler. */
function splatBranch(): string {
  const at = PREVIEW.indexOf("if (data.type === 'fs:model-splat') {");
  expect(at, 'the fs:model-splat branch is gone').toBeGreaterThan(-1);
  return PREVIEW.slice(at, PREVIEW.indexOf("if (data.type === 'fs:model-ktx2')", at));
}

function splatMesh(n = 100) {
  const r = createPreviewMesh('garden.splat', splatRows(n));
  if (!('mesh' in r)) throw new Error('fixture refused');
  return r.mesh;
}

beforeEach(() => {
  useAppStore.setState({ previewMesh: null, previewMeshInventory: null, previewSplatFacts: null, ...HISTORY_IDLE });
});

describe('fs:model-splat — what the parent accepts (the validator the handler calls)', () => {
  const report = (over: Record<string, unknown> = {}) => ({ type: 'fs:model-splat', geometry: 'custom:3', count: 1000, shDropped: 0, ...over });

  it('takes a well-formed report for the splat mesh on screen', () => {
    expect(sanitizeSplatReport(report(), 'custom:3', 3)).toEqual({ meshId: 3, count: 1000, shDropped: 0 });
  });

  it('ignores junk counts', () => {
    for (const count of [-5, 12.5, SPLAT_MAX_COUNT + 1, 1e300, NaN, '1000', null, { valueOf: () => 1000 }]) {
      expect(sanitizeSplatReport(report({ count }), 'custom:3', 3), String(count)).toBeNull();
    }
  });

  it('ignores the wrong key — a torn-down document, another mesh, no splat loaded', () => {
    expect(sanitizeSplatReport(report({ geometry: 'custom:2' }), 'custom:3', 3)).toBeNull();
    expect(sanitizeSplatReport(report(), 'custom:3', 4)).toBeNull();
    expect(sanitizeSplatReport(report(), 'custom:3', null)).toBeNull();
    expect(sanitizeSplatReport(report(), 'bunny', 3)).toBeNull();
  });

  it('ignores a dropped-SH degree that is not 0–3', () => {
    for (const shDropped of [4, -1, '2', 2.5, undefined]) {
      expect(sanitizeSplatReport(report({ shDropped }), 'custom:3', 3)).toBeNull();
    }
  });
});

describe('fs:model-splat — the handler (pinned from source)', () => {
  it('sits behind the handler’s one sender check: a message from any other window is ignored', () => {
    const handler = PREVIEW.indexOf('const handler = (e: MessageEvent) => {');
    expect(handler).toBeGreaterThan(-1);
    const source = PREVIEW.indexOf('if (e.source !== iframeRef.current?.contentWindow) return;', handler);
    expect(source).toBeGreaterThan(handler);
    expect(PREVIEW.indexOf("if (data.type === 'fs:model-splat') {", handler)).toBeGreaterThan(source);
  });

  it('validates against the CURRENT document key and the loaded SPLAT mesh id', () => {
    const b = splatBranch();
    expect(b).toContain('sanitizeSplatReport(data, modelKeyRef.current, mesh && isSplatKind(mesh.kind) ? mesh.id : null)');
    expect(b).toContain('if (!facts || !mesh) return;');
  });

  it('stores the facts through the one setter, only when they changed', () => {
    const b = splatBranch();
    expect(b).toContain('store.setPreviewSplatFacts(facts);');
    expect(b).toMatch(/prev\.meshId !== facts\.meshId \|\| prev\.count !== facts\.count \|\| prev\.shDropped !== facts\.shDropped/);
  });

  it('raises the headset advisory and the dropped-SH line ONCE per mesh id, as one info line', () => {
    const b = splatBranch();
    const once = b.indexOf('if (splatReportedRef.current.has(facts.meshId)) return;');
    expect(once).toBeGreaterThan(-1);
    expect(b.indexOf('splatReportedRef.current.add(facts.meshId);')).toBeGreaterThan(once);
    // The header's count when the file states one; the sandbox's for a gzip .spz.
    expect(b).toContain('splatHeadsetMessage({ count: mesh.splat?.count ?? facts.count }, lang)');
    expect(b).toContain('splatShDroppedMessage(facts.shDropped, lang)');
    expect(b).toContain("showDropNotice([headset, sh].filter(Boolean).join(' '), 'info')");
    // The language is read live — the handler binds once.
    expect(b).toContain('const lang = store.language;');
  });

  it('the drop path raises the advisory itself when the header states the count', () => {
    const apply = callbackBody(PREVIEW, 'applyModelBytes');
    const set = apply.indexOf('setPreviewMesh(result.mesh);');
    const advisory = apply.indexOf('splatHeadsetMessage(result.mesh.splat, language)');
    expect(set).toBeGreaterThan(-1);
    expect(advisory).toBeGreaterThan(set);
    expect(apply).toContain('splatAdvisedRef.current.add(result.mesh.id);');
  });

  it('carries a reported splat on the inventory beside the meshes', () => {
    expect(PREVIEW).toContain('...(inv.splat ? { splat: inv.splat } : {}),');
  });
});

describe('previewSplatFacts in the store', () => {
  it('is set by its setter and cleared by EVERY mesh change, like the inventory', () => {
    const s = useAppStore.getState();
    s.setPreviewMesh(splatMesh(), { persist: false });
    const id = useAppStore.getState().previewMesh!.id;
    s.setPreviewSplatFacts({ meshId: id, count: 100, shDropped: 0 });
    expect(useAppStore.getState().previewSplatFacts).toEqual({ meshId: id, count: 100, shDropped: 0 });
    s.setPreviewMesh(splatMesh(), { persist: false });
    expect(useAppStore.getState().previewSplatFacts).toBeNull();
    s.setPreviewSplatFacts({ meshId: 1, count: 5, shDropped: 1 });
    s.setPreviewMesh(null);
    expect(useAppStore.getState().previewSplatFacts).toBeNull();
  });

  it('starts null and is never persisted: no storage or history site names it', () => {
    expect(STORE).toContain('previewSplatFacts: null,');
    for (const line of STORE.split('\n').filter((l) => l.includes('previewSplatFacts'))) {
      expect(line).not.toMatch(/localStorage|saveString|saveGraph|writeAscii|snapshot|structuredClone/);
    }
  });
});

describe('the study session takes no splat (D10)', () => {
  it('a dropped splat is refused on its kind, BEFORE the pre-read gate and the read', () => {
    const load = callbackBody(PREVIEW, 'loadMeshFile');
    const refusal = load.indexOf('if (isEvalMode() && isSplatKind(kind)) {');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(load.indexOf('preReadModelGate('));
    expect(refusal).toBeLessThan(load.indexOf('file.arrayBuffer()'));
    expect(load.slice(refusal, load.indexOf('return;', refusal))).toContain('meshRefusalMessage(splatEvalRefusal(), language)');
  });

  it('a splat cached by an earlier visit is not restored into a study session', () => {
    const at = PREVIEW.indexOf('void loadPreviewMeshFromCache()');
    const restore = PREVIEW.slice(at, PREVIEW.indexOf('.finally(', at));
    const drop = restore.indexOf('if (isEvalMode() && isSplatKind(mesh.kind)) return;');
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(restore.indexOf('setPreviewMesh(mesh, { persist: false })'));
  });
});

describe('the model feed posts per kind', () => {
  it('bytes for a glb and every splat kind, text for obj / gltf — by isBinaryKind', () => {
    const load = callbackBody(PREVIEW, 'handleIframeLoad');
    expect(load).toContain('if (isBinaryKind(mesh.kind)) {');
    expect(load).toContain("w.postMessage({ type: 'fs:obj-model', geometry: key, kind: mesh.kind, bytes: mesh.bytes, ...extra }, '*');");
    expect(load).toContain("kind: mesh.kind, text: mesh.text ?? ''");
    // The old glb-only ternary is gone: a splat would have been posted as text.
    expect(load).not.toContain("mesh.kind === 'glb'");
  });
});

describe('the Splat Output pane notice (now one of the sink/model fit notices)', () => {
  it('asks the ONE fit check, over unwrapped edges', () => {
    // utils/sinkModelFit.ts decides (sinkModelFit.test.ts pins every case);
    // the pane only renders its answer.
    expect(PREVIEW).toContain('sinkModelIssue(s.nodes, getUnwrappedEdges(s.nodes, s.edges), { geometry: previewGeometry, splatLoaded })');
  });

  it('LOADED and SHOWN stay two facts, and every sentence is translated', () => {
    // The Model menu is local state, so picking Sphere keeps the splat as the
    // store's previewMesh (the menu still offers "Model: garden.splat").
    expect(PREVIEW).toContain('const splatLoaded = previewMesh !== null && isSplatKind(previewMesh.kind);');
    for (const key of [
      SINK_MODEL_ISSUE_KEY['splat-needs-splat'],
      SINK_MODEL_ISSUE_KEY['splat-pick-splat'],
      MESH_SPLAT_EVAL_KEY,
    ]) {
      expect(t(key, 'lv'), key).not.toBe(key);
    }
    expect(t(SINK_MODEL_ISSUE_KEY['splat-pick-splat'], 'lv')).toContain(t('Model', 'lv'));
  });

  it('in a study session: the refusal for the Splat Output’s two, and no new notice', () => {
    const at = PREVIEW.indexOf('const modelNotice = sinkIssue === null');
    const decl = PREVIEW.slice(at, PREVIEW.indexOf(';', PREVIEW.indexOf('sinkModelIssueText(', at)));
    const evalAt = decl.indexOf('isEvalMode()');
    expect(evalAt).toBeGreaterThan(-1);
    expect(decl.indexOf('sinkModelIssueText(')).toBeGreaterThan(evalAt);
    expect(decl).toContain("(sinkIssue === 'splat-needs-splat' || sinkIssue === 'splat-pick-splat' ? t(MESH_SPLAT_EVAL_KEY, language) : null)");
  });

  it('yields the corner to a transient notice', () => {
    expect(PREVIEW).toContain('{modelNotice && !dropNotice && (');
  });
});

describe('the cost bar’s splat figure', () => {
  const COST_BAR = readFileSync(resolve(__dirname, '../Layout/CostBar.tsx'), 'utf8');

  it('reads the reported facts only while the preview shows the model', () => {
    expect(COST_BAR).toContain('useAppStore((s) => (s.previewShowsModel ? s.previewSplatFacts : null))');
  });

  it('is a figure, never points: it never touches the total or the budget', () => {
    const at = COST_BAR.indexOf('{splatFacts && (');
    expect(at).toBeGreaterThan(-1);
    const block = COST_BAR.slice(at, COST_BAR.indexOf('</div>', at));
    expect(block).toContain('formatSplatCount(splatFacts.count, language)');
    expect(block).not.toMatch(/totalCost|maxBudget|pts/);
    for (const line of COST_BAR.split('\n').filter((l) => /totalCost|setTotalCost/.test(l))) {
      expect(line).not.toContain('splat');
    }
  });

  it('is translated, and the Latvian keeps the placeholder', () => {
    for (const key of [
      'Gaussian splats: {count}',
      'How many Gaussian splats the 3D preview is drawing. Shown for information only — splats are not priced in points: their cost depends on how much of the screen they cover and on depth sorting, not on the node graph.',
    ]) {
      expect(COST_BAR).toContain(key);
      const lv = t(key, 'lv');
      expect(lv).not.toBe(key);
      for (const ph of key.match(/\{\w+\}/g) ?? []) expect(lv).toContain(ph);
    }
  });
});

describe('the preview geometry tooltip', () => {
  it('names every model extension, in both languages', () => {
    const at = PREVIEW.indexOf("t('Preview geometry — drag the model to orbit");
    expect(at).toBeGreaterThan(-1);
    const key = PREVIEW.slice(at + 3, PREVIEW.indexOf("', language)", at));
    const lv = t(key, 'lv');
    expect(lv).not.toBe(key);
    for (const ext of MESH_EXTENSIONS) {
      expect(key, ext).toContain(`.${ext}`);
      expect(lv, ext).toContain(`.${ext}`);
    }
  });
});
