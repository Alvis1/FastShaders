/**
 * Pins podest's two size-limit surfaces, by RUNNING podest's own code.
 *
 * `public/podest.html` is a standalone vanilla page copied verbatim into every
 * deploy, so it cannot import the editor's modules and carries hand-written
 * twins instead. Two of them decide what a visitor is told about a file that
 * is too big:
 *  - **the zip reader** (`unzip` / `inflateEntry`) — its caps must equal
 *    `src/utils/zipReader.ts`'s (zipReader.test.ts compares the constants as
 *    text), and a cap failure must read as a SENTENCE ("Could not open the
 *    zip: it unpacks to more than 96 MB.") rather than a parser error ("Could
 *    not read zip: archive too large"), because the fix is the visitor's;
 *  - **the session mirror's restore note** (`restoreLimitText`) — the
 *    IndexedDB mirror silently leaves out a shader over 24 M characters or a
 *    model over 64 MB, so a restarted pedestal comes back without it. The
 *    note says so at the moment of a user load, and its predicates must stay
 *    `writeSession`'s, inverted.
 *
 * Both are sliced out of the page between anchor comments and evaluated with
 * `new Function`, so the maths below is podest's, not a copy of it. Only the
 * STORE path is exercised (FastShaders' own writer is STORE-only), so no
 * DecompressionStream is needed, and nothing touches a global — the suite runs
 * with `isolate: false`. Buffers are small (the caps are overridden to 1 MiB
 * and 16 characters where a size matters), so a shared worker pays nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildZip } from '@/utils/zipWriter';
import { MESH_MAX_BYTES } from '@/utils/previewMesh';

const page = readFileSync(new URL('../public/podest.html', import.meta.url), 'utf8');

/** The text between two anchors; both must exist (a moved anchor fails loudly). */
function between(from: string, to: string): string {
  const a = page.indexOf(from);
  expect(a, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0);
  const b = page.indexOf(to, a + from.length);
  expect(b, `anchor not found after ${from}: ${to}`).toBeGreaterThan(a);
  return page.slice(a, b);
}

/** A top-level function's source: up to the next top-level function or section marker. */
function fnSource(name: string): string {
  const start = page.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const ends = ['\n  function ', '\n  async function ', '\n  // ──']
    .map((m) => page.indexOf(m, start + 1))
    .filter((i) => i > start);
  return page.slice(start, Math.min(...ends));
}

type ZipLimitErr = Error & { zipLimit?: boolean };
interface ZipApi {
  unzip(buf: ArrayBuffer): Promise<{ name: string; data: Uint8Array }[]>;
  zipLimitError(kind: 'size' | 'entries'): ZipLimitErr;
  zipErrorText(e: unknown): string;
  cap(): number;
}
interface RestoreApi {
  restoreLimitText(modelBytes: unknown, shaderSource: unknown): string;
  model(): number;
  shader(): number;
}

const CAPS_ANCHOR = '  // Adversarial-input caps — mirror src/utils/zipReader.ts';
const WIRING_ANCHOR = '  // ── Wiring: drag/drop, file picker, controls';
const zipSlice = between(CAPS_ANCHOR, WIRING_ANCHOR);
const restoreSlice = between('  var DB_NAME = "fs-podest"', '  var dbHandle = null');

/** Podest's reader, optionally with its summed cap lowered (0 = the shipped cap). */
function zipApi(capOverride = 0): ZipApi {
  return new Function(
    'capOverride',
    zipSlice +
      '\nif (capOverride) MAX_TOTAL_UNCOMPRESSED = capOverride;' +
      '\nreturn { unzip: unzip, zipLimitError: zipLimitError, zipErrorText: zipErrorText, cap: function () { return MAX_TOTAL_UNCOMPRESSED; } };',
  )(capOverride) as ZipApi;
}

