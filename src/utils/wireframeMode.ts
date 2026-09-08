/**
 * The Wireframe node's one non-numeric setting: which thing it draws.
 *
 *   grid  (default) — an antialiased lattice on the surface PARAMETER
 *   edges           — the model's real triangle edges, via a per-corner
 *                     barycentric attribute the loader injects on request
 *
 * Stored as `values.edges`, 0 or 1, and read EXACTLY — `=== 1 || === '1'`,
 * never `Number(v) >= 0.5`. That is the rule the noise range flag documents:
 * a coercing read maps `null`/`false`/`''`/`[]` all onto a real mode, and
 * `null` is what the `fs:graph` autosave turns a non-finite into, so a shader
 * would change what it draws across a reload.
 *
 * An ABSENT key means grid — so every graph, saved group and exported module
 * from before this flag emits byte-identically.
 */
export function isWireframeEdges(values: Record<string, unknown> | undefined): boolean {
  const v = values?.edges;
  return v === 1 || v === '1';
}

/** The stored form of a mode, for the settings checkbox. */
export function wireframeEdgesValue(edges: boolean): number {
  return edges ? 1 : 0;
}
