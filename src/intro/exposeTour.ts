/**
 * The intro's sockets slide as data: right-click a noise, tick "scale" — the
 * parameter becomes an input socket; right-click the Output, tick "Emissive" —
 * the channel becomes a socket; then wire the noise into it.
 *
 * Pure and node-testable, like the other tours. The menus' rows and what a
 * tick shows on the cards are the app's own (ExposeScene).
 */
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

/** The noise parameter the slide exposes, and the Output channel. */
export const EXPOSE_PARAM = 'scale';
export const EXPOSE_CHANNEL = 'emissive';

export interface ExposeGeometry {
  /** Where each node is right-clicked (its header). */
  noise: Point;
  output: Point;
  /** The two checkboxes, in their menus. */
  paramBox: Point;
  channelBox: Point;
  /** Bare canvas, pressed to close a menu. */
  away: Point;
  /** The wire's ends: the noise's output socket, the new channel socket. */
  from: Point;
  to: Point;
}

export interface ExposeState {
  menu: 'none' | 'noise' | 'output';
  /** "scale" is a socket on the noise. */
  param: boolean;
  /** "Emissive" is a socket on the Output. */
  channel: boolean;
  dragging: boolean;
  wired: boolean;
  rightClick: boolean;
  pressed: boolean;
}

export interface ExposeTour {
  geo: ExposeGeometry;
  tl: Timeline<ExposeState>;
  /** Stills: each tick with its menu open, and the wire made. */
  param: number;
  channel: number;
  wired: number;
}

const REST: Point = { x: 250, y: 270 };

export function buildExposeTour(geo: ExposeGeometry): ExposeTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  let cur: ExposeState = {
    menu: 'none', param: false, channel: false, dragging: false, wired: false, rightClick: false, pressed: false,
  };
  const steps: Step<ExposeState>[] = [];
  /** A step from the state so far; a press and a right-click are momentary. */
  const go = (ms: number, to: Point, patch: Partial<ExposeState> = {}) => {
    cur = { ...cur, pressed: false, rightClick: false, ...patch };
    steps.push({ ms, to: at(to), state: cur });
    return steps.length - 1;
  };

  go(600, REST);
  // The noise's parameter.
  go(800, geo.noise);
  go(260, geo.noise, { rightClick: true });
  go(450, geo.noise, { menu: 'noise' });
  go(650, geo.paramBox);
  go(220, geo.paramBox, { pressed: true });
  const paramAt = go(1100, geo.paramBox, { param: true });
  go(650, geo.away);
  go(220, geo.away, { pressed: true, menu: 'none' });
  // The Output's channel.
  go(800, geo.output);
  go(260, geo.output, { rightClick: true });
  go(450, geo.output, { menu: 'output' });
  go(650, geo.channelBox);
  go(220, geo.channelBox, { pressed: true });
  const channelAt = go(1100, geo.channelBox, { channel: true });
  go(650, geo.away);
  go(220, geo.away, { pressed: true, menu: 'none' });
  // Wire the noise into the new socket.
  go(900, geo.from);
  go(220, geo.from, { pressed: true });
  go(1100, geo.to, { pressed: true, dragging: true });
  go(220, geo.to, { pressed: true, dragging: true });
  const wiredAt = go(2400, geo.to, { wired: true, dragging: false });
  go(700, { x: geo.to.x + 40, y: geo.to.y + 80 });

  const tl = timeline(at(REST), steps);
  return { geo, tl, param: stepMiddle(tl, paramAt), channel: stepMiddle(tl, channelAt), wired: stepMiddle(tl, wiredAt) };
}

export function exposeFrame(tour: ExposeTour, t: number): { cursor: Point; state: ExposeState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}