/** Podest's restore-note text, optionally with the shader cap lowered. */
function restoreApi(shaderCap = 0): RestoreApi {
  return new Function(
    'shaderCap',
    restoreSlice +
      '\nif (shaderCap) MAX_SAVED_SHADER = shaderCap;' +
      '\nreturn { restoreLimitText: restoreLimitText, model: function () { return MAX_SAVED_MODEL; }, shader: function () { return MAX_SAVED_SHADER; } };',
  )(shaderCap) as RestoreApi;
}

/** A STORE zip of the given entries, as the ArrayBuffer podest's unzip takes. */
function zipOf(entries: { name: string; size: number }[]): ArrayBuffer {
  const zip = buildZip(entries.map((e) => ({ name: e.name, data: new Uint8Array(e.size) })));
  return zip.slice().buffer;
}

async function rejectionOf(p: Promise<unknown>): Promise<ZipLimitErr> {
  try {
    await p;
  } catch (e) {
    return e as ZipLimitErr;
  }
  throw new Error('expected a rejection, but the promise resolved');
}

const MODEL_SENTENCE =
  'This model is over 64 MB and will not be restored after a restart or browser update — keep a copy to drop again.';
const SHADER_SENTENCE =
  'This shader is too large to be restored after a restart or browser update — keep a copy to drop again.';

describe('podest zip reader caps (executed)', () => {
  it('sums to 96 MiB: the editor’s largest model plus 32 MiB beside it', () => {
    expect(zipApi().cap()).toBe(96 * 1024 * 1024);
    expect(zipApi().cap()).toBe(MESH_MAX_BYTES + 32 * 1024 * 1024);
  });

  it('says a cap failure as a sentence, at the real caps', () => {
    const api = zipApi();
    expect(api.zipErrorText(api.zipLimitError('size'))).toBe(
      'Could not open the zip: it unpacks to more than 96 MB.',
    );
    expect(api.zipErrorText(api.zipLimitError('entries'))).toBe(
      'Could not open the zip: it holds more than 512 files.',
    );
  });

  it('refuses one entry over the budget, with the lowered cap in the sentence', async () => {
    const api = zipApi(1024 * 1024);
    const e = await rejectionOf(api.unzip(zipOf([{ name: 'big.glb', size: 1024 * 1024 + 1 }])));
    expect(e.zipLimit).toBe(true);
    expect(api.zipErrorText(e)).toBe('Could not open the zip: it unpacks to more than 1 MB.');
  });

  it('SUMS the budget across entries: two under-cap entries over it together are refused', async () => {
    const api = zipApi(1024 * 1024);
    const e = await rejectionOf(
      api.unzip(zipOf([{ name: 'a.bin', size: 600 * 1024 }, { name: 'b.bin', size: 600 * 1024 }])),
    );
    expect(e.zipLimit).toBe(true);
  });

  it('opens entries summing to exactly the cap', async () => {
    const api = zipApi(1024 * 1024);
    const entries = await api.unzip(
      zipOf([{ name: 'a.bin', size: 512 * 1024 }, { name: 'b.bin', size: 512 * 1024 }]),
    );
    expect(entries.map((x) => x.name)).toEqual(['a.bin', 'b.bin']);
    expect(entries[0].data.length + entries[1].data.length).toBe(1024 * 1024);
  });

  it('refuses more than 512 entries and opens exactly 512', async () => {
    const api = zipApi();
    const many = (n: number) => zipOf(Array.from({ length: n }, (_, i) => ({ name: `f${i}.txt`, size: 1 })));
    const e = await rejectionOf(api.unzip(many(513)));
    expect(e.zipLimit).toBe(true);
    expect(api.zipErrorText(e)).toBe('Could not open the zip: it holds more than 512 files.');
    await expect(api.unzip(many(512))).resolves.toHaveLength(512);
  });

  it('keeps the old "Could not read zip:" text for a malformed archive', async () => {
    const api = zipApi();
    const e = await rejectionOf(api.unzip(new TextEncoder().encode('not a zip at all').slice().buffer));
    expect(e.zipLimit).toBeFalsy();
    expect(api.zipErrorText(e)).toBe('Could not read zip: not a zip archive');
  });
});

