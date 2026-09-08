/**
 * How much shorter a node's BODY gets when the toolbar's "Node graphics"
 * switch is off — the compact look.
 *
 * Hiding the glyph on its own changes nothing: MEASURED over the 81
 * ShaderNode-rendered types, 67 carry a glyph and NOT ONE of them shrinks.
 * In the operator layout `.shader-node__op-glyph` is `position: absolute` over
 * a body with an explicit height, and in the rows layout all 47 glyph-bearing
 * types carry an authored `height` that `.shader-node__region` applies exactly.
 * So the art vanished and its band stayed — an empty reserve that reads as a
 * failed render rather than as a setting. Compacting is what makes the switch
 * mean something.
 *
 * The rule the whole module exists to enforce: **compaction may only make a
 * node smaller, never larger.** Socket offsets are authored in px against the
 * height the node had at the time (NODE_DESIGN_REQUIREMENTS → Socket
 * positions), and the designer protects a SHRINK by rescaling those offsets
 * with the frame — a protection that lives at authoring time and cannot reach
 * a render-time override. So the renderer's own protection is a FLOOR: never
 * go below what the sockets need to stay on the card. That is the failure the
 * spec names ("a row-anchored socket in a node shrunk below its natural
 * content still can" leave the border), removed here by construction.
 *
 * React Flow re-measures handle bounds through its per-node ResizeObserver, so
 * wires re-anchor on their own when the flag flips — no `updateNodeInternals`
 * call is needed for a size change (it IS needed for handles that mount or
 * unmount, which is a different rule).
 */

/** Never shorter than this, whatever the sockets say. */
export const COMPACT_MIN_BODY = 20;

/**
 * The compact `DragNumberInput`'s height at text scale 1
 * (`calc(12px * --node-text-scale)`), plus a 2px margin so the plate never sits
 * flush against the border. A node's authored `text` multiplier runs to 2.5×,
 * so the CALLER scales this — a fixed 14 would clip the value cell on any node
 * whose author enlarged its numbers.
 */
export const VALUE_CELL_PX = 14;

/**
 * Clearance a socket needs at the far edge of the body: the coarse-pointer
 * `--handle-size` (12px), so the dot stays whole on a touch device too, where
 * the token bumps and the desktop 10 would leave it half outside.
 */
export const SOCKET_CLEARANCE = 12;

/**
 * The shortest body that still contains every socket at its authored offset.
 *
 * Offsets are px from the body CENTRE, so a socket at ±n needs 2n of body plus
 * whatever is drawn AT that height — the dot, or `extra` when something taller
 * shares the spot (the operator layout's value cell). The two are the SAME
 * band, so the floor takes the larger of them and never their sum: adding both
 * reserves the dot twice and, at the classic ±12.5 / 52px operator geometry,
 * lands one pixel above the natural height — a floor that quietly cancels the
 * whole compaction while every test still passes.
 */
export function socketFloor(offsets: readonly number[], extra = 0): number {
  let max = 0;
  for (const o of offsets) if (Number.isFinite(o)) max = Math.max(max, Math.abs(o));
  return Math.max(COMPACT_MIN_BODY, Math.round(2 * max + Math.max(SOCKET_CLEARANCE, extra)));
}

/**
 * The operator layout's compact body height.
 *
 * Everything in that body is absolutely positioned — the glyph, the value
 * cells, the sockets — so there is no content to measure and no auto height to
 * fall back on: the compact height IS the socket floor, capped at the natural
 * height so the switch can never grow a node. `cellPx` is the value cell drawn
 * centred on the socket — pass it scaled by the node's `text` multiplier, or an
 * enlarged number clips at the border.
 */
export function compactOpBodyHeight(
  natural: number,
  offsets: readonly number[],
  cellPx: number = VALUE_CELL_PX,
): number {
  return Math.min(natural, socketFloor(offsets, cellPx));
}
