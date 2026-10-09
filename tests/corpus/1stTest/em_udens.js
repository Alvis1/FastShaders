// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup:
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>
//   <a-entity shader="src: shader.js"></a-entity>
//
// Also usable directly with Three.js — import from 'three/tsl'

import { add, clamp, color, float, mix, mul, mx_worley_noise_float, positionGeometry, remap, time, positionLocal, normalLocal } from 'three/tsl';
import { voronoiCells } from 'tsl-textures';

export default function() {
  const time1 = time;
  const float1 = float(0.1);
  const color1 = color(0x0415ea);
  const color2 = color(0x06e0f9);
  const float2 = float(0.73);
  const worley_noise1 = mx_worley_noise_float(positionGeometry);
  const mul1 = mul(time1, 0.5);
  const mul2 = mul(time1, -1);
  const mul3 = mul(worley_noise1, 1);
  const voronoiCells1 = voronoiCells({ scale: float2, variation: 0, facet: 0, color: color(0x000000), background: color(0xC0D0FF), seed: mul1 });
  const voronoiCells2 = voronoiCells({ scale: float2, variation: 0, facet: 0, color: color(0x000000), background: color(0xC0D0FF), seed: mul2 });
  const remap1 = remap(voronoiCells1, 0.65, 1, 0, 1);
  const add1 = add(mul3, voronoiCells2);
  const add2 = add(voronoiCells1, voronoiCells2);
  const add3 = add(remap1, add1);
  const mul4 = mul(add2, 0.2);
  const clamp1 = clamp(add3, 0, 1);
  const mix1 = mix(color1, color2, clamp1);

  return { colorNode: mix1, positionNode: positionLocal.add(normalLocal.mul(mul4)), roughnessNode: float1, transparent: true };
}
