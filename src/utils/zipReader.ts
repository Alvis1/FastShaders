/**
 * Minimal ZIP reader — the import-side counterpart of `zipWriter.ts`.
 *
 * Reads STORE (method 0) and DEFLATE (method 8) entries, so it accepts both
 * our own exports and archives re-zipped by OS tools (Finder/Explorer emit
 * deflate). Everything is driven by the CENTRAL directory — sizes and CRCs
 * there are always final, which sidesteps streamed zips whose local headers
 * defer sizes to data descriptors. Deflate uses the native
 * `DecompressionStream('deflate-raw')` — no dependency (same approach as
 * podest.html's reader), at the cost of a browser floor of Safari 16.4 /
 * Firefox 113 for DEFLATE entries only; see `inflateRaw`.
 *
 * Treat archives as ADVERSARIAL input: every offset is bounds-checked, the
 * entry count is capped, and — critically — each entry is inflated
 * SEQUENTIALLY against a running budget of ACTUAL output bytes (read in
 * chunks, aborted the moment the cumulative total exceeds the cap). Declared
 * central-directory sizes are attacker-controlled, so they are only a cheap
 * early-reject; the real guard is the streamed byte counter. This defeats
 * deflate bombs that declare tiny sizes but inflate to gigabytes.
 *
 * Crossing a CAP throws a typed `ZipLimitError` {kind, limit, value} — a
 * precise, user-actionable refusal that `importShaderZip` rethrows and every
 * import surface announces (LimitModal's `zip-limit` notice). Corruption stays
 * a plain Error, which callers still report as "no shader".
 *
 * The SUM cap is 96 MiB = `MESH_MAX_BYTES` (64 MiB) + 32 MiB, because the
 * reader must open anything the writer emits: an image rides an export three
 * times (the inlined module, the project block and `images/`), so a bundle at
 * the soft image caps carrying a model at its cap is ~72 MiB, and the old
 * 64 MiB refused the app's own exports.
 */

export interface ZipReadEntry {
  name: string;
  data: Uint8Array;
}

export type ZipLimitKind = 'total-size' | 'entry-count' | 'name' | 'method';

/**
 * A reader CAP was crossed — unlike a corrupt archive, this is something the
 * user can act on. Units of `limit`/`value`:
 *   - total-size: bytes (`value` is a LOWER bound on the unpacked size, or the
 *     archive's own size for a caller's pre-read gate);
 *   - entry-count: central-directory entries, folder entries included;
 *   - name: bytes of the central-directory name;
 *   - method: the highest method this reader handles (8) vs the archive's.
 * The English message is for the console; notices are built from the fields.
 */
export class ZipLimitError extends Error {
  readonly kind: ZipLimitKind;
  readonly limit: number;
  readonly value: number;
  constructor(kind: ZipLimitKind, limit: number, value: number, message: string) {
    super(message);
    this.name = 'ZipLimitError';
    this.kind = kind;
    this.limit = limit;
    this.value = value;
  }
}

/** Name-based as well as `instanceof`: the suite runs `isolate: false` and one
 *  file resets modules, so a second instance of this class is possible. */
export function isZipLimitError(e: unknown): e is ZipLimitError {
  if (e instanceof ZipLimitError) return true;
  if (!(e instanceof Error) || e.name !== 'ZipLimitError') return false;
  const k = (e as { kind?: unknown }).kind;
  return (k === 'total-size' || k === 'entry-count' || k === 'name' || k === 'method')
    && Number.isFinite((e as { limit?: unknown }).limit)
    && Number.isFinite((e as { value?: unknown }).value);
}

export const MAX_ENTRIES = 512;
// 96 MiB = MESH_MAX_BYTES (64 MiB) + 32 MiB headroom for the .js (which
// re-embeds every image twice), images/ and README — so the largest bundle the
// app itself writes re-opens. A LITERAL on purpose: this module imports
// nothing, and zipReader.test.ts's podest drift guard evaluates the expression
// on its own. podest.html carries the same number.
export const MAX_TOTAL_UNCOMPRESSED = 96 * 1024 * 1024;
export const MAX_NAME_LENGTH = 512;
/** The largest ARCHIVE worth reading at all: content at the cap plus every
 *  header a legal archive can carry (512 × (30 + 46 + 2 × 512) + 22 ≈ 0.54 MiB)
 *  with generous slack for extras, comments and deflate framing. A caller
 *  holding a File checks this BEFORE `arrayBuffer()`, so a gigabyte drop is
 *  refused without being allocated. The deflate-bomb defence is still the
 *  streamed counter below, not this number. */
export const MAX_ARCHIVE_BYTES = MAX_TOTAL_UNCOMPRESSED + 8 * 1024 * 1024;

/** The desktop room's reader cap (GLB Phase 6): anything a desktop project
 *  exports reopens there (6M-char images and a 32M project ride a bundle about
 *  three times, beside a 64 MiB model — platformCaps.test.ts proves the sum
 *  fits). Desktop-only: the web keeps `MAX_TOTAL_UNCOMPRESSED`, which podest
 *  shares, and podest keeps it inside the desktop app too. */
export const DESKTOP_MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024;
/** What THIS build's reader applies: the web cap, or the desktop room's. The
 *  define is guarded with `typeof` because this leaf is also run in bare node
 *  (the research doc's probe recipe), where an undefined identifier would
 *  throw; Vite still replaces it, so the build output is unchanged. */
export const READ_MAX_TOTAL_UNCOMPRESSED =
  typeof __FS_DESKTOP__ !== 'undefined' && __FS_DESKTOP__
    ? DESKTOP_MAX_TOTAL_UNCOMPRESSED
    : MAX_TOTAL_UNCOMPRESSED;
