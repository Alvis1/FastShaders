# KTX2 test fixtures

Real Basis Universal textures, so the KTX2 transcode path is tested for real
(`src/ktx2Transcode.test.ts` runs three r184's own `basis_transcoder.js` +
`.wasm` over them in node) rather than against a stub.

**Never edit these files.** Tests read them by path and pin their sha256.

## Three r184's test textures (MIT)

Byte copies of `examples/textures/ktx2/` from a three.js **0.184.0** checkout
(the npm package ships no `examples/textures`). © three.js authors, MIT — see
`LICENSE` beside them, copied from the same checkout (identical to
`node_modules/three/LICENSE` at 0.184.0).

| file | bytes | sha256 |
|---|---|---|
| `2d_uastc.ktx2` | 2,560 | `21b6912cae1f074ae3eda1b751f43c36eafc7eb83f3af71f85bba2ccbafce125` |
| `2d_etc1s.ktx2` | 966 | `e56ddcc757fc73ff06bb0dac2a3533ce79c1e196ad895a3ff7dcc4d9de6b9d5d` |
| `2d_rgba8.ktx2` | 8,888 | `93c7b4c9eaecd6144ec6c6292b3408f57d9c557e060f2e2e2d53df8c195fe3d8` |

Container facts (read with three's `ktx-parse`; the test pins them):

- all three: 40 × 40, 6 levels, one face, no layers, sRGB (DFD transfer 2,
  primaries 1), no `KTXorientation` key;
- `2d_uastc`: Basis UASTC — vkFormat 0, DFD colour model 166, supercompression 0;
- `2d_etc1s`: Basis ETC1S — vkFormat 0, colour model 163, supercompression 1 (BasisLZ);
- `2d_rgba8`: not Basis at all — vkFormat 43 (`R8G8B8A8_SRGB`), colour model 1.

## The two GLBs (ours)

Written by `scripts/gen-ktx2-fixture-glbs.mjs` and committed with it; one quad
whose base colour texture is `2d_uastc.ktx2` in a bufferView.

| file | bytes | sha256 | KHR_texture_basisu |
|---|---|---|---|
| `quad-uastc-required.glb` | 3,788 | `dfb100ae40eb85860a79716754bb920e03588a4d1d626accbe2dde532579dba8` | used + **required**, no core `source` |
| `quad-uastc-fallback.glb` | 3,964 | `313b0066d30bc968b585662af36561e96dffb7697746048742c921306c726191` | used only; core `source` = a 40 × 40 solid-magenta PNG |

`src/test-utils.ts`'s `makeKtx2Glb()` builds the same layout so a test can vary
it; the test fails if it stops reproducing these bytes.
