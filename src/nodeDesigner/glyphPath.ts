/**
 * SVG path-data model for the Node Designer's glyph editor: the tokenizer the
 * point editor has always used, plus the "add a point" gesture that subdivides a
 * segment without changing the drawn curve.
 *
 * WHY THIS FILE EXISTS. `tokenizePath`/`segEnd`/`segStart`/`serializePath` lived
 * inside `designerApp.ts`, which is `@ts-nocheck` vanilla with no exports and no
 * test coverage at all. The insert gesture needs exactly that arithmetic — a
 * relative command's arguments are measured from wherever the segments before it
 * ended, so inserting one has to re-derive the same bases the editor's own
 * setters do. Copying it into a second module would have made an invisible drift
 * pair: two implementations of the same rebasing, both plausible, disagreeing
 * only on the relative-command art nobody has in the shipped corpus (the class
 * CLAUDE.md documents for the `hsl` helper's emit-name/skip-name pair). So the
 * functions MOVED here verbatim and `designerApp.ts` imports them — which also
 * finally puts the path arithmetic under test.
 *
 * Pure and import-free so the vitest node env can cover it.
 */

export interface PathSeg {
  /** the command letter, case preserved — lower case means relative */
  cmd: string;
  args: number[];
}

export interface Pt { x: number; y: number }

/** argument count per command, keyed by the lower-case letter */
export const PATH_ARGC: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/**
 * Parse path data into segments.
 *
 * Deliberately forgiving — it stops at the first thing it cannot read rather
 * than throwing, because it runs on every frame of a drag over whatever the user
 * has typed. An implicit repeat after a moveto becomes a lineto (`M 0 0 4 4` is
 * `M 0 0 L 4 4`), which is what the SVG grammar says and what every exporter
 * emits.
 */
export function tokenizePath(d: string): PathSeg[] {
  const toks: Array<string | number> = [];
  const re = /([MLHVCSQTAZmlhvcsqtaz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d || ''))) toks.push(m[1] != null ? m[1] : parseFloat(m[2]));
  const segs: PathSeg[] = [];
  let i = 0;
  let cmd: string | null = null;
  while (i < toks.length) {
    if (typeof toks[i] === 'string') cmd = toks[i++] as string;
    if (cmd == null) break;
    const lc = cmd.toLowerCase();
    if (lc === 'z') { segs.push({ cmd: cmd, args: [] }); cmd = null; continue; }
    const n = PATH_ARGC[lc]; if (n == null) break;
    const args: number[] = [];
    let ok = true;
    for (let k = 0; k < n; k++) { if (typeof toks[i] === 'number') args.push(toks[i++] as number); else { ok = false; break; } }
    if (!ok) break;
    segs.push({ cmd: cmd, args: args });
    if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l';
  }
  return segs;
}

/** The editor's number format: 2 decimals, no trailing zeros. */
export function fmtN(v: number): string { return String(Math.round(v * 100) / 100); }

export function serializePath(segs: PathSeg[]): string {
  return segs.map((s) => s.cmd + (s.args.length ? ' ' + s.args.map(fmtN).join(' ') : '')).join(' ');
}

/** Where a segment leaves the pen, and where the current subpath started. */
export function segEnd(s: PathSeg, cur: Pt, sub: Pt): { cur: Pt; sub: Pt } {
  const lc = s.cmd.toLowerCase(), rel = s.cmd === lc, a = s.args;
  let x = cur.x, y = cur.y, sx = sub.x, sy = sub.y;
  switch (lc) {
    case 'm': x = rel ? cur.x + a[0] : a[0]; y = rel ? cur.y + a[1] : a[1]; sx = x; sy = y; break;
    case 'l': case 't': x = rel ? cur.x + a[0] : a[0]; y = rel ? cur.y + a[1] : a[1]; break;
    case 'h': x = rel ? cur.x + a[0] : a[0]; break;
    case 'v': y = rel ? cur.y + a[0] : a[0]; break;
    case 'c': x = rel ? cur.x + a[4] : a[4]; y = rel ? cur.y + a[5] : a[5]; break;
    case 's': case 'q': x = rel ? cur.x + a[2] : a[2]; y = rel ? cur.y + a[3] : a[3]; break;
    case 'a': x = rel ? cur.x + a[5] : a[5]; y = rel ? cur.y + a[6] : a[6]; break;
    case 'z': x = sx; y = sy; break;
  }
  return { cur: { x: x, y: y }, sub: { x: sx, y: sy } };
}

/** Absolute pen position when segment `idx` begins — the base relative args rebase on. */
export function segStart(segs: PathSeg[], idx: number): Pt {
  let cur = { x: 0, y: 0 }, sub = { x: 0, y: 0 };
  for (let i = 0; i < idx; i++) { const r = segEnd(segs[i], cur, sub); cur = r.cur; sub = r.sub; }
  return cur;
}

/** Absolute end position of every segment, in order. */
export function pathSegEnds(segs: PathSeg[]): Pt[] {
  const out: Pt[] = [];
  let cur = { x: 0, y: 0 }, sub = { x: 0, y: 0 };
  for (let i = 0; i < segs.length; i++) { const r = segEnd(segs[i], cur, sub); cur = r.cur; sub = r.sub; out.push({ x: cur.x, y: cur.y }); }
  return out;
}

