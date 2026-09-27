import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppNode } from '@/types';
import { makeEdge, makeNode } from '@/test-utils';
import { t } from '@/i18n';
import { importNoteLineText } from './importNote';
import { sinkModelIssue, SINK_MODEL_ISSUE_KEY, type SinkModelIssue } from './sinkModelFit';
import { sinkModelIssueText } from './sinkModelCopy';

/**
 * Which output node fits the 3D object on screen (utils/sinkModelFit.ts): the
 * one decision behind the preview pane's notice and the canvas note a wire
 * posts when it makes the pairing wrong.
 */

const out = (id: string, extra: Record<string, unknown> = {}): AppNode => {
  const n = makeNode(id, 'output');
  return { ...n, data: { ...n.data, ...extra } } as AppNode;
};
const sink = (id: string, type: 'raymarchOutput' | 'splatOutput', extra: Record<string, unknown> = {}): AppNode => {
  const n = makeNode(id, type);
  return { ...n, type, data: { ...n.data, ...extra } } as AppNode;
};
const f = makeNode('f1', 'float');
const SPLAT = { geometry: 'custom', splatLoaded: true };
const MESH = { geometry: 'custom', splatLoaded: false };
const SPHERE = { geometry: 'sphere', splatLoaded: false };

describe('sinkModelIssue', () => {
  it('a plain material on a mesh — the common case — is fine, wired or not', () => {
    expect(sinkModelIssue([f, out('o')], [makeEdge('f1', 'out', 'o', 'color')], MESH)).toBeNull();
    expect(sinkModelIssue([f, out('o')], [makeEdge('f1', 'out', 'o', 'color')], SPHERE)).toBeNull();
  });

  it('a WIRED Output on a shown splat does nothing to it; an unwired one reports nothing', () => {
    expect(sinkModelIssue([f, out('o')], [makeEdge('f1', 'out', 'o', 'color')], SPLAT)).toBe('output-on-splat');
    expect(sinkModelIssue([f, out('o')], [], SPLAT)).toBeNull();
    // The splat loaded but parked behind a primitive: the Output shades the sphere, fine.
    expect(sinkModelIssue([f, out('o')], [makeEdge('f1', 'out', 'o', 'color')], { geometry: 'sphere', splatLoaded: true })).toBeNull();
  });

  it('a wired Splat Output that is not the active output: says to activate it', () => {
    const nodes = [f, makeNode('f2', 'float'), out('o', { activeOutput: true }), sink('sp', 'splatOutput')];
    const edges = [makeEdge('f1', 'out', 'o', 'color'), makeEdge('f2', 'out', 'sp', 'opacity')];
    expect(sinkModelIssue(nodes, edges, SPLAT)).toBe('output-on-splat-parked');
  });

  it('a driving Splat Output: fine on a splat; pick it when parked; drop one when none', () => {
    const nodes = [f, out('o'), sink('sp', 'splatOutput')];
    const edges = [makeEdge('f1', 'out', 'sp', 'opacity')];
    expect(sinkModelIssue(nodes, edges, SPLAT)).toBeNull();
    // The drop advice is never the answer while the splat is one pick away.
    expect(sinkModelIssue(nodes, edges, { geometry: 'sphere', splatLoaded: true })).toBe('splat-pick-splat');
    expect(sinkModelIssue(nodes, edges, MESH)).toBe('splat-needs-splat');
    expect(sinkModelIssue(nodes, edges, SPHERE)).toBe('splat-needs-splat');
  });

  it('an UNLIT Splat Output fed by a Normal on a shown splat: the rim would be flat — says to React to light', () => {
    const nw = makeNode('nw', 'normalWorld');
    const nl = makeNode('nl', 'normalLocal');
    const dot = makeNode('d', 'dot');
    const om = makeNode('om', 'oneMinus');
    // Normal (world) → Dot → One Minus → Color, two hops from the sink.
    const rim = [makeEdge('nw', 'out', 'd', 'a'), makeEdge('d', 'out', 'om', 'x'), makeEdge('om', 'out', 'sp', 'color')];
    expect(sinkModelIssue([nw, dot, om, sink('sp', 'splatOutput')], rim, SPLAT)).toBe('splat-normal-faces-camera');
    // The object-space Normal too — both read `n` inside a splat program.
    expect(sinkModelIssue([nl, sink('sp', 'splatOutput')], [makeEdge('nl', 'out', 'sp', 'move')], SPLAT)).toBe('splat-normal-faces-camera');
    // Lit: `n` IS a surface normal there, so nothing to say.
    expect(sinkModelIssue([nw, dot, om, sink('sp', 'splatOutput', { values: { lit: true } })], rim, SPLAT)).toBeNull();
    // Only the literal `true` lights.
    expect(sinkModelIssue([nw, dot, om, sink('sp', 'splatOutput', { values: { lit: 'true' } })], rim, SPLAT)).toBe('splat-normal-faces-camera');
    // No Normal upstream: fine, as before.
    expect(sinkModelIssue([f, sink('sp', 'splatOutput')], [makeEdge('f1', 'out', 'sp', 'opacity')], SPLAT)).toBeNull();
    // A Normal that does not reach the sink says nothing.
    expect(sinkModelIssue([nw, f, sink('sp', 'splatOutput')], [makeEdge('f1', 'out', 'sp', 'opacity'), makeEdge('nw', 'out', 'd', 'a')], SPLAT)).toBeNull();
    // Not shown: the splat's own advice wins (drop / pick it).
    expect(sinkModelIssue([nw, dot, om, sink('sp', 'splatOutput')], rim, MESH)).toBe('splat-needs-splat');
    // An IMPLICIT read counts too: a noise whose stored position is a normal
    // is emitted as mx_noise_float(n) inside the splat program.
    const nz = makeNode('nz', 'perlin', { pos: 'normalWorld', scale: 1 });
    expect(sinkModelIssue([nz, sink('sp', 'splatOutput')], [makeEdge('nz', 'out', 'sp', 'color')], SPLAT)).toBe('splat-normal-faces-camera');
    // …while the same noise with its position WIRED reads the wire instead.
    const pos = makeNode('pos', 'positionLocal');
    expect(sinkModelIssue([pos, nz, sink('sp', 'splatOutput')], [makeEdge('pos', 'out', 'nz', 'pos'), makeEdge('nz', 'out', 'sp', 'color')], SPLAT)).toBeNull();
    // Unlit, a Light socket is read by NOTHING: a Normal reaching only one is
    // no flat rim (the wire is dormant — utils/splatLight.ts).
    expect(sinkModelIssue([nw, sink('sp', 'splatOutput')], [makeEdge('nw', 'out', 'sp', 'lightX')], SPLAT)).toBeNull();
    expect(sinkModelIssue([nw, f, sink('sp', 'splatOutput')], [makeEdge('nw', 'out', 'sp', 'ambient'), makeEdge('f1', 'out', 'sp', 'opacity')], SPLAT)).toBeNull();
    // A cycle in a tampered edge list cannot hang the walk.
    const loop = [...rim, makeEdge('om', 'out', 'd', 'b'), makeEdge('d', 'out', 'om', 'x')];
    expect(sinkModelIssue([nw, dot, om, sink('sp', 'splatOutput')], loop, SPLAT)).toBe('splat-normal-faces-camera');
  });

  it('the Normal walk is kept while the graph means the same (a drag frame), and redone when it does not', () => {
    const nw = makeNode('nw', 'normalWorld');
    const sp = sink('sp', 'splatOutput');
    const edges = [makeEdge('nw', 'out', 'sp', 'color')];
    const nodes = [nw, sp];
    expect(sinkModelIssue(nodes, edges, SPLAT)).toBe('splat-normal-faces-camera');
    // A drag: new arrays, new node objects, the SAME data — the same answer.
    const dragged = nodes.map((n) => ({ ...n, position: { x: n.position.x + 5, y: n.position.y } }));
    expect(sinkModelIssue(dragged, [...edges], SPLAT)).toBe('splat-normal-faces-camera');
    // The Normal swapped for a Float (new data): walked again, nothing to say.
    const swapped = [makeNode('nw', 'float'), sp];
    expect(sinkModelIssue(swapped, edges, SPLAT)).toBeNull();
    // …and a rewire is a semantic change too.
    expect(sinkModelIssue(nodes, [makeEdge('nw', 'out', 'sp', 'lightY')], SPLAT)).toBeNull();
    expect(sinkModelIssue(nodes, edges, SPLAT)).toBe('splat-normal-faces-camera');
    const src = readFileSync(join(__dirname, 'sinkModelFit.ts'), 'utf8');
    expect(src).toContain('sameGraphSemantics(last.nodes as AppNode[], nodes as AppNode[], last.edges as AppEdge[], edges as AppEdge[])');
  });

  it('a driving Raymarch Output: any mesh is a window; a splat has no surface', () => {
    const nodes = [f, out('o'), sink('rm', 'raymarchOutput')];
    const edges = [makeEdge('f1', 'out', 'rm', 'field')];
    expect(sinkModelIssue(nodes, edges, { geometry: 'marchSphere', splatLoaded: false })).toBeNull();
    expect(sinkModelIssue(nodes, edges, { geometry: 'bunny', splatLoaded: false })).toBeNull();
    expect(sinkModelIssue(nodes, edges, MESH)).toBeNull();
    expect(sinkModelIssue(nodes, edges, SPLAT)).toBe('march-on-splat');
  });

  it('a driving Raymarch Output silences the model’s WIRED per-mesh Outputs — and says so', () => {
    const nodes = [f, makeNode('f2', 'float'), out('o'), out('body', { meshTargets: ['Body'] }), sink('rm', 'raymarchOutput')];
    const wiredTarget = [makeEdge('f1', 'out', 'rm', 'field'), makeEdge('f2', 'out', 'body', 'color')];
    expect(sinkModelIssue(nodes, wiredTarget, MESH)).toBe('march-over-mesh-outputs');
    // Nothing wired into it: nothing is being hidden.
    expect(sinkModelIssue(nodes, [makeEdge('f1', 'out', 'rm', 'field')], MESH)).toBeNull();
    // Not the dropped model on screen: its per-mesh Outputs sleep anyway (their own note).
    expect(sinkModelIssue(nodes, wiredTarget, { geometry: 'marchSphere', splatLoaded: false })).toBeNull();
  });
});

