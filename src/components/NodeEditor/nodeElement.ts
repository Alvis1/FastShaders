/**
 * The ONE spelling of "React Flow's DOM wrapper for this node". Ids come out
 * of `.fastshader` files, so every selector is escaped; they are strings
 * (`hasUsableNodeShape`), so the escape cannot throw.
 */
export const nodeEl = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);

/** One socket inside a node's wrapper, by handle id. */
export const handleEl = (
  node: Element | null,
  kind: 'source' | 'target',
  handleId: string,
): HTMLElement | null =>
  node?.querySelector<HTMLElement>(
    `.react-flow__handle.${kind}[data-handleid="${CSS.escape(handleId)}"]`,
  ) ?? null;
