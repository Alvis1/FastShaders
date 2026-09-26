/**
 * The trusted-side Gaussian-splat HEADER SNIFF — the bounded check a dropped
 * `.splat` / `.spz` / `.ply` / `.ksplat` passes before it enters the store.
 *
 * Model bytes are adversarial and are never PARSED on the trusted side: the
 * real parse (`FastShadersSplat.parseBytes`, the runtime's one chokepoint) runs
 * inside the sandboxed preview, where a malformed file surfaces as the model
 * error overlay. This is the third narrow exception beside previewMesh.ts's
 * JSON-header readers: it reads fixed-offset integers and at most
 * `PLY_HEADER_SCAN_BYTES` of ASCII header text, builds no geometry, allocates
 * nothing proportional to the file, resolves no URI and decompresses nothing.
 * It is SYNCHRONOUS, BOUNDED and NEVER THROWS — any failure is a refusal.
 *
 * What it answers is what the user can act on BEFORE the sandbox spends time:
 *   - `.splat`  length % 32 and the row count (the format has no header);
 *   - `.ply`    a `ply` header ending at an exact `end_header` line within
 *               64 KiB, with one `format` line, not SuperSplat's chunked form
 *               ('ply-compressed'), exactly ONE element — `vertex`, carrying
 *               the 3DGS property set in known scalar types (else
 *               'ply-not-splat') — with no `f_rest_N` spherical-harmonic bands
 *               ('ply-sh' — the PLY loader would materialise 180 B/splat of
 *               them), stored BINARY (an ASCII body is refused as bad-splat with
 *               its own sentence, as the runtime refuses it), a vertex count
 *               under the cap ('splat-count') and a body LONG enough to hold
 *               those rows (its length is compared; its bytes are never read).
 *               The rules, in order, are listed above `sniffPly`;
 *   - `.spz`    gzip (count unknown until the sandbox inflates it; the ISIZE
 *               trailer is pre-checked against SPZ_MAX_DECODED_BYTES, and the
 *               sandbox's streamed counter is the real guard, since ISIZE is a
 *               claim), or a raw `NGSP` header — version 4 (zstd) is
 *               'spz-version', anything else 'bad-splat';
 *   - `.ksplat` the 4096-byte header and the section headers after it, at the
 *               offsets three r186's KSPLATLoader reads, refusing exactly what
 *               that loader would throw on, plus the count cap.
 * A pass returns the file's DERIVED facts (`SplatFacts`), which `createPreviewMesh`
 * keeps on the mesh for the session and never persists.
 *
 * Every refusal is a structured `MeshRefusal` whose key is the English sentence
 * AND its lv.json key. podest.html carries a hand-written twin of these rules
 * (same literals, same sentences), drift-guarded by src/podestSplat.test.ts,
 * which runs it over the shared SPLAT_SNIFF_CASES corpus in src/test-utils.ts;
 * the runtime's own `.ply` gate is held to the same corpus by
 * src/fsSplatBundle.test.ts. A new rule needs a case in that corpus.
 */

import {
  KSPLAT_HEADER_BYTES,
  PLY_HEADER_SCAN_BYTES,
  SPLAT_MAX_COUNT,
  SPLAT_ROW_BYTES,
  SPZ_MAGIC,
  SPZ_MAX_DECODED_BYTES,
} from './splatLimits';
import { MESH_BAD_SPLAT_KEY, splatCountRefusal, splatSizeRefusal, type MeshRefusal } from './gltfCompression';

/** The splat file kinds — a subset of `PreviewMeshKind` (previewMesh.ts), by extension. */
export type SplatKind = 'splat' | 'spz' | 'ply' | 'ksplat';

export const SPLAT_KINDS: readonly SplatKind[] = ['splat', 'spz', 'ply', 'ksplat'];

/** A splat kind — exact, case-sensitive (kinds are already lower-cased by `detectMeshKind`). */
export function isSplatKind(kind: unknown): kind is SplatKind {
  return kind === 'splat' || kind === 'spz' || kind === 'ply' || kind === 'ksplat';
}

