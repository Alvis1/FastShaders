/**
 * Detect whether code uses direct material-property assignment style
 * (`model.material.colorNode = ...`) instead of the canonical Fn() wrapper
 * form that codeToGraph can parse. When true, the sync engine skips the
 * code → graph step and leaves the editor untouched.
 */
export function isDirectAssignmentCode(code: string): boolean {
  return /model\.material\.\w+Node\s*=/.test(code);
}
