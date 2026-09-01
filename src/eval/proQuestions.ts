/**
 * The professional block — asked only in the `/evalpro` arm.
 *
 * DRAFT CONTENT. The mechanism is finished; the questions below are a
 * placeholder set chosen to match what this study is actually about, and are
 * meant to be reviewed and replaced by the researcher. Editing them is editing
 * this one array — nothing else knows what the questions are.
 *
 * Why these five. A professional's answers are only useful next to their
 * working context: how long they have done this, what they ship to, how often
 * they touch shaders at all, and — the one that speaks directly to the
 * cost-feedback experiment — whether GPU performance budgets constrain their
 * everyday work. The last question is the adoption signal a tool paper wants.
 *
 * Two shapes only, so the UI stays the SUS radio strip plus a text field:
 * `scale` (five ordered options, each with its own labels) and `text`.
 *
 * PURE (node-tested).
 */

export interface ProScaleQuestion {
  kind: 'scale';
  id: string;
  question: string;
  /** Five ordered option labels, low → high. Index IS the stored value. */
  levels: readonly string[];
}

export interface ProTextQuestion {
  kind: 'text';
  id: string;
  question: string;
}

export type ProQuestion = ProScaleQuestion | ProTextQuestion;

export const PRO_ITEMS: readonly ProQuestion[] = [
  {
    kind: 'text',
    id: 'role',
    question: 'Your role (for example: technical artist, game developer, lecturer)',
  },
  {
    kind: 'scale',
    id: 'years',
    question: 'How long have you worked professionally with 3D or real-time graphics?',
    levels: ['Under a year', '1–3 years', '3–5 years', '5–10 years', 'Over 10 years'],
  },
  {
    kind: 'scale',
    id: 'shaderFrequency',
    question: 'How often do you create or edit shaders in your work?',
    levels: ['Never', 'A few times a year', 'Monthly', 'Weekly', 'Daily'],
  },
  {
    kind: 'scale',
    id: 'performanceBudget',
    question: 'How often does GPU performance constrain what you can build?',
    levels: ['Never', 'Rarely', 'Sometimes', 'Often', 'Always'],
  },
  {
    kind: 'text',
    id: 'platforms',
    question: 'Which platforms do you target? (for example: VR headsets, mobile, desktop, web)',
  },
  {
    kind: 'scale',
    id: 'wouldUse',
    question: 'Could you see a tool like this being useful in your own work?',
    levels: ['Definitely not', 'Probably not', 'Maybe', 'Probably yes', 'Definitely yes'],
  },
];

export const PRO_SCALE_ITEMS = PRO_ITEMS.filter(
  (q): q is ProScaleQuestion => q.kind === 'scale',
);

export type ProAnswers = Record<string, number | string | null>;

/**
 * Every SCALE answered? Free-text questions never block submit — a
 * professional who does not target a platform worth naming must still be able
 * to finish, and an empty string is a real answer.
 */
export function proComplete(answers: ProAnswers): boolean {
  return PRO_SCALE_ITEMS.every((q) => {
    const v = answers[q.id];
    return Number.isInteger(v) && (v as number) >= 0 && (v as number) < q.levels.length;
  });
}

/** The package's `professional` block: value plus label, like `background`. */
export function buildProRecord(answers: ProAnswers): Record<string, unknown> {
  return {
    items: PRO_ITEMS.map((q) => {
      if (q.kind === 'text') {
        const raw = answers[q.id];
        const text = typeof raw === 'string' ? raw.trim() : '';
        return { id: q.id, question: q.question, kind: 'text', text };
      }
      const v = answers[q.id];
      const level = Number.isInteger(v) ? (v as number) : null;
      return {
        id: q.id,
        question: q.question,
        kind: 'scale',
        levels: q.levels,
        level,
        label: level == null ? null : q.levels[level],
      };
    }),
  };
}
