// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup:
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>
//   <a-entity shader="src: shader.js"></a-entity>
//
// Also usable directly with Three.js — import from 'three/tsl'

import { add, color, cos, mix, mul, positionGeometry, sin, sub, time, uv, vec2, positionLocal, normalLocal } from 'three/tsl';
import { perlinNoise } from 'tsl-textures';

export default function() {
  const perlinNoise1 = perlinNoise({ scale: 1.1, balance: 0, contrast: 0, color: color(0xFFFFFF), background: color(0x000000), seed: 0 });
  const color1 = color(0xfec700);
  const color2 = color(0xe32400);
  const _uv1 = sub(mul(uv(9), vec2(10, 1)), vec2(0.5, 0.5));
  const uv1 = add(vec2(sub(mul(_uv1.x, cos(-5)), mul(_uv1.y, sin(-5))), add(mul(_uv1.x, sin(-5)), mul(_uv1.y, cos(-5)))), vec2(0.5, 0.5));
  const time1 = time;
  const perlinNoise2 = perlinNoise({ scale: 1.1, balance: 0, contrast: 0, color: color(0xFFFFFF), background: color(0x000000), seed: 0 });
  const positionGeometry1 = positionGeometry;
  const _uv2 = sub(mul(uv(9), vec2(10, 1)), vec2(0.5, 0.5));
  const uv2 = add(vec2(sub(mul(_uv2.x, cos(-5)), mul(_uv2.y, sin(-5))), add(mul(_uv2.x, sin(-5)), mul(_uv2.y, cos(-5)))), vec2(0.5, 0.5));
  const sub1 = sub(perlinNoise1, 0.5);
  const mix1 = mix(color1, color2, perlinNoise1);
  const mul1 = mul(time1, 0);

  return { colorNode: mix1, positionNode: positionLocal.add(normalLocal.mul(sub1)), transparent: true };
}
