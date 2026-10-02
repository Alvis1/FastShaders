/**
 * The three experience questions asked BEFORE the SUS (EVAL_MODE_PLAN.md §8).
 *
 * They exist because a usability score is not interpretable without knowing
 * who gave it: "this editor is easy to learn" means something different from
 * someone who has used Blender's shader graph for years than from someone who
 * has never seen a node editor. They are asked before the SUS rather than
 * after so that thinking about one's own expertise does not colour the SUS
 * answers — and they are quick, so they cost the participant almost nothing.
 *
 * Before consent-9 a third item asked about "other node-based editors" with a
 * free-text "Which software?" box (`otherNodeEditors`, `otherNodeEditorsText`
 * in the package). The owner REMOVED it on 2026-10-02 — the shader-knowledge
 * question, asked since the block was created, moved up to third — so
 * packages from before then carry four items and later ones three;
 * `scripts/eval-analysis.mjs` reads both.
 *
 * One shared 5-point scale, none → expert, the same width as the SUS strip so
 * the whole questionnaire reads as one instrument rather than two.
 *
 * PURE (node-tested). Labels are English keys the i18n overlay translates;
 * Latvian is the study language and carries the researcher's own wording.
 */

export const BACKGROUND_SCALE_MIN = 0;
export const BACKGROUND_SCALE_MAX = 4;

/** none → expert. Index IS the stored value, so the order is the contract. */
export const EXPERIENCE_LEVELS: readonly string[] = [
  'None',
  'Beginner',
  'Intermediate',
  'Advanced',
  'Expert',
];

export interface BackgroundItem {
  /** Stable key — what the package records; never renamed. */
  id: 'blender' | 'unreal' | 'shaderCode';
  question: string;
}

export const BACKGROUND_ITEMS: readonly BackgroundItem[] = [
  { id: 'blender', question: 'Experience with Blender Shader Editor' },
  { id: 'unreal', question: 'Experience with Unreal Engine Material Editor' },
  { id: 'shaderCode', question: 'Technical knowledge of shader programming (e.g. GLSL, HLSL)' },
];

export type BackgroundAnswers = Record<string, number | null>;

/** Every scale answered? They are the covariate the SUS is read against, so
 *  all of them gate submit. */
export function backgroundComplete(answers: BackgroundAnswers): boolean {
  return BACKGROUND_ITEMS.every((it) => {
    const v = answers[it.id];
    return Number.isInteger(v) && (v as number) >= BACKGROUND_SCALE_MIN && (v as number) <= BACKGROUND_SCALE_MAX;
  });
}

/** The package's `background` block: the raw level plus its label, so a
 *  reader never has to guess what 2 meant. */
export function buildBackgroundRecord(answers: BackgroundAnswers): Record<string, unknown> {
  return {
    scale: EXPERIENCE_LEVELS,
    items: BACKGROUND_ITEMS.map((it) => {
      const v = answers[it.id];
      const level = Number.isInteger(v) ? (v as number) : null;
      return {
        id: it.id,
        question: it.question,
        level,
        label: level == null ? null : EXPERIENCE_LEVELS[level],
      };
    }),
  };
}
