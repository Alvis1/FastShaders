/**
 * The trusted-side Gaussian-splat header sniff (`splatSniff.ts`) and the caps
 * leaf it reads (`splatLimits.ts`). Every fixture is built from the byte
 * layouts three r186's loaders read (SPLATLoader, SPZLoader,
 * GaussianSplatPLYLoader, KSPLATLoader), so each rule is pinned at its edge:
 * one byte, one splat, one section either side. The builders live in
 * `src/test-utils.ts` (the ONE set), because podest's sniff twin
 * (`podestSplat.test.ts`) is run against the same bytes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sniffSplat,
  isSplatKind,
  SPLAT_KINDS,
  MESH_BAD_KSPLAT_KEY,
  MESH_BAD_PLY_KEY,
  MESH_BAD_SPZ_KEY,
  MESH_PLY_ASCII_KEY,
  MESH_PLY_COMPRESSED_KEY,
  MESH_PLY_NOT_SPLAT_KEY,
  MESH_PLY_SH_KEY,
  MESH_PLY_TRUNCATED_KEY,
  MESH_SPZ_TOO_LARGE_KEY,
  MESH_SPZ_VERSION_KEY,
  type SplatKind,
  type SplatSniffResult,
} from './splatSniff';
import { MESH_BAD_SPLAT_KEY, MESH_SPLAT_COUNT_KEY, splatCountRefusal } from './gltfCompression';
import { fillMeshRefusal } from './previewMesh';
import * as limits from './splatLimits';
import lv from '@/i18n/lv.json';
import {
  SPLAT_GS_PROPERTIES as GS_PROPERTIES,
  splatConcat as concat,
  splatAscii as ascii,
  splatFRest as fRest,
  splatKsplat as ksplat,
  splatPly as ply,
  SPLAT_PLY_BODY,
  splatRows,
  SPLAT_SNIFF_CASES,
  splatSpzGzip as spzGzip,
  splatSpzRaw as spzRaw,
  type KsplatOpts,
  type SplatPlyOpts as PlyOpts,
} from '@/test-utils';

const {
  SPLAT_ROW_BYTES,
  SPLAT_MAX_COUNT,
  SPLAT_HEADSET_ADVISORY_COUNT,
  SPZ_MAX_DECODED_BYTES,
  PLY_HEADER_SCAN_BYTES,
  KSPLAT_HEADER_BYTES,
  SPZ_MAGIC,
} = limits;

/* ── helpers ─────────────────────────────────────────────────────────────── */

function facts(r: SplatSniffResult) {
  if (!('facts' in r)) throw new Error(`expected facts, got ${r.refusal.reason}: ${r.refusal.key}`);
  return r.facts;
}

function refusal(r: SplatSniffResult) {
  if (!('refusal' in r)) throw new Error(`expected a refusal, got ${JSON.stringify(r.facts)}`);
  return r.refusal;
}

/* ── the limits leaf ─────────────────────────────────────────────────────── */

