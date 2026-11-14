/**
 * The EMBED switch: FastShaders running inside another app's iframe (SuperWXR's
 * shader panel) at `?embed=1`. A LEAF module (imports nothing), sampled ONCE at
 * module init like `eval/evalArm.ts`, so every consumer sees one answer for the
 * whole page. Never true at the top level — an embedding page is the only
 * thing that can answer the bridge's messages.
 */

export const EMBED_PARAM = 'embed';

const embedded = (() => {
  try {
    return new URLSearchParams(window.location.search).get(EMBED_PARAM) === '1' && window.parent !== window;
  } catch {
    // node tests / no window: never embedded.
    return false;
  }
})();

export function isEmbedMode(): boolean {
  return embedded;
}

/** The host page's origin, the only `targetOrigin` the bridge ever posts to. */
export function embedTargetOrigin(): string {
  return window.location.origin;
}
