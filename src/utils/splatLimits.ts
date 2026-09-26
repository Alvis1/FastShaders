/**
 * The Gaussian-splat caps and header constants — a ZERO-IMPORT leaf, so the
 * pre-read gate (`gltfCompression.ts`), the trusted-side sniff
 * (`splatSniff.ts`) and any later reader can share them without a cycle.
 *
 * The SAME literals live in two places this module cannot reach: the sandboxed
 * runtime's `FastShadersSplat.LIMITS` (`a-frame-shaderloader/js/fs-splat-0.1.js`)
 * and podest's hand-written sniff twin (`public/podest.html`). A move here must
 * move them too — the drift guards compare the three literal sets.
 *
 * `MESH_MAX_BYTES` (64 MiB, `gltfCompression.ts`) stays the byte cap for every
 * splat kind: the zip SUM cap, podest's mirror cap and the export pre-flight all
 * derive from it, so there is deliberately no per-kind byte cap here.
 */

/** One `.splat` row: position f32×3, scale f32×3, RGBA u8×4, rotation u8×4 — the format has no header. */
export const SPLAT_ROW_BYTES = 32;

/** Hard refusal: above ~1M the WebGL CPU counting sort (~0.8 ms/100k on an M4 Max) stops fitting a frame. */
export const SPLAT_MAX_COUNT = 1_000_000;

/** Info line only: a guessed ~4x Quest-class slowdown puts a standalone headset's comfortable ceiling here. */
export const SPLAT_HEADSET_ADVISORY_COUNT = 250_000;

/** The gzip `.spz` inflate cap (the zip reader's 96 MiB SUM cap): a 64 MiB file must not unpack into gigabytes. */
export const SPZ_MAX_DECODED_BYTES = 96 * 1024 * 1024;

/** How far into a `.ply` the header sniff looks for `end_header`; a real 3DGS header is a few hundred bytes. */
export const PLY_HEADER_SCAN_BYTES = 64 * 1024;

/** The fixed `.ksplat` main header (GaussianSplats3D); section headers (1024 B each) follow it. */
export const KSPLAT_HEADER_BYTES = 4096;

/** 'NGSP' read as a little-endian u32 — the raw (un-gzipped) SPZ header magic; v4 files start with it. */
export const SPZ_MAGIC = 0x5053474e;
