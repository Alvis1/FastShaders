/** Convert a string to kebab-case suitable for component/file names. */
export function toKebabCase(name: string, fallback = 'shader'): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  );
}
