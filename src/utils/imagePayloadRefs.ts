/**
 * An image payload is STORED once per localStorage document.
 *
 * In memory nothing changes: every Image node holds its full
 * `values.imageB64`, so graphToCode, imageAssets, cost, thumbnails, history
 * and the export never see a reference. The de-duplication happens only at the
 * two localStorage writers (`fs:graph` and `fs:savedGroups`) and is undone on
 * every restore path.
 *
 * FORMAT. Within ONE document, the first Image node in document order holding
 * a payload keeps it inline. A later Image node holding the byte-identical
 * payload is written `imageB64: ''` (same key position) plus an appended
 * `imageRef: 'img1-<FNV-1a hex>-<payload length base36>'`. The format version
 * is the `img1-` prefix. There are no new top-level keys, and `fs:savedGroups`
 * stays a bare array. A document without duplicates is written byte-identically
 * (the writers return the SAME array).
 *
 * WHY NOT A TABLE OBJECT. `fs:savedGroups` must stay a bare array: 0.3.33
 * returns `[]` for anything else, and its next save overwrites the whole
 * library. A top-level table in `fs:graph` is ignored on read by an older build
 * but DROPPED by its first autosave, which would lose every referenced image
 * after a rollback. A third shared key would need cross-key garbage collection
 * over localStorage, which is neither transactional nor consistent across tabs.
 * With inline canonicals, 0.3.33 shows each first copy with pixels and each
 * duplicate as a named card without a thumbnail that samples black; its own
 * autosave keeps `imageRef`, so this build restores those pixels.
 *
 * COLLISIONS. FNV-1a is a 32-bit bucket, not an identity (a colliding pair of
 * real equal-length payloads is pinned in payloadDigest.test.ts). Identity is
 * decided by CONTENT: the writer de-duplicates by the string itself, and only
 * the printed ref is hashed. A payload may be referenced only when it is the
 * first VALID payload of the document with its key; a later, different payload
 * with the same key is always written inline. The reader resolves a ref to the
 * first valid inline payload of the SAME document whose RE-DERIVED key matches,
 * so nothing stored is trusted as a key and a ref only ever reaches that
 * document's own pixels.
 *
 * AMPLIFICATION. A ref lets a small document expand to N copies of a payload in
 * consumers that work per instance (preview inlining, the project block, the
 * per-call hash). At most MAX_REF_RESOLVED_IMAGE_CHARS characters per document
 * resolve through refs, counted in document order. The writer applies the same
 * guard in the same order and writes inline beyond it (an over-quota write then
 * raises the storage-quota notice as it always did), so the reader never strips
 * what the writer wrote.
 *
 * Writer and reader share ONE ordering rule, one validity function
 * (`validImageDataUrl`) and one guard: change them together.
 *
 * Every value here is read by plain property access, never the `in` operator:
 * these objects come out of untrusted JSON, and `in` throws on a primitive.
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
