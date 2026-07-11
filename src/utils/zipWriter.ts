/**
 * Minimal ZIP writer — STORE method only (no compression), no dependencies.
 *
 * Used by the shader export: when the graph embeds images, "Download Shader"
 * packages the self-contained `.js` module together with the image files.
 * STORE is deliberate: the payloads are already-compressed WebP/PNG/JPEG
 * (deflate would gain nothing) and method 0 is readable by every unzip tool,
 * including podest.html's DecompressionStream-based reader.
 *
 * Pure and deterministic (fixed DOS timestamp) so it runs identically on the
 * host and in node-environment tests.
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive (e.g. `images/cat.webp`). */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE 802.3), as required by the ZIP format. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed DOS date/time (2020-01-01 00:00) — deterministic output beats a real
// mtime here (Date.now inside export paths makes byte-identical snapshots and
// tests impossible; nothing consumes the timestamp).
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/** Build a ZIP archive (all entries stored uncompressed). The return type is
 *  pinned to a plain-ArrayBuffer view so it satisfies `BlobPart` directly. */
export function buildZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const files = entries.map((e) => ({
    nameBytes: enc.encode(e.name),
    data: e.data,
    crc: crc32(e.data),
    offset: 0,
  }));

  const localSize = files.reduce((s, f) => s + 30 + f.nameBytes.length + f.data.length, 0);
  const centralSize = files.reduce((s, f) => s + 46 + f.nameBytes.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const dv = new DataView(out.buffer);
  let p = 0;

  // Local file headers + data.
  for (const f of files) {
    f.offset = p;
    dv.setUint32(p, 0x04034b50, true);            // local header signature
    dv.setUint16(p + 4, 20, true);                // version needed
    dv.setUint16(p + 6, 0x0800, true);            // flags: UTF-8 names
    dv.setUint16(p + 8, 0, true);                 // method 0 = store
    dv.setUint16(p + 10, DOS_TIME, true);
    dv.setUint16(p + 12, DOS_DATE, true);
    dv.setUint32(p + 14, f.crc, true);
    dv.setUint32(p + 18, f.data.length, true);    // compressed size (= raw)
    dv.setUint32(p + 22, f.data.length, true);    // uncompressed size
    dv.setUint16(p + 26, f.nameBytes.length, true);
    dv.setUint16(p + 28, 0, true);                // extra length
    out.set(f.nameBytes, p + 30);
    out.set(f.data, p + 30 + f.nameBytes.length);
    p += 30 + f.nameBytes.length + f.data.length;
  }

  // Central directory.
  const cdStart = p;
  for (const f of files) {
    dv.setUint32(p, 0x02014b50, true);            // central header signature
    dv.setUint16(p + 4, 20, true);                // version made by
    dv.setUint16(p + 6, 20, true);                // version needed
    dv.setUint16(p + 8, 0x0800, true);            // flags: UTF-8 names
    dv.setUint16(p + 10, 0, true);                // method 0
    dv.setUint16(p + 12, DOS_TIME, true);
    dv.setUint16(p + 14, DOS_DATE, true);
    dv.setUint32(p + 16, f.crc, true);
    dv.setUint32(p + 20, f.data.length, true);
    dv.setUint32(p + 24, f.data.length, true);
    dv.setUint16(p + 28, f.nameBytes.length, true);
    // extra len, comment len, disk start, internal attrs = 0
    dv.setUint32(p + 38, 0, true);                // external attrs
    dv.setUint32(p + 42, f.offset, true);         // local header offset
    out.set(f.nameBytes, p + 46);
    p += 46 + f.nameBytes.length;
  }

  // End of central directory.
  dv.setUint32(p, 0x06054b50, true);
  dv.setUint16(p + 8, files.length, true);        // entries on this disk
  dv.setUint16(p + 10, files.length, true);       // entries total
  dv.setUint32(p + 12, p - cdStart, true);        // central directory size
  dv.setUint32(p + 16, cdStart, true);            // central directory offset
  return out;
}
