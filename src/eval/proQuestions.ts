/**
 * The professional block — asked only in the `/evalpro` arm, AFTER SUS item 10
 * and before the comment box (consent-12, 2026-10-24).
 *
 * Why after the SUS. Everything a participant sees up to SUS item 10 is the
 * same in every arm, so a professional's SUS is collected in the same context
 * as a student's. The first draft (consent-6 … consent-11) sat BEFORE the SUS
 * and ended on "Would a tool like this be useful in your work?" — an
 * arm-specific lead-in, with a GPU question naming the very thing the study
 * manipulates. No package ever carried that draft (no /evalpro session ran),
 * so its ids are retired rather than migrated.
 *
 * What it asks, in order, mostly reused from the dissertation's E1 form
 * (vault notes 10/11), reworded into the app's formal "jūs" register:
 *   1. the 2026 pilot's Q5–Q9, word for word (hypothesis H2, pilot continuity);
 *   2. credibility of the cost points (E1–E7) — the expert half of SQ3;
 *   3. what the tool suits (form item H2: teaching / prototyping / production);
 *   4. the work profile: main work, years, platforms (tools and shader code
 *      are the shared experience block's, background.ts — nothing is asked twice).
 * Every required question has an honest answer for everyone ("Studying",
 * "No paid experience", "No", "Can't judge"), and every frequency or count has
 * a reference period and options that neither overlap nor leave gaps.
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
export type ProGroup = 'pilot' | 'points' | 'fit' | 'work';

export const PRO_ITEMS_VERSION = 'pro-2';

/** Ids of the first draft (consent-6 … consent-11). Never reuse one. */
export const RETIRED_PRO_IDS: readonly string[] = [
  'role', 'years', 'shaderFrequency', 'performanceBudget', 'platforms', 'wouldUse',
];

export const PRO_GROUP_HEADINGS: Record<ProGroup, QText> = {
  pilot: { en: 'More statements about FastShaders', lv: 'Vēl apgalvojumi par FastShaders' },
  points: { en: 'The cost points', lv: 'Izmaksu punkti' },
  fit: { en: 'FastShaders and your work', lv: 'FastShaders un jūsu darbs' },
  work: { en: 'Your professional work', lv: 'Jūsu profesionālais darbs' },
};

export const PRO_GROUP_NOTES: Partial<Record<ProGroup, QText>> = {
  points: {
    en: 'About the point numbers you saw on the nodes and in the cost bar.',
    lv: 'Par punktu skaitļiem, ko redzējāt pie mezgliem un izmaksu joslā.',
  },
};

