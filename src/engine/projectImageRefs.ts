/**
 * The project block's ADDITIVE `imageRefs` field: Image nodes that name their
 * payload by key instead of carrying it, recovered from the module's own
 * `data:` literals.
 *
 * WHY THE WRITER IS OFF. FastShaders 0.3.33 and older read pixels ONLY from
 * `values.imageB64`. An additive field keeps a block PARSEABLE there, not its
 * pixels: `sanitizeImageNodes` does not count a node without `imageB64` as
 * stripped, so no notice appears; the card shows the file name and no
 * thumbnail; codegen emits `vec3(0, 0, 0)`, so everything the image fed
 * renders black; and the payload-less node is autosaved, so a re-export from
 * that build writes neither `imageB64` nor `imageRefs` and the image is gone
 * for every later build too. So this module ships the READER now (every build
 * from here on recovers a ref), and the WRITER stays behind
 * `EXPORT_IMAGE_REFS = false`. Flipping it is the owner's decision, and only
 * after the reader has been in the field for a few releases, so a flip strands
 * only builds up to 0.3.33.
 *
 * ONE KEY FORMAT. The key is the storage ref of utils/imagePayloadRefs.ts
 * (`imageRefFor`, `IMAGE_REF_RE`): the same function over the CANONICAL `src`
 * here (what the module literal holds) and over the raw stored string there.
 * Each reader re-derives its key from the text it holds, so the two never
 * cross.
 *
 * COLLISIONS. The key is a 32-bit bucket, never an identity. The writer
 * poisons a key two different payloads share (those nodes keep `imageB64`),
 * and the reader poisons a key two different module literals share (those
 * nodes count as unresolved and raise the `images-missing` notice). A
 * collision can therefore never bind the wrong image.
 *
 * AMPLIFICATION. A ref lets a small block expand to many copies of one module
 * literal in consumers that work per node (the preview inlining and the
 * per-call hash). The reader shares P2a's per-document `RefBudget` with the
 * in-node ref pass, and a node past it stays unresolved.
 *
 * It must NOT import engine/imageAssets.ts: that reaches the store through
 * utils/feedbackReport → utils/edgeUtils, and utils/imagePayloadRefs.ts is the
 * only image module it needs.
 */

import type { AppNode } from '@/types';
import { HARD_MAX_IMAGE_ENCODED_CHARS, IMAGE_REF_KEY } from '@/utils/imageNode';
import { IMAGE_REF_RE, imageRefFor, newRefBudget, type RefBudget } from '@/utils/imagePayloadRefs';
import type { FastShadersProject } from './fastShadersProject';

/**
 * OWNER GATE: write ref-only project blocks. Read ONLY by
 * exportShader.buildShaderBundle. While false, every Image node in every
 * exported block keeps its full `values.imageB64`. Flipping it makes 0.3.33
 * and older open such exports with every referenced image black, with no
 * notice, and a re-save there destroys the images (see the header).
 */
export const EXPORT_IMAGE_REFS = false as const;

/** At most this many `imageRefs` entries are considered per block. */
export const MAX_IMAGE_REFS = 1024;
/** At most this many module literals are scanned per import. */
export const MAX_MODULE_IMAGE_LITERALS = 1024;

/** Node ids never referenced: safeJsonReviver drops these keys on read, so a
 *  ref under one could never be found again. */
const RESERVED_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Max length of an `imageRefs` key (a node id) the reader accepts. */
const MAX_REF_ID_CHARS = 256;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null;
}

/** An Image node's `values`, or null. Plain property access, never `in`. */
function imageValuesOf(node: unknown): Obj | null {
  if (!isObj(node)) return null;
  const data = node.data;
  if (!isObj(data) || data.registryType !== 'imageNode') return null;
  const values = data.values;
  return isObj(values) && !Array.isArray(values) ? values : null;
}

function hasPayload(values: Obj): boolean {
  const p = values.imageB64;
  return typeof p === 'string' && p.length > 0;
}

/**
 * Every double-quoted whitelisted image `data:` literal in `moduleText`, in
 * text order. Linear: a base64 run cannot contain `"`, so a failed match only
 * retries at the next `"data:image/` prefix. Literals over the 8M hard ceiling
 * are skipped, and the scan stops after MAX_MODULE_IMAGE_LITERALS yields.
 * Lazy, so a block with nothing to resolve never scans at all.
 */
