import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_ITEMS,
  EXPERIENCE_LEVELS,
  backgroundComplete,
  buildBackgroundRecord,
} from './background';

describe('the pre-SUS experience questions', () => {
  it('asks the three the study defined, on one none→expert scale', () => {
    // 'otherNodeEditors' (with its "Which software?" box) was REMOVED on
    // 2026-10-02 — the shader-knowledge question was already the fourth item
    // and is now the third. The id must not come back under a different
    // question, or older packages would read as answers to it.
    expect(BACKGROUND_ITEMS.map((i) => i.id)).toEqual(['blender', 'unreal', 'shaderCode']);
    expect(BACKGROUND_ITEMS.find((i) => i.id === 'shaderCode')?.question).toBe(
      'Technical knowledge of shader programming (e.g. GLSL, HLSL)',
    );
    expect(EXPERIENCE_LEVELS[0]).toBe('None');
    expect(EXPERIENCE_LEVELS[EXPERIENCE_LEVELS.length - 1]).toBe('Expert');
    expect(EXPERIENCE_LEVELS).toHaveLength(5);
  });

  it('requires every scale', () => {
    // The levels are quick and are the covariate the SUS score is read
    // against, so every one of them gates submit.
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
    const rec = buildBackgroundRecord({ blender: 4, unreal: 0, shaderCode: 2 }) as {
      items: { id: string; level: number; label: string }[];
    };
    expect(rec.items.map((i) => [i.id, i.level, i.label])).toEqual([
      ['blender', 4, 'Expert'],
      ['unreal', 0, 'None'],
      ['shaderCode', 2, 'Intermediate'],
    ]);
  });

  it('keeps unanswered levels null, and records no free text', () => {
    const rec = buildBackgroundRecord({ blender: 3 }) as Record<string, unknown> & {
      items: { level: number | null; label: string | null }[];
    };
    expect(rec.items[1].level).toBeNull();
    expect(rec.items[1].label).toBeNull();
    // The retired "Which software?" box wrote this key; nothing may any more.
    expect('otherNodeEditorsText' in rec).toBe(false);
    expect(Object.keys(rec).sort()).toEqual(['items', 'scale']);
  });
});
