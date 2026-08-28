/**
 * Cost budget guard for the preset library.
 *
 * Every preset is dropped onto a Quest-3-class budget of 350 points
 * (`complexity.json` meta.maxBudget), and the CostBar the user reads is
 * literally `sum(nodeCostPoints)` over the graph (useSyncEngine). Pinning the
 * numbers here means a preset edit that quietly doubles its price fails in CI
 * rather than on a headset.
 *
 * The exact totals are asserted rather than a loose ceiling: these presets are
 * teaching material whose prices are quoted in their card badges, and a silent
 * drift is exactly what this catches. Update a number here only together with a
 * deliberate change to the preset's TSL.
 */

import { describe, it, expect } from 'vitest';
import { getBuiltinPresets } from './builtinPresets';
import { codeToGraph } from '@/engine/codeToGraph';
import { nodeCostPoints } from '@/utils/nodeCost';
import complexityData from './complexity.json';

/** What the CostBar shows: the graph's nodes minus the Output node. */
function costOf(code: string): number {
  const { nodes, edges } = codeToGraph(code);
  return nodes
    .filter((n) => n.data.registryType !== 'output')
    .reduce((sum, n) => sum + nodeCostPoints(n, edges), 0);
}

const EXPECTED: Record<string, number> = {
  gradient: 4,
  stripes: 30,
  checker: 11,
  // 22 — distance (12) is most of it; the whole point is that a shape costs
  // barely more than a checkerboard.
  circle: 22,
  'edge-glow': 36,
  pulse: 9,
  'uv-scroll': 7,
  'color-ramp': 12,
  // 40, of which toHsl (15) and hsl (15) are 30 — the round trip IS the preset.
  'hue-shift': 40,
  // 49, of which the perlin call is 35 — the point of the preset. The two-node
  // 0..1 remap around it costs 2; folding it into the `remap` node would cost 5.
  'noise-mask': 49,
  // 22. mx_cell_noise_float is 7; its distance-carrying siblings are 230+.
  mosaic: 22,
  'toon-ramp': 34,
  // 8 — it returns the wave HEIGHT; the Output node adds it along the normal,
  // so the preset no longer pays for the normalize/mul/add it used to duplicate.
  'vertex-wave': 8,
  // 39 — the perlin call is 35, exactly as in noise-mask. The vertex stage is
  // not what costs; the noise is.
  'noise-blob': 39,
  'top-cover': 19,
  // 27 — the max() guard on the span is one node, and stops a scrub that
  // collapses fogFar onto fogNear from dividing by zero.
  'distance-fog': 27,
  dissolve: 52,
  // 45 with no noise node at all — a tier-3 look for less than noise-mask.
  iridescence: 45,
  'lava-crust': 55,
  hologram: 46,
  'teleport-beam': 29,
  'force-field': 64,
  'stylized-water': 49,
  // 78 — the library's priciest preset (two cross products at 12 each, three
  // dot products, a pow). Still 39% of the 200-point Quest 3 CostBar budget.
  'studio-shine': 78,
};

describe('preset GPU cost', () => {
  const presets = getBuiltinPresets();

  it.each(presets.map((p) => [p.id, p] as const))('%s costs what it is documented to', (id, preset) => {
    const expected = EXPECTED[id];
    expect(expected, `no expected cost recorded for "${id}"`).toBeDefined();
    expect(costOf(preset.code)).toBe(expected);
  });

  it('keeps every preset inside the headset budget', () => {
    const max = complexityData.meta.maxBudget;
    for (const preset of presets) {
      expect(costOf(preset.code), `${preset.id} exceeds the ${max}-point budget`).toBeLessThanOrEqual(max);
    }
  });

  it('prices the world normal, since it is not free like normalLocal', () => {
    // normalWorld = normalView.transformDirection(cameraViewMatrix), i.e. a
    // mat3 multiply plus a normalize — priced with its positionWorldDirection /
    // positionViewDirection neighbours. Because transformDirection already
    // ends in normalize(), presets must NOT wrap it in another normalize(): the
    // node is unit length by construction and the extra call is 7 wasted points.
    const costs = complexityData.costs as Record<string, number>;
    expect(costs.normalWorld).toBe(7);
    expect(costs.normalLocal).toBe(0);
    for (const preset of getBuiltinPresets()) {
      expect(preset.code, `${preset.id} re-normalizes an already-unit normalWorld`)
        .not.toContain('normalize(normalWorld)');
    }
  });
});
