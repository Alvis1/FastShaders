# ShaderCarousel — Research Context

## Overview

ShaderCarousel is a benchmarking component of the research project
"Performance-Aware Shader Authoring for Web-based Virtual Reality Development."

It addresses the **performance knowledge gap** faced by WebXR content creators —
artists who lack deep graphics engineering expertise and struggle to anticipate the
performance costs of various shader functions. Current WebXR optimization workflows
are reactive (author → deploy → profile → refine), which is inefficient and provides
no guidance during the design phase.

## Research Contributions

The research has three primary contributions:

1. **ShaderCarousel** (this system) — an automated WebXR benchmarking system that
   systematically evaluates shader performance on standalone HMDs.

2. **Point-based scoring methodology** — translates empirical benchmark data from
   ShaderCarousel into a predictive scoring system representing shader operation costs.

3. **FastShaders** — an artist-centric, node-based shader authoring tool that
   incorporates preemptive performance scoring, enabling artists to balance visual
   complexity with runtime performance during creation.

## How ShaderCarousel Works

### Benchmarking Setup

ShaderCarousel presents a 3D environment built with A-Frame and Three.js Shading
Language (TSL):

- Shaders are applied to geometries positioned on a **rotating circular platform**
  aligned horizontally along the XZ-plane.
- The platform continuously rotates around the Y-axis, **incrementally adding
  instances** of a specific shader evenly spaced around its circumference.
- A **fixed-perspective camera** oriented along the Z-axis toward the carousel's
  center captures the scene.
- As each geometry rotates, it naturally transitions in size and visibility relative
  to the camera, allowing observation of shader performance across varying screen
  dimensions.

### Metrics Collected

| Metric | Description |
|--------|-------------|
| **FPS** | Frame rate, sampled at specific rotation angles (90° and 270°) |
| **Frame time** | Per-frame render time in milliseconds |
| **Draw calls** | Number of GPU draw calls per frame |
| **Max instance count** | Maximum shader instances before significant FPS degradation |
| **Mesh count** | Number of visible meshes at sample time |

### Test Scenarios

The profiler tests each shader across multiple configurations:

- **Scale variations**: 1×, 3×, 6×, 10× — tests how pattern scale affects GPU cost
- **Instance load**: Incrementally adds shader instances to measure scaling behavior
- **Camera proximity**: Fixed camera position captures varying screen-space coverage

Data is exported as JSON for subsequent analysis.

## Deriving the Point-Based Scoring System

The methodology for converting benchmark data into FastShaders' performance scores:

1. **Identify key shader operations** — texture sampling, noise functions (simplex,
   Perlin, Worley), mathematical computations (pow, exp, sin), branching (If/Else),
   color space conversions, etc.

2. **Correlate with performance data** — map ShaderCarousel results to the operations
   present in each shader's source code.

3. **Assign initial point values** — based on observed performance impact of each
   operation type.

4. **Iterative refinement** — compare predicted aggregate scores against actual
   benchmarked performance, adjusting point values to minimize prediction error.

### Example Operation Costs

| Operation | Relative Cost | Notes |
|-----------|--------------|-------|
| Basic math (add, mul, sub) | Low | GPU-optimized, minimal impact |
| Trigonometric (sin, cos) | Low-Medium | Hardware-accelerated on most GPUs |
| Noise (mx_noise_float) | Medium | Requires multiple texture lookups |
| Fractal noise (mx_fractal_noise) | High | Multiple octaves of noise evaluation |
| Branching (If/Else) | Medium | Can cause warp divergence on GPU |
| Complex procedural (planet, fordite) | Very High | Combines multiple expensive operations |

## Shared Infrastructure with FastShaders

ShaderCarousel uses the same shader loading pipeline as FastShaders to ensure
benchmarked behavior matches production behavior:

- **shaderloader.js** — same TDZ fix, auto-import injection, and Object API as
  FastShaders' `a-frame-shaderloader`
