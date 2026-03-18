// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup:
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>
//   <a-entity shader="src: shader.js"></a-entity>
//
// Also usable directly with Three.js — import from 'three/tsl'

import { add, color, cos, mix, mul, sin, sub, time, uv, vec2, positionLocal, normalLocal } from 'three/tsl';
import { perlinNoise, satin } from 'tsl-textures';

export default function() {
  const color1 = color(0xff6a00);
  const color2 = color(0xffaa00);
  const _uv1 = sub(uv(1), vec2(0.5, 0.5));
  const uv1 = add(vec2(sub(mul(_uv1.x, cos(1)), mul(_uv1.y, sin(1))), add(mul(_uv1.x, sin(1)), mul(_uv1.y, cos(1)))), vec2(0.5, 0.5));
  const time1 = time;
  const uv2 = uv();
  const mul1 = mul(time1, 0);
  const mul2 = mul(time1, 1);
  const perlinNoise1 = perlinNoise({ position: uv2, scale: 1, balance: 1, contrast: 3.077, color: color(0xFFFFFF), background: color(0xFEC700), seed: mul1 });
  const satin1 = satin({ position: uv1, scale: 2.6, color: color(0xD95000), background: color(0x831100), seed: mul2 });
  const mix1 = mix(color1, color2, perlinNoise1);
  const mul3 = mul(satin1, 9.953);
  const add1 = add(mul3, perlinNoise1);
  const mul4 = mul(perlinNoise1, add1);
  const mul5 = mul(mul4, 0);

  return { emissiveNode: mix1, positionNode: positionLocal.add(normalLocal.mul(mul5)), opacityNode: mul4, alphaTest: 0.5 };
}
