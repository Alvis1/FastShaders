/**
 * The opt-in for "Generate nodes from text" (src/llm/, docs/dev/node-generator.md)
 * — a LEAF that imports nothing, because what reads it sits on the boot path:
 * the store's flag, the toolbar's Settings rows, the launcher that opens the
 * dialog (components/Layout/GeneratorLauncher.tsx) and the study clean slate,
 * which clears every key below.
 *
 * Off by default and switched on per browser (`fs:nodeGenerator`, exact '1').
 * Offered only where a model can be reached at all — the desktop app (a local
 * server through the Rust bridge, or the cloud), a web build whose CSP names
 * the cloud API, or the dev server — and NEVER in a study session.
 */

export const GENERATOR_FLAG_KEY = 'fs:nodeGenerator';

/**
 * Every key the feature stores, the opt-in first. Nothing secret: the API key
 * is never stored (llm/cloudKey.ts). `cleanSlateForStudy` removes them all.
 */
export const GENERATOR_STORAGE_KEYS = [
  GENERATOR_FLAG_KEY,
  'fs:llmRoute',
  'fs:llmLocalBase',
  'fs:llmLocalModel',
  'fs:llmCloudModel',
] as const;

/** Only the exact string '1' turns it on — '1 ', 'true' and 1 do not. */
export function generatorEnabledFrom(raw: unknown): boolean {
  return raw === '1';
}

/** Can this build reach a model at all? `cloud` is the build's `__FS_LLM_CLOUD__`,
 *  which is true on the dev server too (vite.config.ts `llmCloudDefinePlugin`). */
export function generatorBuild(desktop: boolean, cloud: boolean): boolean {
  return desktop || cloud;
}

/** Is the generator offered right now: a build that can reach a model, the
 *  user's opt-in, and not a study session. */
export function generatorOffered(enabled: boolean, evalMode: boolean, build: boolean): boolean {
  return build && enabled && !evalMode;
}
