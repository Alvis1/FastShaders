/**
 * The Sound node's fixed geometry — ONE module, no imports, so every surface
 * that draws the node reads the same numbers:
 *
 *   - SoundNode.tsx           (the live canvas node)
 *   - NodePreviewCard.tsx   (SoundCardContent, the asset-browser tile — also
 *                            rendered by the node-editor.html overview page)
 *   - engine/layoutEngine   (auto-layout needs the footprint; pure node-env
 *                            module, which is why these constants can't live
 *                            in SoundNode.tsx — importing a component there
 *                            would drag React into the engine's import graph)
 *
 * The tile used to keep a hand-copied twin of these values, which is the drift
 * class the shared NodeVisual replica killed for ShaderNode-rendered types —
 * the Sound node renders through its own component, so it needs its own shared
 * source.
 *
 * NAMING: the node is called "Sound", but every identifier here still says
 * `MIC`, matching the registry type (`soundNode`), the React Flow type (`mic`)
 * and the emitted uniform base (`mic1_level`). Those are persisted contracts —
 * inside saved `.fastshader` files and inside every module the app has ever
 * exported — so the module names follow them rather than drifting from them.
 *
 * Layout: header, then the two parameter chips stacked full-width at the top
 * of the body — param sockets on the LEFT edge aligned with them — then the
 * SOURCE dropdown, then the live level meter, then the arm light centred below
 * it, with the four output sockets spread down the RIGHT edge beside the light.
 *
 * The meter and the source picker are both on the card rather than in the
 * settings menu because both answer "what is this node hearing?", and a node
 * whose answer is only visible after a right-click is the problem this layout
 * exists to fix.
 *
 * This IS the Audio Input node's arrangement: that node was folded into the
 * Sound node on 2026-09-08, since a microphone is just one of the sources the
 * picker offers. The numbers below are the deleted `audioGeometry.ts`'s,
 * verbatim, under this module's export names — which stayed `MIC_*` so the
 * three consumers above kept compiling and so the whole merge reads as one
 * node growing a row rather than as a rename sweep.
 *
 * All tops are px from the top of the BODY (not the card), so the header can
 * grow — a long name wraps in some languages, and NodeTitle wraps it to two
 * rows — without dragging anything below it.
 */

/**
 * Outer card width, border-box (includes the 1.5px node border each side).
 *
 * Wide enough for the source `<select>` and no wider: the picker is capped to
 * the body by its absolute left/right insets plus `min-width: 0`, so a long
 * device name ellipsises instead of widening the node (`.node-base` is
 * `width: fit-content`, so an unbounded child would let "MacBook Pro
 * Microphone (Built-in)" dictate the node's size — the same cap the image
 * thumbnail and colormap strip carry). Names that ellipsise are still
 * answerable at a glance: SoundSourceSelect names the current source on the
 * first line of its tooltip precisely because this width truncates.
 *
 * It grew from 68 when the source picker arrived; before that the width was
 * sized so the arm light nearly filled it, because the light WAS the node's
 * whole face. The light is still centred, but it is no longer the only control.
 */
export const SOUND_W = 68;
/** Inner body width — SOUND_W minus the two 1.5px borders. */
export const SOUND_BODY_W = SOUND_W - 3;
/** Body height. Everything below is placed inside it. */
export const SOUND_BODY_H = 118;
/** Header strip height (node-base__header, single line) — layout footprint. */
export const SOUND_HEADER_H = 18;
/** Row CENTRES of the two parameter chips (socket + full-width value box). */
export const MIC_PARAM_TOPS = [13, 33];
/** Height of a parameter chip (the value box the row centres on). */
export const MIC_CHIP_H = 18;
/** Centre of the live level meter. */
export const SOUND_METER_TOP = 50;
/** Height of the level meter bar. */
export const MIC_METER_H = 5;
/** Centre of the arm light (the circle itself is sized in ShaderNode.css). */
export const SOUND_BTN_TOP = 83;
/**
 * The four outputs, spread down the right edge beside the arm light — 18px
 * apart, which keeps a 6px gap between sockets even at the 12px touch size.
 */
export const MIC_OUT_TOPS = [56, 74, 92, 110];
/**
 * Horizontal inset of the full-width rows from the body edge. The chip rows,
 * the source picker and the meter all read it inline, so the inset has ONE
 * source rather than a CSS literal that drifts from its neighbours.
 */
export const MIC_PAD_X = 8;
