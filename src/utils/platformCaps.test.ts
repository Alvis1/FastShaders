/**
 * The platform caps table (GLB Phase 6 "desktop room", `utils/platformCaps.ts`)
 * — it replaces S0's `platformCapsWebPin.test.ts`, whose numbers it keeps.
 *
 * vitest always runs the WEB profile (`__FS_DESKTOP__` is false there), so:
 *  - every web number must still be EXACTLY what a web user already lives under
 *    — threading the caps through one table must not move a single web limit;
 *  - the desktop values can only be tested through the `DESKTOP_CAPS` table
 *    itself or an explicit parameter, never through the exported constants,
 *    which are the web ones here. So the desktop table is held to the
 *    RELATIONSHIPS that make it safe (under the hard ceiling, the reader opens
 *    what a desktop export writes, refs resolve a full project…), which is
 *    what would silently break if one number moved without the others.
 *
 * Pure: no globals are touched and no store state is read, so it is safe in a
 * shared (`isolate: false`) worker.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WEB_CAPS, DESKTOP_CAPS, PLATFORM_CAPS, capsFor, type PlatformCaps } from './platformCaps';
import {
  MAX_IMAGE_ENCODED_CHARS,
  HARD_MAX_IMAGE_ENCODED_CHARS,
  MAX_TOTAL_IMAGE_CHARS,
  MAX_LIBRARY_IMAGE_CHARS,
} from './imageNode';
import { MAX_REF_RESOLVED_IMAGE_CHARS } from './imagePayloadRefs';
import {
  MAX_TOTAL_UNCOMPRESSED,
  MAX_ARCHIVE_BYTES,
  DESKTOP_MAX_TOTAL_UNCOMPRESSED,
  READ_MAX_TOTAL_UNCOMPRESSED,
  READ_MAX_ARCHIVE_BYTES,
} from './zipReader';
import { MESH_MAX_BYTES } from './previewMesh';

const MiB = 1024 * 1024;
const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** The field a `const NAME = PLATFORM_CAPS.<field>;` (module-private or
 *  exported) reads — the declaration must appear EXACTLY once, so the pin
 *  cannot be satisfied by the wrong line. */
function capsField(source: string, name: string, where: string): keyof PlatformCaps {
  const hits = [...source.matchAll(new RegExp(`\\b(?:export )?const ${name} = ([^;\\n]+);`, 'g'))];
  expect(hits.length, `${where}: expected exactly one \`const ${name} = …;\``).toBe(1);
  const m = /^PLATFORM_CAPS\.(\w+)$/.exec(hits[0][1].trim());
  expect(m, `${where}: ${name} no longer reads the platform table`).not.toBeNull();
  const field = m![1] as keyof PlatformCaps;
  expect(Object.keys(WEB_CAPS)).toContain(field);
  return field;
}

