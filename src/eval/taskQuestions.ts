/**
 * The student / general-session block — asked in `/eval` and `/evalp` AFTER
 * SUS item 10 and before the shared experience block (`background.ts`).
 *
 * Why it exists and why it sits after the SUS:
 *   1. Every participant in every arm answers the 10 SUS items FIRST, under
 *      identical context (Brooke 1996), with no prior self-assessment or
 *      condition-specific prime.
 *   2. Immediately after SUS item 10, `/eval` and `/evalp` ask four brief
 *      construct-specific questions that telemetry and SUS cannot observe on
 *      their own:
 *        - `finished`: subjective task completion (distinguishes "finished
 *          early" from "gave up / got stuck", which both look like short
 *          `active_min` in telemetry);
 *        - `mentalEffort`: single-item subjective cognitive load (Paas 1992,
 *          5-point verbal anchors), separating usability from task mental
 *          effort across conditions;
 *        - `nodeLookTold`: Cognitive Dimensions role-expressiveness (CD5,
 *          Green & Petre 1996) split into function (`does`) and performance
 *          impact (`cost`, design principle P1) — identical to the first item
 *          of `proQuestions.ts`, serving as both a P1 measure and a
 *          manipulation check between `/eval` and `/evalp`;
 *        - `pointsChangedBuild`: four behavioural feedforward rungs (identical
 *          to `proQuestions.ts`; telemetry's `budgetCrossings` splits `looked`
 *          into within-budget vs. over-budget), asked only when
 *          `pointsVisible === true` so `/evalp` participants are never asked
 *          about points they could not see.
 *
 * PURE (node-tested).
 */

import {
  NO,
  YES,
  buildRecord,
  csvColumns,
  missingKeys,
  requiredKeys,
  type QAnswers,
  type QItem,
  type QLang,
  type QText,
} from './questionItems';

export const TASK_ITEMS_VERSION = 'tq-1';

/** Retired ids from earlier task-question drafts. Never reuse one. */
export const RETIRED_TASK_IDS: readonly string[] = [];

export const TASK_GROUP_HEADINGS: Record<string, QText> = {
  session: { en: 'This session and the editor', lv: 'Šī sesija un redaktors' },
};

const PARTLY = { id: 'partly', en: 'Partly', lv: 'Daļēji' };

export const TASK_ITEMS: readonly QItem[] = [
  {
    kind: 'choice', id: 'finished', group: 'session',
    question: {
      en: 'Did you finish what you set out to build?',
      lv: 'Vai izdevās izveidot to, ko bijāt iecerējis(-usi)?',
    },
    options: [
      { id: 'yes', en: 'Yes', lv: 'Jā' },
      PARTLY,
      { id: 'stuck', en: 'No — I got stuck or stopped early', lv: 'Nē — iestrēgu vai pārtraucu agrāk' },
    ],
  },
  {
    kind: 'choice', id: 'mentalEffort', group: 'session',
    question: {
      en: 'How much mental effort did building your shader take?',
      lv: 'Cik daudz garīgās piepūles prasīja ēnotāja izveide?',
    },
    options: [
      { id: 'veryLow', en: 'Very little', lv: 'Ļoti maz' },
      { id: 'low', en: 'Little', lv: 'Maz' },
      { id: 'moderate', en: 'Moderate', lv: 'Vidēji' },
      { id: 'high', en: 'High', lv: 'Daudz' },
      { id: 'veryHigh', en: 'Very high', lv: 'Ļoti daudz' },
    ],
  },
  {
    kind: 'grid', id: 'nodeLookTold', group: 'session',
    question: {
      en: "Could you tell this from a node's look?",
      lv: 'Vai to varēja saprast pēc mezgla izskata?',
    },
    rows: [
      { id: 'does', en: 'What it does', lv: 'Ko mezgls dara' },
      { id: 'cost', en: 'Its impact on performance', lv: 'Tā ietekmi uz veiktspēju' },
    ],
    columns: [YES, PARTLY, NO],
  },
  {
    kind: 'choice', id: 'pointsChangedBuild', group: 'session',
    question: {
      en: 'Did the points change what you built?',
      lv: 'Vai punkti mainīja to, ko veidojāt?',
    },
    options: [
      { id: 'ignored', en: 'No — I did not pay attention to them', lv: 'Nē — nepievērsu tiem uzmanību' },
      { id: 'looked', en: 'No — I checked them, but changed nothing', lv: 'Nē — sekoju tiem līdzi, bet neko nemainīju' },
      { id: 'chose', en: 'Yes — I picked cheaper nodes when adding', lv: 'Jā — pievienojot izvēlējos lētākus mezglus' },
      { id: 'replaced', en: 'Yes — I replaced or removed expensive nodes', lv: 'Jā — aizstāju vai noņēmu dārgus mezglus' },
    ],
  },
];

/** The items shown for the session's `pointsVisible` condition (`/evalp` omits `pointsChangedBuild`). */
export const taskItemsFor = (pointsVisible = true): readonly QItem[] =>
  pointsVisible ? TASK_ITEMS : TASK_ITEMS.filter((q) => q.id !== 'pointsChangedBuild');

export const taskRequiredKeys = (pointsVisible = true): string[] =>
  requiredKeys(taskItemsFor(pointsVisible));

export const taskMissing = (answers: QAnswers, pointsVisible = true): string[] =>
  missingKeys(taskItemsFor(pointsVisible), answers);

export const taskComplete = (answers: QAnswers, pointsVisible = true): boolean =>
  taskMissing(answers, pointsVisible).length === 0;

/** The package's `taskQuestions` block (sus.json, `/eval` and `/evalp`). */
export function buildTaskRecord(
  answers: QAnswers,
  langs: Record<string, QLang | undefined> = {},
  pointsVisible = true,
): Record<string, unknown> {
  return {
    itemsVersion: TASK_ITEMS_VERSION,
    placement: 'after-sus',
    items: buildRecord(taskItemsFor(pointsVisible), answers, langs),
  };
}

/** summary.csv's tq_* columns (all four items in fixed column order; empty on `/evalpro`). */
export const taskCsvColumns = (block: unknown): [string, unknown][] =>
  csvColumns('tq', TASK_ITEMS, block);