describe('podest zip reader wiring (source)', () => {
  it('no longer says "archive too large" anywhere', () => {
    expect(page).not.toContain('"archive too large"');
    expect(page.split('zipLimitError("size")').length - 1).toBe(2);
    expect(page.split('zipLimitError("entries")').length - 1).toBe(1);
  });

  it('routes handleZip’s catch through zipErrorText', () => {
    const handleZip = between('function handleZip(', CAPS_ANCHOR);
    expect(handleZip).toContain('showError(zipErrorText(e))');
    expect(handleZip).not.toContain('"Could not read zip: " + e.message');
  });
});

describe('podest restore-limit note', () => {
  it('uses the editor’s model cap and a 24 M character shader cap', () => {
    const api = restoreApi();
    expect(api.model()).toBe(MESH_MAX_BYTES);
    expect(api.shader()).toBe(24 * 1024 * 1024);
  });

  it('names a model only when it is over the cap', () => {
    const api = restoreApi();
    expect(api.restoreLimitText({ byteLength: MESH_MAX_BYTES }, null)).toBe('');
    expect(api.restoreLimitText({ byteLength: MESH_MAX_BYTES + 1 }, null)).toBe(MODEL_SENTENCE);
  });

  it('names a shader only when it is over the cap, and both on two lines, model first', () => {
    const api = restoreApi(16);
    expect(api.restoreLimitText(null, 'x'.repeat(16))).toBe('');
    expect(api.restoreLimitText(null, 'x'.repeat(17))).toBe(SHADER_SENTENCE);
    expect(api.restoreLimitText({ byteLength: MESH_MAX_BYTES + 1 }, 'x'.repeat(17))).toBe(
      MODEL_SENTENCE + '\n' + SHADER_SENTENCE,
    );
  });

  it('says nothing for missing or junk payloads', () => {
    const api = restoreApi();
    expect(api.restoreLimitText(undefined, undefined)).toBe('');
    expect(api.restoreLimitText(null, 123)).toBe('');
  });

  it('inverts writeSession’s own predicates (change them together)', () => {
    expect(page).toContain('state.shaderSource.length <= MAX_SAVED_SHADER');
    expect(page).toContain('state.modelBytes.byteLength <= MAX_SAVED_MODEL');
  });

  it('is gated and called only where a person is at the panel', () => {
    const note = fnSource('noteRestoreLimits');
    expect(note).toContain('!state.autoRestore');
    expect(note).toContain('presenting()');

    const handleFiles = fnSource('handleFiles');
    expect(handleFiles).toContain('Promise.all(reads)');
    // A confirmed GLB-borne shader is a shader load too (glbShader).
    expect(handleFiles).toContain('noteRestoreLimits(!!model, !!shader || glbShader)');

    expect(between('function handleZip(', CAPS_ANCHOR)).toContain(
      'else if (!quiet) noteRestoreLimits(!!model, !!shader)',
    );
    expect(fnSource('advanceWork')).toContain('loadWorkEntry(n, true)');
    // …and loadWorkEntry must carry that flag into BOTH of its branches: a zip
    // hands it to handleZip as `quiet`, a .js gates the note on it directly.
    // Without either, every Cycle stay with an over-cap entry raises the red
    // banner while the panel is up — the "never on a cycle tick" rule.
    const lwe = fnSource('loadWorkEntry');
    expect(lwe).toContain('handleZip(f, seq, fromCycle)');
    expect(lwe).toContain('if (!fromCycle) noteRestoreLimits(false, true)');

    for (const name of ['applyRestored', 'loadShaderText', 'loadModelBuffer']) {
      expect(fnSource(name), `${name} must not raise the restore note`).not.toContain('noteRestoreLimits');
    }

    expect(between('restoreToggle.addEventListener("change"', 'viewReturnToggle.checked')).toContain(
      'noteRestoreLimits(true, true)',
    );
  });

  it('relies on the banner conventions CLAUDE.md claims', () => {
    expect(page).toContain(':root.is-present #error { display: none; }');
    expect(page).toContain('var ERROR_DISMISS_MS = 20000;');
  });
});
