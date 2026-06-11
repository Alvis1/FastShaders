# Node Design Requirements

Authoritative spec for how FastShaders **nodes** look and how the **Node Designer**
(`node-designer.html`) behaves. **Read this before changing node visuals, the
glyph system, `ShaderNode`, `NodePreviewCard`, or the designer tool.**

Implemented in: `src/components/NodeEditor/nodes/ShaderNode.tsx`,
`.../nodes/glyphs/NodeGlyph.tsx`, `.../glyphs/customGlyphs.ts`,
`.../handles/TypedHandle.{tsx,css}`, `NodePreviewCard.tsx`, and `node-designer.html`
(root + `public/` copy). See `CONTEXT.md → Node Visual Anatomy` for the prose version.

## Node anatomy (live nodes + asset cards)

1. **Header** is filled with the node's **performance-impact (cost) color**
   (`getCostColor`), with auto-contrast title text (`getContrastColor`).
2. **Body** is a flat white surface (`var(--bg-panel)`).
3. **Border** is `1.5px` in the node's **category color** (`CAT_HEX[category]`).
4. **Cost "points" badge** stays centered *above* the node (`node-base__cost-badge`).
5. **Sockets** are colored by **data type** (`getTypeColor`).
6. Asset-browser cards (`NodePreviewCard`) mirror this same anatomy.

## Sockets

7. Sockets are **always visually constant and static** — **no hover zoom, scale,
   movement, animation, or transition**. Identical idle, hovered, or
   mid-connection. Size is driven only by `--handle-size`. Do **not** add a
   `scale()` hover, and **never set `transform` on `:hover` at all — not even
   `transform: none`**: React Flow positions handles *via* transform
   (`translate(±50%, -50%)`), so any hover transform override moves the socket
   and makes it jump under the cursor. (`TypedHandle.css`.)
8. **Output sockets show no text/label** next to them.

## Multi-channel stacking

- A node renders a **stacked-cards effect** only when **multi-channel data arrives
  on a connected input** — the widest channel count across its connected input
  edges (2–4). **N channels read as N total cards**: the card itself plus N−1
  offset layers (3px steps), borders in the category color, the deepest layer
  carrying the node shadow (`node-base__stack`). Source/constructor nodes (no
  multi-channel input) never stack, regardless of their output width. While
  stacked, the card suppresses its own drop shadow (unless selected) — cards
  separate by their borders alone and **only the deepest layer casts the single
  group shadow**, so the stack reads as one cohesive node.
- Layers are **siblings of the card** inside its cost-scale wrapper, painted below
  it — never children of the card (negative-z children would paint over the card's
  own background/border and erase its bottom edge). Their z-indices stagger
  downward (−1, −2, −3 = deepest): deeper layers paint first, so every layer's
  bottom strip stays visible (equal z would erase all but the deepest strip).
- **Sockets do NOT stack** — each socket stays a single circle (see the Sockets
  consistency rule). The multi-channel edge rendering (`TypedEdge`) plus the body
  stack carry the channel-count signal.
- The per-edge channel count mirrors `TypedEdge`: `max(live eval length, static
  shape inference)`, clamped 1–4. Stack layers never affect layout or hit-targets
  (`pointer-events: none`).
- The designer previews the body stack via the connected inputs' channel selectors.

## Glyph (visualization)

9. Each node may have a light-theme SVG glyph (`NodeGlyph.tsx`, `0 0 56 56` space).
   Built-in art is dark-on-light. Live-canvas nodes (**time, sin/cos, all noise**,
   plus **color** picker and **output**) keep their own canvases — no glyph.
10. The glyph is **never drawn underneath / behind the input values** in a way that
    obscures them.
11. **Glyph scale** is a per-node value (`customGlyphs.ts → scale`, default 1). Scale
    **grows the rendered glyph ONLY** — it never changes socket/value spacing. In the
    operator layout the body keeps its 52px base height and grows **just enough to
    contain a larger glyph** (`max(52, glyphPx + 10)`).

## Layout

12. **2-input nodes → operator layout**: the glyph sits **between** the two inputs.
    Input `a` above, glyph in the middle, input `b` below. Output socket centered on
    the right; input sockets at each value's height on the left. Socket positions are
    **px offsets from the body center** — defaults `a = −12.5`, `b = +12.5`, `out = 0`
    (the classic 26% / 74% spots of the 52px body) — and are **per-node movable** via
    the designer (`customGlyphs.ts → sockets`, **4px snap**, clamped inside the body).
    Each input's value label always follows its socket.
