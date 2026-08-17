/**
 * The Audio Input node's fixed geometry — ONE module, no imports, so every
 * surface that draws the node reads the same numbers:
 *
 *   - AudioInputNode.tsx    (the live canvas node)
 *   - NodePreviewCard.tsx   (AudioCardContent, the asset-browser tile — also
 *                            rendered by the node-editor.html overview page)
 *   - engine/layoutEngine   (auto-layout needs the footprint; pure node-env
 *                            module, which is why these constants can't live
 *                            in the component — importing it there would drag
 *                            React into the engine's import graph)
 *
 * The exact micGeometry.ts arrangement and for the same reason: the tile used to
 * keep a hand-copied twin of the mic's numbers and drifted, which is what
 * `assetCardGeometry.test.ts` now guards.
 *
 * Layout: header, then the two parameter chips stacked full-width at the top of
 * the body (param sockets on the LEFT edge, aligned with them), then the SOURCE
 * dropdown — the control this node exists for — then the level meter, then the
 * arm light with the four output sockets spread down the RIGHT edge beside it.
 *
 * All tops are px from the top of the BODY (not the card), so the header can
 * grow — a long name wraps in some languages — without dragging anything.
 */

/**
 * Outer card width, border-box (includes the 1.5px node border each side).
 *
 * Nearly twice the Mic node's 80px, and that is the dropdown's doing: a source
 * name like "BlackHole 2ch" or "Screen 1" has to be readable at rest, because
 * the whole point of putting the picker on the card is that you can see what the
 * node is listening to without opening anything. The `<select>` is width-capped
 * to the body and ellipsises rather than widening the node — `.node-base` is
 * `width: fit-content`, so an unbounded child would let a device name dictate
 * the node's size (the load-bearing cap the image thumbnail and colormap strip
 * both carry).
 */
export const AUD_W = 150;
/** Inner body width — AUD_W minus the two 1.5px borders. */
export const AUD_BODY_W = AUD_W - 3;
/** Body height. Everything below is placed inside it. */
export const AUD_BODY_H = 184;
/** Header strip height (node-base__header, single line) — layout footprint. */
export const AUD_HEADER_H = 18;
/** Row CENTRES of the two parameter chips (socket + value box). */
export const AUD_PARAM_TOPS = [16, 40];
/** Height of a parameter chip (the value box the row centres on). */
export const AUD_CHIP_H = 18;
/** Centre of the source `<select>` row. */
export const AUD_SOURCE_TOP = 66;
/** Height of the source `<select>`. */
export const AUD_SOURCE_H = 20;
/** Centre of the live level meter. */
export const AUD_METER_TOP = 88;
/** Height of the level meter bar. */
export const AUD_METER_H = 6;
/** Centre of the arm light (the circle itself is sized in ShaderNode.css). */
export const AUD_BTN_TOP = 124;
/** The four outputs, spread down the right edge beside the arm light. */
export const AUD_OUT_TOPS = [102, 124, 146, 168];
/** Horizontal inset of the full-width rows from the body edge. */
export const AUD_PAD_X = 6;
