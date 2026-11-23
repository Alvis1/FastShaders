/**
 * PORTAL NAMES (docs/dev/canvas-interaction.md, "Portal"). A name is DISPLAY
 * ONLY — identity is the entrance's node id (`data.link`, utils/passThrough.ts)
 * and a name never reaches the code — but it is what a reader traces a portal
 * by, so it is UNIQUE among Portal Ins: a clash gets " 2", " 3" … (the
 * `nextGroupLabel` convention), and a portal with nothing to be named after is
 * "portal 1", "portal 2" … (stored English data, like "Group 1").
 *
 * A LEAF (passThrough.ts and valueCoerce.ts only), so the store's group-clone
 * path can rename copied entrances without an import cycle. Names are
 * adversarial on read (`tunnelLabelOf`) and cleaned on every write
 * (`cleanPortalName`).
 */
import type { AppNode } from '@/types';
import { valueStr } from '@/utils/valueCoerce';
import { isTunnelIn, tunnelLabelOf, tunnelLinkOf } from '@/utils/passThrough';

/** The longest name a rename keeps (code points). The card shows ~12 and the
 *  rest is its tooltip; a cap keeps a pasted paragraph out of every menu. */
export const PORTAL_NAME_MAX = 40;

/** The stem of a portal made with nothing to name it after. */
const UNNAMED_STEM = 'portal';

/** C0 and C1 control characters (`\s` below already covers U+2028 / U+2029). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * A name as a rename or a new portal stores it: text only (`valueStr`), every
 * control or line-separator character a space, runs of white space one space,
 * trimmed, and cut at `PORTAL_NAME_MAX` code points (never inside a surrogate
 * pair).
 */
export function cleanPortalName(raw: unknown): string {
  const flat = valueStr(raw).replace(CONTROL_CHARS, ' ');
  const squeezed = flat.replace(/\s+/g, ' ').trim();
  return Array.from(squeezed).slice(0, PORTAL_NAME_MAX).join('').trim();
}

/** Every Portal In's name, except the entrance `exceptId`. */
export function portalNamesTaken(nodes: readonly AppNode[], exceptId?: string): Set<string> {
  const taken = new Set<string>();
  for (const n of nodes) if (isTunnelIn(n) && n.id !== exceptId) taken.add(tunnelLabelOf(n));
  return taken;
}

/** "portal 1", "portal 2" …: the first one no entrance holds. */
export function nextUnnamedPortal(taken: ReadonlySet<string>): string {
  let n = 1;
  while (taken.has(`${UNNAMED_STEM} ${n}`)) n++;
  return `${UNNAMED_STEM} ${n}`;
}

/**
 * `base` when no entrance holds it, else the first free " 2", " 3" … — a base
 * that already ends in " <n>" counts on from n ("perlin1 2" → "perlin1 3").
 * An empty base is an unnamed portal.
 */
export function uniquePortalName(base: string, taken: ReadonlySet<string>): string {
  if (base === '') return nextUnnamedPortal(taken);
  if (!taken.has(base)) return base;
  const m = /^(.*\S) (\d+)$/.exec(base);
  const counted = m !== null && Number.isSafeInteger(Number(m[2]) + 1);
  const stem = counted ? m[1] : base;
  let n = counted ? Number(m[2]) + 1 : 2;
  while (taken.has(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

function withLabel<N extends AppNode>(n: N, label: string): N {
  return { ...n, data: { ...n.data, label } } as N;
}

/**
 * Copies landing beside the live graph `live` (paste, duplicate, a saved
 * group): every copied ENTRANCE is a NEW portal, so it takes a name no live
 * entrance — and no earlier copy — holds ("perlin1" → "perlin1 2"), and every
 * copied exit linked to it caches that name. An exit copied without its
 * entrance stays an exit of the live portal (`remapTunnelLinks` kept its link)
 * and keeps its cache. `clones` itself when nothing changes.
 */
export function renameCopiedEntrances<N extends AppNode>(clones: N[], live: readonly AppNode[]): N[] {
  if (!clones.some(isTunnelIn)) return clones;
  const taken = portalNamesTaken(live);
  const renamed = new Map<string, string>();
  let out: N[] | null = null;
  clones.forEach((n, i) => {
    if (!isTunnelIn(n)) return;
    const name = uniquePortalName(cleanPortalName(tunnelLabelOf(n)), taken);
    taken.add(name);
    renamed.set(n.id, name);
    if ((n.data as { label?: unknown }).label === name) return;
    out ??= [...clones];
    out[i] = withLabel(n, name);
  });
  clones.forEach((n, i) => {
    const link = tunnelLinkOf(n);
    const name = link === null ? undefined : renamed.get(link);
    if (name === undefined || (n.data as { label?: unknown }).label === name) return;
    out ??= [...clones];
    out[i] = withLabel(n, name);
  });
  return out ?? clones;
}