describe('splatLimits: the contract literals', () => {
  it('carries exactly the agreed values (the runtime LIMITS and podest mirror these)', () => {
    expect(SPLAT_ROW_BYTES).toBe(32);
    expect(SPLAT_MAX_COUNT).toBe(1_000_000);
    expect(SPLAT_HEADSET_ADVISORY_COUNT).toBe(250_000);
    expect(SPZ_MAX_DECODED_BYTES).toBe(96 * 1024 * 1024);
    expect(PLY_HEADER_SCAN_BYTES).toBe(64 * 1024);
    expect(KSPLAT_HEADER_BYTES).toBe(4096);
    expect(SPZ_MAGIC).toBe(0x5053474e);
    // 'NGSP' as it sits in a file.
    expect(new DataView(ascii('NGSP').buffer).getUint32(0, true)).toBe(SPZ_MAGIC);
    expect(Object.keys(limits).sort()).toEqual([
      'KSPLAT_HEADER_BYTES',
      'PLY_HEADER_SCAN_BYTES',
      'SPLAT_HEADSET_ADVISORY_COUNT',
      'SPLAT_MAX_COUNT',
      'SPLAT_ROW_BYTES',
      'SPZ_MAGIC',
      'SPZ_MAX_DECODED_BYTES',
    ]);
  });

  it('is a zero-import leaf', () => {
    const src = readFileSync(join(__dirname, 'splatLimits.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bimport\(/);
    expect(src).not.toMatch(/\brequire\(/);
  });

  it('the headset advisory sits under the hard cap', () => {
    expect(SPLAT_HEADSET_ADVISORY_COUNT).toBeLessThan(SPLAT_MAX_COUNT);
  });

  it('the literal "32" in the bad-.splat sentence is the row size', () => {
    expect(MESH_BAD_SPLAT_KEY).toContain(`${SPLAT_ROW_BYTES}-byte`);
  });
});

describe('splatSniff: kinds', () => {
  it('SPLAT_KINDS is the four splat extensions, and isSplatKind agrees exactly', () => {
    expect([...SPLAT_KINDS]).toEqual(['splat', 'spz', 'ply', 'ksplat']);
    for (const k of SPLAT_KINDS) expect(isSplatKind(k)).toBe(true);
    for (const k of ['obj', 'glb', 'gltf', 'SPLAT', 'Ply', '', null, undefined, 1, {}, 'constructor']) {
      expect(isSplatKind(k)).toBe(false);
    }
  });
});

/* ── .splat ──────────────────────────────────────────────────────────────── */

describe('splatSniff: .splat', () => {
  it('one 32-byte row is one splat, degree 0', () => {
    expect(facts(sniffSplat('splat', new Uint8Array(32)))).toEqual({ count: 1, shDegree: 0, container: 'splat' });
    expect(facts(sniffSplat('splat', new Uint8Array(32 * 7))).count).toBe(7);
    // The shared synthetic rows (test-utils) are what the browser checks drop.
    expect(facts(sniffSplat('splat', splatRows(100)))).toEqual({ count: 100, shDegree: 0, container: 'splat' });
  });

  it.each([1, 31, 33, 63, 32 * 5 + 1])('a length that is not whole rows is bad-splat: %i bytes', (n) => {
    expect(refusal(sniffSplat('splat', new Uint8Array(n)))).toEqual({ reason: 'bad-splat', key: MESH_BAD_SPLAT_KEY });
  });

  it('an empty file is not a valid one', () => {
    expect(refusal(sniffSplat('splat', new Uint8Array(0))).reason).toBe('bad-splat');
  });

  it('the count cap sits exactly at SPLAT_MAX_COUNT rows', () => {
    const over = new Uint8Array((SPLAT_MAX_COUNT + 1) * 32);
    expect(facts(sniffSplat('splat', over.subarray(0, SPLAT_MAX_COUNT * 32))).count).toBe(SPLAT_MAX_COUNT);
    expect(refusal(sniffSplat('splat', over))).toEqual({
      reason: 'splat-count',
      key: MESH_SPLAT_COUNT_KEY,
      count: SPLAT_MAX_COUNT + 1,
    });
  });
});

/* ── .ply ────────────────────────────────────────────────────────────────── */

describe('splatSniff: .ply', () => {
  it('reads a 3DGS binary header: count, degree 0, container', () => {
    expect(facts(sniffSplat('ply', ply()))).toEqual({ count: 3, shDegree: 0, container: 'ply-binary-le' });
  });

  it('records the binary PLY format the loader will read', () => {
    expect(facts(sniffSplat('ply', ply({ format: 'binary_little_endian' }))).container).toBe('ply-binary-le');
    expect(facts(sniffSplat('ply', ply({ format: 'binary_big_endian' }))).container).toBe('ply-binary-be');
  });

  it('refuses an ASCII .ply with its own sentence, as the sandboxed runtime refuses it', () => {
    // PLYLoader turns an ASCII body into one string per number; the runtime
    // (fs-splat-0.1.js sniffPlyHeader) throws "stored as text (format ascii)".
    // Refusing it here too means the user reads the localized pre-read
    // sentence, never the sandbox's model error.
    expect(refusal(sniffSplat('ply', ply({ format: 'ascii' })))).toEqual({ reason: 'bad-splat', key: MESH_PLY_ASCII_KEY });
    expect(refusal(sniffSplat('ply', ply({ format: 'ascii', eol: '\r\n' }))).key).toBe(MESH_PLY_ASCII_KEY);
    // A valid count is not what saves it: the format is.
    expect(refusal(sniffSplat('ply', ply({ format: 'ascii', count: SPLAT_MAX_COUNT, body: 0 }))).key).toBe(MESH_PLY_ASCII_KEY);
  });

  it('an ASCII .ply that is ALSO not a splat, or carries SH, gets the more useful sentence first (the runtime order)', () => {
    expect(refusal(sniffSplat('ply', ply({ format: 'ascii', properties: ['x', 'y', 'z'] }))).reason).toBe('ply-not-splat');
    expect(refusal(sniffSplat('ply', ply({ format: 'ascii', properties: [...GS_PROPERTIES, ...fRest(9)] }))).reason).toBe('ply-sh');
    // A damaged count on an ASCII file: the format is decided first.
    expect(refusal(sniffSplat('ply', ply({ format: 'ascii', count: 'many' }))).key).toBe(MESH_PLY_ASCII_KEY);
  });

  it('the ASCII sentence has a Latvian entry that differs, and names the fix', () => {
    const ui = (lv as { ui: Record<string, string> }).ui;
    expect(ui[MESH_PLY_ASCII_KEY]).toBeTruthy();
    expect(ui[MESH_PLY_ASCII_KEY]).not.toBe(MESH_PLY_ASCII_KEY);
    expect(ui[MESH_PLY_ASCII_KEY]).toContain('format ascii');
    expect(MESH_PLY_ASCII_KEY).toContain('binary .ply');
    const r = refusal(sniffSplat('ply', ply({ format: 'ascii' })));
    expect(fillMeshRefusal(r, ui[r.key], 'lv')).toBe(ui[MESH_PLY_ASCII_KEY]);
  });

  it('accepts CRLF and CR line endings, and the minimal property set without normals', () => {
    expect(facts(sniffSplat('ply', ply({ eol: '\r\n' }))).count).toBe(3);
    expect(facts(sniffSplat('ply', ply({ eol: '\r' }))).count).toBe(3);
    const minimal = GS_PROPERTIES.filter((p) => !p.startsWith('n'));
    expect(facts(sniffSplat('ply', ply({ properties: minimal }))).count).toBe(3);
  });

  it('ignores comments and obj_info, as the loader does', () => {
    const r = sniffSplat('ply', ply({
      before: ['comment property float f_rest_0', 'comment element chunk 9', 'obj_info trained 30000 steps'],
    }));
    expect(facts(r).count).toBe(3);
  });

  it.each<[string, PlyOpts]>([
    // PLYLoader walks EVERY element's declared count; a row of a property-less
    // element reads 0 bytes, so `element junk 99999999999999` was a loop of
    // 1e14 rows no cap bounded (RT-1) — and an EMPTY face element is refused
    // too: 3DGS training, SuperSplat and splat-transform write ONE element.
    ['an empty face element with a list property', { after: ['element face 0', 'property list uchar int vertex_indices'] }],
    ['a zero-property junk element', { after: ['element junk 99999999999999'] }],
    ['a zero-property junk element with a small count', { after: ['element junk 1'] }],
    ['a second, property-less vertex element', { after: ['element vertex 99999999999'] }],
    ['a list property on the vertex element', { after: ['property list uchar int vertex_indices'] }],
  ])('a splat .ply is exactly ONE element, vertex, with no list property: %s', (_why, o) => {
    expect(refusal(sniffSplat('ply', ply(o)))).toEqual({ reason: 'ply-not-splat', key: MESH_PLY_NOT_SPLAT_KEY });
  });

  it('a property before any element is not a splat (the loader would throw on it)', () => {
    const b = concat(
      ascii(['ply', 'format binary_little_endian 1.0', ...GS_PROPERTIES.map((p) => `property float ${p}`),
        'element vertex 3', 'end_header', ''].join('\n')),
      new Uint8Array(SPLAT_PLY_BODY),
    );
    expect(refusal(sniffSplat('ply', b))).toEqual({ reason: 'ply-not-splat', key: MESH_PLY_NOT_SPLAT_KEY });
  });

  it('the header ends at the first LINE that is exactly end_header, and the first end_header must be that line', () => {
    // PLYLoader's extractHeaderText ends the header at an exact, untrimmed
    // `end_header` line; GaussianSplatPLYLoader at the first SUBSTRING. A
    // substring anywhere earlier would make the two read different headers
    // (a `format ascii` after it reaching PLYLoader unseen — RT-2), so it is refused.
    for (const o of [
      { after: ['comment x-end_header', 'format ascii 1.0'] },
      { before: ['comment x-end_header'] },
      { after: ['obj_info end_header'] },
    ]) {
      expect(refusal(sniffSplat('ply', ply(o)))).toEqual({ reason: 'bad-splat', key: MESH_BAD_PLY_KEY });
    }
    const spaced = concat(
      ascii(new TextDecoder().decode(ply({ body: 0 })).replace('end_header\n', 'end_header \nend_header\n')),
      new Uint8Array(SPLAT_PLY_BODY),
    );
    expect(refusal(sniffSplat('ply', spaced)).key).toBe(MESH_BAD_PLY_KEY);
  });

  it.each<[string, PlyOpts]>([
    ['ascii then binary', { format: 'ascii', before: ['format binary_little_endian 1.0'] }],
    ['binary then ascii', { before: ['format ascii 1.0'] }],
    ['the same binary line twice', { before: ['format binary_little_endian 1.0'] }],
  ])('exactly ONE format line — two are refused whatever they say: %s', (_why, o) => {
    expect(refusal(sniffSplat('ply', ply(o)))).toEqual({ reason: 'bad-splat', key: MESH_BAD_PLY_KEY });
  });

  it.each<[string, PlyOpts]>([
    ['an unknown type', { after: ['property half extra'] }],
    ['a fourth word', { after: ['property float extra junk'] }],
    ['no name', { after: ['property float'] }],
    // GaussianSplatPLYLoader decodes the header as UTF-8, PLYLoader byte by byte:
    // a 0xA0 separates words for one and not the other.
    ['a no-break space', { properties: GS_PROPERTIES.map((p) => (p === 'x' ? ' x' : p)) }],
    ['a no-break space in the format line', { format: ' binary_little_endian' }],
  ])('every property is `property <known scalar type> <name>` in ASCII: %s', (_why, o) => {
    expect(refusal(sniffSplat('ply', ply(o)))).toEqual({ reason: 'bad-splat', key: MESH_BAD_PLY_KEY });
  });

  it('knows every PLY scalar type and its size, and sums the row from them', () => {
    const types: [string, number][] = [
      ['char', 1], ['int8', 1], ['uchar', 1], ['uint8', 1], ['short', 2], ['int16', 2], ['ushort', 2], ['uint16', 2],
      ['int', 4], ['int32', 4], ['uint', 4], ['uint32', 4], ['float', 4], ['float32', 4], ['double', 8], ['float64', 8],
    ];
    for (const [type, size] of types) {
      const row = 17 * 4 + size;
      const after = [`property ${type} extra`];
      expect(facts(sniffSplat('ply', ply({ after, body: 3 * row }))).count, type).toBe(3);
      expect(refusal(sniffSplat('ply', ply({ after, body: 3 * row - 1 }))).key, type).toBe(MESH_PLY_TRUNCATED_KEY);
    }
    expect(facts(sniffSplat('ply', ply({ type: 'double' }))).count).toBe(3);
    expect(refusal(sniffSplat('ply', ply({ type: 'double', body: SPLAT_PLY_BODY * 2 - 1 }))).key).toBe(MESH_PLY_TRUNCATED_KEY);
  });

  it('the body must hold every row the header declares; trailing bytes are fine', () => {
    expect(facts(sniffSplat('ply', ply({ body: SPLAT_PLY_BODY }))).count).toBe(3);
    expect(facts(sniffSplat('ply', ply({ body: SPLAT_PLY_BODY + 7 }))).count).toBe(3);
    for (const body of [SPLAT_PLY_BODY - 1, 16, 0]) {
      expect(refusal(sniffSplat('ply', ply({ body })))).toEqual({ reason: 'bad-splat', key: MESH_PLY_TRUNCATED_KEY, count: 3 });
    }
  });

  it('the body starts where PLYLoader starts it: one byte later when the FIRST line ends in CRLF', () => {
    // extractHeaderText: `if ( hasCRNL === true ) i ++;` with hasCRNL = /^ply\r\n/,
    // whatever ends the end_header line itself.
    const crlfMagic = (spare: number) => concat(ascii('ply\r\n'), ply({ body: SPLAT_PLY_BODY + spare }).subarray(4));
    expect(refusal(sniffSplat('ply', crlfMagic(0))).key).toBe(MESH_PLY_TRUNCATED_KEY);
    expect(facts(sniffSplat('ply', crlfMagic(1))).count).toBe(3);
    // All-CRLF: the skipped byte is the LF of end_header's own CRLF.
    expect(facts(sniffSplat('ply', ply({ eol: '\r\n' }))).count).toBe(3);
    expect(refusal(sniffSplat('ply', ply({ eol: '\r\n', body: SPLAT_PLY_BODY - 1 }))).key).toBe(MESH_PLY_TRUNCATED_KEY);
  });

  it('the truncated-body sentence has a Latvian entry that differs, with the same placeholder', () => {
    const ui = (lv as { ui: Record<string, string> }).ui;
    expect(ui[MESH_PLY_TRUNCATED_KEY]).toBeTruthy();
    expect(ui[MESH_PLY_TRUNCATED_KEY]).not.toBe(MESH_PLY_TRUNCATED_KEY);
    expect(MESH_PLY_TRUNCATED_KEY).toContain('{count}');
    expect(ui[MESH_PLY_TRUNCATED_KEY]).toContain('{count}');
    const r = refusal(sniffSplat('ply', ply({ count: 1234, body: 0 })));
    expect(fillMeshRefusal(r, r.key, 'en')).toContain('1,234');
    expect(fillMeshRefusal(r, ui[r.key], 'lv')).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('a stray high byte in a comment is one character, not a parse failure', () => {
    const bytes = ply({ before: ['comment ÿÿ scanned by a camera'] });
    expect(facts(sniffSplat('ply', bytes)).count).toBe(3);
  });

  it.each<[string, PlyOpts]>([
    ['a triangle mesh', { properties: ['x', 'y', 'z', 'nx', 'ny', 'nz'], after: ['element face 12', 'property list uchar int vertex_indices'] }],
    ['a coloured point cloud', { properties: ['x', 'y', 'z', 'red', 'green', 'blue'] }],
    ['one required property short (opacity)', { properties: GS_PROPERTIES.filter((p) => p !== 'opacity') }],
    ['one rotation component short', { properties: GS_PROPERTIES.filter((p) => p !== 'rot_3') }],
    ['the properties but no vertex element', { count: null }],
  ])('is not a splat: %s', (_why, o) => {
    expect(refusal(sniffSplat('ply', ply(o)))).toEqual({ reason: 'ply-not-splat', key: MESH_PLY_NOT_SPLAT_KEY });
  });

  it.each([1, 9, 24, 45])('refuses spherical-harmonic bands (%i f_rest properties)', (n) => {
    const r = sniffSplat('ply', ply({ properties: [...GS_PROPERTIES, ...fRest(n)] }));
    expect(refusal(r)).toEqual({ reason: 'ply-sh', key: MESH_PLY_SH_KEY });
  });

  it("refuses SuperSplat's compressed (chunked) .ply before the property check", () => {
    const compressed = ply({
      before: [
        'element chunk 1',
        ...['min_x', 'min_y', 'min_z', 'max_x', 'max_y', 'max_z'].map((p) => `property float ${p}`),
      ],
      properties: ['packed_position', 'packed_rotation', 'packed_scale', 'packed_color'],
      count: 256,
    });
    expect(refusal(sniffSplat('ply', compressed))).toEqual({ reason: 'ply-compressed', key: MESH_PLY_COMPRESSED_KEY });
  });

  it('the vertex count cap sits exactly at SPLAT_MAX_COUNT', () => {
    // One byte per property keeps the (whole) million-row body at 17 MB.
    expect(facts(sniffSplat('ply', ply({ count: SPLAT_MAX_COUNT, type: 'uchar' }))).count).toBe(SPLAT_MAX_COUNT);
    // Over the cap is refused from the header, before the body is measured.
    expect(refusal(sniffSplat('ply', ply({ count: SPLAT_MAX_COUNT + 1, body: 0 })))).toEqual(splatCountRefusal(SPLAT_MAX_COUNT + 1));
  });

  it('the count is 1 to 10 digits, as the runtime reads it', () => {
    expect(facts(sniffSplat('ply', ply({ count: '0000000003' }))).count).toBe(3);
    expect(refusal(sniffSplat('ply', ply({ count: '00000000003' })))).toEqual({ reason: 'bad-splat', key: MESH_BAD_PLY_KEY });
  });

  it.each<[string, PlyOpts]>([
    ['zero vertices', { count: 0 }],
    ['a count past a safe integer', { count: '99999999999999999999' }],
    ['a negative count', { count: '-3' }],
    ['a non-numeric count', { count: 'many' }],
    ['a fractional count', { count: '3.5' }],
    ['no format line', { format: null }],
    ['an unknown format', { format: 'binary_middle_endian' }],
  ])('refuses a damaged header: %s', (_why, o) => {
    expect(refusal(sniffSplat('ply', ply(o)))).toEqual({ reason: 'bad-splat', key: MESH_BAD_PLY_KEY });
  });

  it('must START with "ply" and carry end_header', () => {
    const good = ply();
    expect(refusal(sniffSplat('ply', concat(ascii(' '), good))).key).toBe(MESH_BAD_PLY_KEY);
    expect(refusal(sniffSplat('ply', ascii('PLY\nformat ascii 1.0\nend_header\n'))).key).toBe(MESH_BAD_PLY_KEY);
    expect(refusal(sniffSplat('ply', ascii('ply\nformat ascii 1.0\nelement vertex 3\n'))).key).toBe(MESH_BAD_PLY_KEY);
    for (const n of [0, 1, 2]) expect(refusal(sniffSplat('ply', ascii('ply').subarray(0, n))).key).toBe(MESH_BAD_PLY_KEY);
  });

  it('looks for end_header within the first 64 KiB and no further', () => {
    const head = ascii(new TextDecoder().decode(ply({ body: 0 })).replace('end_header\n', ''));
    const pad = (n: number) => ascii(`comment ${'x'.repeat(n - 9)}\n`);
    // The marker's LAST byte at offset 64 KiB - 1: found (its line ending is
    // the one byte read past the window).
    const rows = new Uint8Array(SPLAT_PLY_BODY);
    const fits = concat(head, pad(PLY_HEADER_SCAN_BYTES - 10 - head.length), ascii('end_header\n'), rows);
    expect(fits.indexOf(0x65, PLY_HEADER_SCAN_BYTES - 10)).toBe(PLY_HEADER_SCAN_BYTES - 10);
    expect(facts(sniffSplat('ply', fits)).count).toBe(3);
    // One byte later: the marker straddles the scan limit — refused, never read past it.
    const past = concat(head, pad(PLY_HEADER_SCAN_BYTES - 9 - head.length), ascii('end_header\n'), rows);
    expect(refusal(sniffSplat('ply', past)).key).toBe(MESH_BAD_PLY_KEY);
  });

  it('never reads the body: a body spelling f_rest or element chunk changes nothing (only its LENGTH counts)', () => {
    const body = ascii('\nproperty float f_rest_0\nelement chunk 1\nend_header\n');
    expect(facts(sniffSplat('ply', concat(ply({ body: 0 }), body, new Uint8Array(SPLAT_PLY_BODY)))).count).toBe(3);
  });
});

/* ── .spz ────────────────────────────────────────────────────────────────── */

describe('splatSniff: .spz', () => {
  it('a gzip .spz passes with its count unknown (only the sandbox inflates it)', () => {
    expect(facts(sniffSplat('spz', spzGzip()))).toEqual({ count: null, shDegree: null, container: 'spz-gzip' });
  });

  it('pre-checks the ISIZE trailer against the decoded cap, exactly at the cap', () => {
    expect(facts(sniffSplat('spz', spzGzip(SPZ_MAX_DECODED_BYTES))).container).toBe('spz-gzip');
    expect(refusal(sniffSplat('spz', spzGzip(SPZ_MAX_DECODED_BYTES + 1)))).toEqual({
      reason: 'too-large',
      key: MESH_SPZ_TOO_LARGE_KEY,
      sizeBytes: SPZ_MAX_DECODED_BYTES + 1,
      limitBytes: SPZ_MAX_DECODED_BYTES,
    });
    expect(refusal(sniffSplat('spz', spzGzip(0xffffffff))).reason).toBe('too-large');
  });

  it('a trailer claiming less than the 16-byte SPZ header is not a .spz', () => {
    expect(facts(sniffSplat('spz', spzGzip(16))).container).toBe('spz-gzip');
    expect(refusal(sniffSplat('spz', spzGzip(15)))).toEqual({ reason: 'bad-splat', key: MESH_BAD_SPZ_KEY });
  });

  it('a gzip that is not deflate, or too short to hold its trailer, is refused', () => {
    const notDeflate = spzGzip();
    notDeflate[2] = 7;
    expect(refusal(sniffSplat('spz', notDeflate)).key).toBe(MESH_BAD_SPZ_KEY);
    expect(refusal(sniffSplat('spz', spzGzip().subarray(0, 17))).key).toBe(MESH_BAD_SPZ_KEY);
    expect(refusal(sniffSplat('spz', new Uint8Array([0x1f, 0x8b]))).key).toBe(MESH_BAD_SPZ_KEY);
  });

  it('a raw NGSP v4 header (zstd) is spz-version, carrying the version', () => {
    expect(refusal(sniffSplat('spz', spzRaw(4)))).toEqual({ reason: 'spz-version', key: MESH_SPZ_VERSION_KEY, version: 4 });
    expect(refusal(sniffSplat('spz', spzRaw(4, 8))).reason).toBe('spz-version');
  });

  it.each([0, 1, 2, 3, 5, 0xffffffff])('a raw NGSP header of any other version (%i) is bad-splat', (version) => {
    expect(refusal(sniffSplat('spz', spzRaw(version)))).toEqual({ reason: 'bad-splat', key: MESH_BAD_SPZ_KEY });
  });

  it('anything else is not a .spz', () => {
    for (const b of [new Uint8Array(0), new Uint8Array([0x1f]), ascii('NGS'), ascii('NGSP'), ascii('ply\n'), new Uint8Array(64)]) {
      expect(refusal(sniffSplat('spz', b))).toEqual({ reason: 'bad-splat', key: MESH_BAD_SPZ_KEY });
    }
  });
});

/* ── .ksplat ─────────────────────────────────────────────────────────────── */

describe('splatSniff: .ksplat', () => {
  it('reads the count from the header and the SH degree from the section headers', () => {
    expect(facts(sniffSplat('ksplat', ksplat()))).toEqual({ count: 3, shDegree: 0, container: 'ksplat' });
    const two = ksplat({ sections: [{ splats: 2, degree: 0 }, { splats: 5, degree: 2 }] });
    expect(facts(sniffSplat('ksplat', two))).toEqual({ count: 7, shDegree: 2, container: 'ksplat' });
  });

  it('an EMPTY section does not raise the degree (the loader never reads it)', () => {
    const r = sniffSplat('ksplat', ksplat({ sections: [{ splats: 4 }, { splats: 0, max: 2, degree: 3 }] }));
    expect(facts(r)).toEqual({ count: 4, shDegree: 0, container: 'ksplat' });
  });

  it.each([0, 1, 2])('every compression level lays out its own row size (level %i)', (level) => {
    const b = ksplat({ level, sections: [{ splats: 6, max: 8, degree: 1, bucketCount: 2, bucketBytes: 12, partial: 1 }] });
    expect(facts(sniffSplat('ksplat', b))).toEqual({ count: 6, shDegree: 1, container: 'ksplat' });
    // One byte short of the section's storage is a file the loader throws on.
    expect(refusal(sniffSplat('ksplat', b.subarray(0, b.length - 1))).key).toBe(MESH_BAD_KSPLAT_KEY);
  });

  it('the count cap sits exactly at SPLAT_MAX_COUNT, read from the header before the sections', () => {
    // The sections do not have to hold the rows for the cap to answer first.
    expect(refusal(sniffSplat('ksplat', ksplat({ count: SPLAT_MAX_COUNT + 1 })))).toEqual(splatCountRefusal(SPLAT_MAX_COUNT + 1));
    // At the cap the header is honest only if the sections sum to it.
    expect(refusal(sniffSplat('ksplat', ksplat({ count: SPLAT_MAX_COUNT }))).key).toBe(MESH_BAD_KSPLAT_KEY);
  });

  it.each<[string, KsplatOpts]>([
    ['a newer major version', { major: 1 }],
    ['minor version 0', { minor: 0 }],
    ['compression level 3', { level: 3 }],
    ['zero splats', { sections: [{ splats: 0, max: 1 }] }],
    ['an SH degree past 3', { sections: [{ splats: 3, degree: 4 }] }],
    ['sections that do not sum to the header count', { count: 4 }],
    ['truncated section data', { truncate: 1 }],
  ])('refuses %s', (_why, o) => {
    expect(refusal(sniffSplat('ksplat', ksplat(o)))).toEqual({ reason: 'bad-splat', key: MESH_BAD_KSPLAT_KEY });
  });

  it('refuses a file shorter than its 4096-byte header', () => {
    expect(refusal(sniffSplat('ksplat', ksplat().subarray(0, KSPLAT_HEADER_BYTES - 1))).key).toBe(MESH_BAD_KSPLAT_KEY);
    expect(refusal(sniffSplat('ksplat', new Uint8Array(0))).key).toBe(MESH_BAD_KSPLAT_KEY);
  });

  it('an unused (zeroed) section slot is walked and passes, as the loader reads it', () => {
    expect(facts(sniffSplat('ksplat', ksplat({ maxSections: 3 }))).count).toBe(3);
  });

  it('more section slots than the file holds are refused from the header — 2^32-1 never walks', () => {
    for (const slots of [2, 0xffffffff]) {
      const b = ksplat();
      new DataView(b.buffer).setUint32(4, slots, true);
      expect(refusal(sniffSplat('ksplat', b)).key).toBe(MESH_BAD_KSPLAT_KEY);
    }
  });

  it('a section whose storage overflows 2^32 is still compared exactly, and refused', () => {
    const b = ksplat();
    const v = new DataView(b.buffer);
    v.setUint32(KSPLAT_HEADER_BYTES + 12, 0xffffffff, true); // bucketCount
    v.setUint16(KSPLAT_HEADER_BYTES + 20, 0xffff, true); // bucketStorageSizeBytes
    expect(refusal(sniffSplat('ksplat', b)).key).toBe(MESH_BAD_KSPLAT_KEY);
  });
});

/* ── the shared corpus podest's twin is run against ──────────────────────── */

describe('splatSniff: the shared corpus (test-utils SPLAT_SNIFF_CASES)', () => {
  it('reaches every refusal sentence and every container the sniff produces', () => {
    const keys = new Set<string>();
    const containers = new Set<string>();
    const names = new Set<string>();
    for (const c of SPLAT_SNIFF_CASES) {
      expect(names.has(c.name), `duplicate case name ${c.name}`).toBe(false);
      names.add(c.name);
      const r = sniffSplat(c.kind, c.bytes());
      if ('facts' in r) containers.add(r.facts.container);
      else keys.add(r.refusal.key);
    }
    // podestSplat.test.ts proves the twin agrees case by case; this proves the
    // cases leave no sentence unexercised, so that agreement covers them all.
    expect([...keys].sort()).toEqual([
      MESH_BAD_KSPLAT_KEY,
      MESH_BAD_PLY_KEY,
      MESH_BAD_SPLAT_KEY,
      MESH_BAD_SPZ_KEY,
      MESH_PLY_ASCII_KEY,
      MESH_PLY_COMPRESSED_KEY,
      MESH_PLY_NOT_SPLAT_KEY,
      MESH_PLY_SH_KEY,
      MESH_PLY_TRUNCATED_KEY,
      MESH_SPLAT_COUNT_KEY,
      MESH_SPZ_TOO_LARGE_KEY,
      MESH_SPZ_VERSION_KEY,
    ].sort());
    expect([...containers].sort()).toEqual(['ksplat', 'ply-binary-be', 'ply-binary-le', 'splat', 'spz-gzip']);
  });
});

/* ── every kind ──────────────────────────────────────────────────────────── */

describe('splatSniff: bounded, total, never throws', () => {
  it('reads a view at a byte offset as the file it views', () => {
    for (const [kind, file] of [['ksplat', ksplat()], ['ply', ply()], ['spz', spzGzip()], ['splat', new Uint8Array(64)]] as const) {
      const backing = new Uint8Array(file.length + 13);
      backing.set(file, 7);
      expect(sniffSplat(kind, backing.subarray(7, 7 + file.length))).toEqual(sniffSplat(kind, file));
    }
  });

  it('refuses a non-Uint8Array input rather than throwing', () => {
    for (const kind of SPLAT_KINDS) {
      for (const bad of [null, undefined, 'ply\nend_header', [0x1f, 0x8b], { length: 32 }, new ArrayBuffer(32)]) {
        const r = sniffSplat(kind, bad as unknown as Uint8Array);
        expect(refusal(r).reason).toBe('bad-splat');
      }
    }
  });

  it('refuses an unknown kind rather than throwing', () => {
    expect(refusal(sniffSplat('obj' as unknown as SplatKind, new Uint8Array(32))).reason).toBe('bad-splat');
  });

  it('a detached buffer is a refusal, not a throw', () => {
    const b = ksplat();
    structuredClone(b.buffer, { transfer: [b.buffer] });
    for (const kind of SPLAT_KINDS) expect(() => sniffSplat(kind, b)).not.toThrow();
  });

  it('survives random bytes for every kind (seeded)', () => {
    let seed = 0x2545f491;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 300; i++) {
      const b = new Uint8Array(Math.floor(rnd() * 6000));
      for (let j = 0; j < b.length; j++) b[j] = Math.floor(rnd() * 256);
      // Plausible prefixes, so the deeper branches are reached too.
      if (i % 4 === 1) b.set(ascii('ply\nformat ascii 1.0\n').subarray(0, b.length));
      if (i % 4 === 2 && b.length > 2) b.set([0x1f, 0x8b, 8]);
      if (i % 4 === 3 && b.length > 2) b.set([0, 1]);
      for (const kind of SPLAT_KINDS) {
        const r = sniffSplat(kind, b);
        expect('facts' in r || 'refusal' in r).toBe(true);
      }
    }
  });

  it('hands out a fresh refusal per answer, so one caller cannot edit another\'s', () => {
    const a = refusal(sniffSplat('spz', new Uint8Array(4)));
    a.key = 'tampered';
    expect(refusal(sniffSplat('spz', new Uint8Array(4))).key).toBe(MESH_BAD_SPZ_KEY);
  });

  it('never decodes a whole file: a 30 MiB .ply header scan stops at 64 KiB', () => {
    // No end_header anywhere: the scan must give up at the limit, not walk 30 MiB.
    const big = new Uint8Array(30 * 1024 * 1024).fill(0x20);
    big.set(ascii('ply\n'));
    const t0 = performance.now();
    expect(refusal(sniffSplat('ply', big)).key).toBe(MESH_BAD_PLY_KEY);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
