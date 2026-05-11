// Noise demo: mx_worley_noise_float (scalar Worley/Voronoi)

import { Fn, mul, mx_worley_noise_float, positionGeometry, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(3);
  const pos = mul(positionGeometry, scale);
  const n = mx_worley_noise_float(pos, 1.0, 0);
  return vec3(n);
});

export default shader;
