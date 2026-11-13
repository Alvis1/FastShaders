/**
 * The intro's first scene as data: press Space — the node search opens at the
 * canvas centre — type "noise", pick the first result, and it lands there;
 * then right-click empty canvas, the same search opens at the pointer, type
 * "noise" again and pick another row.
 *
 * WHICH rows the search lists is not scripted: the scene reads the real
 * `searchNodes` (SearchScene.tsx), and `searchPicks` chooses the two rows from
 * that list — so a ranking change shows on the slide (and searchTour.test.ts
 * says so).
 *
 * Pure and node-testable, like insertTour.ts.
 */
import type { NodeDefinition } from '@/types';
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

/** What the scene types into the node search, both times. */
export const SEARCH_QUERY = 'noise';
/** The search list shows its first few results, as a short menu would. */
export const SEARCH_ROWS = 6;
/** The row the right-click pass prefers: a different noise than the first. */
const SECOND_CHOICE = 'cellNoise';

/** The two rows the scene picks from the fully typed search: the first result
 *  (what Enter would add), then Cell Noise — or, if the list lacks it, the next
 *  row down. Null when the search found nothing to show. */
export function searchPicks(results: readonly NodeDefinition[]): [NodeDefinition, NodeDefinition] | null {
  const shown = results.slice(0, SEARCH_ROWS);
  if (shown.length < 2) return null;
  const second = shown.find((d, i) => i > 0 && d.type === SECOND_CHOICE) ?? shown[1];
  return [shown[0], second];
}

/** What the scene measures, in stage px. */
export interface SearchGeometry {
  /** Where Space opens the menu: the canvas centre, which is also where the
   *  first node lands (AddNodeMenu places a new node AT the menu's point). */
  centre: Point;
  /** The right-click on empty canvas: the second menu's point and node's spot. */
  click: Point;
  /** The picked row in each menu. */
  firstRow: Point;
  secondRow: Point;
}

export type SearchMenu = 'none' | 'space' | 'right';

export interface SearchState {
  menu: SearchMenu;
  /** Characters of SEARCH_QUERY typed so far. */
  typed: number;
  /** The row shown focused: the search's first, or the picked one. */
  focus: 'first' | 'pick' | null;
  /** Nodes on the canvas: none, the Space pass's, both. */
  placed: 0 | 1 | 2;
  rightClick: boolean;
  pressed: boolean;
  /** The Space key is down. */
  key: boolean;
}

export interface SearchTour {
  geo: SearchGeometry;
  tl: Timeline<SearchState>;
  /** Stills: the first node landed, and both on the canvas. */
  first: number;
  both: number;
}

const REST: Point = { x: -70, y: 80 };
const LEAVE: Point = { x: 60, y: 70 };
const TYPE_MS = 120;

export function buildSearchTour(geo: SearchGeometry): SearchTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  const base: SearchState = { menu: 'none', typed: 0, focus: null, placed: 0, rightClick: false, pressed: false, key: false };
  const s = (patch: Partial<SearchState>): SearchState => ({ ...base, ...patch });
  const rest = at({ x: geo.centre.x + REST.x, y: geo.centre.y + REST.y });
  const typing = (menu: SearchMenu, placed: 0 | 1, where: Key): Step<SearchState>[] => {
    const out: Step<SearchState>[] = [];
    for (let n = 1; n <= SEARCH_QUERY.length; n++) {
      out.push({ ms: TYPE_MS, to: where, state: s({ menu, placed, typed: n, focus: 'first' }) });
    }
    return out;
  };
  const steps: Step<SearchState>[] = [
    // Space: the key goes down, the search opens at the centre.
    { ms: 700, to: rest, state: s({}) },
    { ms: 450, to: rest, state: s({ key: true }) },
    { ms: 300, to: rest, state: s({ key: true, menu: 'space' }) },
    ...typing('space', 0, rest),
  ];
  const typedAt = (menu: SearchMenu, placed: 0 | 1) => ({ menu, placed, typed: SEARCH_QUERY.length });
  steps.push(
    { ms: 450, to: rest, state: s({ ...typedAt('space', 0), focus: 'first' }) },
    { ms: 500, to: at(geo.firstRow), state: s({ ...typedAt('space', 0), focus: 'first' }) },
    { ms: 320, to: at(geo.firstRow), state: s({ ...typedAt('space', 0), focus: 'pick', pressed: true }) },
  );
  const firstAt = steps.length;
  // Right-click empty canvas: the same search, at the pointer.
  steps.push(
    { ms: 1300, to: at(geo.firstRow), state: s({ placed: 1 }) },
    { ms: 800, to: at(geo.click), state: s({ placed: 1 }) },
    { ms: 260, to: at(geo.click), state: s({ placed: 1, rightClick: true }) },
    { ms: 380, to: at(geo.click), state: s({ placed: 1, menu: 'right' }) },
    ...typing('right', 1, at(geo.click)),
    { ms: 450, to: at(geo.click), state: s({ ...typedAt('right', 1), focus: 'first' }) },
    { ms: 500, to: at(geo.secondRow), state: s({ ...typedAt('right', 1), focus: 'first' }) },
    { ms: 600, to: at(geo.secondRow), state: s({ ...typedAt('right', 1), focus: 'pick' }) },
    { ms: 320, to: at(geo.secondRow), state: s({ ...typedAt('right', 1), focus: 'pick', pressed: true }) },
  );
  const bothAt = steps.length;
  steps.push(
    { ms: 2200, to: at(geo.secondRow), state: s({ placed: 2 }) },
    { ms: 700, to: at({ x: geo.secondRow.x + LEAVE.x, y: geo.secondRow.y + LEAVE.y }), state: s({ placed: 2 }) },
  );
  const tl = timeline(rest, steps);
  return { geo, tl, first: stepMiddle(tl, firstAt), both: stepMiddle(tl, bothAt) };
}

export function searchFrame(tour: SearchTour, t: number): { cursor: Point; state: SearchState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}
