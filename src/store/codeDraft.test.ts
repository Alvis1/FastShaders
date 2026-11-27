/**
 * The text the code panel KEEPS when an Apply dropped code (owner, 2026-11-26;
 * utils/codeDraft.ts). Held beside the graph's code, never instead of it: the
 * store's `code` and `previewCode` stay what the graph generates, so the 3D
 * view, every export and the study package follow the graph, while the panel
 * shows — and Apply reads — what was typed.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useAppStore, cancelPendingGraphSave } from './useAppStore';
import { panelText } from '@/utils/codeDraft';
import { planExportGraph } from '@/engine/exportGraph';
import { HISTORY_IDLE, makeNode } from '@/test-utils';
import type { ParseError } from '@/types';

const TYPED = 'const scale = 3;\nreturn mul(positionGeometry, scale);';
const G0 = '// the graph, pass 0';
const G1 = '// the graph, pass 1';
const parsed = { emitted: new Set(['mul-1', 'pos-1']), names: new Map([['mul-1', 'mul1'], ['pos-1', 'p']]) };
const dropped: ParseError = { message: '"scale = 3" was dropped — a plain number is not a node; write float(3).', line: 1, severity: 'warning' };

const store = () => useAppStore.getState();
/** An Apply that dropped code: the text was typed, parsed, and is now kept. */
const applyDropping = (typed = TYPED) => {
  store().setCode(typed, 'code', undefined, { base: store().code });
  store().holdCodeDraft(typed, parsed.emitted, parsed.names);
  store().setCodeErrors([dropped]);
  // The pass the sync engine runs at once (hooks/useSyncEngine.ts).
  store().setCode(G0, 'graph', undefined, { emitted: new Set(['out-1']), names: new Map([['out-1', 'output1']]) });
};

