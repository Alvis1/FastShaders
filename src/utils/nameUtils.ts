/**
 * Sanitize an arbitrary string into a valid JS/GLSL identifier: replace any
 * char outside `[A-Za-z0-9_$]` with `_` and prefix a leading digit with `_`.
 *
 * This is the SINGLE source of truth for how a user-facing property name maps
 * to its generated variable name. graphToCode uses it to name `const <id> =
 * uniform(...)`, and buildShaderModule uses it to derive schema keys that match
 * those generated vars — keeping them aligned avoids the "schema key has a
 * space → invalid module / undriveable uniform" class of bugs.
 */
export function sanitizeIdentifier(rawName: string, fallback = 'property1'): string {
  const cleaned = rawName.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
  return cleaned || fallback;
}

/** Convert a string to kebab-case suitable for component/file names. */
export function toKebabCase(name: string, fallback = 'shader'): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  );
}
