/**
 * The generator's remembered choices — route, local server address, local
 * model, cloud model. Each is an `fs:*` value anything at this origin can
 * write, so each is VALIDATED, never coerced, and falls back when it is not one
 * of the known values (the loadOptionalCategories rule). Nothing secret is
 * stored here: the API key lives in memory only (cloudKey.ts).
 */
import { DEFAULT_LOCAL_BASE, normalizeLocalBase } from './endpoint';
import { isUsableModelId } from './protocol/openaiCompat';
import { DEFAULT_CLAUDE_MODEL, isClaudeModel, type ClaudeModel } from './claudeModels';

export type RouteId = 'local' | 'claude';

export interface GeneratorPrefs {
  route: RouteId | null;
  localBase: string;
  /** '' = none chosen yet. */
  localModel: string;
  cloudModel: ClaudeModel;
}

export const PREF_KEYS = {
  route: 'fs:llmRoute',
  localBase: 'fs:llmLocalBase',
  localModel: 'fs:llmLocalModel',
  cloudModel: 'fs:llmCloudModel',
} as const;

export function loadGeneratorPrefs(read: (key: string) => string | null): GeneratorPrefs {
  const get = (k: string): string | null => {
    try { return read(k); } catch { return null; }
  };
  const route = get(PREF_KEYS.route);
  const base = get(PREF_KEYS.localBase);
  const model = get(PREF_KEYS.localModel);
  const cloud = get(PREF_KEYS.cloudModel);
  return {
    route: route === 'local' || route === 'claude' ? route : null,
    localBase: (base !== null && normalizeLocalBase(base)) || DEFAULT_LOCAL_BASE,
    localModel: model !== null && isUsableModelId(model) ? model : '',
    cloudModel: isClaudeModel(cloud) ? cloud : DEFAULT_CLAUDE_MODEL,
  };
}

export function saveGeneratorPref(key: keyof typeof PREF_KEYS, value: string): void {
  try { localStorage.setItem(PREF_KEYS[key], value); } catch { /* storage blocked: nothing to remember */ }
}
