/** Sanitize a string into a valid JavaScript identifier. */
export function sanitizeIdentifier(name: string, fallback = 'prop'): string {
  let safe = name.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
  if (!safe) safe = fallback;
  return safe;
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
