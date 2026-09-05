// Regenerates public/models/teapot.obj from the runtime tessellator, so the
// static file podest and the copy-ready surfaces load is byte-for-byte what the
// editor's live teapot is at STATIC_TEAPOT_RESOLUTION (teapotGeometry.test.ts
// fails on drift). The tessellator lives in a TS module, hence the strip-types
// flag — no build step, no extra dependency:
//
//   npm run gen:teapot     (= node --experimental-strip-types scripts/gen-teapot-obj.mjs)
//
// Data provenance and the Utah Teapot terms are documented in src/engine/teapotData.ts.
import { writeFileSync } from 'node:fs';

const { loadTeapot, STATIC_TEAPOT_RESOLUTION } = await import('../src/engine/teapotGeometry.ts');
const out = new URL('../public/models/teapot.obj', import.meta.url);
const text = loadTeapot().obj(STATIC_TEAPOT_RESOLUTION);
writeFileSync(out, text);
const faces = (text.match(/^f /gm) ?? []).length;
const verts = (text.match(/^v /gm) ?? []).length;
console.log(`wrote ${out.pathname}: resolution ${STATIC_TEAPOT_RESOLUTION}, ${verts} vertices, ${faces} triangles, ${(text.length / 1024).toFixed(0)} KB`);
