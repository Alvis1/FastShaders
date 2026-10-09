// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup:
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>
//   <a-entity shader="src: shader.js"></a-entity>
//
// Also usable directly with Three.js — import from 'three/tsl'

import { add, clamp, color, float, mix, mul, remap, time, positionLocal } from 'three/tsl';
import { satin } from 'tsl-textures';

export default function() {
  const color1 = color(0xd6eff5);
  const color2 = color(0x1357c3);
  const float1 = float(-1);
  const time1 = time;
  const mul1 = mul(time1, -0.2059);
  const mul2 = mul(time1, -0.0423);
  const satin1 = satin({ scale: 2, color: color(0x7080FF), background: color(0x000050), seed: mul1 });
  const satin2 = satin({ scale: 2, color: color(0x7080FF), background: color(0x000050), seed: mul2 });
  const mul3 = mul(satin1, 1);
  const remap1 = remap(satin1, 0.5452, 0.3359, -0.1614, 0.2733);
  const add1 = add(satin1, satin2);
  const add2 = add(mul3, 0);
  const mul4 = mul(add1, 0.2443);
  const add3 = add(add2, remap1);
  const clamp1 = clamp(add3, 0, 1);
  const mix1 = mix(color1, color2, clamp1);

  return { colorNode: mix1, positionNode: positionLocal.add(mul4), roughnessNode: float1 };
}
