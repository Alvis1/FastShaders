// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup:
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>
//   <a-entity shader="src: shader.js"></a-entity>
//
// Also usable directly with Three.js — import from 'three/tsl'

import { add, color, cos, mix, mul, sin, sub, time, uv, vec2, positionLocal, normalLocal } from 'three/tsl';
import { perlinNoise } from 'tsl-textures';

export default function() {
  const color1 = color(0xff8000);
  const color2 = color(0xe32400);
  const _uv1 = sub(mul(uv(), vec2(10, 1)), vec2(0.5, 0.5));
  const uv1 = add(vec2(sub(mul(_uv1.x, cos(-5)), mul(_uv1.y, sin(-5))), add(mul(_uv1.x, sin(-5)), mul(_uv1.y, cos(-5)))), vec2(0.5, 0.5));
  const time1 = time;
  const _uv2 = sub(mul(uv(), vec2(2, 1.5)), vec2(0.5, 0.5));
  const uv2 = add(vec2(sub(mul(_uv2.x, cos(-1)), mul(_uv2.y, sin(-1))), add(mul(_uv2.x, sin(-1)), mul(_uv2.y, cos(-1)))), vec2(0.5, 0.5));
  const mul1 = mul(time1, 5);
  const mul2 = mul(time1, -2);
  const perlinNoise1 = perlinNoise({ position: uv1, scale: 1.1, balance: 0, contrast: 0, color: color(0xFFFFFF), background: color(0x000000), seed: mul1 });
  const perlinNoise2 = perlinNoise({ position: uv2, scale: 2, balance: 0, contrast: 0, color: color(0xFFFFFF), background: color(0x000000), seed: mul2 });
  const mix1 = mix(color1, color2, perlinNoise1);
  const mul3 = mul(perlinNoise2, -1.19);
  const add1 = add(mul3, perlinNoise1);
  const mul4 = mul(perlinNoise1, add1);
  const mul5 = mul(mul4, 0.2);

  return { emissiveNode: mix1, positionNode: positionLocal.add(normalLocal.mul(mul5)), opacityNode: mul4, transparent: true };
}
