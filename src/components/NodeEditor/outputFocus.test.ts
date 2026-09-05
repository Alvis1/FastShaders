import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FitViewOptions } from '@xyflow/react';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import {
  costFocusId,
  focusNodes,
  focusOutputNode,
  focusTargets,
  outputFocusTarget,
  OUTPUT_FOCUS_FIT,
} from './outputFocus';

/**
 * The "take me there" framing every canvas glide shares — see outputFocus.ts.
 * The pure half is unit-tested; the call sites are source-pinned, because the
 * failure mode of losing one is SILENT (a click that does nothing).
 *
 * Until 2026-09-03 the Output was a SINGLETON and every add surface REDIRECTED
 * to it; several output nodes may coexist now (one ACTIVE —
 * utils/sdfPartition.ts `activeSink`), so the pins below assert the OPPOSITE:
 * an add surface adds, and nothing redirects.
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

const group = (id: string, collapsed: boolean, parentId?: string): AppNode =>
  ({
    id,
    type: 'group',
    parentId,
    position: { x: 0, y: 0 },
    data: { label: id, collapsed },
  }) as unknown as AppNode;

describe('outputFocusTarget', () => {
  it('aims at the Output itself when it is not inside a collapsed group', () => {
    const out = makeNode('out1', 'output');
    expect(outputFocusTarget([out], 'out1')).toBe('out1');
    const inExpanded = { ...makeNode('out1', 'output'), parentId: 'g1' } as AppNode;
    expect(outputFocusTarget([group('g1', false), inExpanded], 'out1')).toBe('out1');
  });

  it('aims at the collapsed group pill hiding the Output (display:none member, not `hidden` — fitView would frame an invisible box)', () => {
    const member = { ...makeNode('out1', 'output'), parentId: 'g1' } as AppNode;
    expect(outputFocusTarget([group('g1', true), member], 'out1')).toBe('g1');
  });

  it('aims at the TOPMOST collapsed ancestor of a nested group', () => {
    const member = { ...makeNode('out1', 'output'), parentId: 'inner' } as AppNode;
    const nodes = [group('outer', true), group('inner', true, 'outer'), member];
    expect(outputFocusTarget(nodes, 'out1')).toBe('outer');
  });

  it('terminates on a parentId cycle (tampered file)', () => {
    const a = group('a', true, 'b');
    const b = group('b', true, 'a');
    const member = { ...makeNode('out1', 'output'), parentId: 'a' } as AppNode;
    expect(outputFocusTarget([a, b, member], 'out1')).toBe('b');
  });
});

describe('focusOutputNode', () => {
  it('asks fitView for exactly the Output node, animated, zoom-capped', () => {
    const calls: FitViewOptions[] = [];
    const out = makeNode('out1', 'output');
    focusOutputNode((o) => {
      calls.push(o!);
    }, [out], 'out1');
    expect(calls).toHaveLength(1);
    expect(calls[0].nodes).toEqual([{ id: 'out1' }]);
    // Animated: an instant viewport jump reads as the canvas breaking, not as
    // "here is your Output".
    expect(calls[0].duration).toBeGreaterThan(0);
    // Capped: uncapped, fitting one ~140px node slams the zoom to maximum.
    expect(calls[0].maxZoom).toBe(OUTPUT_FOCUS_FIT.maxZoom);
    expect(OUTPUT_FOCUS_FIT.maxZoom).toBeLessThanOrEqual(1.5);
  });

  it('fits the collapsed-group pill when the Output is a hidden member', () => {
    const calls: FitViewOptions[] = [];
    const member = { ...makeNode('out1', 'output'), parentId: 'g1' } as AppNode;
    focusOutputNode((o) => {
      calls.push(o!);
    }, [group('g1', true), member], 'out1');
    expect(calls[0].nodes).toEqual([{ id: 'g1' }]);
  });
});

describe('focusNodes / focusTargets — the F key and every other "take me there"', () => {
  it('frames every selected node, in selection order', () => {
    const nodes = [makeNode('a', 'float'), makeNode('b', 'mul'), makeNode('c', 'output')];
    expect(focusTargets(nodes, ['c', 'a'])).toEqual([{ id: 'c' }, { id: 'a' }]);
  });

  it('collapses two selected members of one collapsed group into its pill, once', () => {
    const m1 = { ...makeNode('m1', 'float'), parentId: 'g1' } as AppNode;
    const m2 = { ...makeNode('m2', 'mul'), parentId: 'g1' } as AppNode;
    expect(focusTargets([group('g1', true), m1, m2], ['m1', 'm2'])).toEqual([{ id: 'g1' }]);
  });

  it('drops ids that are not nodes (a stale selection after an undo)', () => {
    expect(focusTargets([makeNode('a', 'float')], ['zzz', 'a'])).toEqual([{ id: 'a' }]);
  });

  it('glides with the Output framing and reports whether anything was framed', () => {
    const calls: FitViewOptions[] = [];
    const fit = (o?: FitViewOptions) => {
      calls.push(o!);
    };
    const nodes = [makeNode('a', 'float'), makeNode('b', 'mul')];
    expect(focusNodes(fit, nodes, ['a', 'b'])).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].nodes).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(calls[0].duration).toBe(OUTPUT_FOCUS_FIT.duration);
    expect(calls[0].maxZoom).toBe(OUTPUT_FOCUS_FIT.maxZoom);
    // Nothing to frame → nothing sent: an empty `nodes` list would make
    // fitView frame the WHOLE graph, which is the caller's decision to make.
    expect(focusNodes(fit, nodes, [])).toBe(false);
    expect(focusNodes(fit, nodes, ['nope'])).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('focusOutputNode is the single-node case of focusNodes', () => {
    const calls: FitViewOptions[] = [];
    focusOutputNode((o) => {
      calls.push(o!);
    }, [makeNode('out1', 'output')], 'out1');
    expect(calls[0].nodes).toEqual([{ id: 'out1' }]);
  });
});

describe('the F key (source pins)', () => {
  const nodeEditor = read('./NodeEditor.tsx');

  it('frames the selection through focusNodes, falling back to fitting the whole graph', () => {
    // The key must route through the SHARED glide, or F would frame the
    // selection differently from how the Output tile / cost pill frame the
    // Output — same node, two framings.
    expect(nodeEditor).toMatch(/key === 'f' && !e\.shiftKey[\s\S]{0,600}focusNodes\(fitView, nodesNow, selected\)/);
    expect(nodeEditor).toMatch(/if \(!focusNodes\(fitView, nodesNow, selected\)\) \{\s*void fitView\(\{ \.\.\.FIT_VIEW_OPTIONS, duration: OUTPUT_FOCUS_FIT\.duration \}\)/);
  });

  it('never fires while typing or with a modifier held (Cmd/Ctrl+F is the browser\'s find)', () => {
    const handler = nodeEditor.slice(nodeEditor.indexOf('F frames the SELECTION'), nodeEditor.indexOf("key !== 'a'"));
    expect(handler).toContain("if (tag === 'INPUT' || tag === 'TEXTAREA') return;");
    expect(handler).toContain('if (e.metaKey || e.ctrlKey || e.altKey) return;');
    expect(handler).toContain("if (tag === 'SELECT' || target?.isContentEditable) return;");
  });
});

describe('several outputs, one active (source pins)', () => {
  const nodeEditor = read('./NodeEditor.tsx');
  const addNodeMenu = read('./menus/AddNodeMenu.tsx');
  const contentBrowser = read('./ContentBrowser.tsx');
  const previewCard = read('./NodePreviewCard.tsx');

  it('placeTilePayload ADDS an Output — no redirect, no silent return', () => {
    expect(
      nodeEditor.includes("registryType === 'output')) return"),
      'placeTilePayload has regrown its silent-return Output guard',
    ).toBe(false);
    const place = nodeEditor.slice(
      nodeEditor.indexOf('const placeTilePayload'),
      nodeEditor.indexOf('const placeCsvFile'),
    );
    expect(place.includes('focusOutputNode('), 'the singleton redirect is back').toBe(false);
    expect(place.includes('existingOutputId('), 'the singleton lookup is back').toBe(false);
    // The Output branch of the placement still exists and adds a node.
    expect(/if \(def\.type === 'output'\) \{[\s\S]{0,900}?addNode\(newNode\)/.test(place)).toBe(true);
  });

  it('the tile drag preview treats an Output tile like any other (no presence gate)', () => {
    const preview = nodeEditor.slice(
      nodeEditor.indexOf('const previewTileConnect'),
      nodeEditor.indexOf('const placeTilePayload'),
    );
    expect(preview.includes("def.type === 'output'"), 'an Output-tile gate is back in the connect preview').toBe(false);
  });

  it("the Add-node menu's Output row is OFFERED and simply adds", () => {
    expect(addNodeMenu.includes('canAddOutput'), 'the Output row must not hide behind a presence gate').toBe(false);
    expect(addNodeMenu.includes('existingOutputId'), 'the singleton lookup is back in the menu').toBe(false);
    expect(addNodeMenu.includes('focusOutputNode('), 'the singleton redirect is back in the menu').toBe(false);
    expect(/if \(def\.type === 'output'\) \{[\s\S]{0,900}?addNode\(newNode\)/.test(addNodeMenu)).toBe(true);
  });

  it('a paste or duplicate keeps Output nodes and strips the active flag off the clones', () => {
    const paste = nodeEditor.slice(nodeEditor.indexOf('function pasteNodes('), nodeEditor.indexOf('const clones = sourceNodes.map') + 600);
    expect(paste.includes("registryType !== 'output'"), 'Outputs are being dropped from the clone set again').toBe(false);
    expect(paste).toContain('delete (cloned.data as Record<string, unknown>).activeOutput');
  });

  it('the ContentBrowser offers the Output tile (tab + All + search)', () => {
    expect(contentBrowser.includes("c.id !== 'output'"), 'the Output category tab has been excluded from the strip again').toBe(false);
    expect(contentBrowser.includes("d.type !== 'output'"), 'the Output def has been filtered out of the tile set again').toBe(false);
  });

  it("the Output tile's accessible name promises an add, because it adds", () => {
    expect(previewCard.includes('redirectsToOutput'), 'the go-to wording is back on the tile').toBe(false);
  });
});

describe('costFocusId — the node the cost pill glides to', () => {
  const pos = makeNode('pos', 'positionLocal');
  const sd = makeNode('sd', 'sdCircle');
  const rm = makeNode('rm', 'raymarchOutput');
  const out = makeNode('out1', 'output');
  const marchWired = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field')];

  it('is the DRIVING Raymarch Output, even when a plain Output also exists', () => {
    expect(costFocusId([pos, sd, rm, out], marchWired)).toBe('rm');
    expect(costFocusId([pos, sd, rm], marchWired)).toBe('rm');
  });
  it('falls back to the Output when the Raymarch Output is present but unwired', () => {
    expect(costFocusId([pos, sd, rm, out], marchWired.slice(0, 1))).toBe('out1');
  });
  it('is null with neither (the pill renders inert)', () => {
    expect(costFocusId([pos, sd], [])).toBeNull();
    expect(costFocusId([pos, sd, rm], [])).toBeNull();
  });
  it('follows the ACTIVE flag over wiring: a flagged Output silences a wired march, a flagged march drives unwired', () => {
    const flaggedOut = { ...out, data: { ...out.data, activeOutput: true } } as AppNode;
    expect(costFocusId([pos, sd, rm, flaggedOut], marchWired)).toBe('out1');
    const flaggedRm = { ...rm, data: { ...rm.data, activeOutput: true } } as AppNode;
    expect(costFocusId([pos, sd, flaggedRm, out], [])).toBe('rm');
    // A second, flagged plain Output outranks the first in array order.
    const out2 = { ...makeNode('out2', 'output'), data: { ...makeNode('out2', 'output').data, activeOutput: true } } as AppNode;
    expect(costFocusId([out, out2], [])).toBe('out2');
  });
  it('the cost pill reads it at click time AND for its enabled state', () => {
    const nodeEditor = read('./NodeEditor.tsx');
    const pill = nodeEditor.slice(nodeEditor.indexOf('const focusOutput = useCallback('), nodeEditor.indexOf('const viewportSaveRef'));
    expect(pill).toContain('costFocusId(nodesNow, edgesNow)');
    expect(pill).toContain('costFocusId(nodes, edges) != null');
  });
});
