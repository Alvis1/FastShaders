import { foldSearchText as fold } from '@/utils/searchFold';

/**
 * The Branch's row in the Add-node menu (docs/dev/canvas-interaction.md,
 * "Branch"). A Branch is no registry node, so `searchNodes` can never return
 * it — like the note (noteSearch.ts), it carries its own words.
 *
 * `BRANCH_DESCRIPTION` is the row's tooltip; its `Also:` tail is the search
 * fodder `nodeMatchRank` would read on a registry node, kept in the same
 * shape so the convention holds, and stripped from the tooltip the same way
 * (`displayDescription`'s split).
 */
export const BRANCH_DESCRIPTION =
  'One wire in, any number of wires out: the same value goes on to several inputs. It computes nothing. Also: reroute, split, fork, junction';

/** The tooltip: the description without its `Also:` tail. */
export const BRANCH_TOOLTIP = BRANCH_DESCRIPTION.split(/\s*Also:/)[0].trim();

/** The words that find the row, in both UI languages: its name, the `Also:`
 *  tail, and the Latvian name and verb. */
const BRANCH_WORDS = [
  'branch',
  ...BRANCH_DESCRIPTION.split(/Also:/)[1].split(',').map((w) => w.trim()),
  'sazarojums', 'sazarot', 'sazarojumu', 'zars',
];

/** Folded once (`foldSearchText`), so "sazarojums" finds "Sazarojums". */
const FOLDED = BRANCH_WORDS.map(fold);

/** Its NAME in both languages, folded. */
const NAMES = ['branch', 'sazarojums'].map(fold);

/**
 * True when `query` is the start of the Branch's NAME ("bra", "branch",
 * "sazar"): then the row goes FIRST, so Enter adds it — the ranked search
 * puts an exact-name hit first too, and Select (whose aliases say "branch")
 * would otherwise take the key. Any other match (an alias: "split", "fork")
 * offers it AFTER the node results, where a node match keeps Enter.
 */
export function branchNameMatchesQuery(query: string): boolean {
  const q = fold(query.trim());
  return q.length >= 2 && NAMES.some((n) => n.startsWith(q));
}

/** True when `query` names the Branch: one of its words starts with the query,
 *  or one of the query's words IS one ("add branch"). Two letters at least,
 *  as for the note. */
export function branchMatchesQuery(query: string): boolean {
  const q = fold(query.trim());
  if (q.length < 2) return false;
  const words = q.split(/\s+/);
  return FOLDED.some((w) => w.startsWith(q) || words.includes(w));
}
