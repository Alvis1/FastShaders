/**
 * The experience block, asked BEFORE the SUS in every arm.
 *
 * It exists because a usability score is not interpretable without knowing
 * who gave it: "this editor is easy to learn" means something different from
 * someone who builds materials in Blender every week than from someone who
 * has never seen a node editor.
 *
 * Version bg-2 (consent-12, 2026-10-24) asks what people have DONE, never
 * what they ARE: which tools they have made materials or shaders with (one
 * Yes/No row each), how much they have worked with node editors, and whether
 * they have written shader code — behavioural anchors with an honest answer
 * for a student and a professional alike. The first version asked for a
 * None→Expert self-rating of Blender, Unreal and shader programming (ids
 * blender/unreal/shaderCode, the 2026 pilot's items; `otherNodeEditors` was
 * removed on 2026-10-02): a level is read against one's own peers, and anyone
 * fluent in Unity or TouchDesigner read as a novice. The 20 packages of the
 * first student wave carry that version (`background.items[].level`, 0–4);
 * `scripts/eval-analysis.mjs` reads both, never pooled. The ids below are
 * new, and RETIRED_BACKGROUND_IDS are never reused.
 *
 * The block stays before the SUS, as it has been since the first packages and
 * as the pilot asked it. That order does NOT keep self-assessment from
 * colouring the SUS — it makes these answers the SUS's immediate context, so
 * a context effect cannot be ruled out and the paper says so; what the order
 * protects is these answers from the SUS ones. Latvian lives beside the
 * English (questionItems.ts says why).
 *
 * PURE (node-tested).
 */

import {
  NO,
  YES,
  buildRecord,
  csvColumns,
  missingKeys,
  type QAnswers,
  type QItem,
  type QLang,
  type QText,
} from './questionItems';

export const BACKGROUND_ITEMS_VERSION = 'bg-2';

/** The first version's ids (0–4 levels) and the pilot's free-text item. Never reuse one. */
export const RETIRED_BACKGROUND_IDS: readonly string[] = ['blender', 'unreal', 'otherNodeEditors', 'shaderCode'];

export const BACKGROUND_HEADING: QText = { en: 'Your experience', lv: 'Jūsu pieredze' };

export const BACKGROUND_ITEMS: readonly QItem[] = [
  {
    kind: 'grid', id: 'toolsUsed', group: 'experience',
    question: {
      en: 'Have you made materials or shaders with these tools?',
      lv: 'Vai esat veidojis/-usi materiālus vai ēnotājus ar šiem rīkiem?',
    },
    rows: [
      { id: 'blender', en: 'Blender', lv: 'Blender' },
      { id: 'unreal', en: 'Unreal Engine', lv: 'Unreal Engine' },
      { id: 'unity', en: 'Unity', lv: 'Unity' },
      { id: 'touchdesigner', en: 'TouchDesigner', lv: 'TouchDesigner' },
      { id: 'other', en: 'Another node editor', lv: 'Cits mezglu redaktors' },
    ],
    columns: [YES, NO],
  },
  {
    kind: 'choice', id: 'nodeEditorUse', group: 'experience',
    question: {
      en: 'How much have you worked with node-based shader or material editors?',
      lv: 'Cik daudz pieredzes jums ir ar ēnotāju vai materiālu mezglu redaktoriem?',
    },
    options: [
      { id: 'never', en: 'Never', lv: 'Nekad' },
      { id: 'tried', en: 'Tried once or twice', lv: 'Izmēģināju pāris reizes' },
      { id: 'few', en: 'Made a few things', lv: 'Izveidoju dažas lietas' },
      { id: 'regular', en: 'Use them regularly', lv: 'Lietoju regulāri' },
      { id: 'paid', en: 'Use them in paid work', lv: 'Lietoju algotā darbā' },
    ],
  },
  {
    kind: 'choice', id: 'shaderCodeUse', group: 'experience',
    question: {
      en: 'Have you written shader code (GLSL, HLSL, WGSL…)?',
      lv: 'Vai esat rakstījis/-usi ēnotāju kodu (GLSL, HLSL, WGSL…)?',
    },
    options: [
      { id: 'no', en: 'No', lv: 'Nē' },
      { id: 'read', en: 'I have read or copied some', lv: 'Lasīju vai kopēju kādu kodu' },
      { id: 'small', en: 'I have written small shaders', lv: 'Rakstīju nelielus ēnotājus' },
      { id: 'regular', en: 'I write it regularly', lv: 'Rakstu regulāri' },
    ],
  },
];

export type BackgroundAnswers = QAnswers;

export const backgroundMissing = (answers: BackgroundAnswers): string[] => missingKeys(BACKGROUND_ITEMS, answers);

/** Every row and choice answered? They are the covariate the SUS is read
 *  against, so all of them gate submit. */
export const backgroundComplete = (answers: BackgroundAnswers): boolean => backgroundMissing(answers).length === 0;

/** The package's `background` block: the wording asked, the answer and its language. */
export function buildBackgroundRecord(
  answers: BackgroundAnswers,
  langs: Record<string, QLang | undefined> = {},
): Record<string, unknown> {
  return { itemsVersion: BACKGROUND_ITEMS_VERSION, items: buildRecord(BACKGROUND_ITEMS, answers, langs) };
}

/** summary.csv's bg_* columns (empty for a block of another version). */
export const backgroundCsvColumns = (block: unknown): [string, unknown][] =>
  csvColumns('bg', BACKGROUND_ITEMS, block);
