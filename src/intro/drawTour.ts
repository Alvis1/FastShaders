/**
 * The intro's annotation slide as data: Draw on, a flower drawn freehand
 * (owner, 2026-10-18), Draw off, then a sticky note added from the
 * right-click menu and typed into.
 *
 * Pure and node-testable, like the other tours. The strokes are polylines in
 * stage px, drawn as the board's own ink (DrawScene renders them through the
 * DrawingLayer's helpers); the pointer follows each one as it is drawn.
 */
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

/** A seeded random source (mulberry32): the flower is drawn freehand, but the
 *  same freehand every loop and every test run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hand's tremor along a stroke: two slow waves with random phases, about
 *  ±1 — smooth, so the line drifts rather than jitters. */
function tremor(rand: () => number): (u: number) => number {
  const f1 = 2 + rand() * 2;
  const f2 = 5 + rand() * 4;
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  return (u) => 0.7 * Math.sin(u * f1 * Math.PI * 2 + p1) + 0.3 * Math.sin(u * f2 * Math.PI * 2 + p2);
}

const FLOWER_SEED = 0x5eed_f10;

/**
 * A flower in four freehand strokes, as one would draw it: the petals (one
 * line round the head, overshooting where it closes), the centre (a small
 * scribbled loop), the stem and a leaf off the stem. `r` is the head's outer
 * radius, in stage px.
 *
 * Drawn the way a hand draws, not plotted: five petals of different length,
 * width and lean, spaced unevenly, a centre a little off centre, a stem that
 * sways and a leaf fuller on one side than the other — every deviation from a
 * seeded random source, so the flower is the same each loop.
 */
