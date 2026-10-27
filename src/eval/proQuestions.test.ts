import { describe, it, expect } from 'vitest';
import {
  PRO_GROUP_HEADINGS,
  PRO_GROUP_NOTES,
  PRO_ITEMS,
  PRO_ITEMS_VERSION,
  RETIRED_PRO_IDS,
  buildProRecord,
  gridKey,
  otherKey,
  proComplete,
  proCsvColumns,
  proMissing,
  proRequiredKeys,
  type ProAgreeItem,
  type ProAnswers,
  type ProChoiceItem,
  type ProGridItem,
  type ProQuestion,
} from './proQuestions';
import { OTHER_CAP } from './questionItems';
import { SUS_ITEMS_EN } from './susScore';

/** A complete, valid set of answers — the first option everywhere. */
function fullAnswers(): ProAnswers {
  const a: ProAnswers = {};
  for (const q of PRO_ITEMS) {
    if (q.kind === 'agree') a[q.id] = 3;
    else if (q.kind === 'choice') a[q.id] = q.options[0].id;
    else if (q.kind === 'grid') for (const r of q.rows) a[gridKey(q, r)] = q.columns[0].id;
  }
  return a;
}

const by = (id: string): ProQuestion => PRO_ITEMS.find((x) => x.id === id)!;