/**
 * Which container a splat file turned out to be. `.ply` records its PLY format
 * line; `'ply-ascii'` is never PRODUCED any more (an ASCII PLY is refused, as
 * the sandboxed runtime refuses it) and stays in the union only so a fact
 * built by hand keeps compiling. `.spz` is only ever gzip here, because a raw
 * `NGSP` header is refused.
 */
export type SplatContainer = 'splat' | 'ply-ascii' | 'ply-binary-le' | 'ply-binary-be' | 'spz-gzip' | 'ksplat';

/**
 * What the sniff learnt about a splat file. DERIVED, session-only, strings and
 * numbers: `createPreviewMesh` keeps it as `PreviewMesh.splat`, `meshToRecord`
 * never writes it, and the IndexedDB restore re-runs the sniff.
 */
export interface SplatFacts {
  /** The splat count the file declares; null when only the sandbox can know it (a gzip `.spz`). */
  count: number | null;
  /** The spherical-harmonics degree the file carries (the sandbox drops it to 0); null when unknown. */
  shDegree: number | null;
  container: SplatContainer;
}

export type SplatSniffResult = { facts: SplatFacts } | { refusal: MeshRefusal };

/*
 * The refusal KEYS. Each is the English template AND its lv.json `ui` key, so a
 * reword here must move the lv.json entry with it. MESH_BAD_SPLAT_KEY and
 * MESH_SPLAT_COUNT_KEY live in gltfCompression.ts, because the pre-read gate
 * builds them from a `.splat`'s size alone.
 */
export const MESH_BAD_SPZ_KEY = 'Not a valid .spz file (missing its gzip or SPZ header).';
export const MESH_BAD_PLY_KEY = 'Not a valid .ply file (missing or damaged PLY header).';
/**
 * A `.ply` whose body is shorter than the rows its header declares (a cut-off
 * download). `{count}` is the declared vertex count. Refused here rather than
 * in the sandbox, where PLYLoader would read past the end.
 */
export const MESH_PLY_TRUNCATED_KEY =
  'This .ply file is cut short: its header declares a splat count of {count}, but the file holds fewer. Download it or export it again.';
export const MESH_BAD_KSPLAT_KEY = 'Not a valid .ksplat file (damaged or unsupported header).';
export const MESH_PLY_NOT_SPLAT_KEY =
  'This .ply is a mesh or point cloud, not a Gaussian splat. Load meshes as .obj, .glb or .gltf.';
export const MESH_PLY_SH_KEY =
  "This .ply carries spherical-harmonic colour (f_rest_* properties), which FastShaders does not read. Convert it to .splat (SuperSplat can) or export it again without spherical harmonics.";
export const MESH_PLY_COMPRESSED_KEY =
  "This is a compressed .ply (SuperSplat's chunked format), which FastShaders cannot read yet. Export it again as an uncompressed .ply or as .splat.";
/**
 * A 3DGS `.ply` stored as TEXT (`format ascii`). The sandboxed runtime refuses
 * it (PLYLoader turns an ASCII body into one string per number — hundreds of
 * MB for a 64 MiB file), so the trusted sniff and podest's twin refuse it
 * first, in the user's language, instead of letting the sandbox's model error
 * say it. Every splat trainer and converter writes binary PLYs.
 */
export const MESH_PLY_ASCII_KEY =
  'This .ply is stored as text (format ascii), which FastShaders does not read. Export it again as a binary .ply or convert it to .splat.';
/** `{version}` is the version the file declares. */
export const MESH_SPZ_VERSION_KEY =
  'This .spz is version {version} (zstd-compressed), which FastShaders cannot read yet. Convert it to .ply or .splat.';
/** `{size}` is the size the gzip trailer CLAIMS; `{limit}` is SPZ_MAX_DECODED_BYTES. */
export const MESH_SPZ_TOO_LARGE_KEY =
  'This .spz unpacks to {size} MB — max {limit} MB. Reduce the scene in SuperSplat (or splat-transform) and export it again.';

