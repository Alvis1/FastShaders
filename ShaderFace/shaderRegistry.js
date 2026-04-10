// ShaderFace — Shader Registry
// Only textures with measurable cost above baseline + baseline + voronoi atomic

import { color, vec3, positionGeometry, mx_worley_noise_float } from 'three/tsl';

import {
  brain, bricks, camouflage, caustics, caveArt, circleDecor, circles,
  clouds, cork, crumpledFabric, dalmatianSpots, darthMaul,
  dysonSphere, entangled, fordite, gasGiant,
  isolayers, isolines, karstRock, marble, neonLights,
  perlinNoise, photosphere, planet, polkaDots, processedWood, protozoa,
  reticularVeins, romanPaving, runnyEggs, rust,
  satin, scepterHead, scream, stars, staticNoise,
  tigerFur, turbulentSmoke, voronoiCells,
  watermelon, wood,
} from 'tsl-textures';

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

// All textures that measured above baseline (marginal > 0.01ms on desktop)
// Ordered roughly by expected cost for readable logs
const textureDefs = [
  ['caustics', caustics],
  ['circleDecor', circleDecor],
  ['cork', cork],
  ['turbulentSmoke', turbulentSmoke],
  ['dalmatianSpots', dalmatianSpots],
  ['protozoa', protozoa],
  ['reticularVeins', reticularVeins],
  ['planet', planet],
  ['crumpledFabric', crumpledFabric],
  ['rust', rust],
  ['romanPaving', romanPaving],
  ['wood', wood],
  ['entangled', entangled],
  ['runnyEggs', runnyEggs],
  ['gasGiant', gasGiant],
  ['bricks', bricks],
  ['watermelon', watermelon],
  ['neonLights', neonLights],
  ['voronoiCells', voronoiCells],
  ['marble', marble],
  ['clouds', clouds],
  ['satin', satin],
  ['photosphere', photosphere],
  ['polkaDots', polkaDots],
  ['karstRock', karstRock],
  ['dysonSphere', dysonSphere],
  ['caveArt', caveArt],
  ['camouflage', camouflage],
  ['scream', scream],
  ['darthMaul', darthMaul],
  ['fordite', fordite],
  ['processedWood', processedWood],
  ['brain', brain],
  ['tigerFur', tigerFur],
  ['scepterHead', scepterHead],
  ['stars', stars],
  ['isolayers', isolayers],
  ['perlinNoise', perlinNoise],
  ['isolines', isolines],
  ['circles', circles],
  ['staticNoise', staticNoise],
];

const textures = textureDefs.map(([name, fn]) => ({
  id: `tex_${name}`,
  label: name,
  category: 'texture',
  build: () => {
    try {
      return fn();
    } catch (e) {
      console.warn(`[ShaderFace] Failed to build texture "${name}":`, e);
      return color(0xff00ff);
    }
  },
}));

export const SHADER_REGISTRY = [...references, ...atomics, ...textures];
