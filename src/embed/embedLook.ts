/**
 * How an EMBEDDED FastShaders looks (embed/EmbedBridge.tsx, protocol 3). The
 * host's 3D view is the scene, so the page is see-through and only the canvas
 * backdrop covers it, at the host's opacity; the theme is the host's too.
 *
 *   - `EMBED_ROOT_CLASS` goes on <html> while the embedded layout is mounted
 *     (AppLayout.tsx), and AppLayout.css makes every full-size ancestor of the
 *     canvas transparent under it. The plates on the canvas keep their own
 *     opaque backgrounds.
 *   - `EMBED_CANVAS_ALPHA_VAR` is set on <html> by `superwxr:appearance`'s
 *     `canvasOpacity`; `canvasBackground` mixes the canvas colour with
 *     transparency by it, and an unset property reads 100%: opaque until the
 *     host says otherwise.
 *   - `hostTheme` reads `superwxr:appearance`'s `theme` as the store's theme.
 *
 * A LEAF (imports nothing): NodeEditor and AppLayout read it without the
 * bridge chunk, and the rules are unit-tested here (embedLook.test.ts). Never
 * true of a full FastShaders page: nothing there sets the class or the
 * property, and `canvasBackground(color, false)` is the colour itself.
 */

/** The class on <html> while the embedded layout is mounted. */
export const EMBED_ROOT_CLASS = 'fs-embed';

/** The canvas backdrop's opacity as a CSS percentage, on <html>. */
export const EMBED_CANVAS_ALPHA_VAR = '--fs-embed-canvas-alpha';

/**
 * The React Flow root's background. Embedded, the canvas colour mixed with
 * transparency by the host's opacity: `color-mix` mixes in premultiplied
 * alpha, so the result is that colour at that alpha. `color` is the store's
 * `nodeEditorBgColor`, a validated `#rrggbb`.
 */
export function canvasBackground(color: string, embedded: boolean): string {
  return embedded ? `color-mix(in srgb, ${color} var(${EMBED_CANVAS_ALPHA_VAR}, 100%), transparent)` : color;
}

/**
 * `canvasOpacity` as the property's value: a finite number clamped to 0–1, as
 * a percentage (0.2 → '20%'). Anything else is null, which the bridge ignores.
 * Rounded to a hundredth of a percent, since 0.07 * 100 is 7.000000000000001.
 */
export function embedCanvasAlpha(raw: unknown): string | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const clamped = Math.min(1, Math.max(0, raw));
  return `${Math.round(clamped * 10000) / 100}%`;
}

/**
 * `theme` as the store's `codeEditorTheme` (historically named: it is the
 * app-wide dark-mode switch). Anything but 'dark' or 'light' is null.
 */
export function hostTheme(raw: unknown): 'vs-dark' | 'vs' | null {
  if (raw === 'dark') return 'vs-dark';
  if (raw === 'light') return 'vs';
  return null;
}
