/**
 * The intro's Preview / Attach slide as data: Alt-click a node and the 3D view
 * shows it in place of the Output's Color, for as long as you look (a press
 * anywhere else ends it); Ctrl/⌘-click it and pick Color from the Attach list,
 * and it is wired there for good.
 *
 * Pure and node-testable, like the other tours. What the preview shows in
 * each state is the app's own derived graph (`previewGraph`) or the wired one
 * (PreviewScene).
 */
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

export interface PreviewGeometry {
  /** The node clicked, both times (its header). */
  node: Point;
  /** Bare canvas, pressed to end Preview mode. */
  away: Point;
  /** The Attach list's Color row. */
  colorRow: Point;
}

export interface PreviewState {
  /** The modifier held for the click: Preview's, Attach's, or none. */
  key: 'preview' | 'attach' | null;
  /** Preview mode is on: the node stands in for Color, the rest dims. */
  previewing: boolean;
  /** The Attach list is open. */
  menu: boolean;
  /** The node is wired into Color. */
  attached: boolean;
  pressed: boolean;
}

export interface PreviewTour {
  geo: PreviewGeometry;
  tl: Timeline<PreviewState>;
  /** Stills: previewing, the list open, attached. */
  previewing: number;
  menu: number;
  attached: number;
}

const REST: Point = { x: 170, y: 270 };

export function buildPreviewTour(geo: PreviewGeometry): PreviewTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  let cur: PreviewState = { key: null, previewing: false, menu: false, attached: false, pressed: false };
  const steps: Step<PreviewState>[] = [];
  const go = (ms: number, to: Point, patch: Partial<PreviewState> = {}) => {
    cur = { ...cur, pressed: false, ...patch };
    steps.push({ ms, to: at(to), state: cur });
    return steps.length - 1;
  };

  go(800, REST);
  // Preview: hold the modifier, click.
  go(800, geo.node);
  go(380, geo.node, { key: 'preview' });
  go(220, geo.node, { key: 'preview', pressed: true, previewing: true });
  const previewingAt = go(3400, geo.node, { key: null });
  // A press anywhere else ends it.
  go(700, geo.away);
  go(220, geo.away, { pressed: true, previewing: false });
  go(1400, geo.away);
  // Attach: the other modifier, the list, Color.
  go(700, geo.node);
  go(380, geo.node, { key: 'attach' });
  go(220, geo.node, { key: 'attach', pressed: true, menu: true });
  const menuAt = go(700, geo.node, { key: null });
  go(600, geo.colorRow);
  go(220, geo.colorRow, { pressed: true });
  const attachedAt = go(3400, geo.colorRow, { menu: false, attached: true });
  go(700, { x: geo.colorRow.x - 60, y: geo.colorRow.y + 60 });

  const tl = timeline(at(REST), steps);
  return { geo, tl, previewing: stepMiddle(tl, previewingAt), menu: stepMiddle(tl, menuAt), attached: stepMiddle(tl, attachedAt) };
}

export function previewFrame(tour: PreviewTour, t: number): { cursor: Point; state: PreviewState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}

/** The modifier as the keyboard in front of the user labels it. */
export function modifierCap(kind: 'preview' | 'attach', mac: boolean): string {
  if (kind === 'preview') return mac ? '⌥ Option' : 'Alt';
  return mac ? '⌘ Cmd' : 'Ctrl';
}
