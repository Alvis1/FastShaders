/**
 * A material's non-node settings — Transparent / Side / Alpha clip / Depth
 * write — as MODULE TEXT, and back again. The ONE emitter and the ONE text
 * sanitizer:
 *
 *  - `materialSettingProps` writes the default material's top-level keys
 *    (buildShaderModule), each `parts` entry's keys (buildShaderModule again,
 *    after re-validating the text) and a targeted material's part body in
 *    editor TSL (graphToCode).
 *  - `materialSettingsFromSource` reads them back from raw source text: an
 *    imported module's top-level keys (scriptToTSL), a part body in the code
 *    panel (buildShaderModule) and a part body in the parse (codeToGraph). It
 *    also owns the text's normalisation (`settingValueText`), so the three
 *    read a commented value alike.
 *
 * One of each, so the per-part rules cannot drift from the default's: alphaTest
 * capped below 1, depthWrite:false only under transparency, a tampered side
 * emits `side: 0`, and only a literal `true` turns flat shading on.
 *
 * A LEAF on purpose — type imports only. tslCodeProcessor is in the main bundle
 * while scriptToTSL is loaded lazily (projectImport's `import('./scriptToTSL')`),
 * so the shared half cannot live in either without dragging one into the
 * other's chunk.
 */

import type { MaterialSettings } from '@/types';

/** THREE.FrontSide=0, THREE.BackSide=1, THREE.DoubleSide=2 */
export const SIDE_VALUES: ReadonlyMap<string, number> = new Map([
  ['front', 0],
  ['back', 1],
  ['double', 2],
]);

/**
 * Reverse of SIDE_VALUES.
 * Quoted spellings are accepted too — hand-authored shaderloader modules write
 * them; a value this can't map (`THREE.DoubleSide`) is DROPPED, never guessed.
 */
export const SIDE_NAMES: ReadonlyMap<string, 'front' | 'back' | 'double'> = new Map<
  string,
  'front' | 'back' | 'double'
>([
  ['0', 'front'], ['1', 'back'], ['2', 'double'],
  ["'front'", 'front'], ["'back'", 'back'], ["'double'", 'double'],
  ['"front"', 'front'], ['"back"', 'back'], ['"double"', 'double'],
]);

/**
 * The MaterialSettings keys a `parts` entry carries: the ones the loader's
 * `buildMaterial` applies to every part it builds. Four of them are in the
 * frozen a-frame-shaderloader/js/a-frame-shaderloader-0.6.js too
 * (`spec.transparent` … `spec.depthWrite`); `flatShading` is 0.8-only and was
 * added there additively, so a shader carrying it renders SMOOTH on 0.6 rather
 * than failing — that loader reads its known keys by name and ignores the rest.
 *
 * NOT `mergeVertices` — a module-level geometry directive the loader reads off
 * the return object — and NOT `displacementMode`, an editor emission choice
 * with no loader key at all.
 *
 * `flatShading` IS per-material and belongs here: it is a THREE.Material
 * property, so two materials on one model can differ, exactly as they can in
 * transparency or side.
 *
 * A Set of literals, so `__proto__` / `constructor` can never match.
 */
export const PART_SETTING_KEYS: ReadonlySet<string> = new Set([
  'transparent',
  'side',
  'alphaTest',
  'depthWrite',
  'flatShading',
]);

/**
 * Loader-form object-literal entries for one material, in the fixed order
 * transparent, side, alphaTest, depthWrite. Returns [] for undefined or no-op
 * settings, which is what keeps a document without settings byte-identical.
 *
 * This is the SECURITY gate for every settings value that becomes text:
 * `materialSettings` arrives from `.fastshader` files, `fs:graph` and saved
 * groups, and the restore paths only check that it is an object
 * (`sanitizeOutputMaterials`' cleanSettings). Nothing here interpolates a raw
 * value — booleans are tested for truthiness, side goes through a Map, and
 * alphaTest through Number().
 */
export function materialSettingProps(s: MaterialSettings | undefined): string[] {
  const out: string[] = [];
  if (s?.transparent) out.push('transparent: true');
  if (s?.side) out.push(`side: ${SIDE_VALUES.get(s.side) ?? 0}`);
  // Coerced and clamped, never interpolated raw: materialSettings arrives from
  // an adversarial FASTSHADERS_PROJECT_V1 block (extractProjectState checks the
  // node shape, not this field's type), so a string value would be spliced
  // straight into the generated module's object literal. Capped BELOW 1
  // because three's test is `diffuseColor.a.lessThanEqual(alphaTest).discard()`
  // — at exactly 1.0 an untouched alpha of 1.0 discards every fragment and the
  // whole object silently disappears.
  const alphaTest = Number(s?.alphaTest);
  if (Number.isFinite(alphaTest) && alphaTest > 0) out.push(`alphaTest: ${Math.min(alphaTest, 0.99)}`);
  // Emitted only when non-default (true is THREE's default), so existing
  // exports stay byte-identical. Applied by the loader's material-prop pass
  // (0.5+, and every new export references 0.8); older CDN loaders ignore the
  // extra key harmlessly.
  //
  // Gated on `transparent` as well: depth-write-off is a transparency sorting
  // control, and on an OPAQUE material it just makes the surface self-occlude
  // into cutout-looking holes. Belt-and-braces with the settings menu, which
  // now clears the flag when Transparent is switched off — this also disarms
  // the flag on graphs that already stored it.
  if (s?.depthWrite === false && s?.transparent) out.push('depthWrite: false');
  // LAST, so every key that existed before keeps its position and a document
  // that does not set this emits byte-identically. Only `true` is written —
  // smooth is three's default, and an explicit `flatShading: false` would say
  // nothing while changing the bytes of every export.
  if (s?.flatShading) out.push('flatShading: true');
  return out;
}