export function* moduleImageLiterals(moduleText: string): Generator<string> {
  const re = /"(data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)"/g;
  let yielded = 0;
  let m: RegExpExecArray | null;
  while (yielded < MAX_MODULE_IMAGE_LITERALS && (m = re.exec(moduleText)) !== null) {
    const lit = m[1];
    if (lit.length > HARD_MAX_IMAGE_ENCODED_CHARS) continue;
    yielded++;
    yield lit;
  }
}

export interface ProjectImageRefsResult {
  /** The SAME project when nothing was resolved. */
  project: FastShadersProject;
  /** Ids of Image nodes that wanted a ref and were left without a payload. */
  unresolvedIds: ReadonlySet<string>;
}

const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Resolve a block's top-level `imageRefs` against `candidates` (the module's
 * own literals). Returns the SAME project, and never iterates the candidates,
 * when the block has no usable `imageRefs` or no Image node lacks a payload. A
 * non-empty `imageB64` always wins over a ref. A resolved literal is charged to
 * `budget`, and a node whose literal would take it past `maxRefChars` stays
 * unresolved. Every recovered string then passes `sanitizeImageNodes` like any
 * other payload.
 *
 * `candidates` is an Iterable so a later phase can feed other sources (GLB
 * images turned into data URLs) instead of module literals.
 */
export function resolveProjectImageRefs(
  project: FastShadersProject,
  candidates: Iterable<string>,
  budget: RefBudget = newRefBudget(),
): ProjectImageRefsResult {
  const raw = (project as { imageRefs?: unknown }).imageRefs;
  if (!isObj(raw) || Array.isArray(raw)) return { project, unresolvedIds: NO_IDS };

  const refs = new Map<string, string>();
  for (const [id, ref] of Object.entries(raw).slice(0, MAX_IMAGE_REFS)) {
    if (id.length > MAX_REF_ID_CHARS || RESERVED_IDS.has(id)) continue;
    if (typeof ref === 'string' && IMAGE_REF_RE.test(ref)) refs.set(id, ref);
  }
  if (refs.size === 0) return { project, unresolvedIds: NO_IDS };

  // The keys some Image node without a payload is waiting for.
  const nodes = project.graph.nodes;
  const wantedByIndex = new Map<number, string>();
  const wanted = new Set<string>();
  const wantedLengths = new Set<number>();
  nodes.forEach((n, i) => {
    const values = imageValuesOf(n);
    if (!values || hasPayload(values)) return;
    const id = (n as { id?: unknown }).id;
    if (typeof id !== 'string') return;
    const ref = refs.get(id);
    if (ref === undefined) return;
    wantedByIndex.set(i, ref);
    wanted.add(ref);
    wantedLengths.add(parseInt((IMAGE_REF_RE.exec(ref) as RegExpExecArray)[2], 36));
  });
  if (wanted.size === 0) return { project, unresolvedIds: NO_IDS };

  // First literal per wanted key; a later DIFFERENT literal under the same key
  // poisons it. The length gate skips the hash for every literal no ref names.
  const found = new Map<string, string>();
  const poisoned = new Set<string>();
  for (const lit of candidates) {
    if (!wantedLengths.has(lit.length)) continue;
    const k = imageRefFor(lit);
    if (!wanted.has(k)) continue;
    const prev = found.get(k);
    if (prev === undefined) found.set(k, lit);
    else if (prev !== lit) poisoned.add(k);
  }

  const unresolvedIds = new Set<string>();
  let changed = false;
  const out = nodes.map((n, i) => {
    const ref = wantedByIndex.get(i);
    if (ref === undefined) return n;
    const lit = found.get(ref);
    if (lit === undefined || poisoned.has(ref) || budget.refChars + lit.length > budget.maxRefChars) {
      unresolvedIds.add(n.id);
      return n;
    }
    budget.refChars += lit.length;
    changed = true;
    const values = imageValuesOf(n) as Obj;
    return { ...n, data: { ...n.data, values: { ...values, imageB64: lit } } } as AppNode;
  });
  if (!changed) return { project, unresolvedIds };
  return { project: { ...project, graph: { ...project.graph, nodes: out } }, unresolvedIds };
}

/**
 * How the image losses of one import split between the two notices, counting
 * each node that is still without a payload ONCE. `before` is the node list
 * handed to the in-node ref pass (resolveImageRefs), `after` what it returned.
 * - `missing`: nodes in `unresolvedIds` still without a payload after both ref
 *   passes → `images-missing`.
 * - `alsoDangling`: how many of those the in-node pass ALSO counted in its
 *   `dangling` (they carried an `imageRef` too). The caller subtracts it from
 *   the `images-stripped` count, so no node is reported twice.
 */
