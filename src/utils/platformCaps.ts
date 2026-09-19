/**
 * The ONE table of caps that differ between the web build and the desktop room
 * (GLB Phase 6).
 *
 * The browser caps are bound by the ~5.24M-char localStorage quota the graph
 * autosave shares with everything else at the origin. The desktop build keeps
 * its autosave in Rust-side files instead, so it gets more. Only the per-image
 * cap (6M) sits under the unchanged 8M per-image HARD ceiling
 * (`HARD_MAX_IMAGE_ENCODED_CHARS` in imageNode.ts), which still bounds every
 * single adversarial payload on both builds alike; the project, library, ref and
 * cache TOTALS are above 8M by design.
 *
 * The zip reader's caps are NOT in this table: zipReader.ts is a zero-import leaf
 * whose 96 MiB literal podest's drift guard evaluates as text, so its desktop
 * value lives beside it (`DESKTOP_MAX_TOTAL_UNCOMPRESSED`, `READ_*`).
 *
 * A ZERO-IMPORT LEAF, like zipReader.ts: it reads nothing but the build define.
 * The define is written `typeof __FS_DESKTOP__ !== 'undefined' && __FS_DESKTOP__`
 * because the research doc's node probe recipe runs these leaves in bare node,
 * with no Vite define, where a bare `__FS_DESKTOP__` is a ReferenceError. Vite
 * still replaces the identifier (`typeof false`), so the build output is the same.
 *
 * vitest runs the WEB profile (the define is false there), so `PLATFORM_CAPS` is
 * `WEB_CAPS` in every test. Desktop values are testable only through
 * `DESKTOP_CAPS` itself or an explicit parameter (platformCaps.test.ts).
 */
export interface PlatformCaps {
  /** Soft per-image budget (`MAX_IMAGE_ENCODED_CHARS`). */
  readonly imageChars: number;
  /** Soft project budget, counted per instance (`MAX_TOTAL_IMAGE_CHARS`). */
  readonly projectImageChars: number;
  /** The saved-group library's own budget (`MAX_LIBRARY_IMAGE_CHARS`). */
  readonly libraryImageChars: number;
  /** Characters one document may resolve through image refs
   *  (`MAX_REF_RESOLVED_IMAGE_CHARS`, imagePayloadRefs.ts). */
  readonly refResolvedImageChars: number;
  /** The imageAssets decode memo's entry and character bounds. */
  readonly imageDecodeCacheEntries: number;
  readonly imageDecodeCacheChars: number;
  /** The Resolution-original cache's record and character bounds
   *  (imageOriginCache.ts). */
  readonly originRecords: number;
  readonly originStoreChars: number;
}

/** Today's browser numbers, unchanged by Phase 6 (platformCaps.test.ts pins them). */
export const WEB_CAPS: PlatformCaps = Object.freeze({
  imageChars: 600_000,
  projectImageChars: 3_000_000,
  libraryImageChars: 3_000_000,
  refResolvedImageChars: 16_000_000,
  imageDecodeCacheEntries: 24,
  imageDecodeCacheChars: 4_000_000,
  originRecords: 32,
  originStoreChars: 24 * 1024 * 1024,
});

/** The desktop room (research doc §5.1; owner default 4). Revisit after the
 *  `.dmg` edit-latency measurement: ≤ 1.5× an empty graph at a full budget. */
export const DESKTOP_CAPS: PlatformCaps = Object.freeze({
  imageChars: 6_000_000,
  projectImageChars: 32_000_000,
  libraryImageChars: 32_000_000,
  // A desktop project (32M counted per instance) must resolve fully through
  // refs, with room for a library document beside it.
  refResolvedImageChars: 64_000_000,
  // Holds a whole desktop project plus one image in flight, so a graph→code
  // pass over a full budget does not evict what it is about to reuse.
  imageDecodeCacheEntries: 128,
  imageDecodeCacheChars: 40_000_000,
  // Each record may reach the 6M per-image cap, so the character bound binds
  // first (~42 records at 256M).
  originRecords: 64,
  originStoreChars: 256 * 1024 * 1024,
});

/** The table for a build. Pure, so a test can ask for either. */
export function capsFor(desktop: boolean): PlatformCaps {
  return desktop ? DESKTOP_CAPS : WEB_CAPS;
}

/** What THIS build applies. */
export const PLATFORM_CAPS: PlatformCaps = capsFor(
  typeof __FS_DESKTOP__ !== 'undefined' && __FS_DESKTOP__,
);