- **`tsl-shader` component** — A-Frame component wrapping the FastShaders loading
  pipeline (named `tsl-shader` to avoid conflict with A-Frame's built-in `shader`
  system; the underlying loader code is identical)
- **tsl-shim.js** — ESM shim that re-exports `window.THREE` and `window.THREE.TSL`
  so blob-loaded shader modules can resolve bare `'three/tsl'` imports

This means:
- Shaders exported from FastShaders load identically in ShaderCarousel
- Performance measurements reflect real-world FastShaders usage
- The point-based scoring system remains calibrated to actual shader loading behavior

### Shaderloader Pipeline

When a `tsl-shader` component loads a shader file, it goes through the same
preprocessing steps as FastShaders' `a-frame-shaderloader`:

1. **Fetch** — shader source is fetched as text from the `src` path
2. **Auto-import injection** (`autoInjectTSLImports`) — scans for undeclared
   function calls and identifier usage, adds missing names to the `three/tsl`
   import statement (validated against `window.THREE.TSL` to avoid injecting
   non-existent symbols)
3. **TDZ fix** (`fixTSLShadowing`) — renames local `const` declarations that
   shadow imported names (e.g., `const color = color(0xFF0000)` becomes
   `const __color = color(0xFF0000)`) to prevent temporal dead zone errors
4. **Import resolution** (`resolveTSLImports`) — resolves bare specifiers
   (`'three/tsl'`, `'three'`) to the absolute URL of `tsl-shim.js`, and
   relative specifiers (`'./tsl-utils.js'`) to absolute URLs based on the
   original file location. This is necessary because blob URLs don't have
   access to the page's import maps.
5. **Blob import** — the preprocessed source is loaded as a blob URL module
6. **Export resolution** — supports both FastShaders' `export default function`
   pattern and tsl-textures' named export pattern (`export { marble }`),
   using kebab-to-camel filename matching as fallback
7. **Schema detection** — auto-detects `params.XXX` and `const name = uniform(val)`
   patterns to create property uniforms, enabling runtime parameter updates
8. **Material creation** — creates `MeshPhysicalNodeMaterial` with Object API
   support (`colorNode`, `positionNode`, `normalNode`, `opacityNode`,
   `roughnessNode`, `metalnessNode`, `emissiveNode`)

### Component Name Difference

FastShaders' shaderloader registers as the `shader` A-Frame component. In
ShaderCarousel, the component is registered as `tsl-shader` because A-Frame
has a built-in `shader` system (used by the `material` component for custom
shader registration via `AFRAME.registerShader`). Using `shader` as a component
name causes A-Frame to intercept the attribute and attempt to process it as a
material shader definition, resulting in "Unknown shader" errors.

The underlying loading code, preprocessing pipeline, and material creation are
identical — only the A-Frame component registration name differs.

### tsl-shim.js

The shim re-exports `window.THREE` (for `import { Color } from 'three'`) and
`window.THREE.TSL` (for `import { vec3, float, ... } from 'three/tsl'`) as
static ES module exports. This is necessary because:

- The shaderloader creates blob URLs for preprocessed shader source
- Blob URLs exist outside the page's import map scope
- Without the shim, bare specifiers like `'three/tsl'` would fail to resolve

The shim must be kept in sync with the Three.js version used. Names that appear
in both `THREE` and `THREE.TSL` (e.g., `NodeAccess`, `NodeShaderStage`, `NodeType`,
`NodeUpdateType`, `defaultBuildStages`, `defaultShaderStages`, `shaderStages`,
`vectorComponents`) are exported only from the TSL section to avoid
`SyntaxError: Cannot declare a lexical variable twice`.

## Future Work

- Automate quantitative analysis using statistical modeling or machine learning
  for point derivation
- Expand device and browser testing for broader applicability
- Conduct formal artist user studies to evaluate usability and effectiveness
- Integrate more granular GPU profiling data as WebXR standards evolve
- Explore dynamic adaptation of the point system to emerging hardware and runtime
  environments
