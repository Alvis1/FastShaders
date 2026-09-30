/**
 * An image payload is STORED once per localStorage document: the first VALID
 * inline one wins, a later identical one becomes `imageRef: 'img1-<fnv>-<len36>'`.
 * Identity is CONTENT, never the hash: docs/dev/storage-and-limits.md § STORED once.
 */

import type { AppNode } from '@/types';
import {
  validImageDataUrl,
  HARD_MAX_IMAGE_ENCODED_CHARS,
  IMAGE_REF_KEY,
  WRITE_IMAGE_REFS,
} from './imageNode';
import { fnv1a32Hex } from './payloadDigest';
import { PLATFORM_CAPS } from './platformCaps';

/** A stored ref: `img1-` + 8 hex digits of FNV-1a + the payload length in
 *  base 36 (8M chars is 5 digits). */
export const IMAGE_REF_RE = /^img1-([0-9a-f]{8})-([0-9a-z]{1,6})$/;

/** Characters per document that may resolve through refs: on the web, 2 × the
 *  8M hard per-image ceiling (16M). A legit web graph under the per-instance
 *  project budget stays under 3M, so there this only ever bites ignore-limits
 *  users. The desktop room raises it to 64M (utils/platformCaps.ts): a desktop
 *  project (32M counted per instance) must resolve fully, and Phase 7's GLB
 *  project view always writes refs. Never below the web number. */
export const MAX_REF_RESOLVED_IMAGE_CHARS = Math.max(
  2 * HARD_MAX_IMAGE_ENCODED_CHARS,
  PLATFORM_CAPS.refResolvedImageChars,
);

/** The ref a stored duplicate of `payload` carries. */
export function imageRefFor(payload: string): string {
  return `img1-${fnv1a32Hex(payload)}-${payload.length.toString(36)}`;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null;
}

/** An Image node's `values` object, or null for anything else. */
function imageValuesOf(node: unknown): Obj | null {
  if (!isObj(node)) return null;
  const data = node.data;
  if (!isObj(data) || data.registryType !== 'imageNode') return null;
  const values = data.values;
  return isObj(values) && !Array.isArray(values) ? values : null;
}