13. **Input numbers are centered** in the node by default, with a **justification
    setting** (`left` | `center` | `right`, per-node `customGlyphs.ts → justify`).
14. 1-input / 0-input / 3+-input glyph nodes use the **glyph-icon-on-top + rows**
    layout (values in rows beside their sockets). *(Pending: extend centered/justify
    to these arities if requested.)*
15. **`float` / `int` render as plain number rows** like `vec2`/`vec3` — no knob.

## Box — size & sockets (customizable) vs frame (fixed)

- **Frame style is FIXED app-wide** — corner radius (8px, `--border-radius-md`) and
  border thickness (1.5px) are **the same for every node** and are NOT per-node
  customizable. Only the border *color* varies (category color, app-owned).
- **Width (horizontal)** — `customGlyphs.ts → width` (px): the node's **exact**
  width (≥24px; default auto / fit-content). Exact — not a minimum — so a node can
  be made **narrower than its natural content**: the header title truncates with an
  ellipsis, and the operator body's `min-width: 54px` floor applies only in auto
  mode (an explicit width overrides it). Rows-layout content may overflow if forced
  very narrow — the designer shows the result live.
- **Height (vertical)** — `height` (px, ≥28; default auto): the body height,
  **exact in BOTH layouts** — it can shrink a node below its natural content
  height; the glyph/rows then simply overflow (overflow stays visible; place art
  with `dx`/`dy`). **Independent of glyph scale**: resizing the node never scales
  the glyph and scaling the glyph never changes an explicit height. Auto keeps
  the classic behavior (op body = `max(52, glyphPx + 10)`; rows = content flow).
  The designer's corner handle drags **→ width / ↕ height**; glyph size is its
  own `scale` field.
- **Glyph nudge** — `dx` / `dy` (glyph-space units in the `0 0 56 56` canvas, default 0):
  translates the glyph art only. Purely visual — never changes node layout, value
  positions, or socket positions (`NodeGlyph` renders with `overflow: visible`).
