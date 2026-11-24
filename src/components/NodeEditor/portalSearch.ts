import type { AppNode } from '@/types';
import { foldSearchText as fold } from '@/utils/searchFold';
import { isTunnelIn, tunnelLabelOf } from '@/utils/passThrough';
import { safeJsonReviver } from '@/utils/safeJson';

/**
 * The live portals as ONE string — a store selector's answer, a primitive, so
 * the menu re-renders only when an entrance comes, goes or is renamed. One
 * JSON line per Portal In (a name is adversarial text: JSON escapes it).
 */
export function portalListKey(nodes: readonly AppNode[]): string {
  let out = '';
  for (const n of nodes) if (isTunnelIn(n)) out += `${JSON.stringify([n.id, tunnelLabelOf(n)])}\n`;
  return out;
}

/** `portalListKey` read back: `{ id, name }` per portal, sorted by name. */
export function parsePortalList(key: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const line of key.split('\n')) {
    if (!line) continue;
    const [id, name] = JSON.parse(line, safeJsonReviver) as [string, string];
    out.push({ id, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/**
 * The Portal rows of the Add-node menu (docs/dev/canvas-interaction.md,
 * "Portal"). A Portal end is no registry node, so `searchNodes` can never
 * return it — like the Branch (branchSearch.ts) and the note, it carries its
 * own words, in the description's `Also:` tail (the ranked search's
 * convention, stripped from the tooltip the same way).
 */
export const PORTAL_IN_DESCRIPTION =
  'A wire goes in here and comes out of every Portal Out of this portal, with no wire drawn in between. It computes nothing. Also: tunnel, named reroute, send, receive, wireless, variable';
export const PORTAL_OUT_DESCRIPTION =
  'Gives out the value that goes into its Portal In, with no wire drawn in between. It computes nothing. Also: tunnel, named reroute, send, receive, wireless, variable';

const tooltipOf = (d: string) => d.split(/\s*Also:/)[0].trim();
/** The rows' tooltips: the descriptions without their `Also:` tails. */
export const PORTAL_IN_TOOLTIP = tooltipOf(PORTAL_IN_DESCRIPTION);
export const PORTAL_OUT_TOOLTIP = tooltipOf(PORTAL_OUT_DESCRIPTION);

/** The words that find the rows, in both UI languages. */
const WORDS = [
  'portal', 'portal in', 'portal out', 'entrance', 'exit',
  ...PORTAL_IN_DESCRIPTION.split(/Also:/)[1].split(',').map((w) => w.trim()),
  'portāls', 'portāla ieeja', 'portāla izeja', 'ieeja', 'izeja', 'tunelis',
].map(fold);

/** The NAMES in both languages, folded. */
const NAMES = ['portal', 'portal in', 'portal out', 'portāls', 'portāla ieeja', 'portāla izeja'].map(fold);

/**
 * True when `query` is the start of a Portal NAME ("por", "portal in",
 * "portā"): its rows then go FIRST, as an exact-name hit does in the ranked
 * search. Two letters at least.
 */
export function portalNameMatchesQuery(query: string): boolean {
  const q = fold(query.trim());
  return q.length >= 2 && NAMES.some((n) => n.startsWith(q));
}

/** True when `query` names the Portal by any of its words (an alias offers
 *  the rows AFTER the node results, where a node match keeps Enter). */
export function portalMatchesQuery(query: string): boolean {
  const q = fold(query.trim());
  if (q.length < 2) return false;
  const words = q.split(/\s+/);
  return WORDS.some((w) => w.startsWith(q) || words.includes(w));
}

/**
 * The portals a wire pulled from an INPUT is offered, filtered by the query:
 * every name containing the folded query (all of them for an empty one), in
 * the order given. A query that names the Portal itself ("portal") keeps them
 * all too.
 */
export function filterPortalsByName<T extends { name: string }>(portals: readonly T[], query: string): T[] {
  const q = fold(query.trim());
  if (q === '' || portalNameMatchesQuery(query)) return [...portals];
  return portals.filter((p) => fold(p.name).includes(q));
}

/** Does `query` name one of `portals` EXACTLY (folded)? Then its rows lead,
 *  as an exact-name hit does in the ranked search. */
export function portalNamedExactly(portals: readonly { name: string }[], query: string): boolean {
  const q = fold(query.trim());
  return q !== '' && portals.some((p) => fold(p.name) === q);
}

/**
 * Which portal results a SEARCH shows (owner, 2026-11-24: "all defined
 * portals can be found through the search box by the word portal and by the
 * portal's name") — the palette's tiles (PortalTileCard.tsx) and the
 * Add-node menu's rows ask the same thing. `portals` are the live entrances
 * (`parsePortalList`).
 *
 *  - a query naming the Portal ("portal", "portāls", an `Also:` word) shows
 *    the Portal In and one Portal Out per portal;
 *  - any other query shows the portals whose NAME contains it (folded), and
 *    no Portal In;
 *  - they LEAD — before the node results — for the start of the Portal's own
 *    name ("por") or a portal's exact name, as the ranked search puts a name
 *    hit first, and otherwise follow the node results, so a node match keeps
 *    Enter and the front of the strip.
 */
export function portalSearchResults<T extends { id: string; name: string }>(
  query: string,
  portals: readonly T[],
): { portalIn: boolean; exits: T[]; lead: boolean } {
  if (!query.trim()) return { portalIn: false, exits: [], lead: false };
  const named = portalMatchesQuery(query);
  const exits = named ? [...portals] : filterPortalsByName(portals, query);
  const lead = portalNameMatchesQuery(query) || portalNamedExactly(exits, query);
  return { portalIn: named, exits, lead: lead && (named || exits.length > 0) };
}
