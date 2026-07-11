/**
 * Minimal ZIP reader — the import-side counterpart of `zipWriter.ts`.
 *
 * Reads STORE (method 0) and DEFLATE (method 8) entries, so it accepts both
 * our own exports and archives re-zipped by OS tools (Finder/Explorer emit
 * deflate). Everything is driven by the CENTRAL directory — sizes and CRCs
 * there are always final, which sidesteps streamed zips whose local headers
 * defer sizes to data descriptors. Deflate uses the native
 * `DecompressionStream('deflate-raw')` — no dependency (same approach as
 * podest.html's reader).
 *
 * Treat archives as ADVERSARIAL input: every offset is bounds-checked, the
 * entry count is capped, and — critically — each entry is inflated
 * SEQUENTIALLY against a running budget of ACTUAL output bytes (read in
 * chunks, aborted the moment the cumulative total exceeds the cap). Declared
 * central-directory sizes are attacker-controlled, so they are only a cheap
 * early-reject; the real guard is the streamed byte counter. This defeats
 * deflate bombs that declare tiny sizes but inflate to gigabytes.
 */

export interface ZipReadEntry {
  name: string;
  data: Uint8Array;
}

const MAX_ENTRIES = 512;
const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024; // 64 MB across all entries
const MAX_NAME_LENGTH = 512;

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
 *  bomb can't fully materialize before the size is known. */
async function inflateRaw(comp: Uint8Array, maxBytes: number): Promise<Uint8Array> {
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
      throw new Error('archive too large');
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
 *  anything malformed, unsupported, or over the safety caps. */
export async function readZip(zip: Uint8Array): Promise<ZipReadEntry[]> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = findEocd(dv);
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory)');

  const count = dv.getUint16(eocd + 10, true);
  if (count > MAX_ENTRIES) throw new Error(`too many entries (${count})`);
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
    if (nameLen > MAX_NAME_LENGTH) throw new Error('entry name too long');
    if (p + 46 + nameLen > zip.length) throw new Error('corrupt central directory');
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory marker

    // Cheap early-reject on the DECLARED size — attacker-controlled, so it is
    // only a fast path; the authoritative guard is the streamed byte budget
    // enforced during inflation below.
    totalDeclared += rawSize;
    if (totalDeclared > MAX_TOTAL_UNCOMPRESSED) throw new Error('archive too large');

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
      throw new Error(`unsupported compression method ${method} for "${name}"`);
    }
    descriptors.push({ name, method, comp });
  }

  // Second pass: inflate SEQUENTIALLY, charging each entry's ACTUAL output
  // against a shared remaining budget so cumulative decompression is bounded
  // regardless of what the central directory declared.
  const entries: ZipReadEntry[] = [];
  let remaining = MAX_TOTAL_UNCOMPRESSED;
  for (const d of descriptors) {
    let data: Uint8Array;
    if (d.method === 0) {
      if (d.comp.length > remaining) throw new Error('archive too large');
      data = d.comp.slice();
    } else {
      data = await inflateRaw(d.comp, remaining);
    }
    remaining -= data.length;
    entries.push({ name: d.name, data });
  }

  return entries;
}
