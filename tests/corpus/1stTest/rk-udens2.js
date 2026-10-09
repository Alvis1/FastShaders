// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup:
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>
//   <a-entity shader="src: shader.js"></a-entity>
//
// Also usable directly with Three.js — import from 'three/tsl'

import { add, clamp, color, float, mix, mul, remap, sub, time, positionLocal, normalLocal } from 'three/tsl';
import { crumpledFabric, voronoiCells } from 'tsl-textures';

export default function() {
  const color1 = color(0x274243);
  const color2 = color(0xdff4ff);
  const time1 = time;
  const float1 = float(0.12);
  const voronoiCells1 = voronoiCells({ scale: 1.3, variation: 0, facet: 0, color: color(0x000000), background: color(0xFFFFFF), seed: 0 });
  const mul1 = mul(time1, 0.2);
  const mul2 = mul(time1, 0.3);
  const voronoiCells2 = voronoiCells({ scale: 0.2, variation: 0, facet: 0, color: color(0x000000), background: color(0xFFFFFF), seed: mul1 });
  const crumpledFabric1 = crumpledFabric({ scale: 2, pinch: 0.7, color: color(0xC6D7D0), subcolor: color(0xF8E1FF), background: color(0x003AC4), seed: mul2 });
  const mul3 = mul(voronoiCells2, 0.9);
  const add1 = add(voronoiCells2, crumpledFabric1);
  const add2 = add(mul3, crumpledFabric1);
  const remap1 = remap(mul3, 0.5, 0, 0, 1);
  const add3 = add(mul3, crumpledFabric1);
  const mul4 = mul(add1, 0.1);
  const add4 = add(remap1, add2);
  const sub1 = sub(add3, 1);
  const clamp1 = clamp(add4, 0, 1);
  const mul5 = mul(sub1, 0.7);
  const mix1 = mix(color1, color2, clamp1);

  return { colorNode: mix1, emissiveNode: mix1, positionNode: positionLocal.add(normalLocal.mul(mul4)), opacityNode: mul5, roughnessNode: float1, transparent: true };
}