describe('the words', () => {
  const ISSUES = Object.keys(SINK_MODEL_ISSUE_KEY) as SinkModelIssue[];

  it('every sentence is translated, and a {name} survives into both languages', () => {
    for (const issue of ISSUES) {
      const key = SINK_MODEL_ISSUE_KEY[issue];
      expect(t(key, 'lv'), key).not.toBe(key);
      if (key.includes('{name}')) expect(t(key, 'lv'), key).toContain('{name}');
    }
  });

  it('quotes and caps the model name, filled in one pass', () => {
    const text = sinkModelIssueText('march-on-splat', 'garden.splat', 'en');
    expect(text).toContain('“garden.splat”');
    expect(text).not.toContain('{');
    const long = sinkModelIssueText('output-on-splat', `${'x'.repeat(80)}.splat`, 'en');
    expect(long).toContain('…”');
    // A name spelling a placeholder is data, not a slot.
    expect(sinkModelIssueText('output-on-splat', '{name}', 'en')).toContain('“{name}”');
  });

  it('the canvas note renders the same sentence as the pane', () => {
    expect(importNoteLineText({ kind: 'sink-model', issue: 'output-on-splat', name: 'garden.splat' }, 'lv'))
      .toBe(sinkModelIssueText('output-on-splat', 'garden.splat', 'lv'));
  });
});

describe('the canvas note fires on a WIRE, not on a Model pick', () => {
  const PREVIEW = readFileSync(join(__dirname, '../components/Preview/ShaderPreview.tsx'), 'utf8');

  it('posts only on a graph-caused change, never over a note or in a study session', () => {
    const at = PREVIEW.indexOf('const lastFitRef = useRef(');
    const end = PREVIEW.indexOf('}, [sinkIssue, shownModelKey, litSplats]);', at);
    expect(end).toBeGreaterThan(at);
    const effect = PREVIEW.slice(at, end);
    expect(effect).toContain('shownModelKey !== prev.shownModelKey');
    // A React to light change in the same step is a SETTING, not a wire: the
    // Normal notice asks for that very box, so unticking it must not post
    // "tick React to light".
    expect(PREVIEW).toContain('const litSplats = useAppStore((s) => litSplatCount(s.nodes));');
    expect(effect).toContain('litSplats !== prev.litSplats');
    expect(effect).toContain('sinkIssue === prev.issue');
    expect(effect).toContain('isEvalMode()');
    expect(effect).toContain('if (store.importNote) return;');
    expect(effect).toContain("store.showImportNote([{ kind: 'sink-model', issue: sinkIssue,");
  });
});
