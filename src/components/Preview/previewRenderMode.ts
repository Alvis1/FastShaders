/**
 * Render on demand, the PARENT's half: whether the sandboxed preview must draw
 * every frame, or may draw only when something has changed.
 *
 * The owner approved render on demand (review 2026-10-11, "Preview renders only
 * when something changed"). A-Frame's loop calls `renderer.render` on every
 * animation frame even when nothing on screen can change. With the demo graph
 * idle, stopping that loop measured 12-16% of a core with the canvas's edge
 * animation running, and about 41 points with it still (M4 Max, 120 Hz).
 *
 * The split:
 *   - the STAGE (tslToPreviewHTML.ts) owns the loop. It draws on a short dirty
 *     window that every parent message, every orbit move, every resize and
 *     every shader-applied reopens, plus a ~2 Hz heartbeat, because a regex
 *     cannot prove that arbitrary module code is static. It treats itself as
 *     continuous until the first `fs:render-mode` arrives;
 *   - this side decides only `continuous`, from facts the parent already holds,
 *     and posts `{type: 'fs:render-mode', continuous}` whenever that value
 *     changes and again on every `fs:preview-ready` (replayed like
 *     `fs:stats-on`, because every fresh document boots continuous).
 *
 * Every input errs towards continuous. A false "continuous" costs only the
 * idle saving. A false "static" freezes a picture that should move, until the
 * heartbeat's next tick, and that would read as a broken preview.
 *
 * The message type is the stage's own `RENDER_MODE_MESSAGE`
 * (engine/tslToPreviewHTML.ts), imported by ShaderPreview the way it imports
 * `SHADER_SWAP_MESSAGE`, so the two sides spell it once.
 *
 * Pure, and imports nothing.
 */

/**
 * Words in the module text that mean the picture can change with no input at
 * all. A match is enough to keep drawing. A word in a comment or a string also
 * matches, and that is the intended side to be wrong on.
 *
 *   - TSL's clocks: `time`, `deltaTime`, `frameId`, the `osc*` family (they
 *     read `time` by default) and the deprecated `timer*` family;
 *   - per-frame hooks on a node or uniform: `onFrameUpdate`,
 *     `onRenderUpdate`, `onObjectUpdate`, …;
 *   - plain-JS ways for module code to change a value later: timers, animation
 *     frames, video frame callbacks, event listeners;
 *   - reads of the wall clock (`Date`, `performance`), which only matter
 *     inside one of the above, but cost nothing to include.
 *
 * Word-bounded, so a property named `timeScale` or `uptime` does not match
 * `time`. Sound uniforms are not listed: the parent's pump writes them every
 * frame, and an armed capture is its own input below.
 */
export const TIME_VARYING_RE =
  /\b(?:time|deltaTime|frameId|osc\w*|timer\w*|on\w*Update|setInterval|setTimeout|requestAnimationFrame|requestVideoFrameCallback|addEventListener|Date|performance)\b/;

/** Does the module text read anything that changes from frame to frame? */
export function moduleIsTimeVarying(module: string): boolean {
  return TIME_VARYING_RE.test(module);
}

export interface RenderModeInputs {
  /** `moduleIsTimeVarying` of the module the live document runs (or is about to). */
  readonly moduleAnimates: boolean;
  /** The turntable's ▶ is on. */
  readonly turntable: boolean;
  /** A model animation clip is loaded and playing. */
  readonly clipPlaying: boolean;
  /** A Gaussian splat is SHOWN (its depth sort runs in onBeforeRender). */
  readonly splatShown: boolean;
  /** The FPS readout is on. A frame rate measured over frames that are not
   *  drawn would be meaningless. */
  readonly stats: boolean;
  /** A Sound capture is armed: its uniforms move every frame. */
  readonly soundArmed: boolean;
}

/** True when ANY input says the picture may change without an event. */
export function previewRendersContinuously(i: RenderModeInputs): boolean {
  return i.moduleAnimates || i.turntable || i.clipPlaying || i.splatShown || i.stats || i.soundArmed;
}
