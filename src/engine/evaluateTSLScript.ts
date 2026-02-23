/**
 * Detect whether code uses tsl-textures or direct material assignment style
 * (as opposed to the graph-generated Fn() wrapper style).
 */
export function isTSLTexturesCode(code: string): boolean {
  return /model\.material\.\w+Node\s*=/.test(code);
}
