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
 * live level meter, then the arm light centred below it, with the four output
 * sockets spread down the RIGHT edge beside the light.
 *
 * The METER is on the card rather than in the settings menu because it answers
 * "is this node hearing anything?", and an answer only visible after a
 * right-click is the problem this layout exists to fix. The SOURCE picker was
 * on the card for a day and moved into the settings menu (2026-09-08): it
 * costs height and width on a control most graphs set once, while the question
 * that changes minute to minute is answered by the light and the meter.
 *
 * Every `*_TOP` below is a CENTRE, not an edge: `.shader-node__param-row` and
 * `.shader-node__arm-wrap` both carry `transform: translateY(-50%)`.
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
 * Sized so the 40px arm light nearly fills it — the light is the node's face,
 * the thing a glance is asking about. It grew to 88 for the day the source
 * `<select>` sat here and came back when that moved to the settings menu.
 */
export const SOUND_W = 68;
/** Inner body width — SOUND_W minus the two 1.5px borders. */
export const SOUND_BODY_W = SOUND_W - 3;
/**
 * Body height. Everything below is placed inside it.
 *
 * 103, down from 118 (2026-09-09, owner request: "make the sound node
 * shorter"). The 15px came from slimmer value chips (18 → 14, which is still
 * comfortably over the 12px compact `DragNumberInput` inside them) and from
 * closing the gap above the arm light, 10.5px → 4.5px.
 *
 * It cannot go much below this, and the floor is the SOCKET COLUMN rather than
 * anything visual: four outputs 18px apart span 54px, and the last one needs
 * ~8px of body beneath its centre so its disc stays inside the card at the
 * 12px coarse-pointer size. 95 + 8 is the 103.
 */
export const SOUND_BODY_H = 103;
/** Header strip height (node-base__header, single line) — layout footprint. */
export const SOUND_HEADER_H = 18;
/** Row CENTRES of the two parameter chips (socket + full-width value box). */
export const MIC_PARAM_TOPS = [11, 27];
/** Height of a parameter chip (the value box the row centres on). */
export const MIC_CHIP_H = 14;
/** Centre of the live level meter. */
export const SOUND_METER_TOP = 41;
/** Height of the level meter bar. */
export const MIC_METER_H = 5;
/** Centre of the arm light (the circle itself is sized in ShaderNode.css). */
export const SOUND_BTN_TOP = 68;
/**
 * The four outputs, spread down the right edge beside the arm light — 18px
 * apart, which keeps a 6px gap between sockets even at the 12px touch size.
 * Centred on the light (68), so they read as belonging to it; the first now
 * shares a centre with the level meter, which is a happy accident worth
 * keeping — the meter shows `level` and the socket beside it emits it.
 */
export const MIC_OUT_TOPS = [41, 59, 77, 95];
/**
 * Horizontal inset of the full-width rows from the body edge. The chip rows
 * and the meter both read it inline, so the inset has ONE source rather than a
 * CSS literal that drifts from its neighbour.
 */
export const MIC_PAD_X = 8;