const BAD_SPZ: MeshRefusal = { reason: 'bad-splat', key: MESH_BAD_SPZ_KEY };
const BAD_PLY: MeshRefusal = { reason: 'bad-splat', key: MESH_BAD_PLY_KEY };
const BAD_KSPLAT: MeshRefusal = { reason: 'bad-splat', key: MESH_BAD_KSPLAT_KEY };
/** Its own sentence, the generic reason: nothing downstream acts on WHY a .ply is unreadable. */
const PLY_ASCII: MeshRefusal = { reason: 'bad-splat', key: MESH_PLY_ASCII_KEY };

/** A fresh refusal object per answer, so one caller cannot edit another's. */
function refuse(r: MeshRefusal): { refusal: MeshRefusal } {
  return { refusal: { ...r } };
}

/**
 * Sniff a splat file's bytes. Synchronous, bounded (a `.ply` reads at most
 * PLY_HEADER_SCAN_BYTES + 1 — the header's last line ending may sit just past
 * the window — and compares the rest by length; a `.ksplat` walks at most one 1 KiB section header per
 * KiB of file) and never throws: anything unexpected is that kind's bad-file
 * refusal. The byte cap (MESH_MAX_BYTES) and the empty-file refusal are the
 * caller's (`checkMeshBytes`); an empty file here is simply not a valid one.
 */
export function sniffSplat(kind: SplatKind, bytes: Uint8Array): SplatSniffResult {
  try {
    if (!(bytes instanceof Uint8Array)) return refuse(badKeyFor(kind));
    switch (kind) {
      case 'splat': return sniffDotSplat(bytes);
      case 'spz': return sniffSpz(bytes);
      case 'ply': return sniffPly(bytes);
      case 'ksplat': return sniffKsplat(bytes);
      default: return refuse(badKeyFor(kind));
    }
  } catch {
    // A detached buffer, a hostile subclass — whatever it was, it is not a file we read.
    return refuse(badKeyFor(kind));
  }
}

