# TSL-Textures Library Analysis

**Package:** tsl-textures v3.0.1
**Location:** `node_modules/tsl-textures/src/`
**Total Files:** 54 JavaScript source files
**Total Exports:** 119 functions

---

## Utility Module — tsl-utils.js (201 non-comment lines, 16 exports)

### TSL Shader Functions (GPU-side, written with `Fn`)

| Function | Code Lines | Signature | Purpose |
|----------|----------:|-----------|---------|
| `vnoise` | 9 | `vec3 → float` | Simple dot-product hash noise, returns [-1,1] |
| `approximateNormal` | 13 | `(pos, posU, posV) → vec3` | Normal from point + 2 neighbors via cross product |
| `remapExp` | 15 | `(x, fromMin, fromMax, toMin, toMax) → float` | Exponential remap (log-space interpolation) |
| `hslHelper` | 14 | `(h, s, l, n) → float` | Internal helper for HSL→RGB channel calc |
| `hsl` | 15 | `vec3 → vec3` | HSL to RGB conversion (depends on hslHelper) |
| `toHsl` | 32 | `vec3 → vec3` | RGB to HSL conversion (with branching via `If`) |
| `spherical` | 14 | `(phi, theta) → vec3` | Angles to unit sphere point |
| `rotatePivot` | 11 | `(vector, pivot, angle) → vec3` | Rotate vector around a pivot point |
| `selectPlanar` | 14 | `(pos, selAngles, selCenter, selWidth) → float` | Planar selection zone [0,1] with smoothstep |

### Re-exported from `three/tsl` (aliases, 0 custom lines)

| Export | Original | Purpose |
|--------|----------|---------|
| `noise` | `mx_noise_float` | Perlin noise |
| `fractal` | `mx_fractal_noise_float` | Fractal noise (float) |
| `fractal3` | `mx_fractal_noise_vec3` | Fractal noise (vec3) |
| `voronoi` | `mx_worley_noise_float` | Worley/Voronoi noise (float) |
| `voronoi2` | `mx_worley_noise_vec2` | Worley/Voronoi noise (vec2) |
| `voronoi3` | `mx_worley_noise_vec3` | Worley/Voronoi noise (vec3) |

### Non-shader JS Functions

| Function | Code Lines | Purpose |
|----------|----------:|---------|
| `showFallbackWarning` | 28 | Shows "NO WEBGPU — TRYING WEBGL2" banner if no GPU adapter |
| `hideFallbackWarning` | 10 | Hides the banner after a countdown |

---

## Texture Generators — Comprehensive Table

All line counts exclude comments and empty lines.
Utils marked with `*` are re-exports from `three/tsl` (0 custom lines in tsl-utils).
`hsl` includes its dependency `hslHelper` (14 lines) in the util line total.