/** Source with // and block comments blanked, so a token in prose is not code. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

describe('platform caps: the web profile keeps today\'s numbers', () => {
  it('the web table holds exactly the numbers a web user already lives under', () => {
    expect(WEB_CAPS).toEqual({
      imageChars: 600_000,
      projectImageChars: 3_000_000,
      libraryImageChars: 3_000_000,
      refResolvedImageChars: 16_000_000,
      imageDecodeCacheEntries: 24,
      imageDecodeCacheChars: 4_000_000,
      originRecords: 32,
      originStoreChars: 24 * MiB,
    });
  });

  it('vitest runs the WEB profile: this build applies the web table', () => {
    expect(PLATFORM_CAPS).toBe(WEB_CAPS);
    expect(capsFor(false)).toBe(WEB_CAPS);
    expect(capsFor(true)).toBe(DESKTOP_CAPS);
  });

  it('both tables are frozen, so no caller can move a cap at run time', () => {
    expect(Object.isFrozen(WEB_CAPS)).toBe(true);
    expect(Object.isFrozen(DESKTOP_CAPS)).toBe(true);
  });

  it('the exported image budgets read the table and keep their web values', () => {
    expect(MAX_IMAGE_ENCODED_CHARS).toBe(WEB_CAPS.imageChars);
    expect(MAX_TOTAL_IMAGE_CHARS).toBe(WEB_CAPS.projectImageChars);
    expect(MAX_LIBRARY_IMAGE_CHARS).toBe(WEB_CAPS.libraryImageChars);
    expect(MAX_LIBRARY_IMAGE_CHARS).toBe(MAX_TOTAL_IMAGE_CHARS);
    expect(MAX_IMAGE_ENCODED_CHARS).toBe(600_000);
    expect(MAX_TOTAL_IMAGE_CHARS).toBe(3_000_000);
  });

  it('the hard per-image ceiling stays 8M on both builds, and web refs resolve up to 2 × it', () => {
    expect(HARD_MAX_IMAGE_ENCODED_CHARS).toBe(8_000_000);
    expect(MAX_REF_RESOLVED_IMAGE_CHARS).toBe(16_000_000);
    expect(MAX_REF_RESOLVED_IMAGE_CHARS).toBe(2 * HARD_MAX_IMAGE_ENCODED_CHARS);
    expect(MAX_REF_RESOLVED_IMAGE_CHARS).toBe(WEB_CAPS.refResolvedImageChars);
  });

  it('the zip reader keeps the 96 / 104 MiB web caps, and this build reads with them', () => {
    expect(MAX_TOTAL_UNCOMPRESSED).toBe(96 * MiB);
    expect(MAX_ARCHIVE_BYTES).toBe(104 * MiB);
    expect(MAX_ARCHIVE_BYTES).toBe(MAX_TOTAL_UNCOMPRESSED + 8 * MiB);
    expect(READ_MAX_TOTAL_UNCOMPRESSED).toBe(MAX_TOTAL_UNCOMPRESSED);
    expect(READ_MAX_ARCHIVE_BYTES).toBe(MAX_ARCHIVE_BYTES);
  });

  it('the exported image budgets READ the table, not literals that happen to equal it (source pins)', () => {
    // Every value assertion above holds on the web profile for a literal
    // `600000` / `3000000` / `2 * HARD…` as well, so only the source says
    // whether the DESKTOP build gets its numbers.
    const node = read('utils/imageNode.ts');
    expect(capsField(node, 'MAX_IMAGE_ENCODED_CHARS', 'imageNode.ts')).toBe('imageChars');
    expect(capsField(node, 'MAX_TOTAL_IMAGE_CHARS', 'imageNode.ts')).toBe('projectImageChars');
    expect(capsField(node, 'MAX_LIBRARY_IMAGE_CHARS', 'imageNode.ts')).toBe('libraryImageChars');
    // The ref cap is the larger of the web rule and the table (never below web).
    expect(read('utils/imagePayloadRefs.ts')).toMatch(
      /export const MAX_REF_RESOLVED_IMAGE_CHARS = Math\.max\(\s*2 \* HARD_MAX_IMAGE_ENCODED_CHARS,\s*PLATFORM_CAPS\.refResolvedImageChars,?\s*\);/,
    );
  });

  it('the module-private memo and cache bounds read the table (source pins)', () => {
    const assets = read('engine/imageAssets.ts');
    expect(WEB_CAPS[capsField(assets, 'IMAGE_SRC_CACHE_LIMIT', 'imageAssets.ts')]).toBe(24);
    expect(WEB_CAPS[capsField(assets, 'IMAGE_SRC_CACHE_MAX_CHARS', 'imageAssets.ts')]).toBe(4_000_000);
    const origin = read('utils/imageOriginCache.ts');
    expect(WEB_CAPS[capsField(origin, 'MAX_RECORDS', 'imageOriginCache.ts')]).toBe(32);
    expect(WEB_CAPS[capsField(origin, 'MAX_STORE_CHARS', 'imageOriginCache.ts')]).toBe(24 * MiB);
  });
});

describe('platform caps: the desktop table is safe by construction', () => {
  const D = DESKTOP_CAPS;

  it('is the owner-adopted set (research doc §5.1)', () => {
    expect(D).toEqual({
      imageChars: 6_000_000,
      projectImageChars: 32_000_000,
      libraryImageChars: 32_000_000,
      refResolvedImageChars: 64_000_000,
      imageDecodeCacheEntries: 128,
      imageDecodeCacheChars: 40_000_000,
      originRecords: 64,
      originStoreChars: 256 * MiB,
    });
  });

  it('never lowers a web cap', () => {
    for (const k of Object.keys(WEB_CAPS) as (keyof PlatformCaps)[]) {
      expect(D[k], k).toBeGreaterThanOrEqual(WEB_CAPS[k]);
    }
  });

  it('stays under the unchanged 8M hard per-image ceiling', () => {
    expect(D.imageChars).toBeLessThan(HARD_MAX_IMAGE_ENCODED_CHARS);
  });

  for (const [name, caps, readCap] of [
    ['web', WEB_CAPS, MAX_TOTAL_UNCOMPRESSED],
    ['desktop', DESKTOP_CAPS, DESKTOP_MAX_TOTAL_UNCOMPRESSED],
  ] as const) {
    describe(`${name} table relationships`, () => {
      it('a project holds at least four images at the per-image cap', () => {
        expect(caps.projectImageChars).toBeGreaterThanOrEqual(4 * caps.imageChars);
      });

      it('refs resolve a whole project, and a whole library, each under its own document budget', () => {
        // The reader charges each document's budget once per DISTINCT image
        // (desktopAutosave.ts MaterializeBudget): a graph's distinct chars are
        // at most its per-instance project total, and the library is budgeted
        // per UNIQUE payload on write — so each must fit on its own. (The web
        // reader is per instance, but a legit web graph stays under 3M anyway.)
        expect(caps.refResolvedImageChars).toBeGreaterThanOrEqual(caps.projectImageChars);
        expect(caps.refResolvedImageChars).toBeGreaterThanOrEqual(caps.libraryImageChars);
        expect(caps.refResolvedImageChars).toBeGreaterThanOrEqual(2 * caps.projectImageChars);
      });

      it('the decode memo holds a whole project plus one image in flight', () => {
        expect(caps.imageDecodeCacheChars).toBeGreaterThanOrEqual(caps.projectImageChars + caps.imageChars);
      });

      it('the Resolution-original cache holds at least eight images at the per-image cap', () => {
        expect(caps.originStoreChars).toBeGreaterThanOrEqual(8 * caps.imageChars);
      });

      it('the reader opens what an export at these caps writes', () => {
        // A model at its cap, plus the project's images twice as ASCII (inlined
        // in the module and in the project block), plus their decoded `images/`
        // files (base64 → bytes is × 0.75), plus a MiB of README / headers.
        const largestBundle =
          MESH_MAX_BYTES + 2 * caps.projectImageChars + Math.ceil(caps.projectImageChars * 0.75) + MiB;
        expect(readCap).toBeGreaterThanOrEqual(largestBundle);
      });
    });
  }

  it('the desktop reader cap is 256 MiB, and its archive gate the Rust MAX_READ_BYTES of 264 MiB', () => {
    expect(DESKTOP_MAX_TOTAL_UNCOMPRESSED).toBe(256 * MiB);
    expect(DESKTOP_MAX_TOTAL_UNCOMPRESSED + 8 * MiB).toBe(264 * MiB);
  });
});

describe('platform caps: source pins', () => {
  it('zipReader keeps the 96 MiB LITERAL podest\'s drift guard evaluates', () => {
    expect(read('utils/zipReader.ts')).toContain('export const MAX_TOTAL_UNCOMPRESSED = 96 * 1024 * 1024;');
  });

  it('both leaves stay zero-import and read the define through the typeof guard (bare-node safe)', () => {
    const GUARD = "typeof __FS_DESKTOP__ !== 'undefined' && __FS_DESKTOP__";
    for (const rel of ['utils/platformCaps.ts', 'utils/zipReader.ts']) {
      const code = codeOnly(read(rel));
      expect(code, `${rel} imports something`).not.toMatch(/^\s*import\b/m);
      const tokens = code.match(/__FS_DESKTOP__/g) ?? [];
      const guards = code.split(GUARD).length - 1;
      expect(guards, `${rel} does not read the define`).toBeGreaterThan(0);
      // Every occurrence of the identifier in CODE is one of the guard's two.
      expect(tokens.length, `${rel} reads __FS_DESKTOP__ outside the typeof guard`).toBe(2 * guards);
    }
  });

  it('projectImport gates a zip on THIS build\'s archive cap before reading it', () => {
    const src = read('engine/projectImport.ts');
    expect(src).toContain('if (file.size > READ_MAX_ARCHIVE_BYTES) {');
    expect(src).not.toMatch(/\bMAX_ARCHIVE_BYTES\b(?<!READ_MAX_ARCHIVE_BYTES)/);
  });

  it("exportPreflight's blocking dialog defaults to THIS build's read cap", () => {
    expect(read('utils/exportPreflight.ts')).toContain('limitBytes: number = READ_MAX_TOTAL_UNCOMPRESSED,');
  });

  it('no 600000 / 3000000 budget literal (underscored or not) outside platformCaps.ts and tests', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(name) || /\.test\.ts$/.test(name)) continue;
        if (p.endsWith(join('utils', 'platformCaps.ts'))) continue;
        if (/\b600_?000\b|\b3_?000_?000\b/.test(readFileSync(p, 'utf8'))) offenders.push(p.slice(SRC.length + 1));
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