export const PRO_ITEMS: readonly QItem[] = [
  // 1. The pilot's Q5–Q9, word for word: English as published (main.tex),
  // Latvian from the pilot form (Q7's "mērki" corrected to "mērķi").
  {
    kind: 'agree', id: 'pilotQ5', group: 'pilot',
    question: {
      en: 'This node editor seemed intuitive and easy to use without technical support.',
      lv: 'Man šis mezglu redaktors šķita intuitīvs un viegli lietojams bez tehniskā atbalsta.',
    },
  },
  {
    kind: 'agree', id: 'pilotQ6', group: 'pilot',
    question: {
      en: 'The visual hierarchy of nodes, their shapes and color codes clearly communicated their functions.',
      lv: 'Mezglu vizuālā hierarhija, formas un krāsu kodi skaidri paziņoja par to funkcijām.',
    },
  },
  {
    kind: 'agree', id: 'pilotQ7', group: 'pilot',
    question: {
      en: 'I felt confident experimenting and connecting various nodes to achieve the set goal.',
      lv: 'Es jutos pārliecināts(-a), eksperimentējot un savienojot dažādus mezglus (nodes), lai sasniegtu izvirzīto mērķi.',
    },
  },
  {
    kind: 'agree', id: 'pilotQ8', group: 'pilot',
    question: {
      en: 'The system provided clear and immediate visual feedback.',
      lv: 'Sistēma nodrošināja skaidru un tūlītēju vizuālo atgriezenisko saiti.',
    },
  },
  {
    kind: 'agree', id: 'pilotQ9', group: 'pilot',
    question: {
      en: 'The interface seemed unnecessarily complex for the tasks I wanted to perform.',
      lv: 'Man saskarne šķita nevajadzīgi sarežģīta tiem uzdevumiem, kurus vēlējos veikt.',
    },
  },

  // 2. Credibility of the cost points (E1 form, section E). Points are always
  // shown on /evalpro (evalTask.ts), so everyone here saw them.
  {
    kind: 'agree', id: 'pointsUnderstood', group: 'points', cantJudge: true,
    question: {
      en: 'The point meter was understandable without extra explanation.',
      lv: 'Punktu rādītājs bija saprotams bez papildu skaidrojuma.',
    },
  },
  {
    kind: 'agree', id: 'pointsInfluenced', group: 'points', cantJudge: true,
    question: {
      en: 'The cost display influenced my decisions while authoring.',
      lv: 'Izmaksu rādītājs ietekmēja manus lēmumus veidošanas laikā.',
    },
  },
  {
    kind: 'agree', id: 'pointsCredible', group: 'points', cantJudge: true,
    question: {
      en: 'The point values seemed credible given my experience with real-time performance.',
      lv: 'Punktu vērtības šķita ticamas, ņemot vērā manu pieredzi ar reāllaika veiktspēju.',
    },
  },
  {
    kind: 'agree', id: 'pointsTrusted', group: 'points', cantJudge: true,
    question: {
      en: 'I would trust this meter when planning a real VR project.',
      lv: 'Es uzticētos šim rādītājam, plānojot reālu VR projektu.',
    },
  },
  {
    kind: 'agree', id: 'pointsRanking', group: 'points', cantJudge: true,
    question: {
      en: 'It matters more that the meter ranks effects by cost correctly than that its numbers are exact.',
      lv: 'Ir svarīgāk, lai rādītājs pareizi sarindo efektus pēc izmaksām, nekā lai tā skaitļi būtu precīzi.',
    },
  },
  {
    kind: 'choice', id: 'pointsOff20', group: 'points',
    question: {
      en: 'If the meter were off by about 20%, would it still be useful?',
      lv: 'Ja rādītājs kļūdītos par aptuveni 20 %, vai tas joprojām būtu noderīgs?',
    },
    options: [
      { id: 'yes', en: 'Yes', lv: 'Jā' },
      { id: 'partly', en: 'Partly', lv: 'Daļēji' },
      { id: 'no', en: 'No', lv: 'Nē' },
    ],
  },
  {
    kind: 'text', id: 'pointsMisleading', group: 'points',
    question: {
      en: 'Where might such a point system mislead its user? (optional)',
      lv: 'Kur, jūsuprāt, šāda punktu sistēma varētu maldināt lietotāju? (pēc izvēles)',
    },
  },

  // 3. What the tool suits today (E1 form H2), one Yes/No row per use.
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

  // 4. The work profile. Options name ACTIVITIES, not people, so the Latvian
  // never has to pick a gender for the respondent.
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
    kind: 'choice', id: 'realtimeYears', group: 'work',
    question: {
      en: 'How many years of paid experience do you have in real-time 3D or XR, or in teaching computer graphics (games, VR/AR, installations, 3D on the web)? Count full years.',
      lv: 'Cik gadu algota darba pieredze jums ir reāllaika 3D vai XR jomā vai datorgrafikas mācīšanā (spēles, VR/AR, instalācijas, 3D tīmeklī)? Skaitiet pilnus gadus.',
    },
    options: [
      { id: 'none', en: 'No paid experience', lv: 'Nav algota darba pieredzes' },
      { id: 'under2', en: 'Less than 2 years (including a few months)', lv: 'Mazāk par 2 gadiem (arī daži mēneši)' },
      { id: 'y2to5', en: '2–5 years', lv: '2–5 gadi' },
      { id: 'y6to10', en: '6–10 years', lv: '6–10 gadi' },
      { id: 'over10', en: 'More than 10 years', lv: 'Vairāk par 10 gadiem' },
    ],
  },
  {
    kind: 'grid', id: 'platforms12m', group: 'work',
    question: {
      en: 'In the past 12 months, did you make real-time 3D or XR content for these platforms?',
      lv: 'Vai pēdējos 12 mēnešos veidojāt reāllaika 3D vai XR saturu šīm platformām?',
    },
    rows: [
      { id: 'standaloneVr', en: 'Standalone VR headsets (e.g. Meta Quest)', lv: 'Autonomās VR brilles (piem., Meta Quest)' },
      { id: 'pcVr', en: 'VR headsets connected to a computer (PC VR)', lv: 'Datoram pieslēgtas VR brilles (PC VR)' },
      { id: 'webxr', en: 'WebXR (VR or AR in a web browser)', lv: 'WebXR (VR vai AR tīmekļa pārlūkā)' },
      { id: 'web', en: 'The web without XR (3D in a browser)', lv: 'Tīmeklis bez XR (3D pārlūkā)' },
    ],
    columns: [YES, NO],
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
