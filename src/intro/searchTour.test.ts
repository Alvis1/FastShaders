import { describe, it, expect } from 'vitest';
import { searchNodes } from '@/registry/nodeRegistry';
import { SEARCH_QUERY, buildSearchTour, searchFrame, searchPicks } from './searchTour';

const geo = {
  centre: { x: 280, y: 110 },
  click: { x: 70, y: 40 },
  firstRow: { x: 320, y: 150 },
  secondRow: { x: 110, y: 160 },
};

describe('intro scene 1: open the node search, find noise, add it', () => {
  it('the real search for "noise" lists Perlin Noise first, and the scene picks two different noises', () => {
    const picks = searchPicks(searchNodes(SEARCH_QUERY, new Set()));
    expect(picks).not.toBeNull();
    const [first, second] = picks!;
    expect(first.type).toBe('perlin');
    expect(second.type).not.toBe(first.type);
    // Both are drawn with the noise card.
    expect(first.category).toBe('noise');
    expect(second.category).toBe('noise');
  });

  it('plays Space → search → node, then right-click → search → second node, in that order', () => {
    const tour = buildSearchTour(geo);
    const seen: string[] = [];
    for (let t = 0; t < tour.tl.total; t += 5) {
      const s = searchFrame(tour, t).state;
      const tag = s.key ? 'space-key' : s.rightClick ? 'right-click' : s.menu !== 'none' ? `menu:${s.menu}` : `placed:${s.placed}`;
      if (seen[seen.length - 1] !== tag) seen.push(tag);
    }
    expect(seen).toEqual(['placed:0', 'space-key', 'menu:space', 'placed:1', 'right-click', 'menu:right', 'placed:2']);
  });

  it('types the query one character at a time, both times', () => {
    const tour = buildSearchTour(geo);
    const counts: Record<string, number[]> = { space: [], right: [] };
    for (let t = 0; t < tour.tl.total; t += 5) {
      const s = searchFrame(tour, t).state;
      if (s.menu === 'none') continue;
      const c = counts[s.menu];
      if (c[c.length - 1] !== s.typed) c.push(s.typed);
    }
    const all = Array.from({ length: SEARCH_QUERY.length }, (_, i) => i + 1);
    expect(counts.space).toEqual([0, ...all]);
    expect(counts.right).toEqual([0, ...all]);
  });

  it('its stills show one node, then both', () => {
    const tour = buildSearchTour(geo);
    expect(searchFrame(tour, tour.first).state.placed).toBe(1);
    expect(searchFrame(tour, tour.both).state.placed).toBe(2);
  });
});
