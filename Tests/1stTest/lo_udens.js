// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup:
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>
//   <a-entity shader="src: shader.js"></a-entity>
//
// Also usable directly with Three.js — import from 'three/tsl'

import { add, clamp, color, div, mix, mul, time, positionLocal, normalLocal } from 'three/tsl';
import { neonLights } from 'tsl-textures';

export default function() {
  const time1 = time;
  const color1 = color(0x008099);
  const color2 = color(0x00d5ff);
  const mul1 = mul(time1, 0.05);
  const mul2 = mul(time1, -0.15);
  const div1 = div(color1, 2);
  const neonLights1 = neonLights({ scale: 1.5, thinness: 1, mode: 0, colorA: color(0xFF0000), colorB: color(0x00FF00), colorC: color(0x0000FF), background: color(0x000000), seed: mul1 });
  const neonLights2 = neonLights({ scale: 2, thinness: 0.8, mode: 0, colorA: color(0xFF0000), colorB: color(0x00FF00), colorC: color(0x0000FF), background: color(0x000000), seed: mul2 });
  const mix1 = mix(neonLights1.x, neonLights2.y, 0.5);
  const add1 = add(neonLights2.y, -0.2);
  const clamp1 = clamp(neonLights2.y, 0.3, 0.5);
  const div2 = div(mix1, 5);
  const clamp2 = clamp(mix1, 0, 0.4);
  const mix2 = mix(color1, color2, clamp1);
  const clamp3 = clamp(div2, 0, 0.1);
  const mix3 = mix(mix2, 1.5, clamp2);
  const div3 = div(mix3, 4);
  const add2 = add(div1, div3);

  return { colorNode: mix3, emissiveNode: add2, positionNode: positionLocal.add(normalLocal.mul(clamp3)), roughnessNode: add1 };
}
