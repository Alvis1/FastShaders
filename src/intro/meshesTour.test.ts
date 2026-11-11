import { describe, it, expect } from 'vitest';
import { graphToCode } from '@/engine/graphToCode';
import { buildMeshesTour, meshPicks, meshesFrame, meshesGraph, targetsAfter } from './meshesTour';

/** The names the preview document reports for the intro figure (the sandbox's
 *  sanitized node names, measured 2026-11-11). Only the picker's rule reads
 *  them here; the slide itself uses the live report. */
const FIGURE = [
  'Mannequin_Body_Down001', 'Mannequin_Body_Up001', 'Mannequin_Hand_L_1001', 'Mannequin_Head001', 'Mannequin_Leg_L_1001',
];

const geo = { picker: { x: 200, y: 190 }, rows: [{ x: 210, y: 240 }, { x: 210, y: 222 }] as [{ x: number; y: number }, { x: number; y: number }], away: { x: 80, y: 140 } };

describe('multi-mesh slide', () => {
  it('ticks the upper body, then the lower, and the Output names them in the model’s order', () => {
    const picks = meshPicks(FIGURE)!;
    expect(picks).toEqual(['Mannequin_Body_Up001', 'Mannequin_Body_Down001']);
    expect(targetsAfter(FIGURE, picks, 1)).toEqual(['Mannequin_Body_Up001']);
    expect(targetsAfter(FIGURE, picks, 2)).toEqual(['Mannequin_Body_Down001', 'Mannequin_Body_Up001']);
  });

  it('falls back to the first two meshes of any other model', () => {
    expect(meshPicks(['a', 'b', 'c'])).toEqual(['a', 'b']);
    expect(meshPicks(['a'])).toBeNull();
  });

  it('the ticked meshes reach the emitted code as parts; with none ticked, the second Output emits nothing', () => {
    const none = graphToCode(...Object.values(meshesGraph([])) as Parameters<typeof graphToCode>).code;
    expect(none).not.toContain('Mannequin');
    const two = graphToCode(...Object.values(meshesGraph(['Mannequin_Body_Down001', 'Mannequin_Body_Up001'])) as Parameters<typeof graphToCode>).code;
    expect(two).toContain('"Mannequin_Body_Down001"');
    expect(two).toContain('"Mannequin_Body_Up001"');
  });

  it('plays: rest → open the list → tick one → tick two → close → hold', () => {
    const tour = buildMeshesTour(geo);
    const seen: string[] = [];
    for (let t = 0; t < tour.tl.total; t += 5) {
      const s = meshesFrame(tour, t).state;
      const tag = `${s.open ? 'open' : 'closed'}:${s.ticked}`;
      if (seen[seen.length - 1] !== tag) seen.push(tag);
    }
    expect(seen).toEqual(['closed:0', 'open:0', 'open:1', 'open:2', 'closed:2']);
    expect(meshesFrame(tour, tour.before).state.ticked).toBe(0);
    expect(meshesFrame(tour, tour.after).state).toMatchObject({ open: false, ticked: 2 });
  });
});