function badKeyFor(kind: unknown): MeshRefusal {
  if (kind === 'spz') return BAD_SPZ;
  if (kind === 'ply') return BAD_PLY;
  if (kind === 'ksplat') return BAD_KSPLAT;
  return { reason: 'bad-splat', key: MESH_BAD_SPLAT_KEY };
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/* ── .splat: headerless 32-byte rows ─────────────────────────────────────── */

function sniffDotSplat(bytes: Uint8Array): SplatSniffResult {
  if (bytes.length === 0) return refuse(badKeyFor('splat'));
  const r = splatSizeRefusal(bytes.length);
  if (r) return { refusal: r };
  return { facts: { count: bytes.length / SPLAT_ROW_BYTES, shDegree: 0, container: 'splat' } };
}

/* ── .spz: gzip (v1–3) or a raw NGSP header (v4, zstd) ───────────────────── */

/** gzip header (10) + CRC32 and ISIZE trailer (8): nothing shorter can inflate. */
const GZIP_MIN_BYTES = 18;
/** The raw SPZ header (magic, version, count, degree, fractional bits, flags, reserved). */
const SPZ_HEADER_BYTES = 16;

function sniffSpz(bytes: Uint8Array): SplatSniffResult {
  const n = bytes.length;
  if (n >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    // CM must be 8 (deflate) — the only method DecompressionStream('gzip') inflates.
    if (n < GZIP_MIN_BYTES || bytes[2] !== 8) return refuse(BAD_SPZ);
    // ISIZE: the uncompressed length mod 2^32, as the writer CLAIMS it. A lie is
    // caught by the sandbox's streamed byte counter; this only refuses early
    // what an honest file already says is too large (or too small to hold the
    // 16-byte SPZ header at all).
    const isize = viewOf(bytes).getUint32(n - 4, true);
    if (isize > SPZ_MAX_DECODED_BYTES) {
      return refuse({ reason: 'too-large', key: MESH_SPZ_TOO_LARGE_KEY, sizeBytes: isize, limitBytes: SPZ_MAX_DECODED_BYTES });
    }
    if (isize < SPZ_HEADER_BYTES) return refuse(BAD_SPZ);
    return { facts: { count: null, shDegree: null, container: 'spz-gzip' } };
  }
  if (n >= 8) {
    const view = viewOf(bytes);
    if (view.getUint32(0, true) === SPZ_MAGIC) {
      const version = view.getUint32(4, true);
      // Version 4 is zstd: its decoder fetches a data: URL the production CSP
      // blocks. Every other version under a raw header is a file SPZLoader throws on.
      if (version === 4) return refuse({ reason: 'spz-version', key: MESH_SPZ_VERSION_KEY, version });
      return refuse(BAD_SPZ);
    }
  }
  return refuse(BAD_SPZ);
}

/* ── .ply: the 3DGS property set, read from the ASCII header ─────────────── */

/** Property names a 3DGS `.ply` must declare — GaussianSplatPLYLoader's REQUIRED_PLY_PROPERTIES. */
const PLY_REQUIRED_PROPERTIES = [
  'x', 'y', 'z',
  'scale_0', 'scale_1', 'scale_2',
  'rot_0', 'rot_1', 'rot_2', 'rot_3',
  'f_dc_0', 'f_dc_1', 'f_dc_2',
  'opacity',
] as const;

/*
 * THE ONE PLY HEADER RULE SET. This function, the runtime's `sniffPlyHeader`
 * (a-frame-shaderloader/build/entry-splat.js) and podest's `sniffPlyHeader`
 * twin (public/podest.html) apply the SAME rules in the SAME order, so a file
 * is accepted by all three or refused by all three — fsSplatBundle.test.ts and
 * podestSplat.test.ts run both copies over SPLAT_SNIFF_CASES (test-utils).
 *
 *  1. `ply` first; the header ends at the first LINE that is exactly
 *     `end_header`, within PLY_HEADER_SCAN_BYTES (its line ending may be the one
 *     byte after the window). PLYLoader.extractHeaderText decides it that way:
 *         const c = String.fromCharCode( bytes[ i ++ ] );
 *         if ( c !== '\n' && c !== '\r' ) { line += c; } else {
 *             if ( line === 'end_header' ) cont = false;
 *         ...
 *         if ( hasCRNL === true ) i ++;      // hasCRNL = /^ply\r\n/.test( first 5 bytes )
 *     — every CR and LF ends a line, the line is compared UNTRIMMED, and the
 *     body starts after its terminator, one byte later still when the FILE's
 *     first line ends in CRLF. GaussianSplatPLYLoader instead reads the header
 *     up to the first `end_header` SUBSTRING, so the first one must BE that
 *     line (a `comment x-end_header` is refused): otherwise the two loaders
 *     read different headers (RT-2).
 *  2. Exactly one `format` line, `ascii` / `binary_little_endian` /
 *     `binary_big_endian`; every `property` line is `property <type> <name>`
 *     with a known PLY scalar type (or a list, rule 4); `format`, `element` and
 *     `property` lines are ASCII (GaussianSplatPLYLoader decodes them as UTF-8,
 *     PLYLoader byte by byte — a 0xA0 separates words for one only).
 *     Anything else here is a damaged header ('bad-splat').
 *  3. An `element chunk` is SuperSplat's compressed form ('ply-compressed') —
 *     before rule 4, which would call it "not a splat".
 *  4. Exactly ONE element, `vertex`, with no list property and no property
 *     before it ('ply-not-splat'). PLYLoader walks EVERY element's declared
 *     count and a property-less row reads 0 bytes, so a second element was a
 *     loop no cap bounded (RT-1); 3DGS training, SuperSplat and splat-transform
 *     write one element.
 *  5. The 3DGS property set ('ply-not-splat'); no `f_rest_N` ('ply-sh').
 *  6. Stored binary: ASCII has its own sentence, after the two above that name
 *     a more useful fix.
 *  7. The count is 1–10 digits (the runtime's rule), > 0, ≤ SPLAT_MAX_COUNT.
 *  8. The body holds count × row bytes (trailing bytes are fine) — measured by
 *     LENGTH only; the body is never read.
 */

/** A spherical-harmonic band component, as GaussianSplatPLYLoader matches it. */
const PLY_REST = /^f_rest_\d+$/;
const END_HEADER = 'end_header';
const CR = 0x0d;
const LF = 0x0a;

/** A PLY scalar type's size in bytes (PLYLoader's getBinaryReader table), 0 when unknown. */
function plyTypeBytes(type: string): number {
  switch (type) {
    case 'char': case 'int8': case 'uchar': case 'uint8': return 1;
    case 'short': case 'int16': case 'ushort': case 'uint16': return 2;
    case 'int': case 'int32': case 'uint': case 'uint32': case 'float': case 'float32': return 4;
    case 'double': case 'float64': return 8;
    default: return 0;
  }
}

/**
 * The offset of the line ending after the header's `end_header` line, or -1:
 * the first `end_header` within the scan window must be a whole line (rule 1).
 */
function plyHeaderEnd(bytes: Uint8Array): number {
  const last = Math.min(bytes.length, PLY_HEADER_SCAN_BYTES) - END_HEADER.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < END_HEADER.length; j++) {
      if (bytes[i + j] !== END_HEADER.charCodeAt(j)) continue outer;
    }
    const before = bytes[i - 1];
    const after = bytes[i + END_HEADER.length];
    return (before === CR || before === LF) && (after === CR || after === LF) ? i + END_HEADER.length : -1;
  }
  return -1;
}