| Texture | Code Lines | Utils Used | Util Lines | Total |
|---------|----------:|-----------|-----------:|------:|
| brain | 65 | fractal*, noise* | 0 | 65 |
| bricks | 69 | fractal3*, noise*, remapExp(15) | 15 | 84 |
| camouflage | 49 | noise* | 0 | 49 |
| caustics | 44 | voronoi*, voronoi3* | 0 | 44 |
| cave-art | 46 | noise* | 0 | 46 |
| circle-decor | 44 | noise*, voronoi* | 0 | 44 |
| circles | 44 | hsl(15+14), toHsl(32) | 61 | 105 |
| clouds | 66 | fractal* | 0 | 66 |
| concrete | 56 | approximateNormal(13), noise* | 13 | 69 |
| cork | 60 | noise*, vnoise(9) | 9 | 69 |
| crumpled-fabric | 47 | noise* | 0 | 47 |
| dalmatian-spots | 46 | noise* | 0 | 46 |
| darth-maul | 49 | noise* | 0 | 49 |
| dyson-sphere | 90 | (none) | 0 | 90 |
| entangled | 43 | noise* | 0 | 43 |
| fordite | 41 | hsl(15+14), noise* | 29 | 70 |
| gas-giant | 55 | hsl(15+14), noise*, toHsl(32) | 61 | 116 |
| grid | 50 | (none) | 0 | 50 |
| isolayers | 47 | hsl(15+14), noise*, toHsl(32) | 61 | 108 |
| isolines | 41 | noise* | 0 | 41 |
| karst-rock | 36 | noise* | 0 | 36 |
| marble | 57 | noise* | 0 | 57 |
| melter | 39 | noise* | 0 | 39 |
| neon-lights | 65 | hsl(15+14), noise*, toHsl(32) | 61 | 126 |
| perlin-noise | 37 | noise* | 0 | 37 |
| photosphere | 39 | noise* | 0 | 39 |
| planet | 107 | noise* | 0 | 107 |
| polka-dots | 61 | spherical(14) | 14 | 75 |
| processed-wood | 50 | noise* | 0 | 50 |
| protozoa | 67 | noise* | 0 | 67 |
| reticular-veins | 42 | noise*, voronoi* | 0 | 42 |
| roman-paving | 30 | voronoi2* | 0 | 30 |
| rotator | 73 | approximateNormal(13), rotatePivot(11), selectPlanar(14) | 38 | 111 |
| rough-clay | 55 | approximateNormal(13), noise*, voronoi* | 13 | 68 |
| runny-eggs | 107 | approximateNormal(13), voronoi* | 13 | 120 |
| rust | 84 | noise* | 0 | 84 |
| satin | 40 | noise* | 0 | 40 |
| scaler | 63 | approximateNormal(13), selectPlanar(14) | 27 | 90 |
| scepter-head | 56 | hsl(15+14), noise*, remapExp(15), toHsl(32) | 76 | 132 |
| scream | 39 | hsl(15+14), noise*, toHsl(32) | 61 | 100 |
| stars | 40 | hsl(15+14), noise*, toHsl(32) | 61 | 101 |
| static-noise | 40 | noise*, vnoise(9) | 9 | 49 |
| supersphere | 61 | approximateNormal(13) | 13 | 74 |
| tiger-fur | 47 | noise* | 0 | 47 |
| translator | 69 | approximateNormal(13), selectPlanar(14) | 27 | 96 |
| turbulent-smoke | 42 | fractal*, fractal3*, voronoi* | 0 | 42 |
| voronoi-cells | 57 | noise*, vnoise(9) | 9 | 66 |
| water-drops | 57 | approximateNormal(13), noise* | 13 | 70 |
| watermelon | 54 | noise* | 0 | 54 |
| wood | 61 | noise* | 0 | 61 |
| zebra-lines | 43 | spherical(14) | 14 | 57 |

---

## Utils Usage Frequency

| Util | Code Lines | Used By |
|------|----------:|--------:|
| noise* | 0 | 37 textures |
| hsl (+hslHelper) | 29 | 8 textures |
| toHsl | 32 | 7 textures |
| approximateNormal | 13 | 8 textures |
| voronoi* | 0 | 5 textures |
| fractal* | 0 | 3 textures |
| vnoise | 9 | 3 textures |
| selectPlanar | 14 | 3 textures |
| fractal3* | 0 | 2 textures |
| remapExp | 15 | 2 textures |
| spherical | 14 | 2 textures |
| rotatePivot | 11 | 1 texture |
| voronoi2* | 0 | 1 texture |
| voronoi3* | 0 | 1 texture |

`*` = re-export from three/tsl (Three.js built-in, 0 custom lines)

---

## Entry Point — tsl-textures.js

Re-exports all 51 texture generators plus all utilities from `tsl-utils.js`.

---

## Other Nodes (TSL Built-ins) — from `nodeRegistry.ts`

These are declarative node definitions wrapping `three/tsl` functions. Each is a single registry entry (no custom function body — they call the TSL built-in directly). Defined in `src/registry/nodeRegistry.ts` (540 lines, 4 exported functions).

