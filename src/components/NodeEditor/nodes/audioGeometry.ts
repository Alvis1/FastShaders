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
 * Sized against the Mic node's width rather than against the longest device
 * name a machine might report: the two are siblings and read as a pair on the
 * canvas. The `<select>` is capped to the body by its absolute left/right
 * insets plus `min-width: 0`, so a long name ellipsises instead of widening the
 * node (`.node-base` is `width: fit-content`, so an unbounded child would let
 * "MacBook Pro Microphone (Built-in)" dictate the node's size — the same cap
 * the image thumbnail and colormap strip carry). Names that ellipsise are still
 * answerable at a glance: AudioSourceSelect names the current source on the
 * first line of its tooltip precisely because this width truncates.
 */
export const AUD_W = 88;
/** Inner body width — AUD_W minus the two 1.5px borders. */
export const AUD_BODY_W = AUD_W - 3;
/** Body height. Everything below is placed inside it. */
export const AUD_BODY_H = 140;
/** Header strip height (node-base__header, single line) — layout footprint. */
export const AUD_HEADER_H = 18;
/** Row CENTRES of the two parameter chips (socket + value box). */
export const AUD_PARAM_TOPS = [13, 33];
/** Height of a parameter chip (the value box the row centres on). */
export const AUD_CHIP_H = 18;
/** Centre of the source `<select>` row. */
export const AUD_SOURCE_TOP = 55;
/**
 * Height of the source `<select>`. Deliberately NOT shrunk with the rest: it is
 * the one real pointer target on the card, and the caret has to stay legible.
 */
export const AUD_SOURCE_H = 20;
/** Centre of the live level meter. */
export const AUD_METER_TOP = 73;
/** Height of the level meter bar. */
export const AUD_METER_H = 5;
/** Centre of the arm light (the circle itself is sized in ShaderNode.css). */
export const AUD_BTN_TOP = 105;
/**
 * The four outputs, spread down the right edge beside the arm light — 18px
 * apart, which keeps a 6px gap between sockets even at the 12px touch size.
 */
export const AUD_OUT_TOPS = [78, 96, 114, 132];
/** Horizontal inset of the full-width rows from the body edge. */
export const AUD_PAD_X = 5;
