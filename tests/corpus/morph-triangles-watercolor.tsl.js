// Morph between two procedural textures:
//   • Texture A — deep-blue voronoi "tangram" tiles with rare white accents
//   • Texture B — soft watercolor (cream / steel-blue / navy / ochre)
//
// Drive the crossfade with the `morph` uniform (0 = geometric, 1 = watercolor).
//
// Paste into the FastShaders TSL editor and press Save.
// Optimisations:
//   • Only 3 noise samples total (1 worley + 2 fbm) — worley supplies both cell
//     distance and crackle edges via F1/F2 in one call.
//   • The low-frequency fbm acts as a SHARED colour driver — it picks the
//     blue for texture A and the cream→steel→navy ramp for texture B, so the
//     two sides remain visually coherent mid-morph while costing one sample.
//   • Final mix is branch-free (standard GPU pattern); no divergent work.

import {
  add, clamp, color, Fn, mix, mul,
  mx_fractal_noise_float, mx_worley_noise_vec3,
  positionGeometry, smoothstep, sub, uniform,
} from "three/tsl";

const shader = Fn(() => {
  const morph        = uniform(0.5);   // 0 = triangles, 1 = watercolor
  const scale        = uniform(1.0);   // global frequency multiplier
  const geoScale     = uniform(5.0);   // voronoi cell density
  const waterScale   = uniform(1.5);   // low-freq colour bands
  const splashScale  = uniform(3.2);   // ochre splash density
  const accentAmount = uniform(0.6);   // ochre intensity
  const edgeSharp    = uniform(0.045); // seam width in texture A

  const posRaw = positionGeometry;
  const pos    = mul(posRaw, scale);   // applied once, reused by both textures

  // ── Shared low-frequency colour driver ─────────────────────────────────
  const posLow   = mul(pos, waterScale);
  const baseN    = mx_fractal_noise_float(posLow);   // ~[-1,1]
  const baseHalf = mul(baseN, 0.5);
  const base01   = add(baseHalf, 0.5);
  const baseT    = clamp(base01, 0, 1);

  // ── Texture A — voronoi "tangram" ──────────────────────────────────────
  const posGeo  = mul(pos, geoScale);
  const worley  = mx_worley_noise_vec3(posGeo);      // x=F1, y=F2, z=F3
  const f1      = worley.x;
  const f2      = worley.y;
  const edge    = sub(f2, f1);                       // crackle distance
  const seamHi  = add(edgeSharp, 0.02);
  const edgeK   = smoothstep(edgeSharp, seamHi, edge);

  const navy      = color(0x0A1B6E);
  const royal     = color(0x2B46E8);
  const blueMix   = smoothstep(0.05, 0.95, baseT);
  const cellBlue  = mix(navy, royal, blueMix);

  const whiteMask = smoothstep(0.93, 0.98, baseT);   // rare white cells
  const whiteCol  = color(0xF5F5F0);
  const cellLit   = mix(cellBlue, whiteCol, whiteMask);

  const seam   = color(0x030517);
  const geoTex = mix(seam, cellLit, edgeK);

  // ── Texture B — watercolor ─────────────────────────────────────────────
  const posSplash = mul(pos, splashScale);
  const splashN   = mx_fractal_noise_float(posSplash);
  const splashHalf = mul(splashN, 0.5);
  const splash01   = add(splashHalf, 0.5);

  const cream    = color(0xFBF2DF);
  const steel    = color(0x6F8CA8);
  const deepNavy = color(0x1E2E4A);
  const ochre    = color(0xE0A04F);

  const cool1    = mix(cream, steel, baseT);         // reuses baseT
  const coolRamp = smoothstep(0.4, 0.95, baseT);
  const cool2    = mix(cool1, deepNavy, coolRamp);

  const ochreMask  = smoothstep(0.60, 0.82, splash01);
  const ochreScale = mul(ochreMask, accentAmount);
  const waterTex   = mix(cool2, ochre, ochreScale);

  // ── Crossfade ──────────────────────────────────────────────────────────
  const blend  = clamp(morph, 0, 1);
  const result = mix(geoTex, waterTex, blend);
  return result;
});
export default shader;
