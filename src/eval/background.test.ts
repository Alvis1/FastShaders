import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_ITEMS,
  BACKGROUND_ITEMS_VERSION,
  RETIRED_BACKGROUND_IDS,
  backgroundComplete,
  backgroundCsvColumns,
  backgroundMissing,
  buildBackgroundRecord,
} from './background';
import { gridKey, type ChoiceItem, type GridItem } from './questionItems';

const tools = BACKGROUND_ITEMS[0] as GridItem;
const full = () => ({
  ...Object.fromEntries(tools.rows.map((r) => [gridKey(tools, r), 'no'])),
  nodeEditorUse: 'never',
  shaderCodeUse: 'no',
});

describe('the pre-SUS experience questions (bg-2)', () => {
  it('asks what people have done, under new ids, never a retired one', () => {
    expect(BACKGROUND_ITEMS_VERSION).toBe('bg-2');
    expect(BACKGROUND_ITEMS.map((i) => i.id)).toEqual(['toolsUsed', 'nodeEditorUse', 'shaderCodeUse']);
    // blender/unreal/shaderCode were the first wave's 0-4 levels and
    // otherNodeEditors the pilot's free-text item: a package of that version
    // must never read as an answer to a new question.
    for (const id of BACKGROUND_ITEMS.map((i) => i.id)) expect(RETIRED_BACKGROUND_IDS).not.toContain(id);
    expect(RETIRED_BACKGROUND_IDS).toContain('otherNodeEditors');
    // Tools are Yes/No rows (forced choice, not a tick-all list) and the two
    // scales are behavioural anchors with an honest answer for a novice.
    expect(tools.kind).toBe('grid');
    expect(tools.columns.map((c) => c.id)).toEqual(['yes', 'no']);
    expect(tools.rows.map((r) => r.id)).toEqual(['blender', 'unreal', 'unity', 'touchdesigner', 'other']);
    const use = BACKGROUND_ITEMS[1] as ChoiceItem;
    expect(use.options[0].id).toBe('never');
    expect((BACKGROUND_ITEMS[2] as ChoiceItem).options[0].id).toBe('no');
  });

  it('carries its own Latvian for every question, option and row', () => {
    for (const q of BACKGROUND_ITEMS) {
      const texts = [q.question, ...(q.kind === 'choice' ? q.options : []), ...(q.kind === 'grid' ? [...q.rows, ...q.columns] : [])];
      for (const t of texts) {
        expect(t.lv.trim(), t.en).not.toBe('');
        expect(t.lv, t.en).toBe(t.lv.trim());
      }
    }
  });

  it('requires every row and choice — they are the covariate the SUS is read against', () => {
    expect(backgroundComplete(full())).toBe(true);
    expect(backgroundComplete({})).toBe(false);
    expect(backgroundMissing({})).toEqual([
      ...tools.rows.map((r) => gridKey(tools, r)),
      'nodeEditorUse',
      'shaderCodeUse',
    ]);
    expect(backgroundMissing({ ...full(), 'toolsUsed.unity': undefined })).toEqual(['toolsUsed.unity']);
  });

  it('rejects an answer the item does not offer', () => {
    expect(backgroundComplete({ ...full(), nodeEditorUse: 'expert' })).toBe(false);
    expect(backgroundComplete({ ...full(), 'toolsUsed.blender': 'maybe' })).toBe(false);
    expect(backgroundComplete({ ...full(), shaderCodeUse: 3 })).toBe(false);
  });

  it('records the wording asked, the answer and its language, and no free text', () => {
    const rec = buildBackgroundRecord(
      { ...full(), 'toolsUsed.unity': 'yes', nodeEditorUse: 'regular' },
      { 'toolsUsed.unity': 'lv', nodeEditorUse: 'en' },
    ) as { itemsVersion: string; items: Record<string, unknown>[] };
    expect(rec.itemsVersion).toBe('bg-2');
    expect(Object.keys(rec).sort()).toEqual(['items', 'itemsVersion']);
    const rows = rec.items[0].rows as { id: string; answer: string; language: string | null }[];
    expect(rows.find((r) => r.id === 'unity')).toMatchObject({ answer: 'yes', language: 'lv' });
    expect(rows.find((r) => r.id === 'blender')).toMatchObject({ answer: 'no', language: null });
    expect(rec.items[1]).toMatchObject({ id: 'nodeEditorUse', choice: 'regular', label: 'Use them regularly', language: 'en' });
    expect(JSON.stringify(rec)).not.toContain('otherNodeEditorsText');
  });

  it('keeps unanswered items null rather than inventing a default', () => {
    const rec = buildBackgroundRecord({}) as { items: Record<string, unknown>[] };
    expect((rec.items[0].rows as { answer: unknown }[]).every((r) => r.answer === null)).toBe(true);
    expect(rec.items[1].choice).toBeNull();
  });

  it('summary.csv columns follow the items and are empty for the first wave\'s block', () => {
    const cols = backgroundCsvColumns(buildBackgroundRecord({ ...full(), 'toolsUsed.blender': 'yes' }));
    expect(Object.fromEntries(cols)).toMatchObject({
      bg_items_version: 'bg-2',
      bg_toolsUsed_blender: 'yes',
      bg_toolsUsed_other: 'no',
      bg_nodeEditorUse: 'never',
      bg_shaderCodeUse: 'no',
    });
    // A first-wave block (levels 0-4 under the old ids) fills nothing.
    const old = backgroundCsvColumns({ scale: [], items: [{ id: 'blender', level: 3 }] });
    expect(old.every(([, v]) => v === '')).toBe(true);
  });
});
