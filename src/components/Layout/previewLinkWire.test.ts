import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeNode, makeEdge, makeGlb, gltfPrimitiveDoc, TRIANGLE_POSITIONS } from '@/test-utils';
import { createPreviewMesh } from '@/utils/previewMesh';
import type { AppNode } from '@/types';
import { previewWireTargets } from '@/utils/outputMaterials';
import { linkLabelText } from '@/components/NodeEditor/nodes/sectionLabelText';
import type { LinkWire } from './previewLinkGeometry';
import { setLivePreviewWires, livePreviewWires, pickLivePreviewWire } from './previewLinkHit';

/**
 * The decorative Output→preview wires — ONE PER CONTRIBUTING OUTPUT NODE since
 * the per-material split, each hoverable (its mesh name) and clickable (glide
 * to that node).
 *
 * The vitest env is `node`: there is no pane, no rect and no pointer, so the
 * DOM half — the hit radius against a real canvas, a wire running under a
 * card, the label's edge clamping — can only be SOURCE-pinned here and has to
 * be checked on the owner's screen. What IS executable is the wire SET (which
 * Outputs get a wire, in which order, with what label), the registry the pane
 * click reads, and the geometry (previewLinkGeometry.test.ts).
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
const LINK = read('./PreviewLink.tsx');
const WIRES = read('./previewWires.ts');
const LINK_CSS = read('./PreviewLink.css');
const NODE_EDITOR = read('../NodeEditor/NodeEditor.tsx');

/** An Output node with an optional binding and an explicit emit rank. */
const out = (id: string, data: Record<string, unknown> = {}): AppNode => {
  const n = makeNode(id, 'output');
  Object.assign(n.data as Record<string, unknown>, data);
  return n;
};

/** The whole-store shape previewWireTargets reads. */
const state = (nodes: AppNode[], extra: Partial<{
  edges: ReturnType<typeof makeEdge>[];
  previewMesh: unknown;
  previewMeshInventory: { meshes?: { name: string }[] } | null;
}> = {}) => ({
  nodes,
  edges: extra.edges ?? [],
  previewMesh: extra.previewMesh ?? null,
  previewMeshInventory: extra.previewMeshInventory ?? null,
});