describe('a kept text', () => {
  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({
      nodes: [makeNode('out-1', 'output')],
      edges: [],
      code: '// generated',
      previewCode: '// generated',
      codeEmitted: null,
      codeNames: null,
      codeScopes: [],
      codeNodeSpans: null,
      codeDraft: null,
      codeErrors: [],
      syncSource: 'graph',
      codeSyncRequested: false,
      ...HISTORY_IDLE,
    });
  });
  afterEach(() => cancelPendingGraphSave());

  it('is what the panel shows, while the store\'s code and the preview are the GRAPH\'s', () => {
    applyDropping();
    const s = store();
    expect(panelText(s)).toBe(TYPED);
    expect(s.code).toBe(G0);
    expect(s.previewCode).toBe(G0);
    expect(s.codeDraft).toMatchObject({ code: TYPED, applied: TYPED, graph: G0 });
    // Its own scope: what the parse built, not what the graph's code emits.
    expect(s.codeDraft!.emitted).toBe(parsed.emitted);
    expect(s.codeDraft!.names).toBe(parsed.names);
    expect([...s.codeEmitted!]).toEqual(['out-1']);
    expect(s.codeErrors).toEqual([dropped]);
  });

  it('so an export writes the graph\'s module, never the text that did not reach it', () => {
    applyDropping();
    const s = store();
    expect(planExportGraph({ nodes: s.nodes, edges: s.edges, code: s.code }, 'whole').code).toBe(G0);
  });

  it('survives every pass that writes the same text again', () => {
    applyDropping();
    const held = store().codeDraft;
    const errors = store().codeErrors;
    for (let i = 0; i < 3; i++) store().setCode(G0, 'graph', undefined, { emitted: new Set(['out-1']), names: new Map() });
    expect(store().codeDraft).toBe(held);
    expect(store().codeErrors).toBe(errors);
    expect(panelText(store())).toBe(TYPED);
  });

  it('a keystroke edits IT — the store\'s code, the preview and the scope do not move', () => {
    applyDropping();
    const emitted = store().codeEmitted;
    let notes = 0;
    const off = useAppStore.subscribe(() => { notes++; });
    try {
      store().setCode(`${TYPED} // fixed`, 'code', undefined, { base: TYPED });
    } finally {
      off();
    }
    expect(notes).toBe(1);
    const s = store();
    expect(s.codeDraft).toMatchObject({ code: `${TYPED} // fixed`, applied: TYPED, graph: G0 });
    expect(s.code).toBe(G0);
    expect(s.previewCode).toBe(G0);
    expect(s.codeEmitted).toBe(emitted);
    // Typing the same text again notifies nobody.
    notes = 0;
    const off2 = useAppStore.subscribe(() => { notes++; });
    try {
      store().setCode(`${TYPED} // fixed`, 'code', undefined, { base: `${TYPED} // fixed` });
    } finally {
      off2();
    }
    expect(notes).toBe(0);
  });

  it('a keystroke that makes the text the graph\'s own code is still a keystroke in the kept text', () => {
    applyDropping();
    store().setCode(G0, 'code', undefined, { base: TYPED });
    expect(store().codeDraft?.code).toBe(G0);
    expect(store().codeDraft?.applied).toBe(TYPED);
  });

  it('ends when the graph\'s code changes: the panel follows the graph, in ONE notification', () => {
    applyDropping();
    let notes = 0;
    const off = useAppStore.subscribe(() => { notes++; });
    try {
      store().setCode(G1, 'graph', undefined, { emitted: new Set(['out-1']), names: new Map([['out-1', 'output1']]) });
    } finally {
      off();
    }
    expect(notes).toBe(1);
    const s = store();
    expect(s.codeDraft).toBeNull();
    expect(panelText(s)).toBe(G1);
    // The report described the text that is gone: it goes with it, so no
    // banner about dropped lines stands over a graph edit, a New or a file.
    expect(s.codeErrors).toEqual([]);
  });

  it('and its scope joins the ring, so Monaco\'s undo back to it reads under it', () => {
    applyDropping();
    store().setCode(G1, 'graph', undefined, { emitted: new Set(['out-1']), names: new Map([['out-1', 'output1']]) });
    expect(store().codeScopes.map((sc) => sc.code)).toEqual([G1, TYPED, G0]);
    // Cmd+Z in the panel: the kept text is back, typed over the graph's code.
    store().setCode(TYPED, 'code', undefined, { base: G1 });
    const s = store();
    expect(s.code).toBe(TYPED);
    expect(s.codeDraft).toBeNull();
    expect(s.codeEmitted).toBe(parsed.emitted);
    expect(s.codeNames).toBe(parsed.names);
  });

  it('a pass over an UNCHANGED graph that writes another text (the validator) moves the hold, never ends it', () => {
    applyDropping();
    store().setCode('// G0, validated', 'graph', undefined, { emitted: new Set(['out-1']), names: new Map(), sameGraph: true });
    const s = store();
    expect(s.codeDraft).toMatchObject({ code: TYPED, graph: '// G0, validated' });
    expect(s.code).toBe('// G0, validated');
    expect(s.codeErrors).toEqual([dropped]);
  });

  it('keeps a failed re-Apply\'s blocking errors: they describe the text still on the panel', () => {
    applyDropping();
    const blocking: ParseError = { message: 'Unexpected token (2:7)', line: 2 };
    store().setCode(`${TYPED} (`, 'code', undefined, { base: TYPED });
    store().setCodeErrors([blocking]);
    store().setCode(G0, 'graph', undefined, { emitted: new Set(['out-1']), names: new Map() });
    expect(store().codeErrors).toEqual([blocking]);
    // …and they go with the text once the graph changes.
    store().setCode(G1, 'graph', undefined, { emitted: new Set(['out-1']), names: new Map() });
    expect(store().codeErrors).toEqual([]);
  });

  it('is replaced by any other \'code\' write — a bare-script import puts its own text on the panel', () => {
    applyDropping();
    store().setCode('// an imported script', 'code');
    const s = store();
    expect(s.codeDraft).toBeNull();
    expect(s.code).toBe('// an imported script');
    expect(panelText(s)).toBe('// an imported script');
  });

  it('holds what the panel shows NOW: a keystroke that landed while the parser loaded is not lost', () => {
    store().setCode(TYPED, 'code', undefined, { base: '// generated' });
    store().setCode(`${TYPED}\n// more`, 'code', undefined, { base: TYPED });
    store().holdCodeDraft(TYPED, parsed.emitted, parsed.names);
    expect(store().codeDraft).toMatchObject({ code: `${TYPED}\n// more`, applied: TYPED, graph: null });
  });

  it('without one, a \'code\' write is exactly what it was', () => {
    store().setCode('// typed', 'code', undefined, { base: '// generated' });
    expect(store().code).toBe('// typed');
    expect(store().codeDraft).toBeNull();
    // The no-op skip that keeps Monaco's echo from notifying.
    let notes = 0;
    const off = useAppStore.subscribe(() => { notes++; });
    try {
      store().setCode('// typed', 'code', undefined, { base: '// typed' });
      store().setCode('// typed', 'code');
    } finally {
      off();
    }
    expect(notes).toBe(0);
  });

  it('is session-only: not in the saved graph, not in an undo entry', () => {
    const source = readFileSync(path.join(__dirname, 'useAppStore.ts'), 'utf8');
    // Named where it is declared, initialised, armed and written by setCode —
    // and in neither builder: the undo snapshot, the `fs:graph` payload.
    for (const name of ['recordHistory', 'graphPayload', 'saveGraph']) {
      const body = source.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n}\\n`))?.[0];
      expect(body, name).toBeTruthy();
      expect(body, name).not.toContain('codeDraft');
    }
    applyDropping();
    store().pushHistory();
    expect(store().past.length).toBeGreaterThan(0);
    expect(JSON.stringify(store().past)).not.toContain('scale = 3');
  });
});

describe('the sync engine and the panel', () => {
  const engine = readFileSync(path.join(__dirname, '../hooks/useSyncEngine.ts'), 'utf8');
  const panel = readFileSync(path.join(__dirname, '../components/CodeEditor/CodeEditor.tsx'), 'utf8');

  it('an Apply that dropped code holds the text, then runs the graph→code pass at once', () => {
    expect(engine).toContain('const keepsText = dropsCode(result.errors);');
    expect(engine).toContain('if (keepsText) useAppStore.getState().holdCodeDraft(codeStr, parseIds, parsedNames);');
    // A text kept from an earlier Apply that now reaches the graph whole is released.
    expect(engine).toContain('else if (heldText) useAppStore.setState({ codeDraft: null });');
    const at = engine.indexOf('const keepsText = dropsCode(result.errors);');
    const pass = engine.indexOf('emitGraphCode(applied.nodes, applied.edges, null, false);');
    expect(pass).toBeGreaterThan(at);
    // After the graph is in the store, before the report is.
    expect(at).toBeGreaterThan(engine.indexOf("setEdges(remappedEdges, 'code');"));
    expect(pass).toBeLessThan(engine.indexOf('setCodeErrors(result.errors);'));
  });

  it('reads a kept text under its own scope, and applies it only when it changed', () => {
    expect(engine).toContain('const scope = heldText ? heldText.emitted : useAppStore.getState().codeEmitted;');
    expect(engine).toContain('const textNames = scope !== null ? (heldText ? heldText.names : useAppStore.getState().codeNames) : null;');
    expect(engine).toMatch(/if \(draft\) \{\s*if \(draft\.code === draft\.applied\) return;\s*useAppStore\.setState\(\{ codeDraft: \{ \.\.\.draft, applied: draft\.code \} \}\);\s*void doCodeSync\(draft\.code\);\s*return;\s*\}/);
  });

  it('only the validator landing on an unchanged graph is a same-graph pass', () => {
    expect(engine).toContain('emitGraphCode(nodes, edges, nodePreview, revalidated && sameGraph);');
    expect(engine).toContain("setCode(result.code, 'graph', previewText, { emitted, names: result.varNames, nodeSpans: result.nodeSpans, sameGraph });");
  });

  it('the panel shows the kept text; the embed tabs read the graph\'s module', () => {
    expect(panel).toContain('const code = useAppStore(panelText);');
    expect(panel).toContain('const heldModuleCode = useAppStore((s) => (s.codeDraft ? s.code : null));');
    expect(panel).toContain('heldModuleCode ?? settledCode,');
    // Typing names its base, which is what tells a keystroke from a replace.
    expect(panel).toContain("setCode(value, 'code', undefined, { base });");
  });
});
