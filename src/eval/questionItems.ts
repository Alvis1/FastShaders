/**
 * The questionnaire's item model, shared by the experience block
 * (background.ts, every arm) and the professional block (proQuestions.ts,
 * /evalpro). One renderer in SusModal draws both.
 *
 * Four kinds, so the form stays radios and text fields:
 *   agree   — a 1–5 agreement strip on the SUS anchors; `cantJudge` adds a
 *             separate "Can't judge" answer, stored as 'na', never a sixth level
 *   choice  — one option; an option whose id is `otherId` reveals a text box
 *   grid    — rows answered on the same columns (Yes / No …): forced choice
 *             per row, which gets more honest endorsements than a tick-all
 *             list (Smyth et al. 2006)
 *   text    — optional free text, never required, never copied into summary.csv
 *
 * Every item carries its own Latvian beside its English, as the SUS does
 * (SUS_ITEMS_LV) — never lv.json keys, which are keyed by English text and
 * shared with unrelated screens, so an edit made elsewhere would silently
 * reword the instrument. Rewording an item changes what it measures: give it
 * a NEW id, bump the block's version, never reuse a retired id.
 *
 * PURE (node-tested through background.test.ts and proQuestions.test.ts).
 */

export type QLang = 'en' | 'lv';

export interface QText {
  en: string;
  lv: string;
}

export interface QOption extends QText {
  id: string;
}

interface QBase {
  id: string;
  /** Section the item is shown under; the block names the headings. */
  group: string;
  question: QText;
}

export interface AgreeItem extends QBase {
  kind: 'agree';
  cantJudge?: boolean;
}

export interface ChoiceItem extends QBase {
  kind: 'choice';
  options: readonly QOption[];
  otherId?: string;
  otherHint?: QText;
}

export interface GridItem extends QBase {
  kind: 'grid';
  rows: readonly QOption[];
  columns: readonly QOption[];
}

export interface TextItem extends QBase {
  kind: 'text';
}

export type QItem = AgreeItem | ChoiceItem | GridItem | TextItem;

/**
 * Answers are keyed by `item.id`, a grid row by `item.id.row`, and a choice's
 * "Other" text by `item.id.other`. Values: an agree item 1–5 or 'na', a choice
 * or grid row the option id, a text item its string.
 */
export type QAnswers = Record<string, number | string | null | undefined>;

export const gridKey = (item: GridItem, row: QOption) => `${item.id}.${row.id}`;
export const otherKey = (item: ChoiceItem) => `${item.id}.other`;

export const qText = (t: QText, lang: QLang): string => t[lang];

/** Every answer key a Submit needs, in the order the form shows them. */
export function requiredKeys(items: readonly QItem[]): string[] {
  const keys: string[] = [];
  for (const q of items) {
    if (q.kind === 'agree' || q.kind === 'choice') keys.push(q.id);
    else if (q.kind === 'grid') for (const r of q.rows) keys.push(gridKey(q, r));
  }
  return keys;
}

function validAnswer(q: QItem, v: unknown): boolean {
  if (q.kind === 'agree') return (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5) || (!!q.cantJudge && v === 'na');
  if (q.kind === 'choice') return q.options.some((o) => o.id === v);
  if (q.kind === 'grid') return q.columns.some((c) => c.id === v);
  return true;
}

/** The required answer keys still missing (or holding a value the item does not offer). */
export function missingKeys(items: readonly QItem[], answers: QAnswers): string[] {
  const missing: string[] = [];
  for (const q of items) {
    if (q.kind === 'agree' || q.kind === 'choice') {
      if (!validAnswer(q, answers[q.id])) missing.push(q.id);
    } else if (q.kind === 'grid') {
      for (const r of q.rows) if (!validAnswer(q, answers[gridKey(q, r)])) missing.push(gridKey(q, r));
    }
  }
  return missing;
}

