/**
 * The FLAT SHADER — an unlit material (A-Frame's `shader: flat`; owner,
 * 2026-11-10). LEAF: the menu, the Output node, the cost walk and the module
 * emitter all read it, so it imports nothing.
 *
 * `materialSettings.unlit === true` makes loader 0.8 build a
 * MeshBasicNodeMaterial (header delta 13): the colour is shown as it is, no
 * light reaches it. Absent is lit, which keeps every existing graph and export
 * byte-identical; frozen 0.6 ignores the key and renders the same channels lit.
 */

/**
 * The Output channels an unlit material does not read: the loader does not
 * apply them, the cost walk does not price what feeds only them, and the menu
 * and the node show them disabled. Colour, Emissive (added on top), Opacity,
 * Discard and Position still apply.
 */
export const UNLIT_IGNORED_CHANNELS: ReadonlySet<string> = new Set(['roughness', 'metalness', 'normal', 'env']);

/** Is this material Unlit? Strict, as the setting is stored only as `true`. */
export function isUnlitSettings(settings: unknown): boolean {
  return !!settings && typeof settings === 'object' && (settings as { unlit?: unknown }).unlit === true;
}

/** The Unlit checkbox's tooltip — an i18n KEY (lv.json carries its Latvian). */
export const UNLIT_HINT_KEY =
  'No lighting: the surface shows exactly the colour wired to Color, the same from every side, with no shadows or reflections. Roughness, Metalness, Normal, Environment and Faces have no effect and are switched off.';

/** The tooltip on a setting the Unlit material switches off — an i18n KEY. */
export const UNLIT_OFF_HINT_KEY = 'No effect while Unlit is on: nothing on this material is lit.';
