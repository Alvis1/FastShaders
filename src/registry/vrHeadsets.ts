/**
 * The built-in performance devices — every row a MEASURED one — and the
 * per-node prices a device selection lays over complexity.json.
 *
 * A LEAF (it imports nothing): the store reads it at module scope, and the
 * device-comparison page (src/compare) lists the same rows without booting the
 * store. Moved out of store/useAppStore.ts, which re-exports both names.
 * See docs/dev/storage-and-limits.md (VR cost budgeting).
 */

export interface VRHeadset {
  id: string;
  label: string;
  maxPoints: number;
  /** Recommended max texture (longest-side) dimension for this device's GPU.
   *  Dropped images are downscaled to fit it (see `encodeImageFile`); it is an
   *  upper bound, not a target — the per-image byte budget can shrink further. */
  maxTextureDim: number;
  /** Measured per-node prices laid over complexity.json while this row is
   *  selected, exactly as a dropped profile's `costs` are; absent = the table
   *  itself (the device the table was calibrated on). */
  costs?: Readonly<Record<string, number>>;
  /** The benchData run `costs` came from — the cost bar's provenance tag and
   *  the study package's `source` name it. Present exactly when `costs` is. */
  costsBasis?: string;
}

export const VR_HEADSETS: VRHeadset[] = [
  // Every row is a MEASURED device. ShaderCarousel/benchData/quest3-20260723
  // is the calibration basis for complexity.json's prices AND this budget. The
  // paper-spec presets (Quest 2/3S, Steam Frame, Pico 4, Vision Pro) were
  // REMOVED 2026-08-14 by owner decision: an unmeasured budget certifies
  // shaders for hardware nobody ran, and a device earns a row only by running
  // ShaderCarousel on it. A persisted fs:headsetId naming a removed preset
  // degrades to this entry (every resolver falls back to VR_HEADSETS[0]). For
  // the record, the pixel-scaling arithmetic for a same-GPU sibling: Quest 3S
  // = 200 × (2064·2208)/(1832·1920) ≈ 260 (same Adreno 740, fewer pixels).
  { id: 'quest3', label: 'Meta Quest 3', maxPoints: 200, maxTextureDim: 2048 },
  // Measured 2026-10-21 (benchData/steamframe-20261021, MicroPlane, GPU
  // timestamps, valid). Only the noise family was run, so only it is
  // repriced; every other node keeps the Quest 3 table — conservative, since
  // this GPU measured faster. The prices are RATIO-BRIDGED, not the profile's
  // raw points: the table is Quest 3 STATIC, the run is MicroPlane, and on
  // Quest 3 MicroPlane under-reads the cheap noises against Static (Perlin
  // 27 vs 36), so each price is table × SteamFrame-MicroPlane ÷
  // Quest3-MicroPlane, the same bench on both devices (steamFrameHeadset.test.ts
  // re-derives every number from the committed files). Cell Noise read 0 on
  // BOTH devices' MicroPlane — under the timer floor, not free — so it keeps
  // the table's Static price. The budget stays 200: the device's speed is in
  // the prices, and its eye-buffer size is unknown (the InOut run could not
  // read it), so there is no measured pixel ratio to scale by. Same id as the
  // removed paper-spec row, so a stale fs:headsetId lands here, on a measured one.
  {
    id: 'steamframe',
    label: 'Valve Steam Frame',
    maxPoints: 200,
    maxTextureDim: 2048,
    costs: { perlin: 25, perlinVec3: 61, fbm: 75, fbmVec3: 135, voronoi: 174, voronoiVec2: 174, voronoiVec3: 204 },
    costsBasis: 'steamframe-20261021',
  },
];

/** The per-node prices a device selection lays over complexity.json: a cost
 *  profile's, else a built-in headset's own measured ones, else none. The ONE
 *  lookup the boot and `setSelectedHeadsetId` both apply. */
export function deviceCostOverrides(
  id: string,
  profiles: { id: string; costs: Record<string, number> }[],
): Record<string, number> | null {
  const p = profiles.find((x) => x.id === id);
  if (p) return p.costs;
  const h = VR_HEADSETS.find((x) => x.id === id);
  return h?.costs ? { ...h.costs } : null;
}