/**
 * A settings value's text with its comments removed and its ends trimmed —
 * the ONE normalisation `materialSettingsFromSource` puts every raw value
 * through, so its three callers cannot disagree about what a value says. They
 * do not slice the same text: codeToGraph takes Babel's value node, whose range
 * starts and ends on the expression, while buildShaderModule's part loop and
 * scriptToTSL take everything from the colon to the next top-level comma,
 * trailing comment included. Compared raw, `transparent: true /* glass *\/`
 * read `true` in the parse and `true /* glass *\/` in the module, so an Apply
 * rendered the part opaque under a section showing Transparent ticked.
 *
 * String-aware, by the same rules as tslCodeProcessor's `stripComments` — which
 * this leaf cannot import (see the header), so outputPartSettings.test.ts runs
 * the two over one corpus. Every comment becomes whitespace, so `1/**\/0`
 * stays two tokens and is rejected rather than read as `10`.
 */
export function settingValueText(v: string | undefined): string {
  if (v === undefined) return '';
  let out = '';
  let quote = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < v.length) out += v[++i];
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && (v[i + 1] === '*' || v[i + 1] === '/')) {
      // A block comment runs to its `*\/` (or the end); a line comment stops
      // BEFORE its newline, which the next pass keeps as whitespace.
      const block = v[i + 1] === '*';
      const end = block ? v.indexOf('*/', i + 2) : v.indexOf('\n', i + 2);
      i = end === -1 ? v.length : block ? end + 1 : end - 1;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
  }
  return out.trim();
}

/**
 * Turn the RAW source text of the stripped material keys into a validated
 * MaterialSettings. Imported modules are adversarial input, so every value is
 * coerced rather than trusted, and anything unrecognised is dropped instead of
 * carried: an inert setting is always better than a spliced one, because these
 * values are re-emitted into a generated module (buildShaderModule) that the
 * XR popup executes at the app's REAL origin.
 *
 * The rules mirror the emitter's own, so an import → export round trip is
 * byte-stable: alphaTest capped BELOW 1 (three discards on `alpha <= alphaTest`,
 * so exactly 1.0 erases the mesh), and depthWrite:false kept only under
 * transparency (on an opaque material it self-occludes into cutout-looking
 * holes — the exact trap ShaderSettingsMenu's handleTransparentChange closes).
 * Returns undefined for an empty result: absent IS the historical no-settings
 * state, and it is what CLEARS a previous graph's settings on import.
 *
 * ALWAYS returns a FRESH object (or undefined) — never a mutation of an
 * existing one. ShaderPreview, CodeEditor and useSyncEngine's mergeMatch all
 * subscribe to `materialSettings` BY REFERENCE and bail on Object.is, so an
 * in-place update would leave the preview and the A-Frame tab showing the old
 * settings with no error.
 *
 * Callers reading a `parts` entry pass ONLY PART_SETTING_KEYS entries: a part's
 * `mergeVertices` is not a part setting (see PART_SETTING_KEYS).
 */
export function materialSettingsFromSource(
  raw: Record<string, string>,
  displacementOffset = false,
): MaterialSettings | undefined {
  const out: MaterialSettings = {};
  if (displacementOffset) out.displacementMode = 'offset';
  if (settingValueText(raw.transparent) === 'true') out.transparent = true;
  // A Map lookup, never a Record index: raw.side is parsed source text, and a
  // Record would resolve 'constructor' through the prototype chain to a
  // Function — which structuredClone can't clone, so the next pushHistory
  // would throw out of a React effect and blank the whole editor.
  const side = SIDE_NAMES.get(settingValueText(raw.side));
  if (side) out.side = side;
  // `Number('')` is 0, so an absent key stays absent exactly as NaN did.
  const alphaTest = Number(settingValueText(raw.alphaTest));
  if (Number.isFinite(alphaTest) && alphaTest > 0) out.alphaTest = Math.min(alphaTest, 0.99);
  if (out.transparent && settingValueText(raw.depthWrite) === 'false') out.depthWrite = false;
  // Only an explicit `false` is meaningful — absent means the default (weld),
  // which is exactly what a module that never carried the key is saying. This
  // is what makes the setting survive an export→import round trip, so the
  // "NOT recoverable from the module text" note in projectImport no longer
  // applies to it.
  if (settingValueText(raw.mergeVertices) === 'false') out.mergeVertices = false;
  // Only an explicit `true`: absent is smooth, which is what a module that
  // never carried the key means.
  if (settingValueText(raw.flatShading) === 'true') out.flatShading = true;
  return Object.keys(out).length > 0 ? out : undefined;
}
