import type { AppNode, NodeDefinition } from '@/types';
import { getNodeValues } from '@/types';
import { nextPropertyName } from '@/utils/propertyConvert';
import { hasNoiseRangeFlag } from '@/utils/noiseRange';

/**
 * Initial `values` for a node the USER is adding right now.
 *
 * Shared by the two creation surfaces — the palette-tile drop path
 * (`placeTilePayload`) and AddNodeMenu — so an added node is identical however
 * it was added. Deliberately NOT used by the paths that rebuild a graph from
 * authored data (code→graph parsing, project import, built-in textures): those
 * carry their own values, and seeding a random colour there would corrupt a
 * shader on load.
 */

/**
 * "Vibrant Color Fiesta" — https://coolors.co/palette/ffbe0b-fb5607-ff006e-8338ec-3a86ff
 *
 * A hand-picked palette rather than a generated colour: five hues that are all
 * vivid, mutually distinguishable, and legible against both the light and dark
 * canvas, which a random roll can only approximate. Order is the palette's own.
 */
export const NEW_COLOR_PALETTE = [
  '#ffbe0b',
  '#fb5607',
  '#ff006e',
  '#8338ec',
  '#3a86ff',
] as const;

/**
 * A colour for a freshly added colour node, drawn from NEW_COLOR_PALETTE.
 *
 * `rand` is injectable so tests can pin the output.
 */
export function randomColorHex(rand: () => number = Math.random): string {
  const i = Math.min(NEW_COLOR_PALETTE.length - 1, Math.floor(rand() * NEW_COLOR_PALETTE.length));
  return NEW_COLOR_PALETTE[i];
}

/** True for the defs whose payload is a colour swatch (`values.hex`). */
function isColorDef(type: string): boolean {
  return type === 'color' || type === 'property_color';
}

export function initialNodeValues(
  def: NodeDefinition,
  existingNodes: AppNode[],
  rand: () => number = Math.random,
): Record<string, unknown> {
  const values: Record<string, unknown> = { ...def.defaultValues };
  // MaterialX Perlin/fBm are signed ~[-1,1], which surprises people: round()
  // gives -1/0/+1 and Output.discard culls BOTH tails. New nodes therefore
  // default to the 0-1 remap. This is the ONLY writer of the flag on a fresh
  // node, and that is the whole scope rule — this function is deliberately NOT
  // used by code→graph, project import, or the built-in textures/presets, so
  // every existing graph and every shipped asset stays signed and emits
  // byte-identically. Stored as 0/1, not a boolean: `values` is typed
  // Record<string, string | number>.
  if (hasNoiseRangeFlag(def.type)) values.signed = 0;
  // Auto-name property nodes — one shared sequence with the convert-to-uniform
  // action, so no surface can mint a duplicate identifier.
  if (def.type === 'property_float' || def.type === 'property_color') {
    const prefix = def.type === 'property_color' ? 'color' : 'property';
    values.name = nextPropertyName(prefix, existingNodes);
  }
  // Every colour node would otherwise arrive as the registry's red, so a graph
  // of them reads as one repeated swatch until each is opened and edited.
  // Prefer a palette entry no colour node is using yet: with only five hues a
  // uniform roll repeats the previous colour about one time in five, which is
  // exactly the sameness this is meant to avoid. Once all five are on the
  // canvas there is nothing left to spread, so it falls back to a plain roll.
  if (isColorDef(def.type)) {
    const used = new Set<string>();
    for (const n of existingNodes) {
      const hex = getNodeValues(n)?.hex;
      if (typeof hex === 'string') used.add(hex.toLowerCase());
    }
    const free = NEW_COLOR_PALETTE.filter((c) => !used.has(c));
    values.hex = free.length
      ? free[Math.min(free.length - 1, Math.floor(rand() * free.length))]
      : randomColorHex(rand);
  }
  return values;
}
