/**
 * The experience block, asked BEFORE the SUS in every arm.
 *
 * It exists because a usability score is not interpretable without knowing
 * who gave it: "this editor is easy to learn" means something different from
 * someone who builds materials in Blender every week than from someone who
 * has never seen a node editor.
 *
 * Version bg-3 (consent-13, 2026-10-25) asks what people have DONE, never
 * what they ARE: which tools they have made materials or shaders with (one
 * Yes/No row each — Blender, Unreal, Unity, three.js/A-Frame, and "another
 * node-based shader editor", whose Yes opens ONE write-in that takes several
 * names, which the owner wants to know; the web row is what tells an
 * engine-side professional from a web-side one). The owner turned the
 * catch-all "Other tools" into the node-editor write-in, kept last
 * (2026-10-26, bg-3 still undeployed, so the version stays), how much they have worked with node editors (never →
 * use them in paid work), and whether they have written or changed shader
 * code (no → changed existing code → written their own) — three behavioural
 * rungs, kept because the research question names its population as "users
 * without programming expertise" and nothing else here tells a shader
 * programmer from an artist fluent in Blender nodes. bg-2 (consent-12, never
 * deployed) had a TouchDesigner row, an "another node editor" row and a
 * five-step shader-code ladder under a two-sentence stem; the owner cut the
 * row and found the ladder too long (2026-10-25), so bg-2's ids retire with
 * it. The first version asked for a None→Expert self-rating of Blender,
 * Unreal and shader programming (ids blender/unreal/shaderCode, the 2026
 * pilot's items; `otherNodeEditors` was removed on 2026-10-02): a level is
 * read against one's own peers, and anyone fluent in Unity read as a novice.
 * The 20 packages of the first student wave carry that version
 * (`background.items[].level`, 0–4); `scripts/eval-analysis.mjs` reads both,
 * never pooled. RETIRED_BACKGROUND_IDS are never reused.
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

export const BACKGROUND_ITEMS_VERSION = 'bg-3';

/** Every earlier version's ids. Never reuse one: the first wave's 0–4 levels
 *  and the pilot's free-text item ride 20 packages, and bg-2's two were
 *  reworded (never deployed, retired all the same). */
export const RETIRED_BACKGROUND_IDS: readonly string[] = [
  'blender', 'unreal', 'otherNodeEditors', 'shaderCode',
  'toolsUsed', 'shaderCodeDepth',
];

export const BACKGROUND_HEADING: QText = { en: 'Your experience', lv: 'Jūsu pieredze' };

/** The one group's heading, read by the renderer and pinned by the test so a
 *  mistyped group cannot blank the questionnaire at its first render. */
export const BACKGROUND_GROUP_HEADINGS: Record<string, QText> = { experience: BACKGROUND_HEADING };

export const BACKGROUND_ITEMS: readonly QItem[] = [
  {
    kind: 'grid', id: 'toolsMade', group: 'experience',
    question: {
      en: 'Have you made materials or shaders with these tools?',
      lv: 'Vai ar šiem rīkiem jums ir gadījies veidot materiālus vai ēnotājus?',
    },
    rows: [
      { id: 'blender', en: 'Blender', lv: 'Blender' },
      { id: 'unreal', en: 'Unreal Engine', lv: 'Unreal Engine' },
      { id: 'unity', en: 'Unity', lv: 'Unity' },
      { id: 'web3d', en: 'three.js or A-Frame (web 3D)', lv: 'three.js vai A-Frame (tīmekļa 3D)' },
      { id: 'otherNodeEditor', en: 'Another node-based shader editor', lv: 'Cits mezglu ēnotāju redaktors' },
    ],
    columns: [YES, NO],
    otherRowId: 'otherNodeEditor',
    otherHint: { en: 'Which one? You can list several (optional)', lv: 'Kurš? Varat nosaukt vairākus (pēc izvēles)' },
  },
  {
    kind: 'choice', id: 'nodeEditorUse', group: 'experience',
    question: {
      en: 'How much have you worked with node-based shader or material editors?',
      lv: 'Cik daudz jums ir nācies strādāt ar ēnotāju vai materiālu mezglu redaktoriem?',
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
    kind: 'choice', id: 'shaderCodeWritten', group: 'experience',
    question: {
      en: 'Have you written or changed shader code (GLSL, HLSL, WGSL…)?',
      lv: 'Vai jums ir nācies rakstīt vai mainīt ēnotāju kodu (GLSL, HLSL, WGSL…)?',
    },
    options: [
      { id: 'no', en: 'No', lv: 'Nē' },
      { id: 'changed', en: 'Only changed existing code (values, small edits)', lv: 'Tikai mainīju gatavu kodu (vērtības, nelieli labojumi)' },
      { id: 'own', en: 'Yes, I have written my own shaders', lv: 'Jā, rakstīju savus ēnotājus' },
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
