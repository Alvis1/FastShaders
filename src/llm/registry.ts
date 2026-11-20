/**
 * Which routes to a model THIS build offers, and how each one loads — always
 * through `import()`, so neither the desktop transport nor the Anthropic SDK
 * ever reaches the boot wave (bootWave.test.ts). The loaders branch on the
 * BUILD constants themselves, so a build drops the chunks it can never use:
 * a web build without the cloud origin (today every hosted one) ships no SDK,
 * and no web build ships the desktop transport.
 *
 *  - engine — the BUNDLED llama.cpp (src-tauri/src/engine.rs, P5): the desktop
 *             app only, offered first ("local first"). No other build carries
 *             the engine.
 *  - local  — the user's own model server on this computer (LM Studio,
 *             Ollama). The desktop app reaches it
 *             through the Rust bridge (src-tauri/src/llm.rs). The dev server
 *             reaches it through its own same-origin proxy (vite.config.ts
 *             `llmDevProxyPlugin`), so the dialog can be exercised in a
 *             browser. Both go to the address the dialog's Port field holds.
 *             No web BUILD offers it — a hosted page cannot reach a
 *             local server reliably (Safari never), and doing so would mean a
 *             CSP and CORS setup per user.
 *  - claude — the user's own API key, wherever `__FS_LLM_CLOUD__` is true:
 *             the desktop app, the dev server, and a web build whose CSP
 *             names api.anthropic.com (FS_LLM_CLOUD_ORIGINS, which drives both
 *             — vite.config.ts `llmCloudDefinePlugin`). No hosted build sets
 *             it (owner, 2026-11-19).
 *
 * Nothing at all in a study session.
 */
import type { RouteId } from './prefs';
import type { LocalTransport } from './transport/types';

export interface BuildEnv {
  desktop: boolean;
  cloud: boolean;
  dev: boolean;
}

export const buildEnv = (): BuildEnv => ({ desktop: __FS_DESKTOP__, cloud: __FS_LLM_CLOUD__, dev: import.meta.env.DEV });

export function offeredRoutes(env: BuildEnv, evalMode: boolean): RouteId[] {
  if (evalMode) return [];
  const routes: RouteId[] = [];
  if (env.desktop) routes.push('engine');
  if (env.desktop || env.dev) routes.push('local');
  if (env.desktop || env.cloud) routes.push('claude');
  return routes;
}

/** The local route's transport for this build, or null where it has none. */
export async function loadLocalTransport(): Promise<LocalTransport | null> {
  if (__FS_DESKTOP__) return (await import('./transport/tauriTransport')).tauriTransport();
  // The dev server: same origin, and its proxy forwards to the server named.
  if (import.meta.env.DEV) return (await import('./transport/fetchTransport')).devProxyTransport(location.origin);
  return null;
}

/** The bundled engine's transport: the desktop app only (it carries the engine). */
export async function loadEngineTransport(): Promise<LocalTransport | null> {
  if (__FS_DESKTOP__) return (await import('./transport/tauriTransport')).engineTransport();
  return null;
}

/** The Claude provider's module, or null on a build whose policy cannot reach the API. */
export async function loadClaude(): Promise<typeof import('./providers/claude') | null> {
  if (!__FS_LLM_CLOUD__) return null;
  return import('./providers/claude');
}
