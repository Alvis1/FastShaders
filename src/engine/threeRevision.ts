/**
 * The three.js release FastShaders is built, tested and exported against.
 *
 * A LEAF — it imports nothing — so `tslCodeProcessor` can import it without
 * joining the `tslToShaderModule ↔ tslCodeProcessor` cycle.
 *
 * It is one member of a DRIFT SET, and every member must say the same number:
 *   - `three` in package.json (and so `node_modules/three`'s REVISION);
 *   - `THREE_VERSION` in `engine/tslToThreeHTML.ts` ('0.<rev>.0');
 *   - the `three@` URLs in the README's plain-three.js snippet;
 *   - `THREE_REVISION` inside the shaderloader (`a-frame-shaderloader-0.8.js`),
 *     which warns — never refuses — when a page runs a different three.
 * `engine/threeRevision.test.ts` checks the ones a test can read.
 */
export const THREE_REVISION = '184';
