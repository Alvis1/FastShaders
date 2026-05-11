// Noise demo: mx_cell_noise_float (cellular hash noise)

import { Fn, mul, mx_cell_noise_float, positionGeometry, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(4);
  const pos = mul(positionGeometry, scale);
  const n = mx_cell_noise_float(pos);
  return vec3(n);
});

export default shader;
