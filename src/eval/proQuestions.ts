/**
 * The professional block — asked only in the `/evalpro` arm, AFTER SUS item 10
 * and before the comment box.
 *
 * Why after the SUS. Everything a participant sees up to SUS item 10 is the
 * same in every arm, so a professional's SUS is collected in the same context
 * as a student's. The first draft (consent-6 … consent-11) sat BEFORE the SUS
 * and ended on "Would a tool like this be useful in your work?" — an
 * arm-specific lead-in, with a GPU question naming the very thing the study
 * manipulates. No package ever carried that draft, so its ids are retired
 * rather than migrated.
 *
 * The method (pro-3, consent-13, 2026-10-25). The professional study is a
 * structured expert review — n ≈ 6–10, so medians, counts and quotes, never
 * p-values — and the block is built BACKWARDS from the sentences the
 * dissertation has to write: one item per sentence, no item without one, and
 * nothing that re-asks what the SUS already measures (ease, complexity,
 * confidence, learnability, the need for technical support). pro-2 (never
 * deployed) opened with the 2026 pilot's Q5–Q9 — five more agreement items
 * straight after ten SUS ones, three of them the SUS's own content — followed
 * by four credibility items that said one thing twice; the owner found it
 * repetitive (2026-10-25). The pilot items stay on the STUDENT paper form,
 * where the continuity hypothesis (H2) lives. In screen order:
 *   1. the tool — could a node's LOOK tell what it does and what it costs
 *      (Cognitive Dimensions role-expressiveness, CD5, answered as two
 *      Yes/Partly/No rows so the cost half, design principle P1, reads alone),
 *      and did the code panel and the presets help (P4 dual modality, P5
 *      presets — the one invented item; the plan had none for them);
 *   2. the cost points (SQ3, the expert half of thesis 3) — credibility (E3,
 *      the block's first agreement item, reported beside the measured ranking
 *      concordance), whether the points CHANGED what was built as five
 *      behavioural rungs (E2 recast: ignored / looked, stayed within budget /
 *      looked, went over / chose cheaper from the start / replaced or removed
 *      — only the last pairs with a logged edit), tolerance of a ±20 % per-node
 *      error (E7, spelled out so every expert answers the same question), and
 *      where such a system might mislead (E6, open);
 *   3. fit — teaching / prototyping / production as forced Yes/No rows (H2),
 *      and what got in the way or would have to change (H6 + H7, open);
 *   4. the respondent's own work — whether WebXR's constraints deter them (W2,
 *      the Introduction's motivating claim measured on the people it is made
 *      about; the second and last agreement item), how they find out today
 *      that a shader is too expensive (F1, the feedforward mechanism in their
 *      own words), main work (B1) and years of paid experience (B2, the
 *      inclusion criterion). Tools and shader code are the shared experience
 *      block's (background.ts) — nothing is asked twice.
 * Cut from the planned E1 form, deliberately: QUESI and the technology-
 * familiarity list (the student line; no 0–4 kind here), E1 (the intro's
 * budget slide makes "without explanation" false), E4 (collinear with E3),
 * E5 (E7 asks it in the respondent's terms), F2–F4, W1 and W3–W5, H0
 * ("reminded me of" is near-tautological for someone who just ticked
 * Blender), H1 (one comparative item against heterogeneous reference tools is
 * uninterpretable at this n), H3 (no 0–10 kind; fitFor is the verdict), the
 * issue log (missingForWork and the comment box), and pro-2's 12-month
 * platform grid (the experience block's web row carries the engine/web
 * split). Every required question has an honest answer for everyone ("Can't
 * judge", "Did not use", "I have not had to find out", "Studying", "No paid
 * experience"). Each agreement item is FIRST in its group: the renderer
 * prints the 1–5 legend above the first agree item of a run.
 *
 * The item model and the Latvian-beside-English rule are questionItems.ts's.
 *
 * Rewording a question changes what it measures: give it a NEW id, bump
 * PRO_ITEMS_VERSION, and never reuse an id in RETIRED_PRO_IDS.
 *
 * PURE (node-tested).
 */

import {
  CANT,
  NO,
  YES,
  buildRecord,
  csvColumns,
  missingKeys,
  requiredKeys,
  type AgreeItem,
  type ChoiceItem,
  type GridItem,
  type QAnswers,
  type QItem,
  type QLang,
  type QText,
  type TextItem,
} from './questionItems';