- **Text size** — `text` (multiplier 0.4–2.5, default 1): scales the node's text —
  header title, value boxes (`DragNumberInput` compact), and edge value labels —
  together via the `--node-text-scale` CSS variable. Purely typographic: layout
  metrics stay fixed (the 14px header bar doesn't grow; oversized header text clips).
- **Socket positions** — `sockets`: per-socket vertical offsets in px from the
  below-header body center, keys = input port ids plus `out`. Authored by dragging
  sockets along the border in the designer; **4px snap increments**; **every
  socket's value follows its socket**. **Operator layout**: inputs + output are
  positioned by offset natively. **Rows layout**: dragging any input or the first
  output **detaches it from its row** and anchors it to the region center — its
  value widget (number box / edge label) moves with it; the vacated row keeps its
  spacing. No override = classic row anchoring; rows overrides persist even at 0
  (0 means region center, not the row spot); "Reset positions" restores rows.

`ShaderNode` reads these via `nodeBox(type)` / `nodeSockets(type)`. **Socket size is
deliberately NOT customizable** (see Sockets — consistency rule); socket *position*
is (operator layout only). When adding more per-node controls, only expose properties
that are *not* app-owned (no category/cost color, cost value, frame radius/border,
socket existence/type, or live-canvas behavior).

## Input values

16. **Unconnected** input → editable number (`DragNumberInput`).
17. **Connected** input → the value(s) taken from the **connecting edge**
    (`evaluateNodeOutput`): one channel → the number (up to 2 decimals),
    **multiple channels → `min…max` range** (ellipsis separator), unevaluable
    upstream (texture chains) → inferred `min…max` (`evaluateNodeRange`), and
    **nothing derivable → `…`** — a connected socket never shows a blank.
    **Ranges round to whole numbers** (integer part only — `-0.8…0.8` displays as
    `-1…1`; a range whose rounded ends meet collapses to that integer); single
    values keep decimals; precise figures live in the `EdgeInfoCard` (2 decimals,
    same `…` separator). Shown blue for a live value, gray for an inferred range
    (`edgeValueLabel` in `ShaderNode`). Geometry attributes carry analytical
    ranges: normals/tangents/view directions `-1…1` per channel;
    `positionGeometry`/`positionLocal` `-0.8…0.8` → displayed `-1…1`.

## Node Designer tool (`node-designer.html`)

18. **Dropdown of existing nodes** (grouped by category) with **search filter**
    (`/` focuses, Enter selects the first match) and **prev/next** (Alt+↑/↓).
    Options are marked **◆ = has saved design**, **● = unsaved changes**. Selecting
    a node shows its **category color and cost — read-only / locked** (from the
    registry; when the folder is linked, costs auto-refresh from
    `src/registry/complexity.json` so the tool can't drift).
19. **Glyph editor**: clicking the glyph opens a box with the SVG — editable in a
    textarea and **replaceable by drag-and-dropping an `.svg` file** (auto-fitted to
    the `0 0 56 56` canvas) or via an Upload button. Modal live-previews the art with
    a toggleable 56-grid/center-guide overlay, validates the SVG (parse errors block
    Apply), and offers Copy SVG / restore Built-in / Clear.
20. **Glyph scale** number (glyph-only; spacing fixed), **glyph nudge dx/dy** (also
    editable by **dragging the glyph on the canvas**; a plain click still opens the
    editor), **Width / Height** controls, **movable sockets** (drag a socket ↕ along
    the border — 4px-snapped ruler appears while dragging; plain click still cycles
    its state; "Reset positions" restores defaults), and a draggable corner handle
    on the node — **drag → width, ↕ → height** (resizing the node never scales the
    glyph). Corner radius / border have **no controls** — they're fixed app-wide.
21. **Input justify** setting (left / center / right).
22. **Preview matches the live node**: operator layout for 2-input, centered numbers,
    output socket has no text, `DragNumberInput`-style boxes (◂ ▸, scrub, type),
    10px sockets, 14px header, cost-based node scale, exact shadows/paddings.
23. **Save** writes the per-node design `{ svg?, justify?, scale?, dx?, dy?, width?,
    height?, text?, sockets? }` into `src/components/NodeEditor/nodes/glyphs/customGlyphs.ts`.
    Persistence picks the best available path, in order: **(1) the vite dev-server
    endpoint** (`/__nd`, a serve-only plugin in `vite.config.ts`) — works in ANY
    browser at `http://localhost:5173/FastShaders/node-designer.html`; **(2) the File
    System Access API** (Chromium — link the FastShaders folder once; remembered in
    IndexedDB, one-click re-permission after reload); **(3) downloading**
    `customGlyphs.ts`. Only non-default fields are written; re-selecting a node loads
    its saved design.
24. **Preview states** (sketch-faithful): every input socket can preview
    **unconnected** (editable number box), **connected · live** (blue edge value) or
    **connected · range** (gray inferred range), each with a **channel count (1–4)**;
    the output socket toggles its edge. Edge stubs mirror `TypedEdge` exactly —
    parallel per-channel lines (R/G/B/W), `4 0.5` dash for multi-channel, per-count
    stroke widths, 1-channel flips black/white against the canvas color. Clicking a
    socket on the canvas cycles its state.
25. **Multi-node session workflow**: edits are stashed per node (switching nodes—or
    reloading—never loses work), the topbar shows an unsaved count, **Save** writes
    the current node, **Save all** (and ⌘/Ctrl+S) writes every changed node;
    per-node **Reset**, **Copy design / Paste** between nodes — copies everything
    **except the glyph art** (justify, scale, dx/dy, width, height, text, sockets);
    the target node always keeps its own svg.
26. **Canvas comfort**: pannable (drag) and zoomable (⌘/Ctrl+wheel, ±/% controls)
    stage with a pickable background color — the cost badge and 1-channel edges
    auto-contrast against it, exactly like the app canvas. Zoom, bg, stash, and the
    last-selected node persist in `localStorage` under `nd:*` keys.

## Verification (run before declaring done)

- `npx tsc --noEmit`
- `npm test` (vitest, expect all green)
- `npm run build` (bundle phase; the post-build `ShaderCarousel` copy may `EPERM` in a
  sandbox — that's environmental, not a code failure)
- For the tool: extract `<script>` and `node --check` it; round-trip the
  `customGlyphs.ts` save format (`fileContent`/`parseGlyphs`).
