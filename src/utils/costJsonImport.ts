/**
 * A benchmark `.json` → device profile(s): an exported PROFILE BUNDLE (the
 * cost bar's "Export profiles… → all"), else a single complexity patch or
 * bench suggestion. The code panel's drop and the Import buttons'
 * router (utils/fileImport.ts) share it. Adversarial text: both parsers
 * validate, and a run flagged invalid is added only after a confirm.
 *
 * Returns false when the text is neither: the caller says what that means
 * (the drop: "not a complexity patch"; an Import: perhaps a palette).
 */
import { useAppStore } from '@/store/useAppStore';
import { t, type Language } from '@/i18n';
import { parseCostFile, parseCostProfileBundle } from '@/utils/costOverride';

export function importCostJsonText(text: string, fileName: string, language: Language): boolean {
  // An exported PROFILE BUNDLE first. It has no top-level `costs`, so the
  // single parser reads it as junk and the app would reject a file it wrote
  // seconds earlier (while accepting its single-profile sibling, which is the
  // confusing half of the asymmetry).
  const bundle = parseCostProfileBundle(text, fileName);
  if (bundle) {
    const bad = bundle.filter((p) => p.meta.valid === false);
    let list = bundle;
    if (bad.length && !window.confirm(
      `${t('This file contains {n} benchmark runs flagged invalid:', language).replace('{n}', String(bad.length))}\n\n` +
      `${bad.map((p) => `• ${p.self?.label ?? p.meta.device ?? '?'}: ${p.meta.reasons.join('; ')}`).join('\n')}\n\n` +
      t('Add them as device profiles anyway? Cancel imports only the valid ones.', language),
    )) {
      list = bundle.filter((p) => p.meta.valid !== false);
    }
    if (list.length) useAppStore.getState().importCostProfiles(list, { select: 'current' });
    return true;
  }
  const parsed = parseCostFile(text, fileName);
  if (!parsed) return false;
  if (
    parsed.meta.valid === false &&
    !window.confirm(
      `${t('This benchmark run was flagged invalid:', language)}\n\n` +
      `${parsed.meta.reasons.join('\n')}\n\n` +
      t('Add it as a device profile anyway?', language),
    )
  ) return true;
  useAppStore.getState().importCostProfile(parsed);
  return true;
}
