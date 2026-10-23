import { describe, it, expect } from 'vitest';
import {
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
  type ProAnswers,
  type ProChoiceItem,
  type ProGridItem,
} from './proQuestions';

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

describe('the professional question block', () => {
  it('has unique ids, never a retired one, and is versioned', () => {
    const ids = PRO_ITEMS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The first draft's ids name different questions; reusing one would pool
    // two questions under one column.
    for (const id of ids) expect(RETIRED_PRO_IDS, id).not.toContain(id);
    expect(PRO_ITEMS_VERSION).toMatch(/^pro-\d+$/);
  });

  it('carries its own Latvian for every question, option and row', () => {
    // Not lv.json: those keys are shared with unrelated screens by English text.
    const texts = PRO_ITEMS.flatMap((q) => [
      q.question,
      ...(q.kind === 'choice' ? q.options : []),
      ...(q.kind === 'grid' ? [...q.rows, ...q.columns] : []),
    ]);
    for (const t of texts) {
      expect(t.en.trim(), t.en).not.toBe('');
      expect(t.lv.trim(), t.en).not.toBe('');
      expect(t.lv, t.en).toBe(t.lv.trim());
    }
  });

  it('keeps the pilot items word for word (pilot continuity, hypothesis H2)', () => {
    const q = (id: string) => PRO_ITEMS.find((x) => x.id === id)!.question;
    expect(q('pilotQ6').lv).toBe('Mezglu vizuālā hierarhija, formas un krāsu kodi skaidri paziņoja par to funkcijām.');
    expect(q('pilotQ8').en).toBe('The system provided clear and immediate visual feedback.');
    // The pilot form's typo "mērki" is corrected, nothing else.
    expect(q('pilotQ7').lv).toContain('izvirzīto mērķi.');
  });

  it('every choice and grid has an answer that fits everyone, and no option twice', () => {
    for (const q of PRO_ITEMS) {
      if (q.kind === 'choice') expect(new Set(q.options.map((o) => o.id)).size, q.id).toBe(q.options.length);
      if (q.kind === 'grid') {
        expect(new Set(q.rows.map((o) => o.id)).size, q.id).toBe(q.rows.length);
        expect(q.columns.some((c) => c.id === 'no'), q.id).toBe(true);
      }
    }
    const years = PRO_ITEMS.find((q) => q.id === 'realtimeYears') as ProChoiceItem;
    expect(years.options[0].id).toBe('none');
    const work = PRO_ITEMS.find((q) => q.id === 'mainWork') as ProChoiceItem;
    expect(work.options.map((o) => o.id)).toContain('studying');
    expect(work.otherId).toBe('other');
  });

  it('requires every choice, strip and grid row, never the free text', () => {
    const all = fullAnswers();
    expect(proComplete(all)).toBe(true);
    expect(proMissing({})).toEqual(proRequiredKeys());
    const keys = proRequiredKeys();
    expect(keys).not.toContain('pointsMisleading');
    expect(proMissing({ ...all, pilotQ5: null })).toEqual(['pilotQ5']);
    const grid = PRO_ITEMS.find((q) => q.id === 'platforms12m') as ProGridItem;
    const row = gridKey(grid, grid.rows[2]);
    expect(proMissing({ ...all, [row]: undefined })).toEqual([row]);
  });

  it('accepts "can\'t judge" only where it is offered, and no level outside 1-5', () => {
    const all = fullAnswers();
    expect(proComplete({ ...all, pointsCredible: 'na' })).toBe(true);
    expect(proComplete({ ...all, pilotQ5: 'na' })).toBe(false);
    expect(proComplete({ ...all, pilotQ5: 0 })).toBe(false);
    expect(proComplete({ ...all, pilotQ5: 6 })).toBe(false);
    expect(proComplete({ ...all, mainWork: 'astronaut' })).toBe(false);
  });

  it('records the wording, the answer and its language, and caps typed text', () => {
    const work = PRO_ITEMS.find((q) => q.id === 'mainWork') as ProChoiceItem;
    const rec = buildProRecord(
      { ...fullAnswers(), pointsCredible: 'na', mainWork: 'other', [otherKey(work)]: `  ${'x'.repeat(500)} `, pointsMisleading: ' noise ' },
      { pilotQ5: 'lv', 'platforms12m.webxr': 'en' },
    ) as { itemsVersion: string; placement: string; items: Record<string, unknown>[] };
    expect(rec.itemsVersion).toBe(PRO_ITEMS_VERSION);
    expect(rec.placement).toBe('after-sus');
    const item = (id: string) => rec.items.find((i) => i.id === id)!;
    expect(item('pilotQ5')).toMatchObject({ kind: 'agree', response: 3, na: false, language: 'lv' });
    expect(item('pointsCredible')).toMatchObject({ response: null, na: true });
    expect(item('mainWork')).toMatchObject({ choice: 'other', label: 'Other' });
    expect((item('mainWork').otherText as string).length).toBe(120);
    expect(item('pointsMisleading')).toMatchObject({ kind: 'text', text: 'noise' });
    const rows = item('platforms12m').rows as { id: string; answer: unknown; language: unknown }[];
    expect(rows.find((r) => r.id === 'webxr')).toMatchObject({ answer: 'yes', language: 'en' });
  });

  it('keeps unanswered items null rather than inventing a default', () => {
    const rec = buildProRecord({}) as { items: Record<string, unknown>[] };
    for (const i of rec.items) {
      if (i.kind === 'agree') expect(i.response, i.id as string).toBeNull();
      if (i.kind === 'choice') expect(i.choice, i.id as string).toBeNull();
    }
  });

  it('summary.csv columns follow the items and never carry typed text', () => {
    const empty = proCsvColumns(undefined);
    expect(empty.every(([, v]) => v === '')).toBe(true);
    const cols = proCsvColumns(buildProRecord({ ...fullAnswers(), pointsCredible: 'na', pointsMisleading: 'secret words' }));
    const names = cols.map(([k]) => k);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('pro_platforms12m_standaloneVr');
    expect(names).not.toContain('pro_pointsMisleading');
    expect(Object.fromEntries(cols)).toMatchObject({ pro_items_version: PRO_ITEMS_VERSION, pro_pointsCredible: 'na', pro_pilotQ5: 3 });
    expect(JSON.stringify(cols)).not.toContain('secret words');
  });
});
