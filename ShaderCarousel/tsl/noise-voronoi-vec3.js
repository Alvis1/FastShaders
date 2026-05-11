// Noise demo: mx_worley_noise_vec3 (vec3 Worley/Voronoi — F1, F2, F3)

import { Fn, mul, mx_worley_noise_vec3, positionGeometry, uniform } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(3);
  const pos = mul(positionGeometry, scale);
  const n = mx_worley_noise_vec3(pos, 1.0, 0);
  return n;
});

export default shader;
