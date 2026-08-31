import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_ITEMS,
  EXPERIENCE_LEVELS,
  backgroundComplete,
  buildBackgroundRecord,
} from './background';

describe('the pre-SUS experience questions', () => {
  it('asks the four the study defined, on one none→expert scale', () => {
    expect(BACKGROUND_ITEMS.map((i) => i.id)).toEqual([
      'blender', 'unreal', 'otherNodeEditors', 'shaderCode',
    ]);
    expect(EXPERIENCE_LEVELS[0]).toBe('None');
    expect(EXPERIENCE_LEVELS[EXPERIENCE_LEVELS.length - 1]).toBe('Expert');
    expect(EXPERIENCE_LEVELS).toHaveLength(5);
  });

  it('only the node-editor question asks WHICH software', () => {
    const withFollowUp = BACKGROUND_ITEMS.filter((i) => i.followUp);
    expect(withFollowUp.map((i) => i.id)).toEqual(['otherNodeEditors']);
  });

  it('requires every scale but never the free text', () => {
    // A participant with no other-editor experience has nothing to name, so
    // the text must not block submit; the four levels are quick and are the
    // covariate the SUS score is read against, so they are required.
    const all = Object.fromEntries(BACKGROUND_ITEMS.map((i) => [i.id, 0]));
    expect(backgroundComplete(all)).toBe(true);
    expect(backgroundComplete({ ...all, blender: null })).toBe(false);
    expect(backgroundComplete({ ...all, unreal: undefined as never })).toBe(false);
    expect(backgroundComplete({})).toBe(false);
  });

  it('rejects out-of-range levels', () => {
    const all = Object.fromEntries(BACKGROUND_ITEMS.map((i) => [i.id, 2]));
    expect(backgroundComplete({ ...all, shaderCode: 5 })).toBe(false);
    expect(backgroundComplete({ ...all, shaderCode: -1 })).toBe(false);
    expect(backgroundComplete({ ...all, shaderCode: 1.5 })).toBe(false);
  });

  it('records the level AND its label, so 2 never has to be guessed at', () => {
    const rec = buildBackgroundRecord(
      { blender: 4, unreal: 0, otherNodeEditors: 2, shaderCode: 1 },
      '  Houdini COPs, intermediate  ',
    ) as { items: { id: string; level: number; label: string }[]; otherNodeEditorsText?: string };
    expect(rec.items.map((i) => [i.id, i.level, i.label])).toEqual([
      ['blender', 4, 'Expert'],
      ['unreal', 0, 'None'],
      ['otherNodeEditors', 2, 'Intermediate'],
      ['shaderCode', 1, 'Beginner'],
    ]);
    expect(rec.otherNodeEditorsText).toBe('Houdini COPs, intermediate');
  });

  it('omits the free text when it is blank, and keeps unanswered levels null', () => {
    const rec = buildBackgroundRecord({ blender: 3 }, '   ') as {
      items: { level: number | null; label: string | null }[];
      otherNodeEditorsText?: string;
    };
    expect('otherNodeEditorsText' in rec).toBe(false);
    expect(rec.items[1].level).toBeNull();
    expect(rec.items[1].label).toBeNull();
  });
});
