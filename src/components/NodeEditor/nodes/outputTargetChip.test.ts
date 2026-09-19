/**
 * The Output node's mesh PICKER must never widen the node.
 *
 * (Written for the target chip of the multi-Output design; the chip is gone,
 * the constraint is not — the same attacker-supplied string now sits in a
 * `<select>` on every added material.)
 *
 * A source pin rather than a rendered measurement, because the vitest env is
 * `node`. What it guards is a defect that CSS alone made invisible: the chip
 * carries the full ellipsis kit (`overflow: hidden`, `text-overflow: ellipsis`,
 * `white-space: nowrap`, `min-width: 0`) and none of it fired, because the node
 * is `width: fit-content` inside React Flow's absolutely-positioned wrapper —
 * which resolves to MAX-CONTENT. `min-width: 0` only lets a flex item shrink
 * under an already-constrained width; it does not cap the item's max-content
 * contribution to the container's intrinsic size. So the node simply grew to
 * fit the name.
 *
 * Measured in Chromium (chrome-headless-shell 1228) against the real rules:
 *
 *   name length     no max-width      max-width: 78px
 *   5  ("Glass")        140.0px            140.0px
 *   43 (Blender)        298.2px            140.0px
 *   74                  462.1px            144.1px
 *   128 (the cap)      1063.3px            144.1px
 *
 * A mesh name is attacker-supplied (it comes out of a dropped glTF, and the
 * inventory a hostile shader can forge), and `MESH_NAME_MAX` is 128 — so
 * without the cap one file could stretch an Output node past a thousand pixels.
 *
 * 78px specifically: it keeps a targeted node inside `layoutEngine`'s fixed
 * 150px Output width estimate, so auto-layout does not place neighbours
 * against a width the node no longer has.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The picker moved out of the <select> and into its own component when it
// grew checkboxes (one material may shade several meshes) — the geometry
// contract came with it, unchanged.
const css = readFileSync(path.resolve(__dirname, 'MeshTargetPicker.css'), 'utf8')
  + readFileSync(path.resolve(__dirname, 'OutputNode.css'), 'utf8');
/** The element that renders a mesh name on the node. */
const MESH_EL = '.mesh-picker {';
const layout = readFileSync(path.resolve(__dirname, '../../../engine/layoutEngine.ts'), 'utf8');

