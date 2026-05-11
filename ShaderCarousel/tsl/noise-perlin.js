// Noise demo: mx_noise_float (scalar Perlin-style)

import { color, Fn, mix, mul, mx_noise_float, positionGeometry, uniform } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(3);
  const pos = mul(positionGeometry, scale);
  const n = mx_noise_float(pos);
  const t = n.mul(0.5).add(0.5);
  return mix(color(0x000000), color(0xffffff), t);
});

export default shader;
