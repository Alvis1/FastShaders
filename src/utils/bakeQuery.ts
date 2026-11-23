/**
 * BAKE TO TEXTURE — the two search boxes' half (docs/dev/baking.md). A LEAF
 * (its only import is `searchFold`), because both boxes sit on the boot path
 * and the planner they open does not.
 */
import type { AppNode } from '@/types';
import { foldSearchText } from './searchFold';
import { isPassThroughNode } from './passThrough';

/**
 * Does a search ask for "Bake to texture"? A SHORT query (at most four words)
 * whose first word is a start of "bake" ("bak", "bake", "baking"…) or of the
 * Latvian "iecept" ("iece", "iecept"…). Diacritic-blind, like every search box.
 * A longer sentence is a request for the generator, never a command.
 */
export function bakeQueryMatches(query: string): boolean {
  const words = foldSearchText(query).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  const w = words[0];
  if (w.length >= 3 && ('bake'.startsWith(w) || w.startsWith('bake') || w.startsWith('baki'))) return true;
  return w.length >= 4 && ('iecept'.startsWith(w) || w.startsWith('iecep'));
}

/** Not a value: a note, or a sink (the Outputs have nothing to bake). */
const NOT_BAKEABLE = new Set(['output', 'raymarchOutput', 'splatOutput']);

/** Can this SELECTED node take part in a bake? A group can: it stands for
 *  the nodes inside it. */
function bakeableSelected(n: AppNode): boolean {
  if (!n.selected || n.type === 'note' || isPassThroughNode(n)) return false;
  const type = (n.data as { registryType?: unknown } | undefined)?.registryType;
  return !(typeof type === 'string' && NOT_BAKEABLE.has(type));
}

/** How many selected nodes a bake of the selection reads. A count, so a
 *  store selector can return it without allocating. */
export function bakeSelectionCount(nodes: readonly AppNode[]): number {
  let n = 0;
  for (const node of nodes) if (bakeableSelected(node)) n++;
  return n;
}

/** The selection a bake opens on — node and group ids, in document order. */
export function bakeSelectionIds(nodes: readonly AppNode[]): string[] {
  return nodes.filter(bakeableSelected).map((n) => n.id);
}
