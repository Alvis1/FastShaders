// Noise demo: mx_noise_vec3 (vec3 Perlin-style)

import { add, Fn, mul, mx_noise_vec3, positionGeometry, uniform } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(3);
  const pos = mul(positionGeometry, scale);
  const n = mx_noise_vec3(pos);
  return add(mul(n, 0.5), 0.5);
});

export default shader;