describe('the professional question block (pro-4)', () => {
  it('has unique ids, never a retired one, a heading for every group, and is versioned', () => {
    const ids = PRO_ITEMS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The earlier drafts' ids name different questions; reusing one would
    // pool two questions under one column.
    for (const id of ids) expect(RETIRED_PRO_IDS, id).not.toContain(id);
    for (const q of PRO_ITEMS) expect(PRO_GROUP_HEADINGS[q.group as keyof typeof PRO_GROUP_HEADINGS], q.group).toBeDefined();
    expect(PRO_ITEMS_VERSION).toMatch(/^pro-\d+$/);
  });

  it('is short: nine questions, two agreement items, thirteen required answers, two optional texts', () => {
    // The owner found pro-2 repetitive — ten agreement items straight after
    // the ten SUS ones (2026-10-25). One item per sentence the thesis writes.
    expect(PRO_ITEMS).toHaveLength(11);
    expect(PRO_ITEMS.filter((q) => q.kind === 'agree')).toHaveLength(2);
    expect(PRO_ITEMS.filter((q) => q.kind === 'text')).toHaveLength(2);
    expect(proRequiredKeys()).toHaveLength(13);
  });

  it('re-asks nothing the SUS measures: no pilot item, no SUS wording', () => {
    for (const id of ['pilotQ5', 'pilotQ6', 'pilotQ7', 'pilotQ8', 'pilotQ9', 'pointsOff20', 'platforms12m', 'realtimeYears', 'pointsOff20PerNode', 'fitFor', 'proYears']) {
      expect(RETIRED_PRO_IDS).toContain(id);
      expect(PRO_ITEMS.map((q) => q.id)).not.toContain(id);
    }
    const stems = PRO_ITEMS.map((q) => q.question.en.toLowerCase());
    for (const s of stems) expect(s).not.toMatch(/easy to use|unnecessarily complex|confident|learn to use|technical support|intuitive/);
    for (const sus of SUS_ITEMS_EN) expect(stems).not.toContain(sus.toLowerCase());
  });

  it('puts each agreement item first in its group and apart from the other', () => {
    // The renderer prints the 1–5 legend above the first agree item of a run;
    // two strips three items apart never read as one more SUS page.
    const groups = new Map<string, ProQuestion[]>();
    for (const q of PRO_ITEMS) groups.set(q.group, [...(groups.get(q.group) ?? []), q]);
    for (const [group, items] of groups) {
      if (items.some((q) => q.kind === 'agree')) expect(items[0].kind, group).toBe('agree');
    }
    const at = PRO_ITEMS.flatMap((q, i) => (q.kind === 'agree' ? [i] : []));
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(3);
    // The groups run tool → points → fit → own work, demographics last.
    expect([...groups.keys()]).toEqual(['tool', 'points', 'fit', 'work']);
  });

  it('every required question has an honest answer for everyone, and no option twice', () => {
    for (const q of PRO_ITEMS) {
      if (q.kind === 'choice') expect(new Set(q.options.map((o) => o.id)).size, q.id).toBe(q.options.length);
      if (q.kind === 'grid') {
        expect(new Set(q.rows.map((o) => o.id)).size, q.id).toBe(q.rows.length);
        expect(new Set(q.columns.map((o) => o.id)).size, q.id).toBe(q.columns.length);
      }
    }
    expect((by('pointsCredible') as ProAgreeItem).cantJudge).toBe(true);
    expect((by('webxrConstraintsDeter') as ProAgreeItem).cantJudge).toBe(true);
    expect((by('pointsChangedBuild') as ProChoiceItem).options.map((o) => o.id)).toEqual(['ignored', 'lookedWithin', 'lookedOver', 'chose', 'replaced']);
    expect((by('costToday') as ProChoiceItem).options.map((o) => o.id)).toContain('notNeeded');
    expect((by('costToday') as ProChoiceItem).otherId).toBe('other');
    expect((by('suitedFor') as ProGridItem).columns.map((c) => c.id)).toEqual(['yes', 'no', 'cantJudge']);
    expect((by('featuresHelped') as ProGridItem).columns.map((c) => c.id)).toEqual(['helped', 'neither', 'hindered', 'notUsed']);
    expect((by('nodeLookTold') as ProGridItem).columns.map((c) => c.id)).toEqual(['yes', 'partly', 'no']);
    expect((by('nodeLookTold') as ProGridItem).rows.map((r) => r.id)).toEqual(['does', 'cost']);
    expect((by('mainWork') as ProChoiceItem).options.map((o) => o.id)).toContain('studying');
    expect((by('mainWork') as ProChoiceItem).otherId).toBe('other');
    const years = by('paidYears') as ProChoiceItem;
    expect(years.options[0].id).toBe('none');
    expect(years.options.map((o) => o.id)).toEqual(['none', 'under2', 'y2to5', 'y5to10', 'over10']);
  });

  it('carries its own Latvian for every question, option, row, column, hint, heading and note', () => {
    // Not lv.json: those keys are shared with unrelated screens by English text.
    const texts = [
      ...PRO_ITEMS.flatMap((q) => [
        q.question,
        ...(q.kind === 'choice' ? q.options : []),
        ...(q.kind === 'grid' ? [...q.rows, ...q.columns] : []),
        ...((q.kind === 'choice' || q.kind === 'grid') && q.otherHint ? [q.otherHint] : []),
      ]),
      ...Object.values(PRO_GROUP_HEADINGS),
      ...Object.values(PRO_GROUP_NOTES),
    ];
    for (const t of texts) {
      expect(t.en.trim(), t.en).not.toBe('');
      expect(t.lv.trim(), t.en).not.toBe('');
      expect(t.lv, t.en).toBe(t.lv.trim());
    }
  });

  it('requires every choice, strip and grid row, never the free text', () => {
    const all = fullAnswers();
    expect(proComplete(all)).toBe(true);
    expect(proMissing({})).toEqual(proRequiredKeys());
    const keys = proRequiredKeys();
    expect(keys).not.toContain('pointsMisleading');
    expect(keys).not.toContain('missingForWork');
    expect(proMissing({ ...all, pointsCredible: null })).toEqual(['pointsCredible']);
    const grid = by('nodeLookTold') as ProGridItem;
    const row = gridKey(grid, grid.rows[1]);
    expect(proMissing({ ...all, [row]: undefined })).toEqual([row]);
  });

  it('accepts "can\'t judge" only where it is offered, and no level outside 1-5', () => {
    const all = fullAnswers();
    expect(proComplete({ ...all, pointsCredible: 'na' })).toBe(true);
    expect(proComplete({ ...all, pointsCredible: 0 })).toBe(false);
    expect(proComplete({ ...all, pointsCredible: 6 })).toBe(false);
    expect(proComplete({ ...all, pointsChangedBuild: 'na' })).toBe(false);
    expect(proComplete({ ...all, mainWork: 'astronaut' })).toBe(false);
    expect(proComplete({ ...all, 'suitedFor.teaching': 'partly' })).toBe(false);
    expect(proComplete({ ...all, 'nodeLookTold.cost': 'partly' })).toBe(true);
  });

  it('records the wording, the answer and its language, and caps typed text', () => {
    const work = by('mainWork') as ProChoiceItem;
    const cost = by('costToday') as ProChoiceItem;
    const rec = buildProRecord(
      {
        ...fullAnswers(),
        pointsCredible: 'na',
        mainWork: 'other',
        [otherKey(work)]: `  ${'x'.repeat(500)} `,
        costToday: 'other',
        [otherKey(cost)]: ' I ask a colleague ',
        pointsMisleading: ' noise ',
      },
      { pointsCredible: 'lv', 'suitedFor.production': 'en' },
    ) as { itemsVersion: string; placement: string; items: Record<string, unknown>[] };
    expect(rec.itemsVersion).toBe(PRO_ITEMS_VERSION);
    expect(rec.placement).toBe('after-sus');
    const item = (id: string) => rec.items.find((i) => i.id === id)!;
    expect(item('pointsCredible')).toMatchObject({ kind: 'agree', response: null, na: true, language: 'lv' });
    expect(item('webxrConstraintsDeter')).toMatchObject({ response: 3, na: false });
    expect(item('mainWork')).toMatchObject({ choice: 'other', label: 'Other' });
    expect((item('mainWork').otherText as string).length).toBe(OTHER_CAP);
    expect(item('costToday')).toMatchObject({ choice: 'other', otherText: 'I ask a colleague' });
    expect(item('pointsMisleading')).toMatchObject({ kind: 'text', text: 'noise' });
    const rows = item('suitedFor').rows as { id: string; answer: unknown; language: unknown }[];
    expect(rows.find((r) => r.id === 'production')).toMatchObject({ answer: 'yes', language: 'en' });
  });

  it('keeps unanswered items null rather than inventing a default', () => {
    const rec = buildProRecord({}) as { items: Record<string, unknown>[] };
    for (const i of rec.items) {
      if (i.kind === 'agree') expect(i.response, i.id as string).toBeNull();
      if (i.kind === 'choice') expect(i.choice, i.id as string).toBeNull();
      if (i.kind === 'grid') expect((i.rows as { answer: unknown }[]).every((r) => r.answer === null), i.id as string).toBe(true);
    }
  });

  it('summary.csv columns follow the items and never carry typed text', () => {
    const empty = proCsvColumns(undefined);
    expect(empty.every(([, v]) => v === '')).toBe(true);
    const cols = proCsvColumns(buildProRecord({ ...fullAnswers(), pointsCredible: 'na', pointsMisleading: 'secret words', missingForWork: 'more secrets' }));
    const names = cols.map(([k]) => k);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('pro_nodeLookTold_cost');
    expect(names).toContain('pro_suitedFor_teaching');
    expect(names).not.toContain('pro_pointsMisleading');
    expect(names).not.toContain('pro_missingForWork');
    expect(Object.fromEntries(cols)).toMatchObject({
      pro_items_version: PRO_ITEMS_VERSION,
      pro_pointsCredible: 'na',
      pro_pointsChangedBuild: 'ignored',
      pro_featuresHelped_codePanel: 'helped',
    });
    expect(JSON.stringify(cols)).not.toContain('secret');
    // A pro-2 block (retired ids) fills nothing but the version.
    const pro2 = proCsvColumns({ itemsVersion: 'pro-2', items: [{ id: 'pilotQ5', kind: 'agree', response: 4 }, { id: 'pointsOff20', kind: 'choice', choice: 'yes' }] });
    expect(pro2.filter(([k]) => k !== 'pro_items_version').every(([, v]) => v === '')).toBe(true);
  });
});
