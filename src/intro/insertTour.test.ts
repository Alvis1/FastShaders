import { describe, it, expect } from 'vitest';
import { buildInsertTour, insertFrame, insertWiring, wiringFor, ORIGINAL_EDGE, INSERT_QUERY } from './insertTour';

const geo = {
  click: { x: 270, y: 130 },
  insertRow: { x: 330, y: 146 },
  roundRow: { x: 330, y: 200 },
  roundGrab: { x: 300, y: 140 },
};

describe('intro scene 2: insert a node on a wire, then delete it', () => {
  it('the inserted Round takes the wire on its input and feeds the old target', () => {
    const w = insertWiring();
    expect(w.spliced).toEqual([
      { source: 'intro-noise', sourceHandle: 'out', target: 'intro-round', targetHandle: 'x' },
      { source: 'intro-round', sourceHandle: 'out', target: 'intro-output', targetHandle: 'color' },
    ]);
  });

  it('deleting it leaves the ORIGINAL wire — what the scene exists to show', () => {
    // bridgeEdgesAcrossDeletedNodes is the canvas's own rule; if it ever
    // stopped bridging, the scene would show the wire gone and this fails.
    expect(insertWiring().afterDelete).toEqual([ORIGINAL_EDGE]);
  });

  it('plays right-click → menu → typing → node on the wire → selected → Delete → gone, in that order', () => {
    const tour = buildInsertTour(geo);
    const seen: string[] = [];
    for (let t = 0; t < tour.tl.total; t += 5) {
      const s = insertFrame(tour, t).state;
      const tag = s.rightClick ? 'right-click' : s.menu === 'edge' ? 'edge-menu' : s.menu === 'add' ? 'search'
        : s.key ? `key:${s.node}` : s.node;
      if (seen[seen.length - 1] !== tag) seen.push(tag);
    }
    expect(seen).toEqual(['absent', 'right-click', 'edge-menu', 'search', 'present', 'selected', 'key:selected', 'key:deleted', 'deleted']);
  });

  it('types the query one character at a time', () => {
    const tour = buildInsertTour(geo);
    const counts: number[] = [];
    for (let t = 0; t < tour.tl.total; t += 5) {
      const s = insertFrame(tour, t).state;
      if (s.menu === 'add' && counts[counts.length - 1] !== s.typed) counts.push(s.typed);
    }
    expect(counts).toEqual(Array.from({ length: INSERT_QUERY.length + 1 }, (_, i) => i));
  });

  it('its stills show the node on the wire, then the original wire back', () => {
    const tour = buildInsertTour(geo);
    const w = insertWiring();
    expect(wiringFor(insertFrame(tour, tour.spliced).state.node, w)).toEqual(w.spliced);
    expect(wiringFor(insertFrame(tour, tour.deleted).state.node, w)).toEqual([ORIGINAL_EDGE]);
  });
});