const TEXT_CAP = 300;
const OTHER_CAP = 120;
const cleanText = (raw: unknown, cap: number) => (typeof raw === 'string' ? raw.trim().slice(0, cap) : '');

/**
 * A block's package record (sus.json). Each answer carries the English
 * wording it was asked with and the language it was GIVEN in, so a later
 * rewording or a Latvian answer can always be told apart.
 */
export function buildRecord(
  items: readonly QItem[],
  answers: QAnswers,
  langs: Record<string, QLang | undefined> = {},
): Record<string, unknown>[] {
  return items.map((q) => {
    const base = { id: q.id, kind: q.kind, question: q.question.en };
    if (q.kind === 'agree') {
      const v = answers[q.id];
      const ok = validAnswer(q, v);
      return {
        ...base,
        response: ok && typeof v === 'number' ? v : null,
        na: ok && v === 'na',
        language: langs[q.id] ?? null,
      };
    }
    if (q.kind === 'choice') {
      const v = answers[q.id];
      const opt = q.options.find((o) => o.id === v) ?? null;
      return {
        ...base,
        options: q.options.map((o) => o.id),
        choice: opt?.id ?? null,
        label: opt?.en ?? null,
        ...(q.otherId ? { otherText: opt?.id === q.otherId ? cleanText(answers[otherKey(q)], OTHER_CAP) : '' } : {}),
        language: langs[q.id] ?? null,
      };
    }
    if (q.kind === 'grid') {
      return {
        ...base,
        columns: q.columns.map((c) => c.id),
        rows: q.rows.map((r) => {
          const v = answers[gridKey(q, r)];
          return {
            id: r.id,
            question: r.en,
            answer: q.columns.some((c) => c.id === v) ? v : null,
            language: langs[gridKey(q, r)] ?? null,
          };
        }),
      };
    }
    return { ...base, text: cleanText(answers[q.id], TEXT_CAP), language: langs[q.id] ?? null };
  });
}

/**
 * summary.csv columns for a block, generated from its items so a new or
 * retired item cannot leave a stale or missing column; empty when the block
 * is absent. Typed text never reaches the CSV — it stays in sus.json.
 */
export function csvColumns(prefix: string, items: readonly QItem[], block: unknown): [string, unknown][] {
  const recs = (block && typeof block === 'object' && Array.isArray((block as { items?: unknown }).items))
    ? (block as { items: Record<string, unknown>[] }).items
    : [];
  const byId = new Map(recs.filter((i) => i && typeof i.id === 'string').map((i) => [i.id as string, i]));
  const version = block && typeof block === 'object' ? (block as { itemsVersion?: unknown }).itemsVersion : undefined;
  const cols: [string, unknown][] = [[`${prefix}_items_version`, typeof version === 'string' ? version : '']];
  for (const q of items) {
    const rec = byId.get(q.id);
    if (q.kind === 'agree') {
      cols.push([`${prefix}_${q.id}`, rec ? (rec.na === true ? 'na' : rec.response ?? '') : '']);
    } else if (q.kind === 'choice') {
      cols.push([`${prefix}_${q.id}`, rec?.choice ?? '']);
    } else if (q.kind === 'grid') {
      const rows = Array.isArray(rec?.rows) ? (rec!.rows as Record<string, unknown>[]) : [];
      for (const r of q.rows) cols.push([`${prefix}_${q.id}_${r.id}`, rows.find((x) => x?.id === r.id)?.answer ?? '']);
    }
  }
  return cols;
}

/** The Yes / No columns a grid shares, and the set-apart "Can't judge". */
export const CANT_JUDGE: QText = { en: "Can't judge", lv: 'Nevaru novērtēt' };
export const YES: QOption = { id: 'yes', en: 'Yes', lv: 'Jā' };
export const NO: QOption = { id: 'no', en: 'No', lv: 'Nē' };
export const CANT: QOption = { id: 'cantJudge', ...CANT_JUDGE };