export function flowerStrokes(centre: Point, r: number): Point[][] {
  const rand = seeded(FLOWER_SEED);
  const jit = (amount: number) => (rand() * 2 - 1) * amount;
  const { x: cx, y: cy } = centre;
  const TAU = Math.PI * 2;

  // Petals: each its own length and lean, their axes spaced unevenly; the
  // outline dips between them to a waist of its own depth.
  const N = 5;
  const a0 = -Math.PI / 2 + jit(0.25);
  const axes = Array.from({ length: N }, (_, i) => a0 + (TAU * i) / N + jit(0.22));
  const reach = axes.map(() => r * (0.84 + rand() * 0.26));
  const waist = axes.map(() => r * (0.38 + rand() * 0.14));
  const skew = axes.map(() => 0.75 + rand() * 0.5);
  const shake = tremor(rand);
  const petals: Point[] = [];
  /** Where the outline dips between two petals — the stem grows from one. */
  const dips: Array<{ a: number; p: Point }> = [];
  const PER = 34;
  for (let i = 0; i < N; i++) {
    // The lobe runs from the dip before this petal to the dip after it.
    const prev = axes[(i + N - 1) % N] - (i === 0 ? TAU : 0);
    const next = axes[(i + 1) % N] + (i === N - 1 ? TAU : 0);
    const from = (prev + axes[i]) / 2;
    const to = (axes[i] + next) / 2;
    const w0 = waist[i];
    const w1 = waist[(i + 1) % N];
    for (let j = i === 0 ? 0 : 1; j <= PER; j++) {
      const u = j / PER;
      // A rounded lobe, its fullest point pushed off the middle (the lean).
      const lobe = Math.pow(Math.sin(Math.PI * Math.pow(u, skew[i])), 0.7);
      const base = w0 + (w1 - w0) * u;
      const rr = (base + (reach[i] - base) * lobe) * (1 + 0.035 * shake((i + u) / N));
      const a = from + (to - from) * u;
      petals.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
      if (j === PER) dips.push({ a, p: petals[petals.length - 1] });
    }
  }
  // The pen does not stop exactly where it began: it runs on a little.
  const over = Math.round(PER * 0.18);
  for (let j = 1; j <= over; j++) {
    const p = petals[j];
    petals.push({ x: p.x + 1.2, y: p.y + 0.8 });
  }

  // The centre: a loop and a bit, off centre, a hand's circle.
  const cc = { x: cx + jit(r * 0.06), y: cy + jit(r * 0.06) };
  const centreRing: Point[] = [];
  const turn = 1.25 + rand() * 0.15;
  const ringShake = tremor(rand);
  const m = 40;
  const s0 = rand() * TAU;
  for (let i = 0; i <= m; i++) {
    const u = i / m;
    const a = s0 + TAU * turn * u;
    const rr = r * (0.2 + 0.03 * u) * (1 + 0.1 * ringShake(u));
    centreRing.push({ x: cc.x + Math.cos(a) * rr * 1.08, y: cc.y + Math.sin(a) * rr });
  }

  // The stem leaves the head at the dip between the two lowest petals and
  // sways: a cubic with its two pulls on opposite sides.
  const down = (a: number) => Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2)));
  const top = dips.reduce((best, d) => (down(d.a) < down(best.a) ? d : best)).p;
  const bottom = { x: cx - r * (0.15 + rand() * 0.2), y: cy + r * (2.5 + rand() * 0.2) };
  const c1 = { x: cx + r * (0.3 + rand() * 0.15), y: cy + r * 1.2 };
  const c2 = { x: cx - r * (0.35 + rand() * 0.15), y: cy + r * 1.9 };
  const stemShake = tremor(rand);
  const stem: Point[] = [];
  const SN = 30;
  for (let i = 0; i <= SN; i++) {
    const t = i / SN;
    const k = 1 - t;
    stem.push({
      x: k * k * k * top.x + 3 * k * k * t * c1.x + 3 * k * t * t * c2.x + t * t * t * bottom.x + stemShake(t) * r * 0.03,
      y: k * k * k * top.y + 3 * k * k * t * c1.y + 3 * k * t * t * c2.y + t * t * t * bottom.y,
    });
  }

  // The leaf: out along one edge to a tip that curls up, back along the
  // other, the two sides of different fullness.
  const base = stem[Math.round(SN * (0.55 + rand() * 0.1))];
  const tip = { x: base.x + r * (0.9 + rand() * 0.2), y: base.y - r * (0.4 + rand() * 0.2) };
  const len = Math.hypot(tip.x - base.x, tip.y - base.y) || 1;
  const nx = (base.y - tip.y) / len;
  const ny = (tip.x - base.x) / len;
  const leafShake = tremor(rand);
  const leaf: Point[] = [];
  const k = 20;
  for (const [side, full] of [[1, r * (0.3 + rand() * 0.08)], [-1, r * (0.2 + rand() * 0.08)]] as const) {
    for (let i = 0; i <= k; i++) {
      const t = side === 1 ? i / k : 1 - i / k;
      // Fullest a little before the middle, the tip drawn to a point.
      const bulge = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 1.1) * full * side;
      const curl = t * t * r * 0.12;
      const x = base.x + (tip.x - base.x) * t;
      const y = base.y + (tip.y - base.y) * t - curl;
      const wob = 1 + 0.06 * leafShake(t * 0.5 + (side === 1 ? 0 : 0.5));
      leaf.push({ x: x + nx * bulge * wob, y: y + ny * bulge * wob });
    }
  }
  // Back to the stem, but not to the very same point.
  leaf.push({ x: base.x - 1, y: base.y + 1.5 });
  return [petals, centreRing, stem, leaf];
}

function lengths(points: readonly Point[]): number[] {
  const acc = [0];
  for (let i = 1; i < points.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return acc;
}

/** The first `p` (0–1, by length) of a stroke, ending exactly where the pen
 *  is — what has been drawn so far. */
export function strokePrefix(points: readonly Point[], p: number): Point[] {
  if (points.length === 0 || p <= 0) return [];
  if (p >= 1) return points.slice();
  const acc = lengths(points);
  const target = acc[acc.length - 1] * p;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (acc[i] < target) {
      out.push(points[i]);
      continue;
    }
    const seg = acc[i] - acc[i - 1] || 1;
    const u = (target - acc[i - 1]) / seg;
    out.push({ x: points[i - 1].x + (points[i].x - points[i - 1].x) * u, y: points[i - 1].y + (points[i].y - points[i - 1].y) * u });
    break;
  }
  return out;
}

