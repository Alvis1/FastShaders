import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FitViewOptions } from '@xyflow/react';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import {
  existingOutputId,
  firstFreeOutputChannel,
  focusOutputNode,
  outputFocusTarget,
  OUTPUT_FOCUS_FIT,
} from './outputFocus';

/**
 * The Output node is a SINGLETON, and every surface that offers it must turn
 * into a "take me to it" affordance once one exists — see outputFocus.ts.
 * The pure half is unit-tested; the call sites are source-pinned, because the
 * failure mode of losing one is SILENT (a drop or click that does nothing).
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

describe('existingOutputId', () => {
  it('returns null when the graph has no Output', () => {
    expect(existingOutputId([makeNode('a', 'add'), makeNode('b', 'float')])).toBeNull();
    expect(existingOutputId([])).toBeNull();
  });

  it('returns the Output node id', () => {
    const nodes = [makeNode('a', 'add'), makeNode('out1', 'output')];
    expect(existingOutputId(nodes)).toBe('out1');
  });

  it('returns the FIRST Output when a foreign file carries several (pre-fold)', () => {
    const nodes = [makeNode('out1', 'output'), makeNode('out2', 'output')];
    expect(existingOutputId(nodes)).toBe('out1');
  });
});

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

describe('firstFreeOutputChannel', () => {
  const CHANNELS = [
    { id: 'color' },
    { id: 'emissive' },
    { id: 'roughness' },
    { id: 'position' },
  ];

  it('picks the first exposed channel on a fresh Output (implicit defaults)', () => {
    const out = makeNode('out1', 'output');
    expect(firstFreeOutputChannel(out, [], CHANNELS)).toBe('color');
  });

  it('skips a channel that already carries an edge', () => {
    const out = makeNode('out1', 'output');
    const edges = [makeEdge('src', 'out', 'out1', 'color')];
    expect(firstFreeOutputChannel(out, edges, CHANNELS)).toBe('roughness');
  });

  it('never lands on a HIDDEN channel — an edge at an unmounted socket is the documented silent failure', () => {
    const out = makeNode('out1', 'output');
    (out.data as { exposedPorts?: string[] }).exposedPorts = ['emissive'];
    // emissive is free and exposed; color is free but hidden.
    expect(firstFreeOutputChannel(out, [], CHANNELS)).toBe('emissive');
  });

  it('returns null when every exposed channel is taken (the caller then only focuses)', () => {
    const out = makeNode('out1', 'output');
    (out.data as { exposedPorts?: string[] }).exposedPorts = ['color'];
    const edges = [makeEdge('src', 'out', 'out1', 'color')];
    expect(firstFreeOutputChannel(out, edges, CHANNELS)).toBeNull();
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

describe('singleton call sites (source pins)', () => {
  const nodeEditor = read('./NodeEditor.tsx');
  const addNodeMenu = read('./menus/AddNodeMenu.tsx');
  const contentBrowser = read('./ContentBrowser.tsx');
  const previewCard = read('./NodePreviewCard.tsx');

  it('placeTilePayload redirects an Output drop to the existing node — never a silent return', () => {
    // The old guard: `if (currentNodes.some(... === 'output')) return;` — a
    // drop that does NOTHING, which reads as a broken tile.
    expect(
      nodeEditor.includes("registryType === 'output')) return"),
      'placeTilePayload has regrown its silent-return Output guard',
    ).toBe(false);
    const place = nodeEditor.slice(
      nodeEditor.indexOf('const placeTilePayload'),
      nodeEditor.indexOf('const placeCsvFile'),
    );
    expect(
      /if \(dropDef\?\.type === 'output'\) \{[\s\S]{0,600}?focusOutputNode\(/.test(place),
      "placeTilePayload's Output redirect must focusOutputNode when one exists",
    ).toBe(true);
    // The redirect must run BEFORE the asset-drop telemetry: a redirected drop
    // places nothing, and an eval session must not count a phantom placement.
    // (Anchored on the event name, not the logger call — evalHooks.test.ts
    // sweeps src for the call form and this file is not a chokepoint.)
    expect(
      place.indexOf('focusOutputNode('),
      'the Output redirect must precede the asset-drop telemetry',
    ).toBeLessThan(place.indexOf("'asset-drop'"));
  });

  it('the tile drag preview promises nothing for an Output drop that will redirect', () => {
    const preview = nodeEditor.slice(
      nodeEditor.indexOf('const previewTileConnect'),
      nodeEditor.indexOf('const placeTilePayload'),
    );
    expect(
      preview.includes('existingOutputId('),
      'previewTileConnect must suppress the phantom connect preview for an Output tile once an Output exists — the drop is redirected to a zoom, so a previewed wire would be a lie',
    ).toBe(true);
  });

  it("the Add-node menu's Output row stays OFFERED and zooms to the existing node", () => {
    expect(
      addNodeMenu.includes('canAddOutput'),
      'the Output row must not be hidden behind a presence gate — a vanished row reads as the node not existing; once an Output exists the row is "take me to it"',
    ).toBe(false);
    expect(
      /if \(def\.type === 'output'\) \{[\s\S]{0,1600}?focusOutputNode\(/.test(addNodeMenu),
      "handleAddNode's Output branch must focusOutputNode when one exists (covers browse row AND search results)",
    ).toBe(true);
  });

  it('a wire dropped on empty canvas that picks Output CONNECTS to the existing node', () => {
    // The menu can open from a dangling wire (sourceNodeId set); every other
    // def auto-connects, so the Output pick discarding the wire silently would
    // make the same gesture connect in one state and vanish in the other.
    const branch = addNodeMenu.slice(
      addNodeMenu.indexOf("if (def.type === 'output')"),
      addNodeMenu.indexOf('newNodeId = generateId()'),
    );
    expect(
      branch.includes('sourceNodeId') && branch.includes('firstFreeOutputChannel('),
      "the Output-exists branch must honour a wire-drop's promised connection via firstFreeOutputChannel",
    ).toBe(true);
  });

  it('the ContentBrowser offers the Output tile (tab + All + search)', () => {
    // Either exclusion regrowing removes the "dragged from assets" path.
    expect(
      contentBrowser.includes("c.id !== 'output'"),
      'the Output category tab has been excluded from the strip again',
    ).toBe(false);
    expect(
      contentBrowser.includes("d.type !== 'output'"),
      'the Output def has been filtered out of the tile set again',
    ).toBe(false);
  });

  it("the Output tile's accessible name says it redirects — not that it adds", () => {
    expect(
      previewCard.includes('redirectsToOutput'),
      'NodePreviewCard must swap the "Add Output node" activation label for the go-to wording once an Output exists — a label promising an add that will not happen is a lie to screen readers',
    ).toBe(true);
  });

  // (The socket's canvas-token scoping is pinned where the socket's other
  // rules live: outputTargetChip.test.ts.)
});
