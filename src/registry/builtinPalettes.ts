/**
 * The shipped starter palettes, with the same standing as `builtinTextures` /
 * `builtinPresets`: read-only content that lives in code, not user data.
 *
 * They are NOT copied into a shader on first run. A shader starts with no
 * palettes of its own and simply sees these below its own; "Duplicate" makes
 * an editable copy that then belongs to the shader. That keeps a fresh shader's
 * saved payload empty and means a future edit to this list reaches every
 * existing project rather than only new ones.
 *
 * WHY THESE COLOURS. A shader editor's palette is not a mood board — it is a
 * set of physically meaningful starting values, which is exactly what is hard
 * to guess and easy to get wrong by eye. Metals carry measured F0 reflectances,
 * dielectrics sit inside the plausible albedo band, the skin ramp spans the
 * Fitzpatrick scale, and the emissive entries carry the HDR multiplier they are
 * meant to be scaled by. Every entry is NAMED, and the name is the whole point:
 * `#ffe39d` means nothing, "Gold" means everything.
 *
 * ORDER IS DELIBERATE — Emissive & FX first. It is the group people reach for
 * most (glow is the common case in a hobby shader), and it is the one whose
 * hexes are least guessable from the swatch alone.
 *
 * SWATCHES LIE, AND THAT IS EXPECTED. A metal's colour is its F0, so a flat
 * chip of "Gold" reads as pale cream and only becomes gold once a BRDF shades
 * it; an emissive chip is the colour BEFORE its multiplier. Both facts are in
 * the per-colour names/tooltips rather than in a caption, because the swatch is
 * where the user is looking.
 */

import type { Palette } from '@/utils/palettes';

/**
 * Authoring form: colour + name in ONE literal, so a hex and its label cannot
 * drift apart on the page where they are typed. `toPalette` splits them into
 * the parallel `colors`/`names` arrays the `Palette` model stores — the
 * split happens once, here, rather than in four hand-aligned array literals.
 */
type Entry = readonly [hex: string, name: string];

function toPalette(id: string, name: string, entries: readonly Entry[]): Palette {
  return {
    id,
    name,
    colors: entries.map((e) => e[0]),
    names: entries.map((e) => e[1]),
  };
}

/**
 * Emission colour. The `x N` in each name is the suggested HDR multiplier:
 * final emission = linear colour x N. The values assume a bloom-enabled,
 * tonemapped pipeline, so they are a starting point, not a constant.
 */
const EMISSIVE: readonly Entry[] = [
  ['#c81e08', 'Ember x2'],
  ['#ff6e14', 'Flame Orange x4'],
  ['#ffc33c', 'Flame Yellow x6'],
  ['#fff0d2', 'White Hot x10'],
  ['#ffbe78', 'Tungsten Glow x2'],
  ['#ff2828', 'Laser Red x8'],
  ['#78ff3c', 'Toxic Green x5'],
  ['#3c8cff', 'Electric Blue x6'],
  ['#3ce6ff', 'Hologram Cyan x4'],
  ['#963cff', 'Plasma Violet x6'],
  ['#ff3cc8', 'Neon Magenta x5'],
  ['#6428ff', 'UV Blacklight x3'],
];

/**
 * Metal F0 (base colour with metalness = 1). These are the measured
 * reflectances the BRDF expects, which is why the chips look washed out flat —
 * they only read as metal once shaded. Brass and Bronze are alloys and so are
 * approximations rather than measurements.
 */
const METALS: readonly Entry[] = [
  ['#ffe39d', 'Gold'],
  ['#fcfaf5', 'Silver'],
  ['#fad1c2', 'Copper'],
  ['#f5f6f6', 'Aluminum'],
  ['#c5c7c8', 'Iron'],
  ['#c4c5c4', 'Chromium'],
  ['#d4cdc0', 'Nickel'],
  ['#c2bbb3', 'Titanium'],
  ['#d6d1c9', 'Platinum'],
  ['#d5d4d0', 'Cobalt'],
  ['#f5e4ae', 'Brass (alloy, approx.)'],
  ['#e8bb96', 'Bronze (alloy, approx.)'],
];

/**
 * Albedo for subsurface-ish materials (metalness = 0). The skin ramp spans the
 * Fitzpatrick scale so a character shader starts from a real distribution
 * rather than one tone lightened and darkened. Flesh Red is the subsurface
 * radius colour, NOT a surface albedo — hence the qualifier in its name.
 */
const ORGANICS: readonly Entry[] = [
  ['#f3d9c6', 'Skin I - Porcelain'],
  ['#e7c0a2', 'Skin II - Fair'],
  ['#d3a183', 'Skin III - Light'],
  ['#b3805c', 'Skin IV - Tan'],
  ['#8c5b3f', 'Skin V - Brown'],
  ['#5e3b29', 'Skin VI - Deep'],
  ['#942a20', 'Flesh Red (SSS radius)'],
  ['#e3c98f', 'Beeswax'],
  ['#e9e7e2', 'Marble'],
  ['#6fa083', 'Jade'],
  ['#5f8c46', 'Leaf Green'],
  ['#4a5b2e', 'Moss'],
];

/**
 * Albedo for non-metals (metalness = 0). Every value sits inside the
 * physically plausible band (roughly 30-247 sRGB): no pure black, no pure
 * white. Charcoal and Snow are deliberately AT those bounds, so the palette
 * also teaches where they are.
 */
const DIELECTRICS: readonly Entry[] = [
  ['#232323', 'Charcoal (dark albedo floor)'],
  ['#2b2b2e', 'Rubber'],
  ['#3a3a3c', 'Asphalt'],
  ['#7a7873', 'Granite'],
  ['#9c9a94', 'Concrete'],
  ['#9c4e3b', 'Brick'],
  ['#b06b4c', 'Terracotta'],
  ['#5c4632', 'Walnut Wood'],
  ['#a98e6f', 'Oak Wood'],
  ['#d3bd97', 'Sand'],
  ['#e8e5de', 'Ceramic White'],
  ['#f2f5f7', 'Snow (bright albedo ceiling)'],
];

export const BUILTIN_PALETTES: readonly Palette[] = [
  toPalette('builtin-emissive', 'Emissive & FX', EMISSIVE),
  toPalette('builtin-metals', 'Metals', METALS),
  toPalette('builtin-organics', 'Organics & Subsurface', ORGANICS),
  toPalette('builtin-dielectrics', 'Dielectrics & Surfaces', DIELECTRICS),
];

/** True for an id this module owns — such a palette is read-only, so the UI
 *  offers Duplicate instead of Edit/Delete. */
export function isBuiltinPaletteId(id: string): boolean {
  return BUILTIN_PALETTES.some((p) => p.id === id);
}