export function splitImageLosses(
  before: readonly AppNode[],
  after: readonly AppNode[],
  unresolvedIds: ReadonlySet<string>,
): { missing: number; alsoDangling: number } {
  if (unresolvedIds.size === 0) return { missing: 0, alsoDangling: 0 };
  let missing = 0;
  let alsoDangling = 0;
  for (let i = 0; i < after.length; i++) {
    const n = after[i];
    if (!unresolvedIds.has(n.id)) continue;
    const values = imageValuesOf(n);
    if (!values || hasPayload(values)) continue;
    missing++;
    const prior = imageValuesOf(before[i]);
    if (prior && prior[IMAGE_REF_KEY] !== undefined) alsoDangling++;
  }
  return { missing, alsoDangling };
}

/**
 * THE WRITER (owner-gated; see EXPORT_IMAGE_REFS). Omit `imageB64` from every
 * Image node whose canonical `src` is present in `moduleText` as a
 * double-quoted literal, and append `imageRefs` (node id → key) as the LAST
 * top-level key. The literal check is load-bearing: `state.code` can be
 * un-applied code-panel text or an `// Export error:` fallback holding no
 * payload, and referencing such a node would ship a file that loses the image
 * in EVERY build.
 *
 * Never referenced: an id that occurs more than once, a reserved id, and every
 * node under a key two DIFFERENT payloads share. Never mutates: the input
 * nodes are live store objects. Returns the SAME project when nothing is
 * referenced, so the block stays byte-identical.
 */
export function referenceImagesInModule(
  project: FastShadersProject,
  moduleText: string,
  canonicalSrc: (n: AppNode) => string | null,
): FastShadersProject {
  return referenceImagesWhere(project, (src) => moduleText.includes(`"${src}"`), canonicalSrc);
}

/**
 * The single-GLB writer's form: reference every Image node whose canonical
 * src is in `srcs` — the canonical srcs of the payload images actually WRITTEN
 * into the GLB (the `assets` targets), so every referenced node is
 * recoverable by `resolveProjectImageRefs` from those bytes. Refs are ALWAYS
 * written there: no build older than the single-GLB import can open such a
 * file, so the EXPORT_IMAGE_REFS gate (which protects 0.3.33 readers of `.js`)
 * does not apply. Same rules as `referenceImagesInModule` otherwise — one
 * body, one set of exceptions.
 */
export function referenceImagesInSet(
  project: FastShadersProject,
  srcs: ReadonlySet<string>,
  canonicalSrc: (n: AppNode) => string | null,
): FastShadersProject {
  return referenceImagesWhere(project, (src) => srcs.has(src), canonicalSrc);
}

/** The one writer body; `isPresent` decides which canonical srcs may become refs (memoised per src). */
function referenceImagesWhere(
  project: FastShadersProject,
  isPresent: (src: string) => boolean,
  canonicalSrc: (n: AppNode) => string | null,
): FastShadersProject {
  const nodes = project.graph.nodes;
  const idCount = new Map<string, number>();
  for (const n of nodes) idCount.set(n.id, (idCount.get(n.id) ?? 0) + 1);

  const presence = new Map<string, boolean>();
  const srcOfKey = new Map<string, string>();
  const poisoned = new Set<string>();
  const keyOfIndex = new Map<number, string>();
  nodes.forEach((n, i) => {
    if (!imageValuesOf(n)) return;
    if (typeof n.id !== 'string' || RESERVED_IDS.has(n.id) || idCount.get(n.id) !== 1) return;
    const src = canonicalSrc(n);
    if (src === null) return;
    let present = presence.get(src);
    if (present === undefined) {
      present = isPresent(src);
      presence.set(src, present);
    }
    if (!present) return;
    const k = imageRefFor(src);
    const prev = srcOfKey.get(k);
    if (prev === undefined) srcOfKey.set(k, src);
    else if (prev !== src) poisoned.add(k);
    keyOfIndex.set(i, k);
  });

  const imageRefs: Record<string, string> = {};
  let referenced = 0;
  const out = nodes.map((n, i) => {
    const k = keyOfIndex.get(i);
    if (k === undefined || poisoned.has(k)) return n;
    const values: Obj = { ...(imageValuesOf(n) as Obj) };
    delete values.imageB64;
    imageRefs[n.id] = k;
    referenced++;
    return { ...n, data: { ...n.data, values } } as AppNode;
  });
  if (referenced === 0) return project;

  const rest: Obj = { ...project };
  delete rest.imageRefs;
  return { ...rest, graph: { ...project.graph, nodes: out }, imageRefs } as FastShadersProject;
}
