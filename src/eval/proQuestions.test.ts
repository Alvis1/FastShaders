import { describe, it, expect } from 'vitest';
import { PRO_ITEMS, PRO_SCALE_ITEMS, buildProRecord, proComplete } from './proQuestions';

describe('the professional question block', () => {
  it('every scale offers exactly five ordered options', () => {
    // Five keeps it the same shape as the SUS and experience strips; a
    // different width per question would read as a different instrument.
    for (const q of PRO_SCALE_ITEMS) {
      expect(q.levels, q.id).toHaveLength(5);
      expect(new Set(q.levels).size, `${q.id} has duplicate labels`).toBe(5);
    }
  });

  it('has unique ids — they are what the package records', () => {
    const ids = PRO_ITEMS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires every scale but never the free text', () => {
    const all = Object.fromEntries(PRO_SCALE_ITEMS.map((q) => [q.id, 0]));
    expect(proComplete(all)).toBe(true);              // texts left empty
    expect(proComplete({ ...all, [PRO_SCALE_ITEMS[0].id]: null })).toBe(false);
    expect(proComplete({})).toBe(false);
  });

  it('rejects a level outside its own option list', () => {
    const all = Object.fromEntries(PRO_SCALE_ITEMS.map((q) => [q.id, 1]));
    expect(proComplete({ ...all, [PRO_SCALE_ITEMS[0].id]: 5 })).toBe(false);
    expect(proComplete({ ...all, [PRO_SCALE_ITEMS[0].id]: -1 })).toBe(false);
  });

  it('records the label beside the level, and trims free text', () => {
    const first = PRO_SCALE_ITEMS[0];
    const rec = buildProRecord({ [first.id]: 2, role: '  Technical artist  ' }) as {
      items: { id: string; kind: string; level?: number; label?: string; text?: string }[];
    };
    const scale = rec.items.find((i) => i.id === first.id)!;
    expect(scale.level).toBe(2);
    expect(scale.label).toBe(first.levels[2]);
    const role = rec.items.find((i) => i.id === 'role')!;
    expect(role.kind).toBe('text');
    expect(role.text).toBe('Technical artist');
  });

  it('keeps an unanswered scale null rather than inventing a default', () => {
    const rec = buildProRecord({}) as { items: { level?: number | null; label?: string | null }[] };
    const scales = rec.items.filter((i) => 'level' in i);
    expect(scales.every((i) => i.level === null && i.label === null)).toBe(true);
  });
});
