/**
 * The switch for "Generate nodes from text" (src/llm/, docs/dev/node-generator.md)
 * — a LEAF that imports nothing, because what reads it sits on the boot path:
 * the store's flag, the two search boxes, the toolbar's Settings rows, the
 * launcher that opens the dialog (components/Layout/GeneratorLauncher.tsx) and
 * the study clean slate, which clears every key below.
 *
 * THREE states under `fs:nodeGenerator` (owner decision D1, 2026-11-20):
 * absent = SUGGEST (a search that reads as a request offers "Set up AI…";
 * nothing is loaded or sent until the user opens the dialog and presses
 * Generate), exact '1' = ON (a route was set up once), exact '0' = OFF (the
 * Settings row unticked, or "Don't suggest AI"). Offered only where a model
 * can be reached at all — the desktop app (its bundled engine, a local server
 * through the Rust bridge, or the cloud), a web build whose CSP names the
 * cloud API (no hosted one does), or the dev server — and NEVER in a study
 * session, the embed or a running lesson.
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

export type GeneratorMode = 'suggest' | 'on' | 'off';

/** The stored value, validated and never coerced: only the exact strings '1'
 *  and '0' mean on and off; absent — and anything else — is the default. */
export function generatorModeFrom(raw: unknown): GeneratorMode {
  return raw === '1' ? 'on' : raw === '0' ? 'off' : 'suggest';
}

/** What opens the dialog: the text to start from, where on the canvas the
 *  request was made (flow coords; an unwired group lands there), and whether
 *  to start at once (Ctrl/Cmd+Enter with a route already working). */
export interface GeneratorRequest {
  prompt: string;
  at?: { x: number; y: number };
  autostart?: boolean;
  /** A picture pasted or dropped on a search box: the request's picture.
   *  Session-only like the rest of the request — never stored. */
  picture?: File;
}

/** Can this build reach a model at all? `cloud` is the build's `__FS_LLM_CLOUD__`,
 *  which is true on the dev server too (vite.config.ts `llmCloudDefinePlugin`). */
export function generatorBuild(desktop: boolean, cloud: boolean): boolean {
  return desktop || cloud;
}

/** Is the generator offered right now: a build that can reach a model, not
 *  switched off, and not a study session. */
export function generatorOffered(mode: GeneratorMode, evalMode: boolean, build: boolean): boolean {
  return build && mode !== 'off' && !evalMode;
}
