import { useAppStore } from '@/store/useAppStore';
import { nodeHeaderTip } from '@/i18n';

/** Spread onto a canvas node's header element (see `useHeaderTip`). */
export interface HeaderTip {
  'data-header-tip': string;
}

/**
 * The Latvian-mode name label of a CANVAS node's header: the node's bilingual
 * name ("Reizināt (Multiply)"), drawn ABOVE the header. The header keeps
 * printing the generated varName — the graph mirrors the code — so this is
 * where a Latvian user reads what the node is. `null` in English, where the
 * header's title stays its own text.
 *
 * It is the SOCKET label's twin, not a TooltipLayer bubble: the same look (one
 * shared rule in TypedHandle.css), shown at once on hover, and pinned by the
 * double-click that pins every socket label (labelPeek.ts) — so one gesture
 * names the node and its ports together.
 *
 * Canvas only, and only for the nodes whose header shows a varName: the Output
 * family already prints its Latvian name in the header, and the NodeVisual
 * replica behind asset tiles has the tile's own tooltip (and prints the
 * Latvian name as its title). Pass `bare` to the header's NodeTitle whenever
 * this returns a tip, or the title's own `title` opens a second bubble over it.
 */
export function useHeaderTip(def: { label: string; type: string } | undefined): HeaderTip | null {
  const language = useAppStore((s) => s.language);
  if (!def) return null;
  const tip = nodeHeaderTip(def.label, def.type, language);
  return tip === null ? null : { 'data-header-tip': tip };
}
