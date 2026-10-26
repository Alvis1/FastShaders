import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_GROUP_HEADINGS,
  BACKGROUND_ITEMS,
  BACKGROUND_ITEMS_VERSION,
  RETIRED_BACKGROUND_IDS,
  backgroundComplete,
  backgroundCsvColumns,
  backgroundMissing,
  buildBackgroundRecord,
} from './background';
import { OTHER_CAP, gridKey, otherKey, type ChoiceItem, type GridItem } from './questionItems';

const tools = BACKGROUND_ITEMS[0] as GridItem;
const full = () => ({
  ...Object.fromEntries(tools.rows.map((r) => [gridKey(tools, r), 'no'])),
  nodeEditorUse: 'never',
  shaderCodeWritten: 'no',
});

describe('the pre-SUS experience questions (bg-3)', () => {
  it('asks what people have done, under new ids, never a retired one', () => {
    expect(BACKGROUND_ITEMS_VERSION).toBe('bg-3');
    expect(BACKGROUND_ITEMS.map((i) => i.id)).toEqual(['toolsMade', 'nodeEditorUse', 'shaderCodeWritten']);
    // The renderer looks each item's group up in this map; a miss would throw
    // at the questionnaire's first render.
    for (const q of BACKGROUND_ITEMS) expect(BACKGROUND_GROUP_HEADINGS[q.group], q.group).toBeDefined();
    // blender/unreal/shaderCode were the first wave's 0-4 levels and
    // otherNodeEditors the pilot's free-text item: a package of that version
    // must never read as an answer to a new question. bg-2's two reworded ids
    // never shipped and are retired all the same.
    for (const id of BACKGROUND_ITEMS.map((i) => i.id)) expect(RETIRED_BACKGROUND_IDS).not.toContain(id);
    for (const id of ['blender', 'unreal', 'otherNodeEditors', 'shaderCode', 'toolsUsed', 'shaderCodeDepth']) {
      expect(RETIRED_BACKGROUND_IDS).toContain(id);
    }
    // Tools are Yes/No rows (forced choice, not a tick-all list) and the two
    // scales are behavioural anchors with an honest answer for a novice.
    expect(tools.kind).toBe('grid');
    expect(tools.columns.map((c) => c.id)).toEqual(['yes', 'no']);
    expect(tools.rows.map((r) => r.id)).toEqual(['blender', 'unreal', 'unity', 'web3d', 'otherNodeEditor']);
    const use = BACKGROUND_ITEMS[1] as ChoiceItem;
    expect(use.options[0].id).toBe('never');
    expect((BACKGROUND_ITEMS[2] as ChoiceItem).options.map((o) => o.id)).toEqual(['no', 'changed', 'own']);
  });

  it('has no TouchDesigner row; the node-editor write-in comes last and takes several names (owner, 2026-10-25/26)', () => {
    expect(JSON.stringify(BACKGROUND_ITEMS)).not.toMatch(/touchdesigner/i);
    expect(tools.otherRowId).toBe('otherNodeEditor');
    expect(tools.rows[tools.rows.length - 1].id).toBe(tools.otherRowId);
    expect(tools.rows.find((r) => r.id === tools.otherRowId)?.en).toMatch(/node-based/);
    expect(tools.otherHint?.en).toMatch(/several/);
    expect(tools.otherHint?.lv).toMatch(/vairākus/);
    // A list of tools has to fit the one write-in.
    expect(OTHER_CAP).toBeGreaterThanOrEqual(200);
    const names = 'Houdini, Substance Designer, Godot, Maya, Cinema 4D, TouchDesigner, Nuke, Unity Shader Graph, Material Maker';
    const rec = buildBackgroundRecord({ ...full(), 'toolsMade.otherNodeEditor': 'yes', [otherKey(tools)]: names }) as { items: Record<string, unknown>[] };
    expect(rec.items[0].otherText).toBe(names);
  });

  it('asks about shader code in one line with three rungs, the first honest for a novice', () => {
    // The five-step ladder under a two-sentence stem was too long (owner,
    // 2026-10-25); the split that matters is no code / tinkered / writes shaders.
    const code = BACKGROUND_ITEMS[2] as ChoiceItem;
    expect(code.question.en.length).toBeLessThan(80);
    expect(code.question.en).not.toMatch(/\. /);
    expect(code.options).toHaveLength(3);
    expect(code.options[0].id).toBe('no');
  });

  it('carries its own Latvian for every question, option, row and hint', () => {
    for (const q of BACKGROUND_ITEMS) {
      const texts = [
        q.question,
        ...(q.kind === 'choice' ? q.options : []),
        ...(q.kind === 'grid' ? [...q.rows, ...q.columns] : []),
        ...((q.kind === 'choice' || q.kind === 'grid') && q.otherHint ? [q.otherHint] : []),
      ];
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
      'shaderCodeWritten',
    ]);
    expect(backgroundMissing({ ...full(), 'toolsMade.unity': undefined })).toEqual(['toolsMade.unity']);
  });

  it('rejects an answer the item does not offer', () => {
    expect(backgroundComplete({ ...full(), nodeEditorUse: 'expert' })).toBe(false);
    expect(backgroundComplete({ ...full(), 'toolsMade.blender': 'maybe' })).toBe(false);
    expect(backgroundComplete({ ...full(), shaderCodeWritten: 3 })).toBe(false);
    expect(backgroundComplete({ ...full(), shaderCodeWritten: 'complex' })).toBe(false);
  });

  it('records the wording asked, the answer and its language, and the other tools only when named', () => {
    const rec = buildBackgroundRecord(
      { ...full(), 'toolsMade.unity': 'yes', 'toolsMade.otherNodeEditor': 'yes', [otherKey(tools)]: '  Godot, Houdini  ', nodeEditorUse: 'regular' },
      { 'toolsMade.unity': 'lv', nodeEditorUse: 'en' },
    ) as { itemsVersion: string; items: Record<string, unknown>[] };
    expect(rec.items[0].otherText).toBe('Godot, Houdini');
    // Names typed and then the row answered No are not kept.
    const noOther = buildBackgroundRecord({ ...full(), [otherKey(tools)]: 'Godot' }) as { items: Record<string, unknown>[] };
    expect(noOther.items[0].otherText).toBe('');
    expect(rec.itemsVersion).toBe('bg-3');
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

  it('summary.csv columns follow the items and are empty for an earlier version\'s block', () => {
    const cols = backgroundCsvColumns(buildBackgroundRecord({ ...full(), 'toolsMade.blender': 'yes' }));
    expect(Object.fromEntries(cols)).toMatchObject({
      bg_items_version: 'bg-3',
      bg_toolsMade_blender: 'yes',
      bg_toolsMade_web3d: 'no',
      bg_toolsMade_otherNodeEditor: 'no',
      bg_nodeEditorUse: 'never',
      bg_shaderCodeWritten: 'no',
    });
    expect(cols.map(([k]) => k)).not.toContain('bg_toolsMade_touchdesigner');
    // The write-in never reaches the CSV.
    expect(JSON.stringify(backgroundCsvColumns(buildBackgroundRecord({ ...full(), 'toolsMade.otherNodeEditor': 'yes', [otherKey(tools)]: 'Godot' })))).not.toContain('Godot');
    // A first-wave block (levels 0-4 under the old ids) fills nothing, and
    // neither does a bg-2 one (its ids are retired).
    const old = backgroundCsvColumns({ scale: [], items: [{ id: 'blender', level: 3 }] });
    expect(old.every(([, v]) => v === '')).toBe(true);
    const bg2 = backgroundCsvColumns({ itemsVersion: 'bg-2', items: [{ id: 'toolsUsed', kind: 'grid', rows: [{ id: 'blender', answer: 'yes' }] }, { id: 'shaderCodeDepth', kind: 'choice', choice: 'complex' }] });
    expect(bg2.filter(([k]) => k !== 'bg_items_version').every(([, v]) => v === '')).toBe(true);
  });
});
