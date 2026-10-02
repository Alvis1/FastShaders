/**
 * Which language version of the SUS a participant ANSWERED.
 *
 * The questionnaire carries its own EN/LV switch (owner request, 2026-10-02),
 * so one form can be answered partly in each language — and the Latvian
 * statements are a non-validated adaptation, so "which version did this
 * participant rate" is a split the analysis reports, not a detail. The UI
 * language at Submit cannot answer it: someone who rated every English
 * statement and then switched to read the comment prompt in Latvian would be
 * counted as a Latvian form, and the reverse would pass Latvian ratings off as
 * the validated English ones.
 *
 * So SusModal notes the UI language at each SUS radio's onChange — the moment
 * the answer was GIVEN; re-reading a statement after a switch changes nothing —
 * and this turns those notes into the record: one language per item, and the
 * form's language, or 'mixed' when the answers span both.
 *
 * PURE (node-tested).
 */
import type { Language } from '@/i18n';

export type FormLanguage = Language | 'mixed';

/**
 * `perItem[i]` is the language item i was answered in. An item with no note
 * (not reachable through the UI, which requires every answer) counts as
 * `fallback`, the language at Submit.
 */
export function summarizeAnswerLanguages(
  perItem: readonly (Language | undefined)[],
  fallback: Language,
): { language: FormLanguage; perItem: Language[] } {
  const filled = perItem.map((l) => l ?? fallback);
  const distinct = new Set(filled);
  return { language: distinct.size > 1 ? 'mixed' : (filled[0] ?? fallback), perItem: filled };
}
