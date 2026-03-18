// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup:
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>
//   <a-entity shader="src: shader.js"></a-entity>
//
// Also usable directly with Three.js — import from 'three/tsl'

import { add, color, cos, mix, mul, sin, sub, time, uv, vec2, positionLocal, normalLocal } from 'three/tsl';
import { processedWood, voronoiCells } from 'tsl-textures';

export default function() {
  const time1 = time;
  const _uv1 = sub(mul(uv(), vec2(-4.847, 0.5)), vec2(0.5, 0.5));
  const uv1 = add(vec2(sub(mul(_uv1.x, cos(0.1)), mul(_uv1.y, sin(0.1))), add(mul(_uv1.x, sin(0.1)), mul(_uv1.y, cos(0.1)))), vec2(0.5, 0.5));
  const color1 = color(0xff0000);
  const mul1 = mul(time1, -6);
  const processedWood1 = processedWood({ position: uv1, scale: 2, lengths: 4, strength: 0.3, angle: 0, color: color(0xFFFFFF), background: color(0x000000), seed: mul1 });
  const voronoiCells1 = voronoiCells({ position: uv1, scale: 2, variation: 0, facet: 0, color: color(0xFFD84D), background: color(0xFF7214), seed: mul1 });
  const mul2 = mul(processedWood1, 0.5);
  const mix1 = mix(voronoiCells1, color1, processedWood1);

  return { colorNode: mix1, emissiveNode: color1, positionNode: positionLocal.add(normalLocal.mul(mul2)) };
}