export { CANT_JUDGE, gridKey, otherKey } from './questionItems';
export type ProLang = QLang;
export type ProText = QText;
export type ProAnswers = QAnswers;
export type ProQuestion = QItem;
export type ProAgreeItem = AgreeItem;
export type ProChoiceItem = ChoiceItem;
export type ProGridItem = GridItem;
export type ProTextItem = TextItem;
export type ProGroup = 'tool' | 'points' | 'fit' | 'work';

export const PRO_ITEMS_VERSION = 'pro-3';

/** Ids of the first draft (consent-6 … consent-11) and of pro-2 (consent-12,
 *  never deployed). Never reuse one. */
export const RETIRED_PRO_IDS: readonly string[] = [
  'role', 'years', 'shaderFrequency', 'performanceBudget', 'platforms', 'wouldUse',
  'pilotQ5', 'pilotQ6', 'pilotQ7', 'pilotQ8', 'pilotQ9',
  'pointsUnderstood', 'pointsInfluenced', 'pointsTrusted', 'pointsRanking', 'pointsOff20',
  'platforms12m', 'realtimeYears',
];

export const PRO_GROUP_HEADINGS: Record<ProGroup, QText> = {
  tool: { en: 'FastShaders as a tool', lv: 'FastShaders kā rīks' },
  points: { en: 'The cost points', lv: 'Izmaksu punkti' },
  fit: { en: 'FastShaders and your work', lv: 'FastShaders un jūsu darbs' },
  work: { en: 'Your own work', lv: 'Jūsu darbs' },
};

export const PRO_GROUP_NOTES: Partial<Record<ProGroup, QText>> = {
  tool: {
    en: 'About the editor you just used: the nodes, the code panel and the presets.',
    lv: 'Par redaktoru, ko tikko lietojāt, — mezgliem, koda paneli un sagatavēm.',
  },
  points: {
    en: 'About the point numbers you saw on the nodes and in the cost bar.',
    lv: 'Par punktu skaitļiem, ko redzējāt pie mezgliem un izmaksu joslā.',
  },
  work: {
    en: 'About your usual work, not about FastShaders.',
    lv: 'Par jūsu ierasto darbu, nevis par FastShaders.',
  },
};

const PARTLY = { id: 'partly', en: 'Partly', lv: 'Daļēji' };