/**
 * C/S/Q → L with the SAME endpoint args (same segment, same base), so the end
 * position is bit-identical and only the curvature is gone. Deleting a curve's
 * HANDLE must not delete the shape, and doing nothing would be a dead key.
 */
export function degradeCurve(s: PathSeg): PathSeg {
  const lc = s.cmd.toLowerCase(), rel = s.cmd === lc, a = s.args;
  if (lc === 'c') return { cmd: rel ? 'l' : 'L', args: [a[4], a[5]] };
  if (lc === 's' || lc === 'q') return { cmd: rel ? 'l' : 'L', args: [a[2], a[3]] };
  return { cmd: s.cmd, args: s.args.slice() };
}

/* ------------------------------------------------------- adding a point --- */

function lerp(a: Pt, b: Pt, t: number): Pt { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

/** Which segments can a point be inserted into? */
export function canInsertInto(cmd: string): boolean {
  const lc = cmd.toLowerCase();
  return lc === 'l' || lc === 'h' || lc === 'v' || lc === 'c' || lc === 'q' || lc === 's' || lc === 't' || lc === 'z';
}

/**
 * The absolute control points of segment `si`, as a 2/3/4-point Bézier, given the
 * pen position it starts from. Returns null for a segment that is not a drawable
 * span (a moveto) or one this module refuses (an arc).
 *
 * `S` and `T` are MATERIALIZED into their explicit `C`/`Q` forms here: their
 * first control point is the reflection of the previous segment's, so a split
 * that kept the shorthand would silently re-reflect against a new neighbour and
 * move the curve. `prevCtrl` is that previous control point in absolute space
 * (null when the previous segment was not a curve of the matching family, which
 * per the SVG spec means the reflection degenerates to the current point).
 */
export function segCurve(segs: PathSeg[], si: number, base: Pt, prevCtrl: Pt | null, subStart: Pt): Pt[] | null {
  const s = segs[si]; if (!s) return null;
  const lc = s.cmd.toLowerCase(), rel = s.cmd === lc, a = s.args;
  const abs = (dx: number, dy: number): Pt => (rel ? { x: base.x + dx, y: base.y + dy } : { x: dx, y: dy });
  const refl = (): Pt => (prevCtrl ? { x: 2 * base.x - prevCtrl.x, y: 2 * base.y - prevCtrl.y } : { x: base.x, y: base.y });
  switch (lc) {
    case 'l': return [base, abs(a[0], a[1])];
    case 'h': return [base, { x: rel ? base.x + a[0] : a[0], y: base.y }];
    case 'v': return [base, { x: base.x, y: rel ? base.y + a[0] : a[0] }];
    case 'z': return [base, subStart];
    case 'c': return [base, abs(a[0], a[1]), abs(a[2], a[3]), abs(a[4], a[5])];
    case 'q': return [base, abs(a[0], a[1]), abs(a[2], a[3])];
    case 's': return [base, refl(), abs(a[0], a[1]), abs(a[2], a[3])];
    case 't': return [base, refl(), abs(a[0], a[1])];
    default: return null;                      // m / a — nothing to subdivide
  }
}

/**
 * The absolute control point a following S/T would reflect, for segment `si`.
 * Null when this segment is not a curve, per the SVG rule.
 */
export function trailingCtrl(segs: PathSeg[], si: number, base: Pt, prevCtrl: Pt | null): Pt | null {
  const s = segs[si]; if (!s) return null;
  const lc = s.cmd.toLowerCase(), rel = s.cmd === lc, a = s.args;
  const abs = (dx: number, dy: number): Pt => (rel ? { x: base.x + dx, y: base.y + dy } : { x: dx, y: dy });
  const refl = (): Pt => (prevCtrl ? { x: 2 * base.x - prevCtrl.x, y: 2 * base.y - prevCtrl.y } : { x: base.x, y: base.y });
  if (lc === 'c') return abs(a[2], a[3]);
  if (lc === 'q') return abs(a[0], a[1]);
  if (lc === 's') return abs(a[0], a[1]);
  if (lc === 't') return refl();
  return null;
}

/**
 * Every drawable span of a path, in absolute space, with the segment index it
 * belongs to — what the insert gesture hit-tests against.
 */
export function pathSpans(segs: PathSeg[]): Array<{ si: number; pts: Pt[] }> {
  const out: Array<{ si: number; pts: Pt[] }> = [];
  let cur = { x: 0, y: 0 }, sub = { x: 0, y: 0 }, prevCtrl: Pt | null = null;
  for (let i = 0; i < segs.length; i++) {
    const span = segCurve(segs, i, cur, prevCtrl, sub);
    if (span) out.push({ si: i, pts: span });
    const nextCtrl = trailingCtrl(segs, i, cur, prevCtrl);
    const r = segEnd(segs[i], cur, sub);
    cur = r.cur; sub = r.sub; prevCtrl = nextCtrl;
  }
  return out;
}

/**
 * Insert an anchor at parameter `t` of segment `si`, returning new path data and
 * the index of the segment whose ENDPOINT is the new anchor.
 *
 * Two rules make this safe. The drawn curve is **bit-identical** afterwards — a
 * `C`/`Q` is split with de Casteljau, an `L`/`H`/`V` at the interpolated point —
 * so adding a handle never moves the art. And every segment this touches is
 * rewritten in ABSOLUTE form: a relative command's arguments are measured from
 * the previous segment's end, and inserting one shifts that base for everything
 * downstream, so keeping the shorthand would translate the rest of the subpath.
 * (`Z` is a special case: it is not rewritten but preceded by a new `L`, so the
 * subpath still closes.)
 */
export function insertIntoPath(segs: PathSeg[], si: number, t: number): { segs: PathSeg[]; anchorSeg: number } | null {
  const s = segs[si]; if (!s || !canInsertInto(s.cmd)) return null;
  const u = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5));
  let cur = { x: 0, y: 0 }, sub = { x: 0, y: 0 }, prevCtrl: Pt | null = null;
  for (let i = 0; i < si; i++) {
    prevCtrl = trailingCtrl(segs, i, cur, prevCtrl);
    const r = segEnd(segs[i], cur, sub); cur = r.cur; sub = r.sub;
  }
  const span = segCurve(segs, si, cur, prevCtrl, sub); if (!span) return null;
  const lc = s.cmd.toLowerCase();

  /* A FOLLOWING S/T takes its first control point by reflecting THIS segment's
     last one — so splitting this segment silently redefines the next curve. It is
     therefore materialized here, from the ORIGINAL neighbour, BEFORE the splice:
     computing it afterwards reflects against the second half's control point and
     moves the art (measured: a C split at t=0.5 followed by an S drifted 1.96
     view units, a third of the canvas). Two S's in a row are safe once the first
     is explicit, since its absolute controls are unchanged. */
  const follow = segs[si + 1];
  let followAbs: PathSeg | null = null;
  if (follow && /^[st]$/i.test(follow.cmd)) {
    const ctrlHere = trailingCtrl(segs, si, cur, prevCtrl);
    const r = segEnd(segs[si], cur, sub);
    const sp = segCurve(segs, si + 1, r.cur, ctrlHere, r.sub);
    if (sp && sp.length === 4) followAbs = { cmd: 'C', args: [sp[1].x, sp[1].y, sp[2].x, sp[2].y, sp[3].x, sp[3].y] };
    else if (sp && sp.length === 3) followAbs = { cmd: 'Q', args: [sp[1].x, sp[1].y, sp[2].x, sp[2].y] };
  }

  const out = segs.slice();
  let replacement: PathSeg[];

  if (span.length === 4) {
    const a = lerp(span[0], span[1], u), b = lerp(span[1], span[2], u), c = lerp(span[2], span[3], u);
    const d = lerp(a, b, u), e = lerp(b, c, u), f = lerp(d, e, u);
    replacement = [
      { cmd: 'C', args: [a.x, a.y, d.x, d.y, f.x, f.y] },
      { cmd: 'C', args: [e.x, e.y, c.x, c.y, span[3].x, span[3].y] },
    ];
  } else if (span.length === 3) {
    const a = lerp(span[0], span[1], u), b = lerp(span[1], span[2], u);
    const c = lerp(a, b, u);
    replacement = [
      { cmd: 'Q', args: [a.x, a.y, c.x, c.y] },
      { cmd: 'Q', args: [b.x, b.y, span[2].x, span[2].y] },
    ];
  } else {
    const m = lerp(span[0], span[1], u);
    /* A Z is KEPT — removing it would open the subpath — and the new anchor goes
       in front of it as an explicit lineto to the same place the Z would have
       gone. */
    replacement = lc === 'z'
      ? [{ cmd: 'L', args: [m.x, m.y] }, { cmd: s.cmd, args: [] }]
      : [{ cmd: 'L', args: [m.x, m.y] }, { cmd: 'L', args: [span[1].x, span[1].y] }];
  }
  out.splice(si, 1, ...replacement);
  if (followAbs) out[si + replacement.length] = followAbs;
  return { segs: out, anchorSeg: si };
}

/**
 * Insert a vertex into a `points` list at the segment starting on vertex `vi`.
 * Returns the new flat number list and the ARG index (x) of the new vertex, which
 * is what `collectGlyphPoints` keys its poly handles on.
 */
export function insertIntoPoly(nums: number[], vi: number, t: number, closed = false): { nums: number[]; at: number } | null {
  const count = Math.floor(nums.length / 2);
  if (count < 2 || vi < 0 || vi >= count) return null;
  const next = vi + 1 >= count ? (closed ? 0 : -1) : vi + 1;
  if (next < 0) return null;
  const u = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5));
  const ax = nums[vi * 2], ay = nums[vi * 2 + 1], bx = nums[next * 2], by = nums[next * 2 + 1];
  const mx = ax + (bx - ax) * u, my = ay + (by - ay) * u;
  const out = nums.slice();
  const at = (vi + 1) * 2;
  out.splice(at, 0, mx, my);
  return { nums: out, at: at };
}