interface PlyElement {
  name: string;
  count: string;
  names: string[];
  rowBytes: number;
}

function sniffPly(bytes: Uint8Array): SplatSniffResult {
  // 'ply' first — both loaders anchor their header pattern there.
  if (bytes.length < 3 || bytes[0] !== 0x70 || bytes[1] !== 0x6c || bytes[2] !== 0x79) return refuse(BAD_PLY);
  const end = plyHeaderEnd(bytes);
  if (end < 0) return refuse(BAD_PLY);
  // Bytes, not UTF-8 (PLYLoader's own decoding): a stray high byte stays one character.
  let text = '';
  for (let i = 3; i < end - END_HEADER.length; i++) text += String.fromCharCode(bytes[i]);

  let formats = 0;
  let format = '';
  let damaged = false;
  let orphan = false;
  let list = false;
  const elements: PlyElement[] = [];
  let current: PlyElement | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const words = line.split(/\s+/);
    const keyword = words[0];
    // comment, obj_info and anything else PLYLoader skips carry no rule.
    if (keyword !== 'format' && keyword !== 'element' && keyword !== 'property') continue;
    if (/[^\x00-\x7f]/.test(raw)) damaged = true;
    if (keyword === 'format') {
      formats++;
      format = words[1] ?? '';
    } else if (keyword === 'element') {
      current = { name: words[1] ?? '', count: words[2] ?? '', names: [], rowBytes: 0 };
      elements.push(current);
    } else {
      if (current === null) orphan = true;
      if (words[1] === 'list') list = true;
      else if (words.length !== 3 || plyTypeBytes(words[1]) === 0) damaged = true;
      else if (current !== null) {
        current.names.push(words[2]);
        current.rowBytes += plyTypeBytes(words[1]);
      }
    }
  }

  const container: SplatContainer | null =
    format === 'ascii' ? 'ply-ascii'
      : format === 'binary_little_endian' ? 'ply-binary-le'
        : format === 'binary_big_endian' ? 'ply-binary-be'
          : null;
  if (formats !== 1 || container === null || damaged) return refuse(BAD_PLY);
  if (elements.some((e) => e.name === 'chunk')) return refuse({ reason: 'ply-compressed', key: MESH_PLY_COMPRESSED_KEY });
  const vertex = elements.length === 1 && elements[0].name === 'vertex' && !orphan && !list ? elements[0] : null;
  if (vertex === null || PLY_REQUIRED_PROPERTIES.some((name) => !vertex.names.includes(name))) {
    return refuse({ reason: 'ply-not-splat', key: MESH_PLY_NOT_SPLAT_KEY });
  }
  if (vertex.names.some((name) => PLY_REST.test(name))) return refuse({ reason: 'ply-sh', key: MESH_PLY_SH_KEY });
  if (container === 'ply-ascii') return refuse(PLY_ASCII);
  if (!/^\d{1,10}$/.test(vertex.count)) return refuse(BAD_PLY);
  const count = Number(vertex.count);
  if (count === 0) return refuse(BAD_PLY);
  if (count > SPLAT_MAX_COUNT) return { refusal: splatCountRefusal(count) };
  const bodyStart = end + 1 + (bytes[3] === CR && bytes[4] === LF ? 1 : 0);
  if (count * vertex.rowBytes > bytes.length - bodyStart) {
    return refuse({ reason: 'bad-splat', key: MESH_PLY_TRUNCATED_KEY, count });
  }
  return { facts: { count, shDegree: 0, container } };
}

