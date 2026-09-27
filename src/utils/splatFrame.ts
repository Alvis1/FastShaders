/**
 * The longest side `splat-model` bakes a splat scene to (its `size`, centred on
 * the origin — the same 1.6 `fit-bounds` bakes a mesh to), so a splat's
 * object-space centre `p` lies in ±0.8 on its longest axis. The preview
 * document passes it to the component, and a Splat Output's UV projection
 * (utils/sdfPartition.ts SPLAT_CONSTANTS) maps that frame to 0–1 with it — ONE
 * number, so the two cannot drift. A zero-import leaf of its own: splatLimits.ts
 * must equal the runtime's frozen LIMITS export for export (fsSplatBundle.test.ts).
 */
export const SPLAT_MODEL_SIZE = 1.6;
