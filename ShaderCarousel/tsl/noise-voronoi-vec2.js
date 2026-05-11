// Noise demo: mx_worley_noise_vec2 (vec2 Worley/Voronoi — F1, F2)

import { Fn, mul, mx_worley_noise_vec2, positionGeometry, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(3);
  const pos = mul(positionGeometry, scale);
  const n = mx_worley_noise_vec2(pos, 1.0, 0);
  return vec3(n.x, n.y, 0);
});

export default shader;