/* ── .ksplat: GaussianSplats3D's sectioned container ─────────────────────── */

/** Each section header, after the main header. */
const KSPLAT_SECTION_HEADER_BYTES = 1024;
/** f_rest components per SH degree (KSPLATLoader's SH_DEGREE_TO_COMPONENTS). */
const KSPLAT_SH_COMPONENTS = [0, 9, 24, 45] as const;
/** Bytes per splat before SH, and per SH component, per compression level. */
const KSPLAT_LEVELS: readonly { base: number; sh: number }[] = [
  { base: 12 + 12 + 16 + 4, sh: 4 },
  { base: 6 + 6 + 8 + 4, sh: 2 },
  { base: 6 + 6 + 8 + 4, sh: 1 },
];

function sniffKsplat(bytes: Uint8Array): SplatSniffResult {
  const n = bytes.length;
  if (n < KSPLAT_HEADER_BYTES) return refuse(BAD_KSPLAT);
  const view = viewOf(bytes);
  // Main header — KSPLATLoader parseHeader(): u8 major @0, u8 minor @1,
  // u32 maxSectionCount @4, u32 splatCount @16, u16 compressionLevel @20.
  const major = view.getUint8(0);
  const minor = view.getUint8(1);
  if (major !== 0 || minor < 1) return refuse(BAD_KSPLAT);
  const level = KSPLAT_LEVELS[view.getUint16(20, true)];
  if (level === undefined) return refuse(BAD_KSPLAT);
  const splatCount = view.getUint32(16, true);
  if (splatCount > SPLAT_MAX_COUNT) return { refusal: splatCountRefusal(splatCount) };
  if (splatCount === 0) return refuse(BAD_KSPLAT);
  const maxSections = view.getUint32(4, true);
  let base = KSPLAT_HEADER_BYTES + maxSections * KSPLAT_SECTION_HEADER_BYTES;
  // This bound is also what bounds the walk: at most one section per KiB of file.
  if (base > n) return refuse(BAD_KSPLAT);

  let seen = 0;
  let shDegree = 0;
  for (let s = 0; s < maxSections; s++) {
    // Section header — parseSectionHeader(): u32 splatCount @0, u32 maxSplatCount @4,
    // u32 bucketCount @12, u16 bucketStorageSizeBytes @20,
    // u32 partiallyFilledBucketCount @36, u16 sphericalHarmonicsDegree @40.
    const at = KSPLAT_HEADER_BYTES + s * KSPLAT_SECTION_HEADER_BYTES;
    const sectionSplats = view.getUint32(at, true);
    const sectionMax = view.getUint32(at + 4, true);
    const bucketCount = view.getUint32(at + 12, true);
    const bucketBytes = view.getUint16(at + 20, true);
    const partialBuckets = view.getUint32(at + 36, true);
    const degree = view.getUint16(at + 40, true);
    const components = KSPLAT_SH_COMPONENTS[degree];
    if (components === undefined) return refuse(BAD_KSPLAT);
    const bytesPerSplat = level.base + components * level.sh;
    // Every term is < 2^48, so the sum stays an exact integer; `base` never
    // exceeds the file length, because a section that would is refused.
    const storage = bucketBytes * bucketCount + partialBuckets * 4 + bytesPerSplat * sectionMax;
    if (base + storage > n) return refuse(BAD_KSPLAT);
    if (sectionSplats > 0) {
      seen += sectionSplats;
      if (degree > shDegree) shDegree = degree;
    }
    base += storage;
  }
  if (seen !== splatCount) return refuse(BAD_KSPLAT);
  return { facts: { count: splatCount, shDegree, container: 'ksplat' } };
}
