// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup:
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>
//   <a-entity shader="src: shader.js"></a-entity>
//
// Also usable directly with Three.js — import from 'three/tsl'

import { add, clamp, color, cos, div, mix, mul, sin, sub, time, uv, vec2, positionLocal, normalLocal } from 'three/tsl';
import { marble, perlinNoise } from 'tsl-textures';

export default function() {
  const time1 = time;
  const _uv1 = sub(uv(), vec2(0.5, 0.5));
  const uv1 = add(vec2(sub(mul(_uv1.x, cos(-0.865)), mul(_uv1.y, sin(-0.865))), add(mul(_uv1.x, sin(-0.865)), mul(_uv1.y, cos(-0.865)))), vec2(0.5, 0.5));
  const _uv2 = sub(mul(uv(), vec2(1, 0.2)), vec2(0.5, 0.5));
  const uv2 = add(vec2(sub(mul(_uv2.x, cos(3.2)), mul(_uv2.y, sin(3.2))), add(mul(_uv2.x, sin(3.2)), mul(_uv2.y, cos(3.2)))), vec2(0.5, 0.5));
  const mul1 = mul(time1, 1.5);
  const mul2 = mul(time1, -2);
  const marble1 = marble({ position: uv2, scale: 1.2, thinness: 5, noise: 0.3, color: color(0xFE6716), background: color(0x000000), seed: mul1 });
  const perlinNoise1 = perlinNoise({ position: uv1, scale: 1, balance: 0, contrast: 0.1, color: color(0xFFFFFF), background: color(0x000000), seed: mul2 });
  const sub1 = sub(perlinNoise1, 0.5);
  const div1 = div(marble1.x, 20);
  const mul3 = mul(sub1, 5);
  const mix1 = mix(marble1, 0, mul3);
  const clamp1 = clamp(mix1, 0.1, 1);
  const sub2 = sub(clamp1, 0.1);
  const mul4 = mul(sub2, 3);

  return { colorNode: mix1, emissiveNode: mul4, positionNode: positionLocal.add(normalLocal.mul(div1)) };
}