export const PRO_ITEMS: readonly QItem[] = [
  // 1. The tool. CD5 (Green & Petre 1996) asks both halves in one breath —
  // "what it does and what it costs" — so the ANSWER is split, not the
  // question: the cost row alone is the P1 sentence.
  {
    kind: 'grid', id: 'nodeLookTold', group: 'tool',
    question: {
      en: "Could you tell this from a node's look?",
      lv: 'Vai to varēja saprast pēc mezgla izskata?',
    },
    rows: [
      { id: 'does', en: 'What it does', lv: 'Ko mezgls dara' },
      { id: 'cost', en: 'How many points it costs', lv: 'Cik punktu tas maksā' },
    ],
    columns: [YES, PARTLY, NO],
  },
  {
    kind: 'grid', id: 'featuresHelped', group: 'tool',
    question: {
      en: 'Did these help you?',
      lv: 'Vai šīs iespējas jums palīdzēja?',
    },
    rows: [
      { id: 'codePanel', en: 'The code panel (the TSL code beside the graph)', lv: 'Koda panelis (TSL kods blakus grafam)' },
      { id: 'presets', en: 'Presets (ready-made effects you can open and edit)', lv: 'Sagataves (gatavi efekti, ko var atvērt un rediģēt)' },
    ],
    // "Got in the way" is kept apart from "No difference": the code panel is
    // the feature most likely to HINDER, and the student sheet's CF1 keeps
    // hinder / neither / help apart too. "Did not use" is honest for everyone.
    columns: [
      { id: 'helped', en: 'Helped', lv: 'Palīdzēja' },
      { id: 'neither', en: 'No difference', lv: 'Ne palīdzēja, ne traucēja' },
      { id: 'hindered', en: 'Got in the way', lv: 'Traucēja' },
      { id: 'notUsed', en: 'Did not use', lv: 'Nelietoju' },
    ],
  },

  // 2. The cost points (E1 form, section E). Points are always shown on
  // /evalpro (evalTask.ts), so everyone here saw them.
  {
    kind: 'agree', id: 'pointsCredible', group: 'points', cantJudge: true,
    question: {
      en: 'The point values seemed credible given my experience with real-time performance.',
      lv: 'Punktu vērtības šķita ticamas, ņemot vērā manu pieredzi ar reāllaika veiktspēju.',
    },
  },
  {
    kind: 'choice', id: 'pointsChangedBuild', group: 'points',
    question: {
      en: 'Did the cost points change what you built? Mark the one that fits best.',
      lv: 'Vai izmaksu punkti mainīja to, ko veidojāt? Atzīmējiet atbilstošāko.',
    },
    // Five states, each with its own cell: "looked, stayed within budget" is
    // the meter working as a guide, "chose cheaper from the start" the
    // strongest feedforward case and the one telemetry cannot see.
    options: [
      { id: 'ignored', en: 'No — I paid no attention to them', lv: 'Nē — nepievērsu tiem uzmanību' },
      { id: 'lookedWithin', en: 'I looked, but changed nothing: my build stayed within budget', lv: 'Skatījos, bet neko nemainīju: mans darbs palika budžetā' },
      { id: 'lookedOver', en: 'I looked, but changed nothing, even when it went over budget', lv: 'Skatījos, bet neko nemainīju, arī tad, kad tas pārsniedza budžetu' },
      { id: 'chose', en: 'Yes — I chose cheaper nodes from the start', lv: 'Jā — jau no sākuma izvēlējos lētākus mezglus' },
      { id: 'replaced', en: 'Yes — I replaced or removed something', lv: 'Jā — kaut ko aizstāju vai noņēmu' },
    ],
  },
  {
    kind: 'choice', id: 'pointsOff20PerNode', group: 'points',
    // The error is spelled per node and either way: a uniform 20 % bias
    // leaves every ranking intact, so "off by 20 %" alone was two questions.
    question: {
      en: "If each node's points could be about 20% too high or too low, would the meter still help keep a shader within budget?",
      lv: 'Ja katra mezgla punkti varētu būt par aptuveni 20 % par lielu vai par mazu, vai rādītājs joprojām palīdzētu ēnotājam iekļauties budžetā?',
    },
    options: [YES, PARTLY, NO, CANT],
  },
  {
    kind: 'text', id: 'pointsMisleading', group: 'points',
    question: {
      en: 'Where might such a point system mislead its user? (optional)',
      lv: 'Kur, jūsuprāt, šāda punktu sistēma varētu maldināt lietotāju? (pēc izvēles)',
    },
  },

  // 3. Fit (E1 form H2), one Yes/No row per use, then the obstacles.
  {
    kind: 'grid', id: 'fitFor', group: 'fit',
    question: {
      en: 'What is FastShaders, as you used it today, suited for?',
      lv: 'Kam FastShaders — tāds, kādu to šodien lietojāt — ir piemērots?',
    },
    rows: [
      { id: 'teaching', en: 'Teaching or learning shader basics', lv: 'Ēnotāju pamatu mācīšanai un apguvei' },
      { id: 'prototyping', en: 'Quick prototyping of effects', lv: 'Ātrai efektu prototipēšanai' },
      { id: 'production', en: 'Production work in real projects', lv: 'Darbam reālos projektos' },
    ],
    columns: [YES, NO, CANT],
  },
  {
    kind: 'text', id: 'missingForWork', group: 'fit',
    question: {
      en: 'What got in your way, or would have to change, before you used FastShaders in your own work? (optional)',
      lv: 'Kas jums traucēja vai kam būtu jāmainās, lai jūs FastShaders lietotu savā darbā? (pēc izvēles)',
    },
  },

  // 4. The respondent's own work. Options name ACTIVITIES, not people, so the
  // Latvian never has to pick a gender for the respondent.
  {
    kind: 'agree', id: 'webxrConstraintsDeter', group: 'work', cantJudge: true,
    question: {
      en: 'The constraints of WebXR development (performance, tooling, browser support) deter me from using it.',
      lv: 'WebXR izstrādes ierobežojumi (veiktspēja, rīki, pārlūku atbalsts) mani attur no tā lietošanas.',
    },
  },
  {
    kind: 'choice', id: 'costToday', group: 'work',
    question: {
      en: 'In your own work, how do you usually find out that a shader is too expensive?',
      lv: 'Kā jūs savā darbā parasti uzzināt, ka ēnotājs ir pārāk dārgs?',
    },
    options: [
      { id: 'afterRun', en: 'Profiling or testing on the device, after it runs', lv: 'Profilējot vai testējot uz ierīces pēc palaišanas' },
      { id: 'intuition', en: 'From experience or intuition while building', lv: 'Pēc pieredzes vai nojautas veidošanas laikā' },
      { id: 'editorCount', en: 'From an instruction count or cost indicator in the editor', lv: 'Pēc instrukciju skaita vai izmaksu rādītāja redaktorā' },
      { id: 'notNeeded', en: 'I have not had to find out', lv: 'Man tas nav bijis jānoskaidro' },
      { id: 'other', en: 'Another way', lv: 'Citādi' },
    ],
    otherId: 'other',
    otherHint: { en: 'How? (optional)', lv: 'Kā? (pēc izvēles)' },
  },
  {
    kind: 'choice', id: 'mainWork', group: 'work',
    question: {
      en: 'Which best describes your main work?',
      lv: 'Kas vislabāk raksturo jūsu galveno darbu?',
    },
    options: [
      { id: 'gameDev', en: 'Game development', lv: 'Spēļu izstrāde' },
      { id: 'xrDev', en: 'XR (VR/AR) development', lv: 'XR (VR/AR) izstrāde' },
      { id: 'webCreative', en: 'Web 3D or creative coding (e.g. three.js, A-Frame)', lv: 'Tīmekļa 3D vai radošā programmēšana (piem., three.js, A-Frame)' },
      { id: 'shaderGraphics', en: 'Shader or graphics programming', lv: 'Ēnotāju vai grafikas programmēšana' },
      { id: 'techArt', en: 'Technical art', lv: 'Tehniskā māksla (technical art)' },
      { id: 'artDesign', en: '3D or media art and design', lv: '3D, mediju māksla vai dizains' },
      { id: 'teaching', en: 'Teaching computer graphics or 3D', lv: 'Datorgrafikas vai 3D mācīšana' },
      { id: 'studying', en: 'Studying', lv: 'Studēju' },
      { id: 'other', en: 'Other', lv: 'Cits' },
    ],
    otherId: 'other',
    otherHint: {
      en: 'Job title only — no employer, client or project names (optional)',
      lv: 'Tikai amats — bez darba devēja, klientu vai projektu nosaukumiem (pēc izvēles)',
    },
  },
  {
    kind: 'choice', id: 'proYears', group: 'work',
    question: {
      en: 'How many years of paid experience do you have in real-time 3D, XR or teaching computer graphics?',
      lv: 'Cik gadu algota darba pieredze jums ir reāllaika 3D vai XR jomā vai datorgrafikas mācīšanā?',
    },
    // Bands that neither overlap nor leave a gap (five and a half years has a cell).
    options: [
      { id: 'none', en: 'No paid experience', lv: 'Nav algota darba pieredzes' },
      { id: 'under2', en: 'Less than 2 years', lv: 'Mazāk par 2 gadiem' },
      { id: 'y2to5', en: '2–5 years', lv: '2–5 gadi' },
      { id: 'y5to10', en: 'More than 5, up to 10 years', lv: 'Vairāk par 5, līdz 10 gadiem' },
      { id: 'over10', en: 'More than 10 years', lv: 'Vairāk par 10 gadiem' },
    ],
  },
];

export const proText = (t: QText, lang: QLang): string => t[lang];

/** Every answer key a Submit needs, in the order the form shows them. */
export const proRequiredKeys = (): string[] => requiredKeys(PRO_ITEMS);

/** The required answer keys still missing (or holding a value the item does not offer). */
export const proMissing = (answers: QAnswers): string[] => missingKeys(PRO_ITEMS, answers);

/** Every required answer given? Free text never blocks Submit. */
export const proComplete = (answers: QAnswers): boolean => proMissing(answers).length === 0;

/** The package's `professional` block (sus.json). */
export function buildProRecord(
  answers: QAnswers,
  langs: Record<string, QLang | undefined> = {},
): Record<string, unknown> {
  return { itemsVersion: PRO_ITEMS_VERSION, placement: 'after-sus', items: buildRecord(PRO_ITEMS, answers, langs) };
}

/** summary.csv's pro_* columns; empty for every other arm. */
export const proCsvColumns = (block: unknown): [string, unknown][] => csvColumns('pro', PRO_ITEMS, block);