/** The declaration block for one selector. */
function block(selector: string): string {
  const i = css.indexOf(selector);
  expect(i, `${selector} must exist`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
}

describe('the mesh picker cannot stretch the node', () => {
  const chip = block(MESH_EL);

  it('caps its own width', () => {
    const max = /max-width:\s*(\d+)px/.exec(chip);
    expect(
      max,
      'without a max-width the chip contributes its full max-content width to a '
      + 'fit-content node, and the ellipsis rules below it never fire',
    ).toBeTruthy();
    expect(Number(max![1])).toBeGreaterThan(0);
  });

  it('can shrink at all — a flex item refuses to below its content otherwise', () => {
    expect(chip).toMatch(/min-width:\s*0/);
  });

  it('the label CLIPS, and the "more" ellipsis is outside the clip', () => {
    // The closed control shows the first mesh plus an ellipsis. Folding that
    // ellipsis into the label string would make it the FIRST thing a long mesh
    // name pushes out of the box — the "there are more" signal vanishing
    // exactly when there is most to hide.
    const label = block('.mesh-picker__label {');
    expect(label).toMatch(/overflow:\s*hidden/);
    expect(label).toMatch(/text-overflow:\s*ellipsis/);
    expect(label).toMatch(/white-space:\s*nowrap/);
    const tsx = readFileSync(path.resolve(__dirname, 'MeshTargetPicker.tsx'), 'utf8');
    expect(tsx).toMatch(/<span className="mesh-picker__more">/);
    // One cap, on ONE element, shared by every material — material 0 included.
    const out = readFileSync(path.resolve(__dirname, 'OutputNode.tsx'), 'utf8');
    expect(out, 'the caption element must be gone, not merely unstyled')
      .not.toContain('output-node__default-mesh');
    expect((out.match(/<MeshTargetPicker/g) ?? []).length).toBe(1);
  });

  it('the mesh NAME is bold and 1.3x the node chrome, on the node and in the list', () => {
    // 9px is what every other label on this node uses; the mesh name is the one
    // word saying what the block is about, so it outranks them. The control's
    // own height must follow it — at 16px the descenders clipped.
    const name = block('.mesh-picker__label,');
    expect(name).toMatch(/font-size:\s*11\.7px/);   // 9 x 1.3
    expect(name).toMatch(/font-weight:\s*700/);
    expect(Number(/height:\s*(\d+)px/.exec(block('.mesh-picker {'))![1]))
      .toBeGreaterThanOrEqual(18);
  });

  it('stays within layoutEngine\'s Output width estimate', () => {
    // node = min-width floor OR (title + chip + padding); the measured 128-char
    // case lands at 144.1px for a 78px cap. Assert the arithmetic the two files
    // share, so moving either one without the other fails here.
    const cap = Number(/max-width:\s*(\d+)px/.exec(chip)![1]);
    // Anchored on the RETURN, not on a fixed window after `case 'output':` —
    // the branch grew when it learned about materials and a windowed match
    // silently stopped finding the number.
    const estimate = Number(
      /case 'output':[\s\S]*?return \{ width: (\d+)/.exec(layout)![1],
    );
    const TITLE_AND_PADDING = 36; // the select's row: 8px×2 padding + the ✕ + gap
    expect(
      cap + TITLE_AND_PADDING,
      `a targeted Output must fit layoutEngine's ${estimate}px estimate`,
    ).toBeLessThanOrEqual(estimate);
  });

  it('the node is still shrink-to-fit, which is why the cap is needed at all', () => {
    // If this ever becomes a fixed width the cap is redundant — but silently
    // so, and the comment above would then be describing something untrue.
    expect(block('.output-node')).toMatch(/width:\s*fit-content/);
  });
});

/**
 * The Output node's own OUTPUT SOCKET — the permanently-connected dot the
 * decorative preview wire leaves from.
 *
 * A source pin because the vitest env is `node`: every property here is a
 * rendered fact, and each one fails SILENTLY. A socket that stops matching the
 * wire's colour looks like a design choice; one that becomes a real handle
 * looks like a port until someone drags from it and nothing happens.
 */
describe('the Output node\'s preview socket', () => {
  const tsx = readFileSync(path.resolve(__dirname, 'OutputNode.tsx'), 'utf8');
  const card = readFileSync(path.resolve(__dirname, '../NodePreviewCard.tsx'), 'utf8');
  const link = readFileSync(path.resolve(__dirname, '../../Layout/PreviewLink.tsx'), 'utf8');
  const wires = readFileSync(path.resolve(__dirname, '../../Layout/previewWires.ts'), 'utf8');
  const rule = block('.output-node__preview-socket {');

  it('is TWICE the regular socket, derived from the token', () => {
    // `--handle-size` is bumped 10 -> 12px on coarse pointers, so a literal
    // 20px would stop being 2x exactly where sockets get bigger.
    expect(rule).toMatch(/width:\s*calc\(var\(--handle-size\) \* 2\)/);
    expect(rule).toMatch(/height:\s*calc\(var\(--handle-size\) \* 2\)/);
  });

  it("is painted in the WIRE's colour on the canvas, the node's ink on cards", () => {
    // `--node-cost-text` is the auto-contrast value NodeEditor publishes from
    // the user-picked canvas background — the same one the wire's stroke uses.
    // Hardcode black on the CANVAS and the socket disappears on a dark canvas
    // while the wire turns white. But the token is published on
    // `.node-editor`, which the asset bar ALSO sits inside, so the token read
    // must be SCOPED to `.react-flow`: unscoped, a dark canvas turned the
    // palette TILE's socket white-on-white, while the base rule keeps the
    // card on the node's one default-canvas look (the NodeBase.css
    // cost-badge precedent).
    // Off the canvas it takes the NODE'S OWN ink (black in light, near-white in
    // dark) rather than a literal black, since nodes flip with the theme as of
    // 2026-09-09 and a black disc on a dark card is invisible.
    expect(rule).toMatch(/background:\s*rgb\(var\(--node-ink-rgb\)\)/);
    expect(rule).not.toMatch(/var\(--node-cost-text/);
    expect(css).toMatch(/\.react-flow \.output-node__preview-socket \{[^}]*var\(--node-cost-text/);
    const wire = readFileSync(path.resolve(__dirname, '../../Layout/PreviewLink.css'), 'utf8');
    expect(wire).toMatch(/stroke:\s*var\(--node-cost-text/);
  });

  it('is the ACTIVATION control on the canvas, inert on the tiles, and never a port', () => {
    // Several output nodes may coexist with exactly one ACTIVE
    // (utils/sdfPartition.ts `activeSink`); clicking a node's socket makes it
    // the active sink. The BASE rule stays `pointer-events: none` so the
    // palette tiles' inert replicas never become controls; only the canvas
    // rule opts back in.
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(css).toMatch(/\.react-flow \.output-node__preview-socket \{[^}]*pointer-events:\s*auto/);
    // Hollow while inactive — the ordinary "free port" reading.
    // Hollow when inactive: the node's PLATE colour, which tracks the body the
    // same way the number boxes do, so the disc reads as unfilled in either
    // theme rather than as a white dot on a dark card.
    expect(css).toMatch(/\.output-node__preview-socket--inactive \{[^}]*background:\s*var\(--node-plate\)/);
    // A <button> carrying `nodrag` (React Flow's drag filter) with its
    // pointerdown AND click stopped, so a press activates instead of dragging
    // the node, panning the canvas, or selecting.
    //
    // On the Output that button is now the UNTARGETED branch only — see the
    // D2 test below; the file still contains exactly one of them.
    for (const [file, src] of [['OutputNode.tsx', tsx], ['RaymarchOutputNode.tsx', readFileSync(path.resolve(__dirname, 'RaymarchOutputNode.tsx'), 'utf8')]] as const) {
      const at = src.indexOf('output-node__preview-socket nodrag');
      expect(at, `${file}: the socket must carry nodrag`).toBeGreaterThan(-1);
      const el = src.slice(src.lastIndexOf('<button', at), src.indexOf('/>', at));
      expect(el, `${file}: pointerdown must be stopped`).toContain('onPointerDown={(e) => e.stopPropagation()}');
      expect(el, `${file}: the click must activate and not select`).toContain('e.stopPropagation(); setActiveOutput(id);');
      expect(el, `${file}: state for assistive tech`).toContain('aria-pressed={isActive}');
    }
    expect(tsx, 'a Handle here would be draggable')
      .not.toMatch(/preview-socket[\s\S]{0,80}<TypedHandle/);
    // The tiles keep the inert <span> — a card is `pointer-events: none`, which
    // stops the pointer but not the keyboard, so a real button there would be a
    // tab stop that mutates the graph from a static replica.
    expect(card).toContain('<span className="output-node__preview-socket" aria-hidden="true" />');
    expect(card).not.toContain('output-node__preview-socket nodrag');
  });

  it('is ONE PER NODE, centred on the material block and NOT on the header', () => {
    // `.output-node__material` is the offset parent and it EXCLUDES the header,
    // so centring on `.output-node` would drop the socket by half a header
    // height. One Output node is one material since the per-material split, so
    // there is exactly one of these — and it must still live inside the block,
    // not at node level.
    expect(block('.output-node__material {')).toMatch(/position:\s*relative/);
    expect(rule).toMatch(/top:\s*50%/);
    expect(rule).toMatch(/transform:\s*translateY\(-50%\)/);
    const sockets = tsx.match(/output-node__preview-socket/g) ?? [];
    // Two RENDERED elements, one per branch of D2 (button / inert span), plus
    // the `--inactive` and `--fixed` modifier spellings inside them.
    expect((tsx.match(/className=\{`output-node__preview-socket nodrag/g) ?? []), 'the activation button')
      .toHaveLength(1);
    expect((tsx.match(/className="output-node__preview-socket output-node__preview-socket--fixed nodrag"/g) ?? []), 'the inert anchor')
      .toHaveLength(1);
    expect(sockets.length).toBeGreaterThan(1);
    const blockStart = tsx.indexOf('`output-node__material${');
    expect(blockStart, 'the material block wrapper is gone').toBeGreaterThan(-1);
    expect(
      tsx.indexOf('className={`output-node__preview-socket nodrag'),
      'the socket must render INSIDE the material block',
    ).toBeGreaterThan(blockStart);
  });

  it('is INERT on a TARGETED node (owner decision D2)', () => {
    // Activation decides which UNTARGETED Output is the whole-model material;
    // a targeted one contributes whatever the flag says. Clicking a targeted
    // node's socket would write a flag `normalizeActiveOutput` strips — and,
    // until it did, would silently stop the whole-model material emitting.
    expect(tsx).toContain('{isUntargetedOutput(selfNode) ? (');
    const at = tsx.indexOf('output-node__preview-socket--fixed');
    const el = tsx.slice(tsx.lastIndexOf('<span', at), tsx.indexOf('/>', at));
    expect(el, 'no activation').not.toContain('setActiveOutput');
    expect(el, 'no toggle state to announce').not.toContain('aria-pressed');
    expect(el, 'a press must not drag the node from what looks like a port')
      .toContain('onPointerDown={(e) => e.stopPropagation()}');
    // The title is the whole point of the state, and TooltipLayer resolves its
    // host from `elementFromPoint` — so the element must keep real pointer
    // events, and only the CURSOR says it is not a button.
    expect(el).toContain('title={t(FIXED_SOCKET_KEY, language)}');
    expect(block('.react-flow .output-node__preview-socket--fixed {')).toMatch(/cursor:\s*default/);
    expect(css).not.toMatch(/\.output-node__preview-socket--fixed \{[^}]*pointer-events:\s*none/);
    // A contributing node is SOLID; hollow only ever means parked.
    expect(tsx).not.toMatch(/preview-socket--fixed[^`"]*--inactive/);
  });

  it('the NODE is the whole right-click scope — the section walk is gone', () => {
    // `data-material-index` picked a SECTION out of a stack so the settings
    // menu could open scoped to it. One node is one material now, so there is
    // nothing to choose between inside a node and the whole chain retires:
    // the attribute, NodeEditor's `closest()` walk, and the store field it fed.
    const nodeEditor = readFileSync(path.resolve(__dirname, '../NodeEditor.tsx'), 'utf8');
    const menu = readFileSync(path.resolve(__dirname, '../menus/ShaderSettingsMenu.tsx'), 'utf8');
    const store = readFileSync(path.resolve(__dirname, '../../../store/useAppStore.ts'), 'utf8');
    // The CODE forms — the retirement notes left behind naturally NAME the
    // attribute, which is what a retirement note is for.
    expect(tsx).not.toContain('data-material-index={');
    expect(nodeEditor).not.toContain("closest?.('[data-material-index]')");
    expect(menu).not.toContain('menuState.materialIndex');
    expect(menu).not.toContain('setMaterialIndex');
    expect(store).not.toContain('materialIndex?: number');
    expect(store).not.toMatch(/openContextMenu[^\n]*materialIndex/);
    // The node id alone identifies the scope, so the menu opens with it and
    // nothing else.
    expect(nodeEditor).toContain("openContextMenu(event.clientX, event.clientY, menuType, node.id);");
    // And the menu still shows a static scope LINE rather than growing a
    // dropdown of its own — a second control for a binding the node's own
    // picker owns is how the two end up disagreeing.
    expect(menu).not.toMatch(/<select[\s\S]{0,200}?setMaterialIndex/);
  });

  it('the wire-drop source pin rides a NAMED object, never trailing positions', () => {
    // `materialIndex` was the 8th POSITIONAL argument, immediately before
    // `sourceHandleType`. Removing it without moving every call site would have
    // shifted the handle TYPE into its slot, and that failure renders as
    // NOTHING: a wire dropped from an INPUT would connect backwards, React Flow
    // draws no edge for one authored out of an input, and graphToCode still
    // emits it. A named object cannot be shifted.
    const nodeEditor = readFileSync(path.resolve(__dirname, '../NodeEditor.tsx'), 'utf8');
    const store = readFileSync(path.resolve(__dirname, '../../../store/useAppStore.ts'), 'utf8');
    expect(store).toContain('openContextMenu: (x, y, type, nodeId, edgeId, pin) =>');
    expect(store).toContain('set({ contextMenu: { open: true, x, y, type, nodeId, edgeId, ...pin } })');
    expect(nodeEditor).toContain('sourceHandleType: pending?.handleType,');
    expect(nodeEditor).not.toMatch(/openContextMenu\([^)]*undefined,\s*pending/);
  });

  it('dormant sections hide, announce themselves, and re-measure on waking', () => {
    // The "different model clears it, the right model restores it" rule:
    // every consumer must route through dormantIndicesForPreview (the shared
    // context rules — inventory-unknown hold-off + the 0.6 single-mesh
    // fallback exemption), and each half fails SILENTLY on its own —
    // 1. the node skips dormant sections and shows the chip (or they vanish
    //    with no signal at all);
    expect(tsx).toContain('dormantIndicesForPreview(materials');
    // A material is a NODE now, so the node renders COMPACT — header plus the
    // chip — instead of skipping a section out of a stack.
    expect(tsx).toContain('const nodeDormant = dormant.has(SELF);');
    expect(tsx).toContain('{nodeDormant ? (');
    expect(tsx).toContain('output-node__dormant');
    // 2. the updateNodeInternals key folds dormancy — a sleeping node unmounts
    //    every REAL channel handle, and without a key change the waking node's
    //    handles are never re-measured, so every restored wire stays undrawn
    //    until a reload;
    expect(tsx).toContain("const exposedKey = nodeDormant ? '~' : exposedPorts.join('|');");
    // 3. PreviewLink draws only wires whose Output is AWAKE, through a whole-
    //    store derivation that ends in this same function — a dormant node
    //    mounts no preview socket at all, so its wire would have no anchor and
    //    the element cache would re-query every frame for as long as it sleeps.
    //    (It counted VISIBLE MATERIALS of one node until the per-material
    //    split; `previewWireTargets` is the node-set form of that question.)
    // The derivation moved to `previewWires.ts` when the RAILS needed it too —
    // one list for the wire, the canvas socket it ends on and the preview
    // socket mirroring it, so the three cannot disagree.
    expect(wires).toContain('previewWireTargets(');
    const materials = readFileSync(path.resolve(__dirname, '../../../utils/outputMaterials.ts'), 'utf8');
    expect(materials).toMatch(/export function previewWireTargets[\s\S]*?dormantIndicesForPreview\(/);
  });

  it('an edge into a dormant section is neither hit-testable nor a console flood', () => {
    const nodeEditor = readFileSync(path.resolve(__dirname, '../NodeEditor.tsx'), 'utf8');
    // What is not DRAWN must not be hit-testable: without the drawable guard,
    // handleAnchor's first-handle fallback anchored the invisible edge on the
    // Output's first mounted handle and drop-on-edge could SPLICE a phantom
    // curve with no highlight ever painted — committing what was never
    // previewed, into a sleeping material's wiring.
    expect(nodeEditor).toContain('edgeEndpointDrawable(srcNode, edge.sourceHandle');
    expect(nodeEditor).toContain('edgeEndpointDrawable(tgtNode, edge.targetHandle');
    // And React Flow's 008 stays "always a bug" for everything EXCEPT an edge
    // landing on a currently-dormant material: unscoped, a sleeping section
    // warns at frame rate on every pan; blanket suppression would hide the
    // real missing-useUpdateNodeInternals class.
    expect(nodeEditor).toContain("onError={onFlowError}");
    // The swallow is keyed on the EDGE React Flow names, resolved to the node
    // the wire lands on. A handle-keyed test cannot be node-scoped (several
    // Outputs spell their handles identically), and the id is the only part of
    // the message that identifies one. Both halves must be here: the parse
    // alone swallows every 008 it can read an id out of, and the predicate
    // alone has nothing to ask about.
    expect(nodeEditor).toContain('edgeIdFromError008(message)');
    expect(nodeEditor).toContain('outputEdgeIsDormant(useAppStore.getState(), edgeId)');
    // Scoped means CONDITIONAL: a `return` that any 008 reaches is the blanket
    // suppression this comment exists to refuse.
    expect(nodeEditor).toContain("if (edgeId !== null && outputEdgeIsDormant(useAppStore.getState(), edgeId)) {");
    // The retired handle-keyed form asked "is index N dormant on ANY Output",
    // which excused a real 008 about an awake section whenever some other
    // node's section with the same number slept.
    expect(nodeEditor).not.toContain('anyOutputDormant');
  });

  it('is where the preview wires start — one per contributing Output — and the card replicates it', () => {
    // ONE WIRE PER NODE since the per-material split (it was one per material
    // SECTION of the single stacked Output, resolved with a plural
    // querySelectorAll on that one node). Each wire's anchor is looked up
    // INSIDE its own node element, so a document-wide query — which would
    // return every Output's socket in DOM order and pin wire N to whichever
    // node happened to come Nth — cannot come back.
    expect(link).toContain("nodeEls[i]?.querySelector<HTMLElement>('.output-node__preview-socket')");
    expect(link).not.toContain("document.querySelector<HTMLElement>('.output-node__preview-socket')");
    // The wire set follows the store's CONTRIBUTING-Output derivation (see the
    // dormancy test above for why it is the shared one).
    // The derivation moved to `previewWires.ts` when the RAILS needed it too —
    // one list for the wire, the canvas socket it ends on and the preview
    // socket mirroring it, so the three cannot disagree.
    expect(wires).toContain('previewWireTargets(');
    // The per-index d-string dedupe cache must be truncated to the live path
    // count: a shrink-then-regrow (remove a material, undo) mounts a FRESH
    // <path d=""> whose recomputed d matches the stale entry byte-for-byte,
    // and an untrimmed cache skips the write — an invisible wire until
    // something moves.
    expect(link).toContain('lastDs.length = paths.length');
    // One node, one look: the card is the static replica of this node, and a
    // replica that drops a visible element is the drift these cards keep
    // reintroducing (the mic card's arm light is the precedent). The card
    // wraps its single material in the same block, so the socket centres
    // exactly as the live single-material node does.
    expect(card).toContain('output-node__preview-socket');
    const cardBlock = card.indexOf('OutputCardContent');
    expect(
      card.indexOf('className="output-node__material"', cardBlock),
      "the card's material-block wrapper is gone",
    ).toBeGreaterThan(cardBlock);
  });

  it('`__divider` is RETIRED — there is never a next material to divide from', () => {
    // It separated one MATERIAL from the next inside a stacked Output, in the
    // node's own frame colour. One node is one material, so the node's own
    // border does that job and `__subdivider` — the two halves of ONE material
    // — is the only line left. The stylesheet rule must go with the markup: a
    // dead rule is how the next reader wires it back up.
    expect(card).toContain('output-node__subdivider');
    expect(card).not.toMatch(/className="output-node__divider"/);
    expect(tsx).not.toMatch(/className="output-node__divider"/);
    expect(css).not.toMatch(/^\.output-node__divider\s*\{/m);
    expect(block('.output-node__subdivider {')).toMatch(/height:\s*1px/);
  });
});

describe('a mesh belongs to exactly one material', () => {
  const tsx = readFileSync(path.resolve(__dirname, 'OutputNode.tsx'), 'utf8');
  const picker = readFileSync(path.resolve(__dirname, 'MeshTargetPicker.tsx'), 'utf8');

  it('the node writes targets ONLY through the CROSS-NODE assignMeshTargets', () => {
    // That function is what takes the mesh away from whoever held it — and
    // after the per-material split "whoever" is another NODE, so it has to walk
    // the whole node list. A direct `meshTargets:` write here would leave two
    // Outputs claiming one mesh: legal for the store, resolved silently at
    // emission, and invisible until someone wonders why a node renders nothing.
    expect(tsx).toContain('assignMeshTargetsAcross(state.nodes, id, names)');
    expect(tsx).not.toContain('meshTargets:');
  });

  it('the cross-node move is ONE undo entry, and a no-op writes nothing', () => {
    // `updateNodeData` patches ONE node, so the move would be two writes and
    // Cmd+Z would step through a half-assigned state where both Outputs claim
    // the mesh. One `setNodes` inside one `asOneHistoryEntry` instead — and the
    // no-op guard sits OUTSIDE the bracket, because `beginInteraction`
    // snapshots AND clears `future` up front.
    const body = /const setMeshTargets = useCallback\(([\s\S]*?)\n    \[id\],/.exec(tsx)?.[1] ?? '';
    expect(body, 'setMeshTargets must exist').toBeTruthy();
    expect(body).toContain('if (next === state.nodes) return;');
    expect(body.indexOf('if (next === state.nodes) return;'))
      .toBeLessThan(body.indexOf('asOneHistoryEntry('));
    expect((body.match(/asOneHistoryEntry\(/g) ?? []).length).toBe(1);
    expect((body.match(/setNodes\(/g) ?? []).length).toBe(1);
    expect(body).not.toContain('updateNodeData(');
  });

  it('every plain Output offers the default — unticking is the way back', () => {
    // `allowDefault` was material-0-only, where a second empty list would have
    // authored a second default. Among NODES the active flag resolves that
    // instead, and unticking everything is the ONLY way to turn a targeted
    // Output back into a whole-model one.
    expect(tsx).toContain('allowDefault\n');
    expect(tsx).not.toContain('allowDefault={index === 0}');
  });

  it('the picker never refuses a tick', () => {
    // A checkbox that silently does nothing is worse than the empty material it
    // was avoiding — and the empty state is marked, so it cannot pass for one
    // that works.
    expect(picker).not.toMatch(/if \(next\.length === 0[^)]*\) return;/);
    expect(picker).toContain('mesh-picker--unassigned');
  });
});