/** The pre-read gate for THIS build (`MAX_ARCHIVE_BYTES`'s rule over
 *  `READ_MAX_TOTAL_UNCOMPRESSED`). */
export const READ_MAX_ARCHIVE_BYTES = READ_MAX_TOTAL_UNCOMPRESSED + 8 * 1024 * 1024;

/** Locate the End-Of-Central-Directory record (scans back over a possible
 *  archive comment, up to the spec's 64KB maximum). */
function findEocd(dv: DataView): number {
  const min = Math.max(0, dv.byteLength - 22 - 0xffff);
  for (let p = dv.byteLength - 22; p >= min; p--) {
    if (dv.getUint32(p, true) === 0x06054b50) return p;
  }
  return -1;
}

/** Inflate a deflate-raw stream, aborting as soon as the OUTPUT exceeds
 *  `maxBytes`. Reads chunk-by-chunk instead of `Response.arrayBuffer()` so a
 *  bomb can't fully materialize before the size is known. `spent` is what the
 *  earlier entries already inflated and `limit` the archive-wide cap applied —
 *  both only so the refusal can report a total against the right cap. */
async function inflateRaw(
  comp: Uint8Array,
  maxBytes: number,
  spent: number,
  limit: number,
): Promise<Uint8Array> {
  // The dependency-free deflate path has a browser floor the rest of the app
  // does not: `DecompressionStream` is Safari 16.4 / Firefox 113. Below it this
  // constructor throws a bare `ReferenceError`, which says nothing about what
  // the user actually did — and the split is invisible from our own artefacts,
  // because `zipWriter` is STORE-only, so a FastShaders export imports fine and
  // only an archive re-zipped by Finder or Explorer (which emit deflate) trips
  // it. Name the cause instead. NB `importShaderZip` rethrows only
  // ZipLimitError and maps everything else to its caller's "no shader"
  // message, so this text is for the console; it is deliberately NOT a
  // ZipLimitError (it is no cap, and the app's browser floor makes it
  // unreachable). podest.html's reader is a separate hand-minified copy with
  // the same floor.
  if (typeof DecompressionStream === 'undefined') {
    throw new Error(
      'this browser cannot read compressed archives (needs Safari 16.4+ / Firefox 113+) — ' +
      're-export the shader from FastShaders, which writes uncompressed zips',
    );
  }
  const ds = new DecompressionStream('deflate-raw');
  const blob = new Blob([comp as Uint8Array<ArrayBuffer>]);
  const reader = blob.stream().pipeThrough(ds).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ZipLimitError('total-size', limit, spent + total, 'archive too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Parse a ZIP archive into its file entries (directories skipped). Throws on
 *  anything malformed, unsupported, or over the safety caps. `maxTotal` is the
 *  SUM cap, THIS build's by default (web 96 MiB, desktop 256 MiB); every
 *  `total-size` refusal reports the cap actually applied. */
export async function readZip(
  zip: Uint8Array,
  maxTotal: number = READ_MAX_TOTAL_UNCOMPRESSED,
): Promise<ZipReadEntry[]> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEocd(dv);
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory)');

  const count = dv.getUint16(eocd + 10, true);
  if (count > MAX_ENTRIES) {
    throw new ZipLimitError('entry-count', MAX_ENTRIES, count, `too many entries (${count})`);
  }
  let p = dv.getUint32(eocd + 16, true);

  // First pass: parse and bounds-check every central-directory record into a
  // descriptor. No inflation here, so this stays cheap and can't balloon.
  const descriptors: { name: string; method: number; comp: Uint8Array }[] = [];
  let totalDeclared = 0;
  const dec = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || dv.getUint32(p, true) !== 0x02014b50) {
      throw new Error('corrupt central directory');
    }
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const rawSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    if (nameLen > MAX_NAME_LENGTH) {
      throw new ZipLimitError('name', MAX_NAME_LENGTH, nameLen, 'entry name too long');
    }
    if (p + 46 + nameLen > zip.length) throw new Error('corrupt central directory');
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory marker

    // Cheap early-reject on the DECLARED size — attacker-controlled, so it is
    // only a fast path; the authoritative guard is the streamed byte budget
    // enforced during inflation below.
    totalDeclared += rawSize;
    if (totalDeclared > maxTotal) {
      throw new ZipLimitError('total-size', maxTotal, totalDeclared, 'archive too large');
    }

    // The local header's own name/extra lengths locate the data (its extra
    // field can differ from the central one).
    if (localOff + 30 > zip.length || dv.getUint32(localOff, true) !== 0x04034b50) {
      throw new Error('corrupt local header');
    }
    const localNameLen = dv.getUint16(localOff + 26, true);
    const localExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > zip.length) throw new Error('entry overruns archive');
    const comp = zip.subarray(dataStart, dataStart + compSize);

    if (method !== 0 && method !== 8) {
      throw new ZipLimitError('method', 8, method, `unsupported compression method ${method} for "${name}"`);
    }
    descriptors.push({ name, method, comp });
  }

  // Second pass: inflate SEQUENTIALLY, charging each entry's ACTUAL output
  // against a shared remaining budget so cumulative decompression is bounded
  // regardless of what the central directory declared.
  const entries: ZipReadEntry[] = [];
  let remaining = maxTotal;
  for (const d of descriptors) {
    let data: Uint8Array;
    if (d.method === 0) {
      if (d.comp.length > remaining) {
        throw new ZipLimitError(
          'total-size', maxTotal,
          maxTotal - remaining + d.comp.length, 'archive too large',
        );
      }
      data = d.comp.slice();
    } else {
      data = await inflateRaw(d.comp, remaining, maxTotal - remaining, maxTotal);
    }
    remaining -= data.length;
    entries.push({ name: d.name, data });
  }

  return entries;
}
