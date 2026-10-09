// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup:
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>
//   <a-entity shader="src: shader.js"></a-entity>
//
// Also usable directly with Three.js — import from 'three/tsl'

import { color, float, mix, mul, time, uv, positionLocal, normalLocal } from 'three/tsl';
import { voronoiCells } from 'tsl-textures';

export default function() {
  const color1 = color(0x15adc1);
  const color2 = color(0xbefafe);
  const time1 = time;
  const float1 = float(0);
  const uv1 = uv();
  const mul1 = mul(time1, 0.6);
  const mul2 = mul(time1, 0.8);
  const voronoiCells1 = voronoiCells({ scale: 1.186, variation: 0, facet: -0.6, color: color(0x85ECF9), background: color(0xFFFFFF), seed: mul1 });
  const voronoiCells2 = voronoiCells({ position: uv1, scale: 1.19, variation: 0, facet: 0, color: color(0x666666), background: color(0xFFFFFF), seed: mul1 });
  const voronoiCells3 = voronoiCells({ scale: 2, variation: 0, facet: -0.7, color: color(0x3BB08D), background: color(0x288153), seed: mul2 });
  const mul3 = mul(voronoiCells2, 0.3);
  const mul4 = mul(voronoiCells1, voronoiCells3);
  const mix1 = mix(mul4, voronoiCells1, voronoiCells2);

  return { colorNode: mix1, positionNode: positionLocal.add(normalLocal.mul(mul3)), roughnessNode: float1 };
}