/** Where the pen is at `p` along the stroke. */
export function penAt(points: readonly Point[], p: number): Point {
  const prefix = strokePrefix(points, Math.max(p, 1e-6));
  return prefix[prefix.length - 1] ?? points[0];
}

export interface DrawGeometry {
  /** The canvas bar's Draw button. */
  drawBtn: Point;
  /** The strokes, in drawing order, in stage px. */
  strokes: Point[][];
  /** Where the canvas is right-clicked for the note, and the menu's row. */
  noteClick: Point;
  noteRow: Point;
}

export interface DrawState {
  /** Draw mode is on (the button lit, its settings shown). */
  draw: boolean;
  /** The stroke being drawn, or -1. */
  stroke: number;
  /** The Add menu is open. */
  menu: boolean;
  /** The note is on the canvas, with this many characters typed. */
  note: boolean;
  typed: number;
  rightClick: boolean;
  pressed: boolean;
}

export interface DrawTour {
  geo: DrawGeometry;
  tl: Timeline<DrawState>;
  /** A still: every stroke and the finished note. */
  still: number;
}

const REST: Point = { x: 270, y: 200 };
const TYPE_MS = 65;

export function buildDrawTour(geo: DrawGeometry, noteText: string): DrawTour {
  const keyOf = (i: number) => `p${i}`;
  let cur: DrawState = { draw: false, stroke: -1, menu: false, note: false, typed: 0, rightClick: false, pressed: false };
  let prog: Record<string, number> = Object.fromEntries(geo.strokes.map((_, i) => [keyOf(i), 0]));
  const steps: Step<DrawState>[] = [];
  const go = (ms: number, to: Point, patch: Partial<DrawState> = {}, done: Record<string, number> = {}) => {
    cur = { ...cur, pressed: false, rightClick: false, ...patch };
    prog = { ...prog, ...done };
    steps.push({ ms, to: { x: to.x, y: to.y, ...prog }, state: cur });
    return steps.length - 1;
  };

  go(600, REST);
  go(800, geo.drawBtn);
  go(220, geo.drawBtn, { pressed: true });
  go(450, geo.drawBtn, { draw: true });
  geo.strokes.forEach((stroke, i) => {
    const end = stroke[stroke.length - 1];
    go(i === 0 ? 700 : 380, stroke[0]);
    // The pen's pace follows the stroke's length, as a hand's does.
    let len = 0;
    for (let j = 1; j < stroke.length; j++) len += Math.hypot(stroke[j].x - stroke[j - 1].x, stroke[j].y - stroke[j - 1].y);
    go(Math.max(500, len * 4.5), end, { stroke: i, pressed: true }, { [keyOf(i)]: 1 });
    go(200, end, { stroke: -1 });
  });
  go(800, geo.drawBtn);
  go(220, geo.drawBtn, { pressed: true });
  go(400, geo.drawBtn, { draw: false });
  go(800, geo.noteClick);
  go(260, geo.noteClick, { rightClick: true });
  go(450, geo.noteClick, { menu: true });
  go(550, geo.noteRow);
  go(220, geo.noteRow, { pressed: true });
  go(500, geo.noteRow, { menu: false, note: true });
  for (let n = 1; n <= noteText.length; n++) go(TYPE_MS, geo.noteRow, { typed: n });
  const stillAt = go(2600, geo.noteRow);
  go(700, { x: geo.noteRow.x + 60, y: geo.noteRow.y + 50 });

  const tl = timeline({ x: REST.x, y: REST.y, ...Object.fromEntries(geo.strokes.map((_, i) => [keyOf(i), 0])) } as Key, steps);
  return { geo, tl, still: stepMiddle(tl, stillAt) };
}

export function drawFrame(
  tour: DrawTour,
  t: number,
): { cursor: Point; state: DrawState; progress: number[]; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  const progress = tour.geo.strokes.map((_, i) => key[`p${i}`]);
  // While a stroke is being drawn the pointer IS the pen.
  const k = state.stroke;
  const cursor = k >= 0 ? penAt(tour.geo.strokes[k], progress[k]) : { x: key.x, y: key.y };
  return { cursor, state, progress, opacity };
}
