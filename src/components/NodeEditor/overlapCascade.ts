/**
 * Local overlap-removal cascade for programmatic node placement — used when a
 * drag-connect snap parks a node beside its new peer: whatever sits under
 * that spot must MAKE ROOM, including knock-on effects (a pushed neighbor can
 * shove its own neighbors in turn), while the rest of the layout — the user's
 * mental map — stays put.
 *
 * Why a relaxation cascade and not a grid: node footprints vary ~10× (a 28px
 * color circle vs. a cost-scaled preview card), so a grid coarse enough to
 * guarantee separation wastes most of the canvas, and a fine grid guarantees
 * nothing. A cascade moves only what must move, by the minimum that clears
 * the collision — the same "insert a word, the sentence shifts" behavior.
 *
 * Mechanics: BFS from the FIXED anchors (the just-connected pair — their
 * handle alignment is the point of the gesture, so they never move). Each
 * settled box triggers an ESCAPE for every unsettled box it overlaps: per
 * pass, gather the current offenders among everything already settled, build
 * the four single-axis displacements that clear ALL of them at once, and take
 * the cheapest one that also clears the whole settled set. The full-set check
 * matters: a greedy per-box push ping-pongs in the corridor between the two
 * anchors — the exact geometry every connect snap creates (pair sits
 * CONNECT_SNAP_GAP apart, a wide mover straddles the gap) — while the
 * full-set candidate hops OVER the second anchor instead of bouncing off it.
 * Escaped boxes settle, push in turn, and never move again, so the sweep is
 * deterministic and terminates in at most one settle per box.
 */

export interface CascadeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Immovable anchor (the just-connected pair). */
  fixed?: boolean;
}

export interface CascadeShift {
  id: string;
  dx: number;
  dy: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bound on escape passes when no single-axis candidate clears the whole
 *  settled set (dense packs); residual overlap past this beats oscillation. */
const ESCAPE_PASSES = 8;

function overlaps(a: Rect, b: Rect): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0
  );
}

/** Displace `mover` (mutating it) until it overlaps nothing in `settled`. */
function escapeSettled(mover: Rect, settled: Rect[], gap: number): void {
  for (let pass = 0; pass < ESCAPE_PASSES; pass++) {
    const offenders = settled.filter((s) => overlaps(mover, s));
    if (offenders.length === 0) return;

    // The four single-axis displacements that clear EVERY current offender.
    const right = Math.max(...offenders.map((o) => o.x + o.w)) + gap - mover.x;
    const left = Math.min(...offenders.map((o) => o.x)) - gap - mover.w - mover.x;
    const down = Math.max(...offenders.map((o) => o.y + o.h)) + gap - mover.y;
    const up = Math.min(...offenders.map((o) => o.y)) - gap - mover.h - mover.y;
    const candidates = [
      { dx: right, dy: 0 },
      { dx: left, dy: 0 },
      { dx: 0, dy: down },
      { dx: 0, dy: up },
    ].sort((a, b) => Math.abs(a.dx + a.dy) - Math.abs(b.dx + b.dy));

    // Cheapest candidate that clears the WHOLE settled set wins; if none
    // does, take the cheapest partial escape and re-resolve next pass.
    const winner =
      candidates.find(
        (c) =>
          !settled.some((s) =>
            overlaps({ x: mover.x + c.dx, y: mover.y + c.dy, w: mover.w, h: mover.h }, s),
          ),
      ) ?? candidates[0];
    mover.x += winner.dx;
    mover.y += winner.dy;
  }
}

/**
 * Resolve overlaps radiating out from the fixed boxes. Returns the
 * displacement of every box that moved (fixed boxes never do). Boxes may be
 * in any shared coordinate space — callers use absolute flow coords and apply
 * the deltas to local positions (a delta is parent-invariant).
 */
export function resolveOverlapCascade(boxes: CascadeBox[], gap = 10): CascadeShift[] {
  const work = boxes.map((b) => ({ ...b }));
  const settled: CascadeBox[] = [];
  const queue: CascadeBox[] = [];
  const settledIds = new Set<string>();
  for (const b of work) {
    if (b.fixed) {
      settled.push(b);
      queue.push(b);
      settledIds.add(b.id);
    }
  }
  if (queue.length === 0) return [];

  while (queue.length > 0) {
    const a = queue.shift()!;
    for (const b of work) {
      if (settledIds.has(b.id)) continue;
      if (!overlaps(b, a)) continue;
      escapeSettled(b, settled, gap);
      settledIds.add(b.id);
      settled.push(b);
      queue.push(b);
    }
  }

  const original = new Map(boxes.map((b) => [b.id, b]));
  const shifts: CascadeShift[] = [];
  for (const b of work) {
    const o = original.get(b.id)!;
    const dx = b.x - o.x;
    const dy = b.y - o.y;
    if (dx !== 0 || dy !== 0) shifts.push({ id: b.id, dx, dy });
  }
  return shifts;
}
