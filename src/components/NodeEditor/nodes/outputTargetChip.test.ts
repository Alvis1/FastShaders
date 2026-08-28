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
  const rule = block('.output-node__preview-socket {');

  it('is TWICE the regular socket, derived from the token', () => {
    // `--handle-size` is bumped 10 -> 12px on coarse pointers, so a literal
    // 20px would stop being 2x exactly where sockets get bigger.
    expect(rule).toMatch(/width:\s*calc\(var\(--handle-size\) \* 2\)/);
    expect(rule).toMatch(/height:\s*calc\(var\(--handle-size\) \* 2\)/);
  });

  it("is painted in the WIRE's colour on the canvas, plain black on cards", () => {
    // `--node-cost-text` is the auto-contrast value NodeEditor publishes from
    // the user-picked canvas background — the same one the wire's stroke uses.
    // Hardcode black on the CANVAS and the socket disappears on a dark canvas
    // while the wire turns white. But the token is published on
    // `.node-editor`, which the asset bar ALSO sits inside, so the token read
    // must be SCOPED to `.react-flow`: unscoped, a dark canvas turned the
    // palette TILE's socket white-on-white, while the base rule keeps the
    // card on the node's one default-canvas look (the NodeBase.css
    // cost-badge precedent).
    expect(rule).toMatch(/background:\s*#000/);
    expect(rule).not.toMatch(/var\(--node-cost-text/);
    expect(css).toMatch(/\.react-flow \.output-node__preview-socket \{[^}]*var\(--node-cost-text/);
    const wire = readFileSync(path.resolve(__dirname, '../../Layout/PreviewLink.css'), 'utf8');
    expect(wire).toMatch(/stroke:\s*var\(--node-cost-text/);
  });

  it('cannot be dragged from — it is not a port', () => {
    // The Output node has no outputs. A real handle would invite a connection
    // that can never land; without pointer-events:none a drag on it pans the
    // canvas from something that looks like a socket.
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(tsx).toMatch(/<span className="output-node__preview-socket" aria-hidden="true" \/>/);
    expect(tsx, 'a Handle here would be draggable')
      .not.toMatch(/preview-socket[\s\S]{0,80}<TypedHandle/);
  });

  it('is ONE PER MATERIAL, centred on its own section', () => {
    // `.output-node__material` is the offset parent: each material block
    // carries its own socket, centred on that block, so a multimesh Output
    // visibly feeds the preview once per section (the design sketch's
    // multimesh reading). A single-material node keeps its one socket.
    expect(block('.output-node__material {')).toMatch(/position:\s*relative/);
    expect(rule).toMatch(/top:\s*50%/);
    expect(rule).toMatch(/transform:\s*translateY\(-50%\)/);
    // The span is rendered exactly ONCE in OutputNode.tsx — inside
    // renderMaterial's block, never at node level (a node-level twin would
    // draw a stray centre socket on top of the per-section ones).
    const spans = tsx.match(/className="output-node__preview-socket"/g) ?? [];
    expect(spans).toHaveLength(1);
    const blockStart = tsx.indexOf('className="output-node__material"');
    expect(blockStart, 'the material block wrapper is gone').toBeGreaterThan(-1);
    expect(
      tsx.indexOf('className="output-node__preview-socket"'),
      'the socket must render INSIDE the material block',
    ).toBeGreaterThan(blockStart);
  });

  it('each material block carries the right-click hit test for its scoped menu', () => {
    // data-material-index → NodeEditor's onNodeContextMenu (closest walk) →
    // contextMenu.materialIndex → ShaderSettingsMenu seeds its selector, so a
    // right-click on a SECTION opens the menu already scoped to that material
    // and channels can be exposed per section. Every link in that chain fails
    // silently (the menu just opens on material 0).
    expect(tsx).toContain('data-material-index={index}');
    const nodeEditor = readFileSync(path.resolve(__dirname, '../NodeEditor.tsx'), 'utf8');
    expect(nodeEditor).toContain("closest?.('[data-material-index]')");
    const menu = readFileSync(path.resolve(__dirname, '../menus/ShaderSettingsMenu.tsx'), 'utf8');
    expect(menu).toContain('.materialIndex');
    // The reseed effect must key on the contextMenu OBJECT (fresh identity per
    // open), never the index VALUE alone: re-right-clicking the SAME section
    // after manually switching the selector writes the same number, and a
    // value-keyed effect never fires — the menu moves but stays mis-scoped.
    expect(menu).toContain('[menuState, seededIndex]');
    // Materials are anonymous indices: a count change under an open menu
    // shifts the selection onto a NEIGHBOUR, so the menu resets visibly.
    expect(menu).toContain('setMaterialIndex(0)');
    // The section right-click is the ONE scoping control: the menu shows a
    // static scope line, never its own material dropdown — a second control
    // for the same scope is how the two end up disagreeing (the same argument
    // that keeps the MESH picker off this menu).
    expect(menu).not.toMatch(/<select[\s\S]{0,200}?setMaterialIndex/);
  });

  it('is where the preview wires start — one per socket — and the card replicates it', () => {
    // PreviewLink resolves ALL sockets (plural) and keeps one <path> per
    // material; a singular querySelector would silently pin every wire to
    // material 0's socket.
    expect(link).toContain("querySelectorAll<HTMLElement>('.output-node__preview-socket')");
    expect(link).toContain('outputMaterials(');
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

  it('the card uses the SUB-divider — `__divider` now means "next material"', () => {
    // `.output-node__divider` became the node's red frame colour, edge to edge,
    // separating one MATERIAL from the next. A card shows one material, so
    // using it there would paint a red band where the node shows a hairline.
    expect(card).toContain('output-node__subdivider');
    expect(card).not.toMatch(/className="output-node__divider"/);
    expect(block('.output-node__divider {')).toMatch(/background:\s*var\(--cat-output\)/);
  });
});

describe('a mesh belongs to exactly one material', () => {
  const tsx = readFileSync(path.resolve(__dirname, 'OutputNode.tsx'), 'utf8');
  const picker = readFileSync(path.resolve(__dirname, 'MeshTargetPicker.tsx'), 'utf8');

  it('the node writes targets ONLY through assignMeshTargets', () => {
    // That function is what takes the mesh away from whoever held it. A direct
    // `meshTargets:` write here would leave two materials claiming one mesh —
    // legal for the store, resolved silently at emission, and invisible on the
    // node until someone wonders why a section renders nothing.
    expect(tsx).toContain('assignMeshTargets(outputMaterials(node), index, names)');
    // TWO writes, and only two: the single updateNodeData that lands a move,
    // and `addMaterial` seeding a brand-new material — which is safe because it
    // only ever picks a mesh NOTHING has claimed (`claimedNames` folds every
    // material's list). A third write is the one to worry about.
    const writes = tsx.match(/meshTargets:/g) ?? [];
    expect(writes.length).toBe(2);
    expect(tsx).toMatch(/const free = meshNames\.find\(\(n\) => !claimed\.has\(n\)\);/);
  });

  it('the move is ONE undo entry', () => {
    // Material 0's targets are a node field and the rest ride `materials`;
    // writing them separately would make Cmd+Z step through a half-assigned
    // state where two materials briefly hold the same mesh.
    const body = /const setMaterialTargets = useCallback\(([\s\S]*?)\n  \);/.exec(tsx)?.[1] ?? '';
    expect(body, 'setMaterialTargets must exist').toBeTruthy();
    expect((body.match(/updateNodeData\(/g) ?? []).length).toBe(1);
  });

  it('the picker never refuses a tick', () => {
    // A checkbox that silently does nothing is worse than the empty material it
    // was avoiding — and the empty state is marked, so it cannot pass for one
    // that works.
    expect(picker).not.toMatch(/if \(next\.length === 0[^)]*\) return;/);
    expect(picker).toContain('mesh-picker--unassigned');
  });
});