describe('previewWireTargets — which Outputs get a wire', () => {
  it('is one wire for a plain single-Output shader, labelled "All meshes"', () => {
    const wires = previewWireTargets(state([out('o1')]));
    expect(wires).toEqual([{ id: 'o1', label: { kind: 'default' } }]);
    expect(linkLabelText(wires[0].label, 'en')).toBe('All meshes');
    expect(linkLabelText(wires[0].label, 'lv')).toBe('Visi');
  });

  it('no Output, no wire', () => {
    expect(previewWireTargets(state([makeNode('m', 'mul')]))).toEqual([]);
  });

  it('is ONE PER CONTRIBUTING NODE — the default plus every targeted Output', () => {
    // The split's whole shape: the untargeted default holds the module's
    // top-level channels, each targeted node its own `parts` entry.
    const wires = previewWireTargets(state([
      out('def'),
      out('body', { meshTargets: ['Body'], emitOrder: 1 }),
      out('glass', { meshTargets: ['Glass'], emitOrder: 2 }),
    ], { previewMesh: {}, previewMeshInventory: { meshes: [{ name: 'Body' }, { name: 'Glass' }] } }));
    expect(wires.map((w) => w.id)).toEqual(['def', 'body', 'glass']);
    expect(wires.map((w) => linkLabelText(w.label, 'en'))).toEqual(['All meshes', 'Body', 'Glass']);
  });

  it('a mesh section naming SEVERAL meshes shows the first plus an ellipsis', () => {
    // The owner's own words: "shows mesh name or all or first mesh and … dots
    // indicating multiple". The ellipsis is a separate word — the node picker's
    // rule — because the thing worth reading is WHICH mesh, then "there are
    // more".
    const wires = previewWireTargets(state([
      out('def'),
      out('many', { meshTargets: ['Body', 'Glass', 'Wheel'], emitOrder: 1 }),
    ], { previewMesh: {}, previewMeshInventory: { meshes: [{ name: 'Body' }] } }));
    expect(wires.map((w) => w.id)).toEqual(['def', 'many']);
    expect(linkLabelText(wires[1].label, 'en')).toBe('Body …');
  });

  it('an import-built INDEX node names its glTF material — and sleeps on another model', () => {
    // Real bytes through `createPreviewMesh`, the one constructor the drop, the
    // zip import and the IndexedDB restore share, so these are the trusted
    // facts the node really sees rather than the sandbox's forgeable inventory.
    const sig = ['Paint', ''];
    const glb = makeGlb(gltfPrimitiveDoc({
      materials: [{ name: 'Paint' }, {}],
      meshes: [
        { name: 'Body', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
        { name: 'Trim', primitives: [{ attributes: { POSITION: 0 }, material: 1 }] },
      ],
      nodes: [{ mesh: 0 }, { mesh: 1 }],
      scenes: [{ nodes: [0, 1] }],
      scene: 0,
    }), TRIANGLE_POSITIONS.slice());
    const r = createPreviewMesh('paint.glb', glb);
    if (!('mesh' in r)) throw new Error('refused: ' + r.error);

    const nodes = [
      out('def'),
      out('m0', { gltfMaterialIndex: 0, modelSignature: { materials: sig }, emitOrder: 1 }),
      out('m1', { gltfMaterialIndex: 1, modelSignature: { materials: sig }, emitOrder: 2 }),
    ];
    const wires = previewWireTargets(state(nodes, { previewMesh: r.mesh }));
    expect(wires.map((w) => linkLabelText(w.label, 'en'))).toEqual([
      'All meshes', 'Paint', 'Material #1',
    ]);
    // An unnamed glTF material is numbered 0-based, as in the glTF JSON.
    expect(linkLabelText(wires[2].label, 'lv')).toBe('Materiāls #1');
    // With no glTF on screen the index nodes sleep, so only the default's wire
    // is drawn — the wiring is untouched and the wires return with the model.
    expect(previewWireTargets(state(nodes)).map((w) => w.id)).toEqual(['def']);
  });

  it('a PARKED untargeted Output gets NO wire — it contributes nothing', () => {
    // Among untargeted Outputs exactly one contributes; a wire from the parked
    // one would claim the viewer renders what it does not. (It is still on the
    // canvas, still wired, one socket click from being the default again.)
    const flagged = out('live', { activeOutput: true });
    const wires = previewWireTargets(state([out('parked'), flagged]));
    expect(wires.map((w) => w.id)).toEqual(['live']);
  });

  it('a DORMANT Output gets no wire — it mounts no socket to anchor one on', () => {
    // Its every mesh absent from the loaded model: the node renders
    // header-plus-chip and unmounts the preview socket, so a wire for it would
    // have no anchor at all and the element cache would re-query every frame.
    const nodes = [out('def'), out('body', { meshTargets: ['Body'], emitOrder: 1 })];
    const reported = (names: string[]) => state(nodes, {
      previewMesh: {},
      previewMeshInventory: { meshes: names.map((name) => ({ name })) },
      // A contributing default disarms the 0.6 single-mesh fallback exemption,
      // which would otherwise keep the first named material awake.
      edges: [makeEdge('c', 'out', 'def', 'color')],
    });
    expect(previewWireTargets(reported(['Body', 'Other'])).map((w) => w.id)).toEqual(['def', 'body']);
    expect(previewWireTargets(reported(['Other', 'Else'])).map((w) => w.id)).toEqual(['def']);
    // …and it comes straight back when a matching model is loaded. Visibility
    // only: nothing about the node changed.
    expect(previewWireTargets(reported(['Body', 'Other'])).map((w) => w.id)).toEqual(['def', 'body']);
  });

  it('a model LOADED but not yet reported hides nothing (the inventory hold-off)', () => {
    const nodes = [out('def'), out('body', { meshTargets: ['Body'], emitOrder: 1 })];
    expect(
      previewWireTargets(state(nodes, { previewMesh: {}, previewMeshInventory: null }))
        .map((w) => w.id),
    ).toEqual(['def', 'body']);
  });

  it('follows EMIT order, never the nodes array — a drag-into-a-group reorders that array', () => {
    // `liftChildrenAfterParents` splices a node into a new slot on an ordinary
    // drag, and `useSyncEngine` reorders on every Apply. Reading the wire order
    // off the array would renumber the wires on a gesture that changed nothing.
    const nodes = [
      out('b', { meshTargets: ['B'], emitOrder: 2 }),
      out('def'),
      out('a', { meshTargets: ['A'], emitOrder: 1 }),
    ];
    const ids = previewWireTargets(state(nodes, {
      previewMesh: {}, previewMeshInventory: { meshes: [{ name: 'A' }, { name: 'B' }] },
    })).map((w) => w.id);
    expect(ids).toEqual(['def', 'a', 'b']);
    // Permuting the array must not move a single wire.
    const permuted = previewWireTargets(state([nodes[2], nodes[0], nodes[1]], {
      previewMesh: {}, previewMeshInventory: { meshes: [{ name: 'A' }, { name: 'B' }] },
    })).map((w) => w.id);
    expect(permuted).toEqual(ids);
  });
});

describe('the live wire registry — what the pane click reads', () => {
  afterEach(() => setLivePreviewWires([]));

  const wire = (id: string, sy: number): LinkWire => ({
    id, label: id, start: { x: 0, y: sy }, end: { x: 600, y: 300 },
  });

  it('starts empty, publishes, and clears', () => {
    expect(livePreviewWires()).toEqual([]);
    expect(pickLivePreviewWire(300, 300)).toBeNull();
    setLivePreviewWires([wire('b', 300)]);
    expect(livePreviewWires().map((w) => w.id)).toEqual(['b']);
    expect(pickLivePreviewWire(300, 300)?.wire.id).toBe('b');
    // PreviewLink's unmount cleanup: a stale registry would answer a LATER
    // pane click with wires that are no longer drawn anywhere.
    setLivePreviewWires([]);
    expect(pickLivePreviewWire(300, 300)).toBeNull();
  });

  it('answers with the same radius the hover uses, so the two agree', () => {
    setLivePreviewWires([wire('b', 300)]);
    expect(pickLivePreviewWire(300, 311)?.wire.id).toBe('b');
    expect(pickLivePreviewWire(300, 313)).toBeNull();
  });
});

describe('PreviewLink wiring (source pins — no DOM in this env)', () => {
  it('draws one wire per contributing Output and anchors each on its OWN node', () => {
    // The derivation lives in `previewWires.ts` since the RAILS needed it too:
    // the wire, the canvas-edge socket it ends on and the preview socket that
    // mirrors it are ONE connection seen three times, and a condition gained by
    // one list and not the others would draw a wire ending on nothing.
    expect(WIRES).toContain('previewWireTargets(s');
    expect(LINK).toContain('useAppStore(wireTargetsKey)');
    expect(LINK).toContain('const pathCount = wires.length;');
    expect(LINK).toContain("nodeEls[i]?.querySelector<HTMLElement>('.output-node__preview-socket')");
  });

  it('the anchor cache is keyed on the contributing-id LIST, never a COUNT', () => {
    // Two nodes swapping identity keeps the count equal while every cached
    // element is the wrong node's — the wires would be drawn from the wrong
    // cards, with nothing to say so and no frame in which it self-corrects.
    expect(LINK).toContain('const key = idsKey(list);');
    expect(LINK).toContain('if (key !== cacheKey) {');
    // idsKey is length-prefixed, so it stays injective for ids out of a
    // `.fastshader` file, which may spell anything at all.
    expect(LINK).toMatch(/function idsKey[\s\S]*?\$\{w\.id\.length\}:\$\{w\.id\};/);
    // A count-keyed cache would look like this and must not come back.
    expect(LINK).not.toMatch(/!==\s*pathCountRef\.current/);
  });

  it('the hover is imperative, gated on the PANE, and stood down during a gesture', () => {
    // A React render per pointermove is exactly what this component's memo()
    // exists to avoid.
    expect(LINK).toContain("classList.add('preview-link__path--hot')");
    expect(LINK).toContain('label.textContent = hit.wire.label;');
    // Live only over the pane — the same condition under which a press reaches
    // React Flow's onPaneClick, so hover and click cannot disagree about what
    // is hittable (a wire under a node card is neither).
    expect(LINK).toContain("target.classList.contains('react-flow__pane')");
    // A node drag, a pan, a marquee, a connection drag or a seam drag owns the
    // pointer; nothing is being inspected mid-gesture.
    expect(LINK).toContain("root.contains('fs-canvas-busy') || root.contains('fs-dragging')");
    // Capture phase: a bubble listener can be cut off by any descendant's
    // stopPropagation, and this must see every move to know when the pointer
    // LEAVES a wire.
    expect(LINK).toContain("host?.addEventListener('pointermove', onMove, true);");
    // It never preventDefaults or stops propagation — that is what keeps it
    // out of the way of a drag, a marquee and a connection.
    const effect = LINK.slice(LINK.indexOf('const onMove ='), LINK.indexOf('raf = requestAnimationFrame(tick);'));
    expect(effect).not.toContain('preventDefault');
    expect(effect).not.toContain('stopPropagation');
  });

  it('nothing imperative outlives the canvas', () => {
    const cleanup = LINK.slice(LINK.indexOf('return () => {\n      cancelAnimationFrame(raf);'));
    expect(cleanup).toContain("removeEventListener('pointermove', onMove, true)");
    expect(cleanup).toContain("removeEventListener('pointerleave', clearHot)");
    expect(cleanup).toContain('clearHot();');
    expect(cleanup).toContain('setLivePreviewWires([]);');
  });

  it('the label is its own element, because a `title` on an SVG path never opens', () => {
    // TooltipLayer's findHost requires an HTMLElement (`closest('[title]')`
    // from elementFromPoint), so a title on a <path> is silently dead.
    expect(LINK).toContain('className="preview-link__label"');
    expect(LINK).not.toMatch(/<path[^>]*title=/);
  });

  it('the wire layer stays unhittable — pointer-events is only ever `none`', () => {
    // The hit test MUST be the pure distance function: `.preview-link` is a
    // z-index -1 sibling of `.react-flow__renderer`, itself a stacking context
    // wrapping the pane, so making the wire hittable means lifting the layer
    // over every node card — where it would swallow presses aimed at the graph.
    // A future reader's first instinct is to flip this value.
    const values = [...LINK_CSS.matchAll(/pointer-events:\s*([a-z-]+)/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values)).toEqual(new Set(['none']));
  });
});

describe('clicking a wire glides to its Output (source pins)', () => {
  const pane = NODE_EDITOR.slice(
    NODE_EDITOR.indexOf('const onPaneClick = useCallback('),
    NODE_EDITOR.indexOf('const outputCycleRef'),
  );

  it('routes through React Flow\'s own onPaneClick, which already guards the gestures', () => {
    // It is the only signal that knows a marquee did not just end
    // (`selectionInProgress`), no connection is in progress, and the press
    // landed on the PANE rather than on a node card. Re-deriving any of that
    // is the fragile duplication this avoids.
    expect(NODE_EDITOR).toContain('onPaneClick={onPaneClick}');
    expect(pane).toContain('pickLivePreviewWire(event.clientX, event.clientY)');
    // The SAME glide every other "take me there" gesture uses.
    expect(pane).toContain('focusNode(fitView, useAppStore.getState().nodes, hit.wire.id)');
  });

  it('eats nothing: the menu and the peek still close FIRST, and a non-primary button is out', () => {
    expect(pane.indexOf('closeContextMenu();')).toBeLessThan(pane.indexOf('pickLivePreviewWire'));
    expect(pane.indexOf('setPeekNodeId(null);')).toBeLessThan(pane.indexOf('pickLivePreviewWire'));
    // `click` does not fire for the middle button (that is `auxclick`), so a
    // middle-drag pan cannot reach this — belt-and-braces for a future path.
    expect(pane).toContain('if ((event.button ?? 0) !== 0) return;');
  });
});