function payloadOf(values: Obj | null): string | null {
  if (!values) return null;
  const p = values.imageB64;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

// ---------------------------------------------------------------------------
// WRITER
// ---------------------------------------------------------------------------

/**
 * Which slots (indices into `payloads`, one per node in document order; null
 * for a non-image node or an empty payload) are written as a ref, and with
 * which ref. Empty when nothing is duplicated.
 */
function planRefs(payloads: readonly (string | null)[], maxRefChars: number): Map<number, string> {
  const plan = new Map<number, string>();
  if (!WRITE_IMAGE_REFS) return plan;

  const count = new Map<string, number>();
  for (const p of payloads) if (p !== null) count.set(p, (count.get(p) ?? 0) + 1);

  // Only a payload of the same LENGTH as a referable one can share its key.
  const dupLengths = new Set<number>();
  for (const [p, c] of count) if (c >= 2 && validImageDataUrl(p) !== null) dupLengths.add(p.length);
  if (dupLengths.size === 0) return plan;

  const bucketOwner = new Map<string, string>(); // ref -> the payload that claimed it
  const refOf = new Map<string, string>(); // referable payload -> its ref
  const seen = new Set<string>();
  let refChars = 0;
  for (let i = 0; i < payloads.length; i++) {
    const p = payloads[i];
    if (p === null) continue;
    if (!seen.has(p)) {
      // First occurrence: always inline. It claims its key only if it is
      // valid — the reader skips an invalid inline payload, so an invalid one
      // must not block a later valid one either.
      seen.add(p);
      if (dupLengths.has(p.length) && validImageDataUrl(p) !== null) {
        const r = imageRefFor(p);
        if (!bucketOwner.has(r)) {
          bucketOwner.set(r, p);
          if ((count.get(p) ?? 0) >= 2) refOf.set(p, r);
        }
        // else: a different, earlier payload owns the key — p stays inline.
      }
      continue;
    }
    const r = refOf.get(p);
    if (r === undefined) continue;
    if (refChars + p.length > maxRefChars) continue; // the guard: write inline
    refChars += p.length;
    plan.set(i, r);
  }
  return plan;
}

/** `node` rewritten for storage: a planned ref replaces the payload, and a
 *  stray ref key is dropped. The SAME node when neither applies. */
function rewriteForStorage<T>(node: T, values: Obj | null, ref: string | undefined): T {
  if (!values) return node;
  if (ref === undefined && values[IMAGE_REF_KEY] === undefined) return node;
  const nv: Obj = { ...values };
  delete nv[IMAGE_REF_KEY];
  if (ref !== undefined) {
    nv.imageB64 = ''; // assigning an existing key keeps its position
    nv[IMAGE_REF_KEY] = ref;
  }
  const n = node as Obj;
  return { ...n, data: { ...(n.data as Obj), values: nv } } as T;
}

/**
 * The `fs:graph` writer's node list: each duplicated payload stored once. The
 * SAME array when nothing is duplicated and no node carries a stray ref (the
 * byte-identical case). Never mutates its input.
 */
export function imagePayloadsForStorage(
  nodes: AppNode[],
  maxRefChars: number = MAX_REF_RESOLVED_IMAGE_CHARS,
): AppNode[] {
  const values = nodes.map((n) => imageValuesOf(n));
  const plan = planRefs(values.map(payloadOf), maxRefChars);
  const stray = values.some((v) => v !== null && v[IMAGE_REF_KEY] !== undefined);
  if (plan.size === 0 && !stray) return nodes;
  return nodes.map((n, i) => rewriteForStorage(n, values[i], plan.get(i)));
}

/**
 * The `fs:savedGroups` writer: ONE plan over every group's nodes in order, so
 * a ref may point into an earlier group (the library stores each payload once
 * however many groups hold it). Rebuilds only the groups that changed; the
 * SAME array when none did.
 */
export function libraryPayloadsForStorage<G extends { nodes: AppNode[] }>(
  groups: G[],
  maxRefChars: number = MAX_REF_RESOLVED_IMAGE_CHARS,
): G[] {
  const flat: Array<Obj | null> = [];
  for (const g of groups) for (const n of g.nodes) flat.push(imageValuesOf(n));
  const plan = planRefs(flat.map(payloadOf), maxRefChars);
  const stray = flat.some((v) => v !== null && v[IMAGE_REF_KEY] !== undefined);
  if (plan.size === 0 && !stray) return groups;
  let k = 0;
  let changedAny = false;
  const out = groups.map((g) => {
    let changed = false;
    const nodes = g.nodes.map((n) => {
      const i = k++;
      const next = rewriteForStorage(n, flat[i], plan.get(i));
      if (next !== n) changed = true;
      return next;
    });
    if (!changed) return g;
    changedAny = true;
    return { ...g, nodes };
  });
  return changedAny ? out : groups;
}

// ---------------------------------------------------------------------------
// READER
// ---------------------------------------------------------------------------

/**
 * The inline payloads of one stored document, in document order. Nothing is
 * validated or hashed up front; `lookup` memoises both on first use.
 */
export interface ImagePayloadIndex {
  /** First-occurrence inline payloads, grouped by length, in document order. */
  readonly byLength: Map<number, string[]>;
  /** payload -> the first string object carrying it (for interning). */
  readonly intern: Map<string, string>;
  readonly valid: Map<string, boolean>;
  readonly hash: Map<string, string>;
}

/**
 * Harvest the inline payloads of a RAW, freshly parsed node list. Defensive:
 * anything that is not an object, has no `data`, or is not an Image node with
 * an object `values` and a non-empty string `imageB64` is skipped.
 */
export function harvestImagePayloads(rawNodes: readonly unknown[]): ImagePayloadIndex {
  const index: ImagePayloadIndex = {
    byLength: new Map(),
    intern: new Map(),
    valid: new Map(),
    hash: new Map(),
  };
  for (const n of rawNodes) {
    const p = payloadOf(imageValuesOf(n));
    if (p === null || index.intern.has(p)) continue;
    index.intern.set(p, p);
    const list = index.byLength.get(p.length);
    if (list) list.push(p);
    else index.byLength.set(p.length, [p]);
  }
  return index;
}

/** The payload a ref names: the first VALID inline payload of the document
 *  with the ref's length whose RE-DERIVED hash matches. Null otherwise. */
function lookup(index: ImagePayloadIndex, ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const m = IMAGE_REF_RE.exec(ref);
  if (!m) return null;
  const list = index.byLength.get(parseInt(m[2], 36));
  if (!list) return null;
  for (const p of list) {
    let ok = index.valid.get(p);
    if (ok === undefined) {
      ok = validImageDataUrl(p) !== null;
      index.valid.set(p, ok);
    }
    if (!ok) continue;
    let h = index.hash.get(p);
    if (h === undefined) {
      h = fnv1a32Hex(p);
      index.hash.set(p, h);
    }
    if (h === m[1]) return p;
  }
  return null;
}

/** How many characters one document has resolved through refs so far. ONE
 *  budget per document: `fs:savedGroups` shares it across its groups. */
export interface RefBudget {
  refChars: number;
  readonly maxRefChars: number;
}

export function newRefBudget(maxRefChars: number = MAX_REF_RESOLVED_IMAGE_CHARS): RefBudget {
  return { refChars: 0, maxRefChars };
}

/**
 * Resolve stored refs back into full payloads, BEFORE `sanitizeImageNodes`, so
 * the caps judge the real payload. Per Image node with an object `values`:
 * - no ref: a non-empty inline payload is INTERNED in place (replaced by the
 *   content-identical first copy, so N parsed duplicates share one string);
 * - a ref: the values are copied without it. A non-empty inline payload
 *   beside the ref wins; otherwise the ref resolves within the budget, or the
 *   node is emptied and counted in `dangling`.
 * Returns the SAME array when no node carried a ref.
 *
 * The in-place intern assumes a FRESHLY PARSED array, which every call site
 * passes. Never call it on live store state.
 */
export function resolveImageRefs<T>(
  nodes: T[],
  index: ImagePayloadIndex = harvestImagePayloads(nodes),
  budget: RefBudget = newRefBudget(),
): { nodes: T[]; dangling: number } {
  let dangling = 0;
  let out: T[] | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const values = imageValuesOf(nodes[i]);
    if (!values) continue;
    const ref = values[IMAGE_REF_KEY];
    if (ref === undefined) {
      const p = payloadOf(values);
      if (p !== null) {
        const shared = index.intern.get(p);
        if (shared !== undefined) values.imageB64 = shared;
      }
      continue;
    }
    const nv: Obj = { ...values };
    delete nv[IMAGE_REF_KEY];
    const inline = payloadOf(nv);
    if (inline !== null) {
      nv.imageB64 = index.intern.get(inline) ?? inline;
    } else {
      const p = lookup(index, ref);
      if (p !== null && budget.refChars + p.length <= budget.maxRefChars) {
        nv.imageB64 = p;
        budget.refChars += p.length;
      } else {
        nv.imageB64 = '';
        dangling++;
      }
    }
    out ??= nodes.slice();
    const n = nodes[i] as Obj;
    out[i] = { ...n, data: { ...(n.data as Obj), values: nv } } as T;
  }
  return { nodes: out ?? nodes, dangling };
}
