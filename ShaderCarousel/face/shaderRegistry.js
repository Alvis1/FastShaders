// ShaderFace — Shader Registry
//
// Purpose-built for the FastShaders ↔ tsl-textures pair comparison plus the
// MaterialX noise primitives the editor's noise nodes wrap.
//
// Five groups:
//   1. references  — baseline (flat color), for marginal-cost subtraction
//   2. atomics     — single-instruction calibration shader (Voronoi @ scale 4)
//   3. textures    — the 8 tsl-textures shaders that have FastShaders
//                    builtin-texture-group counterparts (and only those)
//   4. fastshaders — FastShaders builtin texture group reconstructions, built
//                    from MaterialX noise + inner three/tsl nodes (the same TSL
//                    the editor compiles from the Textures tab)
//   5. noise       — the 8 MaterialX noise functions exposed by the editor's
//                    Noise category, called directly the way graphToCode emits
//                    them (positionGeometry, no scale): each measures the
//                    per-pixel cost of one primitive noise node
//
// `pairId` joins each tsl-textures entry with its FastShaders reconstruction so
// analysis can group `tex_xxx` and `fs_xxx`: the headline number is "library
// shader cost vs editor-graph reconstruction cost" for the same visual. Noise
// nodes have no library counterpart and are therefore unpaired.

import {
  color, vec3, positionGeometry,
  mx_noise_float, mx_noise_vec3,
  mx_fractal_noise_float, mx_fractal_noise_vec3,
  mx_cell_noise_float,
  mx_worley_noise_float, mx_worley_noise_vec2, mx_worley_noise_vec3,
} from 'three/tsl';

// Only the 8 tsl-textures shaders that have FastShaders builtin texture-group
// counterparts. Every other tsl-textures shader was removed — the registry is
// purpose-built for the FastShaders ↔ tsl-textures pair comparison and there's
// no value in measuring shaders that have no reconstruction to pair against.
import {
  crumpledFabric, gasGiant, grid, marble, polkaDots, staticNoise, tigerFur, wood,
} from 'tsl-textures';

import {
  polkaDotsFS, gridFS, tigerFurFS, staticNoiseFS, crumpledFabricFS,
  gasGiantFS, marbleFS, woodFS,
} from './fastShadersTextures.js';

// Baseline reference
const references = [
  {
    id: 'ref_flat_color',
    label: 'Flat Color (baseline)',
    category: 'reference',
    build: () => color(0x888888),
  },
];

// Single atomic for calibration — voronoi is the only one measurably above baseline
const atomics = [
  {
    id: 'atom_voronoi',
    label: 'Voronoi (mx)',
    category: 'atomic',
    build: () => vec3(mx_worley_noise_float(positionGeometry.mul(4))),
  },
];

// The 8 tsl-textures shaders that have FastShaders reconstructions. Each
// `pairId` matches a FastShaders entry below; together they form the 8
// comparison pairs. Ordered to match the FastShaders side, so paired entries
// sit adjacent in the picker.
const textureDefs = [
  ['polkaDots',      polkaDots,      'polka-dots'],
  ['grid',           grid,           'grid'],
  ['tigerFur',       tigerFur,       'tiger-fur'],
  ['staticNoise',    staticNoise,    'static-noise'],
  ['crumpledFabric', crumpledFabric, 'crumpled-fabric'],
  ['gasGiant',       gasGiant,       'gas-giant'],
  ['marble',         marble,         'marble'],
  ['wood',           wood,           'wood'],
];

const textures = textureDefs.map(([name, fn, pairId]) => ({
  id: `tex_${name}`,
  label: name,
  category: 'texture',
  pairId,
  build: () => {
    try {
      return fn();
    } catch (e) {
      console.warn(`[ShaderFace] Failed to build texture "${name}":`, e);
      return color(0xff00ff);
    }
  },
}));

// FastShaders builtin texture group reconstructions.
// Each `pairId` matches a tsl-textures entry above; together they form the
// 8 comparison pairs.
const fastShadersDefs = [
  ['polka-dots',      'Polka Dots (FS)',      polkaDotsFS],
  ['grid',            'Grid (FS)',            gridFS],
  ['tiger-fur',       'Tiger Fur (FS)',       tigerFurFS],
  ['static-noise',    'Static Noise (FS)',    staticNoiseFS],
  ['crumpled-fabric', 'Crumpled Fabric (FS)', crumpledFabricFS],
  ['gas-giant',       'Gas Giant (FS)',       gasGiantFS],
  ['marble',          'Marble (FS)',          marbleFS],
  ['wood',            'Wood (FS)',            woodFS],
];

const fastshaders = fastShadersDefs.map(([pairId, label, fn]) => ({
  id: `fs_${pairId}`,
  label,
  category: 'fastshaders',
  pairId,
  build: () => {
    try {
      return fn();
    } catch (e) {
      console.warn(`[ShaderFace] Failed to build FastShaders texture "${pairId}":`, e);
      return color(0xff00ff);
    }
  },
}));

// FastShaders Noise category — the 8 MaterialX noise primitives the editor
// exposes as Noise nodes. Called the way graphToCode emits them: bare
// `positionGeometry` (no `.mul(scale)` because the registry default is 1).
// Float-output noises are wrapped in vec3() to land in the color slot;
// vec2 is padded to vec3 with a zero in z. Cost difference between a
// scalar mx_noise_float and the vec3 wrap is negligible (a single splat).
const noiseDefs = [
  ['perlin',      'Perlin (float)',       () => vec3(mx_noise_float(positionGeometry))],
  ['perlinVec3',  'Perlin (vec3)',        () => mx_noise_vec3(positionGeometry)],
  ['fbm',         'fBm (float)',          () => vec3(mx_fractal_noise_float(positionGeometry))],
  ['fbmVec3',     'fBm (vec3)',           () => mx_fractal_noise_vec3(positionGeometry)],
  ['cellNoise',   'Cell Noise (float)',   () => vec3(mx_cell_noise_float(positionGeometry))],
  ['voronoi',     'Voronoi F1 (float)',   () => vec3(mx_worley_noise_float(positionGeometry))],
  ['voronoiVec2', 'Voronoi F1/F2 (vec2)', () => {
    const v = mx_worley_noise_vec2(positionGeometry);
    return vec3(v.x, v.y, 0);
  }],
  ['voronoiVec3', 'Voronoi F1/F2/F3 (vec3)', () => mx_worley_noise_vec3(positionGeometry)],
];

const noises = noiseDefs.map(([id, label, fn]) => ({
  id: `noise_${id}`,
  label,
  category: 'noise',
  build: () => {
    try {
      return fn();
    } catch (e) {
      console.warn(`[ShaderFace] Failed to build noise "${id}":`, e);
      return color(0xff00ff);
    }
  },
}));

export const SHADER_REGISTRY = [...references, ...atomics, ...textures, ...fastshaders, ...noises];

// Convenience: ids of every shader that participates in a FS-vs-tsl-textures
// pair (both sides). The Pairs preset in the picker selects exactly these
// (plus the baseline).
export const PAIR_SHADER_IDS = SHADER_REGISTRY
  .filter(s => s.pairId)
  .map(s => s.id);
