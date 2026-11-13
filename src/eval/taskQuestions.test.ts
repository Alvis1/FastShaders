import { describe, it, expect } from 'vitest';
import {
  RETIRED_TASK_IDS,
  TASK_GROUP_HEADINGS,
  TASK_ITEMS,
  TASK_ITEMS_VERSION,
  buildTaskRecord,
  taskComplete,
  taskCsvColumns,
  taskItemsFor,
  taskMissing,
  taskRequiredKeys,
} from './taskQuestions';
import { gridKey, type ChoiceItem, type GridItem } from './questionItems';

const full = () => ({
  finished: 'yes',
  mentalEffort: 'moderate',
  'nodeLookTold.does': 'yes',
  'nodeLookTold.cost': 'partly',
  pointsChangedBuild: 'looked',
});

describe('the student / general-session post-SUS questions (tq-1)', () => {
  it('has unique ids, never a retired one, a heading for every group, and is versioned', () => {
    expect(TASK_ITEMS_VERSION).toBe('tq-1');
    const ids = TASK_ITEMS.map((q) => q.id);
    expect(ids).toEqual(['finished', 'mentalEffort', 'nodeLookTold', 'pointsChangedBuild']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(RETIRED_TASK_IDS).not.toContain(id);
    for (const q of TASK_ITEMS) expect(TASK_GROUP_HEADINGS[q.group], q.group).toBeDefined();
  });

  it('omits pointsChangedBuild when pointsVisible is false (/evalp)', () => {
    expect(taskItemsFor(true).map((q) => q.id)).toEqual(['finished', 'mentalEffort', 'nodeLookTold', 'pointsChangedBuild']);
    expect(taskItemsFor(false).map((q) => q.id)).toEqual(['finished', 'mentalEffort', 'nodeLookTold']);
    expect(taskRequiredKeys(true)).toHaveLength(5);
    expect(taskRequiredKeys(false)).toHaveLength(4);
  });

  it('carries its own Latvian for every question, option, row, column and heading', () => {
    const texts = [
      ...TASK_ITEMS.flatMap((q) => [
        q.question,
        ...(q.kind === 'choice' ? (q as ChoiceItem).options : []),
        ...(q.kind === 'grid' ? [...(q as GridItem).rows, ...(q as GridItem).columns] : []),
      ]),
      ...Object.values(TASK_GROUP_HEADINGS),
    ];
    for (const t of texts) {
      expect(t.en.trim(), t.en).not.toBe('');
      expect(t.lv.trim(), t.en).not.toBe('');
      expect(t.lv, t.en).toBe(t.lv.trim());
    }
  });

  it('validates required answers per condition and rejects invalid option values', () => {
    expect(taskComplete(full(), true)).toBe(true);
    expect(taskComplete({ ...full(), pointsChangedBuild: undefined }, true)).toBe(false);
    expect(taskComplete({ ...full(), pointsChangedBuild: undefined }, false)).toBe(true);
    expect(taskMissing({}, false)).toEqual(['finished', 'mentalEffort', 'nodeLookTold.does', 'nodeLookTold.cost']);
    expect(taskComplete({ ...full(), mentalEffort: 'impossible' }, true)).toBe(false);
    const grid = TASK_ITEMS.find((q) => q.id === 'nodeLookTold') as GridItem;
    expect(gridKey(grid, grid.rows[0])).toBe('nodeLookTold.does');
  });

  it('builds a post-SUS record and fixed tq_* CSV columns', () => {
    const recEval = buildTaskRecord(full(), { finished: 'lv' }, true) as { itemsVersion: string; placement: string; items: Record<string, unknown>[] };
    expect(recEval.itemsVersion).toBe('tq-1');
    expect(recEval.placement).toBe('after-sus');
    expect(recEval.items).toHaveLength(4);
    expect(Object.fromEntries(taskCsvColumns(recEval))).toEqual({
      tq_items_version: 'tq-1',
      tq_finished: 'yes',
      tq_mentalEffort: 'moderate',
      tq_nodeLookTold_does: 'yes',
      tq_nodeLookTold_cost: 'partly',
      tq_pointsChangedBuild: 'looked',
    });

    const recEvalp = buildTaskRecord({ ...full(), pointsChangedBuild: undefined }, {}, false);
    expect(Object.fromEntries(taskCsvColumns(recEvalp))).toEqual({
      tq_items_version: 'tq-1',
      tq_finished: 'yes',
      tq_mentalEffort: 'moderate',
      tq_nodeLookTold_does: 'yes',
      tq_nodeLookTold_cost: 'partly',
      tq_pointsChangedBuild: '',
    });
  });
});