Exported functions: `searchNodes()`, `getAllDefinitions()`, `getFlowNodeType()`, + registry maps (`NODE_REGISTRY`, `TSL_FUNCTION_TO_DEF`).

| Node | Label | Category | TSL Function | Inputs | Outputs |
|------|-------|----------|-------------|-------:|--------:|
| positionGeometry | Position | input | `positionGeometry` | 0 | 1 |
| normalLocal | Normal | input | `normalLocal` | 0 | 1 |
| tangentLocal | Tangent | input | `tangentLocal` | 0 | 1 |
| time | Time | input | `time` | 0 | 1 |
| screenUV | Screen UV | input | `screenUV` | 0 | 1 |
| uv | UV | input | `uv` | 4 | 1 |
| property_float | Property (float) | input | `uniform` | 0 | 1 |
| slider | Slider | input | `float` | 0 | 1 |
| float | Float | type | `float` | 0 | 1 |
| int | Int | type | `int` | 0 | 1 |
| vec2 | Vec2 | type | `vec2` | 2 | 1 |
| vec3 | Vec3 | type | `vec3` | 3 | 1 |
| vec4 | Vec4 | type | `vec4` | 4 | 1 |
| color | Color | type | `color` | 0 | 1 |
| add | Add | arithmetic | `add` | 2 | 1 |
| sub | Subtract | arithmetic | `sub` | 2 | 1 |
| mul | Multiply | arithmetic | `mul` | 2 | 1 |
| div | Divide | arithmetic | `div` | 2 | 1 |
| sin | Sine | math | `sin` | 1 | 1 |
| cos | Cosine | math | `cos` | 1 | 1 |
| abs | Abs | math | `abs` | 1 | 1 |
| sqrt | Sqrt | math | `sqrt` | 1 | 1 |
| exp | Exp | math | `exp` | 1 | 1 |
| log2 | Log2 | math | `log2` | 1 | 1 |
| floor | Floor | math | `floor` | 1 | 1 |
| round | Round | math | `round` | 1 | 1 |
| fract | Fract | math | `fract` | 1 | 1 |
| pow | Power | math | `pow` | 2 | 1 |
| mod | Mod | math | `mod` | 2 | 1 |
| clamp | Clamp | math | `clamp` | 3 | 1 |
| min | Min | math | `min` | 2 | 1 |
| max | Max | math | `max` | 2 | 1 |
| mix | Mix | interpolation | `mix` | 3 | 1 |
| smoothstep | Smoothstep | interpolation | `smoothstep` | 3 | 1 |
| remap | Remap | interpolation | `remap` | 5 | 1 |
| select | Select | interpolation | `select` | 3 | 1 |
| normalize | Normalize | vector | `normalize` | 1 | 1 |
| length | Length | vector | `length` | 1 | 1 |
| distance | Distance | vector | `distance` | 2 | 1 |
| dot | Dot Product | vector | `dot` | 2 | 1 |
| cross | Cross Product | vector | `cross` | 2 | 1 |
| split | Split | vector | `split` | 1 | 4 |
| append | Append | vector | `append` | 2 | 1 |
| voronoi | Voronoi | noise | `mx_worley_noise_float` | 0 | 1 |
| hsl | HSL to RGB | color | `hsl` | 3 | 1 |
| toHsl | RGB to HSL | color | `toHsl` | 1 | 1 |
| output | Output | output | `output` | 6 | 0 |
| unknown | Unknown | unknown | (varies) | 0 | 1 |

### Summary by Category

| Category | Node Count |
|----------|----------:|
| Input | 8 |
| Type | 6 |
| Arithmetic | 4 |
| Math | 14 |
| Interpolation | 4 |
| Vector | 7 |
| Noise | 1 |
| Color | 2 |
| Output | 1 |
| Unknown | 1 (hidden) |
| **Total built-in** | **48** |
| **+ Textures (tsl-textures)** | **51** |
| **Grand total** | **99** |
