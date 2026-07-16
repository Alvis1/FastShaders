import citationsData from './citations.json';

/**
 * An academic / provenance reference for a node or built-in texture.
 * `ref` is a compact single-line human-readable citation; `url` is the DOI or
 * canonical source URL when one exists.
 */
export interface Citation {
  ref: string;
  url?: string;
}

/**
 * Citations are deliberately SPARSE: only entries with a genuine, verifiable
 * primary source are present. Standard operations (add, mix, sin, clamp, …) are
 * intentionally absent — the docs table renders an em-dash for them.
 */
export const CITATIONS: {
  nodes: Record<string, Citation>;
  textures: Record<string, Citation>;
} = citationsData;

/** Look up a citation by node type or texture id. Returns undefined when absent. */
export function getCitation(kind: 'node' | 'texture', key: string): Citation | undefined {
  const table = kind === 'node' ? CITATIONS.nodes : CITATIONS.textures;
  // hasOwnProperty guard: a key like '__proto__' must not resolve to inherited junk.
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}
