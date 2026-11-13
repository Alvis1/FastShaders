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
 * The Output channels an unlit material does not read: the cost walk does not
 * price what feeds only them, and the menu and the node show them disabled.
 * Colour, Opacity, Discard and Position still apply.
 *
 * Emissive is here too (owner, 2026-11-10): on an unlit material the colour IS
 * the emitted light, so the Color socket is LABELLED Emissive
 * (`unlitPortLabel`) and the separate Emissive channel goes dormant like the
 * others. The loader drops the other four itself (delta 13's LIT_ONLY_PROPS)
 * but would ADD an emissive, so the MODULE emitter drops that one
 * (`buildShaderModule`, default and part bodies alike) — the panel code keeps
 * it, so the wire survives every resync and returns when Unlit is unticked.
 */
export const UNLIT_IGNORED_CHANNELS: ReadonlySet<string> = new Set(['roughness', 'metalness', 'normal', 'env', 'emissive']);

/**
 * The label an Output port shows: an unlit material's Color socket reads
 * "Emissive" — what it is once nothing lights it. Display only: the handle id,
 * the stored values and the emitted key stay `color`. Returns an English
 * label, translated by the caller like any other.
 */
export function unlitPortLabel(portId: string, label: string, unlit: boolean): string {
  return unlit && portId === 'color' ? 'Emissive' : label;
}

/** Is this material Unlit? Strict, as the setting is stored only as `true`. */
export function isUnlitSettings(settings: unknown): boolean {
  return !!settings && typeof settings === 'object' && (settings as { unlit?: unknown }).unlit === true;
}

/** The Unlit checkbox's tooltip — an i18n KEY (lv.json carries its Latvian). */
export const UNLIT_HINT_KEY =
  'No lighting: the surface glows with exactly the colour wired to Emissive (the Color socket), the same from every side, with no shadows or reflections. The separate Emissive, Roughness, Metalness, Normal, Environment and Faces have no effect and are switched off.';

/** The tooltip on a setting the Unlit material switches off — an i18n KEY. */
export const UNLIT_OFF_HINT_KEY = 'No effect while Unlit is on: nothing on this material is lit.';
