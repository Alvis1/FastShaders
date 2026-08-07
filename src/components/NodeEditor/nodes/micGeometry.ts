/**
 * The Mic node's fixed geometry — ONE module, no imports, so every surface
 * that draws the node reads the same numbers:
 *
 *   - MicNode.tsx           (the live canvas node)
 *   - NodePreviewCard.tsx   (MicCardContent, the asset-browser tile — also
 *                            rendered by the node-editor.html overview page)
 *   - engine/layoutEngine   (auto-layout needs the footprint; pure node-env
 *                            module, which is why these constants can't live
 *                            in MicNode.tsx — importing a component there
 *                            would drag React into the engine's import graph)
 *
 * The tile used to keep a hand-copied twin of these values, which is the drift
 * class the shared NodeVisual replica killed for ShaderNode-rendered types —
 * mic renders through its own component, so it needs its own shared source.
 *
 * Layout (matches the design sketch): header, then the two parameter chips
 * stacked full-width at the top of the body — param sockets on the LEFT edge
 * aligned with them — then the arm light, a large circle centred below, with
 * the four output sockets spread down the RIGHT edge beside it.
 *
 * All tops are px from the top of the BODY (not the card), so the header can
 * grow — a long name wraps in some languages — without dragging anything.
 */

/**
 * Outer card width, border-box (includes the 1.5px node border each side).
 * Sized so the arm light nearly fills it — the light IS the node's face, and
 * a wide frame around it read as a box with a dot in it rather than a control.
 */
export const MIC_W = 80;
/** Inner body width — MIC_W minus the two 1.5px borders. */
export const MIC_BODY_W = MIC_W - 3;
/** Body height. Everything below is placed inside it. */
export const MIC_BODY_H = 138;
/** Header strip height (node-base__header, single line) — layout footprint. */
export const MIC_HEADER_H = 18;
/** Row CENTRES of the two parameter chips (socket + full-width value box). */
export const MIC_PARAM_TOPS = [16, 40];
/** Height of a parameter chip (the value box the row centres on). */
export const MIC_CHIP_H = 18;
/** Centre of the arm light (the circle itself is sized in ShaderNode.css). */
export const MIC_BTN_TOP = 94;
/** The four outputs, spread down the right edge beside the arm light. */
export const MIC_OUT_TOPS = [64, 84, 104, 124];
