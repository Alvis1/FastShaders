// @ts-nocheck
/**
 * Node Designer application logic — ported from node-designer.html's inline
 * script when the designer became a Vite entry in the app's module graph.
 *
 * What changed in the port (and why the designer can no longer drift):
 *   · The stage preview is rendered by the REAL app renderer (NodeVisual via
 *     bridge.renderNodePreview) — the hand-written `.node` DOM/CSS mimic is
 *     gone. Gestures (socket drag/click, glyph & art drag-to-nudge, corner
 *     resize) now bind by DELEGATION on the stage, identifying targets by the
 *     replica's own classes plus data-port/data-io/data-nd-glyph/data-nd-art.
 *   · The inline NODES/COSTS/colour/i18n/built-in-art snapshots are imports
 *     (bridge.ts / ndData.ts). designerCoverage.test.ts used to police the
 *     NODES copy; parity is now by construction.
 *   · Values scrubbed on the preview go through the real DragNumberInput.
 *
 * What deliberately did NOT change: the inspector, the glyph SVG editor with
 * its draggable-points mode, the stash/dirty model, and every save path
 * (dev-server /__nd endpoint → File System Access folder → download). The
 * customGlyphs.ts file format is byte-compatible.
 *
 * Kept as plain, lightly-typed JS under @ts-nocheck: this is the one file that
 * is UI plumbing for a dev tool, ported from battle-tested vanilla code —
 * retyping it wholesale would churn every line for no behavioural gain.
 */
import * as ND from './bridge';
import { scaleSocketOffsets, scaleSocketOffsetsRaw } from './socketScale';
import { scanGlyphSource, tagsAlign, drawableIndexAtOffset, mergeRanges, formatGlyphSource, DRAWABLE_TAGS } from './glyphSource';
import { rotatePt, normalizeDeg, snapDeg, rotateTransform, projectOnSegment, nearestOnCurve, simplifyRdp, freehandPathData, shouldCloseStroke, penPathData } from './glyphGeometry';
import { PATH_ARGC, tokenizePath, fmtN, serializePath, segEnd, segStart, pathSegEnds, degradeCurve, pathSpans, insertIntoPath, insertIntoPoly, canInsertInto } from './glyphPath';
import { GLYPH_PALETTE, isPaletteColor, normalizePaintValue, normalizePaintNumber, displayPaintNumber, summarizePaint } from './glyphPaint';

/* ---------------- registry data (live imports — see bridge.ts) ---------------- */
const NODES = ND.designerNodes();
const COSTS = ND.NODE_COSTS;
/* Object.create(null), not {} — this map is a MEMBERSHIP TEST, and a plain
   object inherits Object.prototype, so NODE_BY_TYPE['constructor'] (or
   'toString', '__proto__', 'valueOf'…) answers truthy for a node that doesn't
   exist. That matters because the lookup key is attacker-supplied via ?node=:
   a crafted link would pass every `if(!NODE_BY_TYPE[t])` guard, reach
   selectNode, and persist the bogus type to nd:lastNode BEFORE crashing —
   poisoning every later BARE load until localStorage is cleared by hand. */
const NODE_BY_TYPE = Object.create(null);
NODES.forEach((n) => { NODE_BY_TYPE[n.type] = n; });

/* --- i18n (EN/LV), display-only — the app's own tables via the bridge. --- */
let ND_LANG = (lsGet('nd:lang', 'en') === 'lv') ? 'lv' : 'en';

/* ---------------- display names (renaming) ----------------
   A node's NAME is registry source — `label` in nodeRegistry.ts (English) and
   node-i18n.json's `nodes` map (Latvian) — so unlike every other field in this
   inspector it does NOT live in customGlyphs.ts and cannot ride the glyph file's
   save. It gets its own patch endpoint and its own dirty bookkeeping.

   Renaming is safe precisely because `label` is display-only: `type` is the
   registry key, the `registryType` stored in every saved .fastshader, and what
   codeToGraph matches on — none of which the label touches. That separation is
   pinned by nodeLabelRename.test.ts, and `type` is deliberately NOT editable here.

   Names resolve in three layers, nearest first, because the BUNDLE cannot see a
   save (nodeRegistry.ts HMR reloads the page; a deployed build never changes):
     labelEdits[type]  — this session's unsaved rename
     savedLabels[type] — the on-disk file as /__nd/labels last reported it
     NODE_BY_TYPE      — what this build was compiled with */
let savedLabels = Object.create(null);      // type -> EN label (on-disk truth)
let savedLvLabels = Object.create(null);    // type -> LV label (on-disk truth)
let labelEdits = Object.create(null);       // type -> { en?, lv? }, only when DIFFERENT
let labelApi = false;                       // /__nd/labels reachable
/* Same null-prototype reasoning as NODE_BY_TYPE: this is rehydrated from
   localStorage and every read below is an `in` check. */
try { Object.assign(labelEdits, JSON.parse(lsGet('nd:labelEdits', '{}')) || {}); } catch (e) { labelEdits = Object.create(null); }
/* Drop edits for types this build has no node for. Nothing else can clear such a key:
   it is not in the dropdown so it cannot be selected and typed back, yet dirtyTypes()
   would include it, saveAll() would put it in the patch, and BOTH writers reject an
   unknown type — so one stale key from a retired node type (this repo has retired
   several) would abort every future Save All with no way out. */
Object.keys(labelEdits).forEach((t) => { if (!NODE_BY_TYPE[t]) delete labelEdits[t]; });

/** On-disk English name (no session edit) — falls back to the compiled registry. */
function savedEn(type) {
  if (type in savedLabels) return savedLabels[type];
  const n = NODE_BY_TYPE[type];
  return n ? n.label : type;
}
/** On-disk Latvian name, '' when untranslated (NOT the English fallback). */
function savedLv(type) {
  if (type in savedLvLabels) return savedLvLabels[type];
  return ND.nodeLabelLV(type);
}
function labelEn(type) {
  const e = labelEdits[type];
  return (e && typeof e.en === 'string') ? e.en : savedEn(type);
}
function labelLv(type) {
  const e = labelEdits[type];
  return (e && typeof e.lv === 'string') ? e.lv : savedLv(type);
}
/* These two mirror i18n's formatNodeLabel(en, type, lang, bilingual) exactly —
   they cannot CALL it, because it reads the compiled node-i18n.json and would
   ignore an unsaved rename. Keep the two output forms in step with i18n/index.ts. */
function ndBaseLabel(type) {
  const lv = labelLv(type);
  return (ND_LANG === 'lv' && lv) ? lv : labelEn(type);
}
function ndNodeLabel(type) {
  const en = labelEn(type);
  const lv = labelLv(type);
  return (ND_LANG === 'lv' && lv) ? lv + ' (' + en + ')' : en;
}
function ndCatLabel(cat) { return ND.catLabel(cat, ND_LANG); }
function updateLangBtn() {
  const b = el('langBtn'); if (!b) return;
  b.textContent = 'LV';
  if (ND_LANG === 'lv') { b.style.background = '#2563eb'; b.style.color = '#fff'; b.style.borderColor = '#2563eb'; }
  else { b.style.background = ''; b.style.color = ''; b.style.borderColor = ''; }
  b.title = ND_LANG === 'lv'
    ? 'Rāda latviešu nosaukumus — klikšķini, lai atgrieztos pie English'
    : 'Switch node names to Latvian (Pārslēgt uz latviešu)';
}

/* channel count per data type (preview-state seeding) */
const LINE_COUNT = ND.TYPE_CHANNELS;
/* per-channel edge colors — the REAL TypedEdge table (1-ch flips vs canvas) */
const COUNT_EDGE_COLORS = ND.COUNT_EDGE_COLORS;
/* Edge-stub geometry mirrors TypedEdge.tsx (GAP = 3.5/3, per-count widths,
   `4 0.5` dash). Stubs aren't part of the node, so this stays a documented
   mirror — TypedEdge needs React Flow context and can't render standalone. */
const EDGE_GAP = 3.5 / 3, STUB_LEN = 64;

function builtinGlyph(t) { return ND.builtinGlyphSvg(t); }

/* ---------------- helpers ---------------- */
function contrast(hex) { return ND.contrastColor(String(hex || '#ffffff')); }
function costColor(c) { return ND.costColorOf(c); }
function costScaleOf(c) { return ND.costScaleOf(c); }
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400); }
function el(id) { return document.getElementById(id); }
function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

/* normalize pasted/dropped svg to inner content in 0..56 space */
/**
 * Serialize a parsed <svg>'s children WITHOUT namespace declarations.
 *
 * `svg.innerHTML` on a document parsed as image/svg+xml runs the XML serializer,
 * which re-declares the SVG namespace on every top-level child it emits — pasting a
 * plain `<svg>…<text>…` comes back as `<text xmlns="http://www.w3.org/2000/svg">`.
 * The string is injected INSIDE a live <svg> (NodeGlyph, via dangerouslySetInnerHTML)
 * where that namespace is already in scope, so the declaration is pure noise — but
 * glyphCoverage.test.ts fails any glyph containing `http(s):`, because art must never
 * reference an external URL. Without this, the designer's own "paste an SVG" path
 * saves a glyph that turns the suite red — which is exactly how the `oneMinus` entry
 * in customGlyphs.ts got there.
 *
 * Re-hosting the children in an <svg> owned by THIS document and reading innerHTML
 * there gets the HTML fragment serializer, which emits no namespace declarations at
 * all. A regex over the XML output was the obvious alternative and is WRONG: it also
 * eats the literal text `xmlns="…"` out of a <text> node's CONTENT — measured in
 * Chrome, a glyph reading `use xmlns="trap" here` came back as `use here`. Also
 * measured: this path preserves SVG's case-sensitive attributes (gradientUnits,
 * textLength, lengthAdjust) and xlink:href, and normalizes `<circle/>` to
 * `<circle></circle>`, which glyphCoverage's tag-balance count accepts.
 *
 * A genuine external reference (`xlink:href="http://…"`) still survives and still
 * trips that test, which is the point of it.
 */
function innerSvgOf(svg) {
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const kids = Array.prototype.slice.call(svg.childNodes);
  for (let i = 0; i < kids.length; i++) host.appendChild(document.importNode(kids[i], true));
  return host.innerHTML;
}
function normalizeSvg(text) {
  text = (text || '').trim(); if (!text) return '';
  if (!/<svg[\s>]/i.test(text)) return text; // already inner content
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml'); const svg = doc.querySelector('svg'); if (!svg) return text;
    let vb = svg.getAttribute('viewBox'); let mx = 0, my = 0, w = 56, h = 56;
    if (vb) { const p = vb.split(/[ ,]+/).map(Number); mx = p[0]; my = p[1]; w = p[2]; h = p[3]; }
    else { w = parseFloat(svg.getAttribute('width')) || 56; h = parseFloat(svg.getAttribute('height')) || 56; }
    const inner = innerSvgOf(svg);
    if (Math.abs(mx) < .01 && Math.abs(my) < .01 && Math.abs(w - 56) < .01 && Math.abs(h - 56) < .01) return inner;
    const sx = (56 / w).toFixed(4), sy = (56 / h).toFixed(4);
    return '<g transform="scale(' + sx + ' ' + sy + ') translate(' + (-mx) + ' ' + (-my) + ')">' + inner + '</g>';
  } catch (e) { return text; }
}
/* returns null if `inner` parses cleanly as SVG content, else an error string */
function svgError(inner) {
  if (!(inner || '').trim()) return null;
  try {
    const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg">' + inner + '</svg>', 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    if (err) return (err.textContent || 'SVG parse error').split('\n')[0].slice(0, 160);
    return null;
  } catch (e) { return 'SVG parse error'; }
}

/* ---------------- glyph point editor (drag points on the preview) ----------------
   Parses the live preview SVG and exposes draggable handles for every editable
   coordinate: line endpoints, circle/ellipse centers (+ radius handles), rect
   corners, polyline/polygon vertices, text anchors, and path command points
   (M/L/H/V/C/S/Q/T/A — absolute or relative; relative deltas are rebased so the
   dragged point lands exactly where dropped). Ancestor transforms
   (translate/scale/rotate/matrix) are honored. Edits write back to the SVG and
   the textarea live; 0.5-unit snap. */
function mulMat(p, q) { return [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]]; }
function invMat(m) { const det = m[0] * m[3] - m[1] * m[2] || 1e-9; const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det; return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]; }
function applyMat(m, x, y) { return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; }
function parseTransform(str) {
  let m = [1, 0, 0, 1, 0, 0]; const re = /(translate|scale|rotate|matrix)\(([^)]*)\)/g; let t;
  while ((t = re.exec(str || ''))) {
    const a = t[2].split(/[\s,]+/).filter(Boolean).map(Number); let n = null;
    if (t[1] === 'translate') n = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
    else if (t[1] === 'scale') n = [a[0] != null ? a[0] : 1, 0, 0, a[1] != null ? a[1] : (a[0] != null ? a[0] : 1), 0, 0];
    else if (t[1] === 'matrix' && a.length === 6) n = a;
    else if (t[1] === 'rotate') {
      const r = (a[0] || 0) * Math.PI / 180, co = Math.cos(r), si = Math.sin(r); n = [co, si, -si, co, 0, 0];
      if (a.length === 3) n = mulMat([1, 0, 0, 1, a[1], a[2]], mulMat(n, [1, 0, 0, 1, -a[1], -a[2]]));
    }
    if (n) m = mulMat(m, n);
  }
  return m;
}
function ctmOf(elm, root) {
  const chain = []; let e = elm; while (e && e !== root) { chain.unshift(e); e = e.parentNode; }
  let m = [1, 0, 0, 1, 0, 0]; chain.forEach((x) => { if (x.getAttribute) m = mulMat(m, parseTransform(x.getAttribute('transform'))); }); return m;
}

/* The path-data model (tokenizer, relative-command rebasing, serializer) MOVED to
   ./glyphPath.ts, which is pure and node-testable. The "add a point" gesture needs
   exactly this arithmetic, and a second copy of it would have been an invisible
   drift pair — two plausible implementations of the same rebasing, disagreeing
   only on the relative-command art nobody has in the shipped corpus. */
function pathPointDefs(elm) {
  const segs = tokenizePath(elm.getAttribute('d') || '');
  const defs = [];
  segs.forEach((s, si) => {
    const lc = s.cmd.toLowerCase(), rel = s.cmd === lc;
    const pairs = [];
    switch (lc) {
      case 'm': case 'l': case 't': pairs.push([0, 1, 'anchor']); break;
      case 'c': pairs.push([0, 1, 'ctrl'], [2, 3, 'ctrl'], [4, 5, 'anchor']); break;
      case 's': pairs.push([0, 1, 'ctrl'], [2, 3, 'anchor']); break;
      case 'q': pairs.push([0, 1, 'ctrl'], [2, 3, 'anchor']); break;
      case 'a': pairs.push([5, 6, 'anchor']); break;
      case 'h': pairs.push([0, -1, 'anchor']); break;
      case 'v': pairs.push([-1, 0, 'anchor']); break;
    }
    pairs.forEach((pr) => {
      const ax = pr[0], ay = pr[1], kind = pr[2];
      defs.push({
        el: elm, kind: kind,
        /* what Delete does to this point. `si` is otherwise trapped in the
           closures below, and the delete driver has to group by segment before
           it may touch `d` — splicing one segment re-indexes every later one. */
        del: kind === 'ctrl' ? { k: 'ctrl', si: si } : { k: 'seg', si: si },
        get: function () {
          const g = tokenizePath(elm.getAttribute('d') || ''); const sg = g[si]; if (!sg) return { x: 0, y: 0 }; const base = segStart(g, si);
          return { x: ax < 0 ? base.x : ((rel ? base.x : 0) + sg.args[ax]), y: ay < 0 ? base.y : ((rel ? base.y : 0) + sg.args[ay]) };
        },
        set: function (x, y) {
          const g = tokenizePath(elm.getAttribute('d') || ''); const sg = g[si]; if (!sg) return; const base = segStart(g, si);
          if (ax >= 0) sg.args[ax] = x - (rel ? base.x : 0);
          if (ay >= 0) sg.args[ay] = y - (rel ? base.y : 0);
          elm.setAttribute('d', serializePath(g));
        },
      });
    });
  });
  return defs;
}
const DEL_ELM = { k: 'elm' };           // shared, never mutated
function collectGlyphPoints(root) {
  const pts = [];
  root.querySelectorAll('line,circle,ellipse,rect,polyline,polygon,text,path').forEach((elm) => {
    const tag = elm.tagName.toLowerCase();
    const g = (n) => parseFloat(elm.getAttribute(n)) || 0;
    const S = (n, v) => elm.setAttribute(n, fmtN(v));
    /* `del` = what Delete does to this point: DEL_ELM removes the whole shape
       (nothing left to shrink), {k:'poly'} splices one vertex, null = not
       deletable at all (a size handle is a dimension, not a point). */
    const add = (get, set, kind, del) => pts.push({ el: elm, get: get, set: set, kind: kind || 'anchor', del: del === undefined ? DEL_ELM : del });
    if (tag === 'line') {
      add(() => ({ x: g('x1'), y: g('y1') }), (x, y) => { S('x1', x); S('y1', y); });
      add(() => ({ x: g('x2'), y: g('y2') }), (x, y) => { S('x2', x); S('y2', y); });
    } else if (tag === 'circle') {
      add(() => ({ x: g('cx'), y: g('cy') }), (x, y) => { S('cx', x); S('cy', y); });
      add(() => ({ x: g('cx') + g('r'), y: g('cy') }), (x, _y) => { S('r', Math.max(.5, Math.abs(x - g('cx')))); }, 'ctrl', null);
    } else if (tag === 'ellipse') {
      add(() => ({ x: g('cx'), y: g('cy') }), (x, y) => { S('cx', x); S('cy', y); });
      add(() => ({ x: g('cx') + g('rx'), y: g('cy') }), (x, _y) => { S('rx', Math.max(.5, Math.abs(x - g('cx')))); }, 'ctrl', null);
      add(() => ({ x: g('cx'), y: g('cy') + g('ry') }), (_x, y) => { S('ry', Math.max(.5, Math.abs(y - g('cy')))); }, 'ctrl', null);
    } else if (tag === 'rect') {
      add(() => ({ x: g('x'), y: g('y') }), (x, y) => {
        const brx = g('x') + g('width'), bry = g('y') + g('height');
        const nx = Math.min(x, brx - .5), ny = Math.min(y, bry - .5);
        S('x', nx); S('y', ny); S('width', brx - nx); S('height', bry - ny);
      });
      add(() => ({ x: g('x') + g('width'), y: g('y') + g('height') }), (x, y) => { S('width', Math.max(.5, x - g('x'))); S('height', Math.max(.5, y - g('y'))); }, 'ctrl', null);
    } else if (tag === 'polyline' || tag === 'polygon') {
      const nums = () => (elm.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
      const count = nums().length;
      for (let i = 0; i + 1 < count; i += 2) {
        ((idx) => { add(() => { const a = nums(); return { x: a[idx] || 0, y: a[idx + 1] || 0 }; }, (x, y) => { const a = nums(); a[idx] = x; a[idx + 1] = y; elm.setAttribute('points', a.map(fmtN).join(' ')); }, 'anchor', { k: 'poly', i: idx }); })(i);
      }
    } else if (tag === 'text') {
      add(() => ({ x: g('x'), y: g('y') }), (x, y) => { S('x', x); S('y', y); });
    } else if (tag === 'path') {
      pathPointDefs(elm).forEach((p) => pts.push(p));
    }
  });
  return pts;
}
let ptDrag = null;
/* Shift while dragging locks the drag vector (from the point's start position,
   in view space) to the nearest of the 30°/45° angle families:
   0, 30, 45, 60, 90, 120, 135, 150, 180, … Length moves in 0.5 steps along
   the locked axis, so axis-aligned drags stay on clean coordinates. */
const ANGLE_LOCK = (() => { const s = new Set(); for (let a = 0; a < 360; a += 30) s.add(a); for (let a = 45; a < 360; a += 90) s.add(a); return Array.from(s).map((a) => a * Math.PI / 180); })();
function angleLockVec(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: 0 };
  const ang = Math.atan2(dy, dx);
  let best = 0, err = 1e9;
  ANGLE_LOCK.forEach((c) => { const d = Math.abs(Math.atan2(Math.sin(ang - c), Math.cos(ang - c))); if (d < err) { err = d; best = c; } });
  const ux = Math.cos(best), uy = Math.sin(best);
  let pl = dx * ux + dy * uy; pl = Math.round(pl * 2) / 2;
  return { x: ux * pl, y: uy * pl };
}
/* Smart alignment: snap the dragged point to OTHER points' x (vertical guide)
   and/or y (horizontal guide) within a threshold — both at once = the cross
   of one point's column with another's row. Refs are captured at drag start
   (other points + the 28,28 canvas center); matched guides draw as dashed
   magenta lines. Aligned axes write exact coordinates (fine rounding). */
const ALIGN_T = 1.5; // view-units threshold (≈4px on the 140px preview)
function alignSnap(vx, vy, refs, t) {
  let gx = null, gy = null, bx = t, by = t;
  (refs || []).forEach((r) => {
    const dx = Math.abs(vx - r.x); if (dx < bx) { bx = dx; gx = r.x; }
    const dy = Math.abs(vy - r.y); if (dy < by) { by = dy; gy = r.y; }
  });
  return { x: gx != null ? gx : vx, y: gy != null ? gy : vy, gx: gx, gy: gy };
}

/* ---------------- point selection (marquee / delete / multi-move / scale) ----
   Selection is a set of INDICES into glyphPoints(): renderGlyphPts() destroys
   and rebuilds the whole handle layer on every pointermove and the point defs
   are fresh objects each pass, so nothing DOM-side and no object identity can
   hold it. The order (document order, then segment order, then arg-pair order)
   is deterministic, so an index is stable for exactly as long as the art's
   STRUCTURE is — which is what ptsSig() measures: it folds tag + point kind and
   deliberately NOT coordinates, so a gesture that only MOVES points keeps its
   selection while adding/removing a shape or a segment drops it.
   NOTHING here calls stash() — the modal only edits #mPreview's DOM and the
   textarea, mApply is the sole commit, so Cancel is the undo for all of it. */
const SVG_NS = 'http://www.w3.org/2000/svg';
const PT_CAP = 240;                     // sanity cap for pathological art
const PT_PAD = 3, PT_GRIP = 2.4;        // view units — 15px / 12px on the 280px canvas
const glyphSel = new Set();
let selSig = '';
let ptMarq = null, ptScale = null;
/* The ONE point list every gesture indexes into. The cap MUST live here and not
   in the renderer: a point past it gets no handle, so a selection that could
   reach it would be invisible, un-clickable and un-deletable. */
function glyphPoints(root) {
  let pts; try { pts = collectGlyphPoints(root); } catch (e) { return []; }
  return pts.length > PT_CAP ? pts.slice(0, PT_CAP) : pts;
}
/* UNCAPPED point count for REPORTING only (-1 = unmeasurable). Everything the
   user can touch goes through the capped glyphPoints(); a count taken from that
   list saturates at PT_CAP and would tell someone who just deleted six points
   that nothing happened. */
function glyphPointCount(root) { try { return collectGlyphPoints(root).length; } catch (e) { return -1; } }
function ptsSig(pts) { return pts.map((p) => p.el.tagName + (p.del ? p.del.k : '-') + (p.kind === 'ctrl' ? 'c' : 'a')).join('|'); }
function clearGlyphSel() { glyphSel.clear(); selSig = ''; }
function markGlyphSel(pts) { selSig = ptsSig(pts); }
/* screen → 0..56 view space (the maths onPtMove used to do inline) */
function viewPtOf(e) {
  const box = el('mPtsLay').getBoundingClientRect();
  if (!box.width || !box.height) return null;
  return { x: (e.clientX - box.left) / box.width * 56, y: (e.clientY - box.top) / box.height * 56 };
}
function r2(v) { return Math.round(v * 100) / 100; }   // fine
function rHalf(v) { return Math.round(v * 2) / 2; }    // the editor's 0.5 grid
const MOVE_T = .6;                      // ≈3px on the 280px canvas: below this a press is a CLICK

/* ---- gesture pointer ownership ----
   Capture on #mPtsLay, NOT on the pressed handle: renderGlyphPts() rebuilds the
   whole handle layer on every pointermove, and removing the capturing element
   drops the capture on the first frame. The layer element itself survives (only
   its children are replaced), so the capture holds for the whole drag.
   The move/up listeners deliberately stay on `window`: a captured event still
   bubbles there, and if setPointerCapture throws (no active pointer — synthetic
   events) the gesture must keep working exactly as before. */
function grabPointer(e) {
  try { el('mPtsLay').setPointerCapture(e.pointerId); return e.pointerId; } catch (err) { return null; }
}
function dropPointer(id) {
  if (id == null) return;
  try { el('mPtsLay').releasePointerCapture(id); } catch (err) {}
}
/* A pointermove with no button held means the release happened where we never
   saw it — outside the browser window, the classic case — and the gesture would
   otherwise keep rewriting the art on every hover. Only a TRUSTED event may end
   it: a synthetic one carries whatever `buttons` its constructor was given, so
   it says nothing about the physical device. */
function pointerReleased(e) { return e.isTrusted && e.buttons === 0; }

/* Every gesture takes the keyboard target off #mSvg by hand: the gestures
   preventDefault (which kills the implicit focus change) and openGlyph leaves
   the caret in the markup box, where Del would edit text.
   preventScroll is LOAD-BEARING, not tidiness. .modal is max-height:92vh with
   overflow:auto, so on a normal laptop it scrolls — and a plain focus() scrolls
   #mPrevBox back into view BETWEEN the browser's hit test and this gesture's own
   viewPtOf() read. The press lands on the handle the user saw; the layer then
   moves under the still-stationary pointer and the coordinate is measured
   against the NEW rect. Scroll is px, the canvas is 56 units over 280px, so it
   converts 5:1 — measured on a 700px-tall window: 139px = 27.8 units. A dragged
   point teleported 28 units (half the canvas) on the first move; a marquee's
   ORIGIN corner landed 28 units off the one that was drawn, silently selecting
   the wrong points; a scale grip's vertical lever (grab − opp) was measured from
   the wrong side of its anchor, turning a 1.53× drag into 0.375× — i.e. a drag
   that should GROW the selection shrank it. (The bbox move survives it: its
   leader offset is taken from the same shifted read and cancels out — but the
   LEADER, "nearest selected point to the press", is then chosen against a
   position 28 units away, so the wrong point owns the snap.)
   It reads as intermittent because a repeat focus() on
   the already-focused element does not re-scroll — only the FIRST gesture after
   focus was elsewhere (the state on open, and after every click on #mSvg, the
   Load select or a button) misbehaves.
   Nothing is lost by not scrolling: the element is the one the user just
   pressed, so it is on screen by construction. */
function focusPtCanvas() { el('mPrevBox').focus({ preventScroll: true }); }

/* ---- gesture undo ----
   #mSvg.value is the modal's single source of truth, so ONE string per gesture
   is a complete snapshot — no per-element bookkeeping. The point gestures push,
   and so does every whole-document replacement (Clear / Built-in / Load /
   Upload / .svg drop — see replaceGlyphSource); ⌘A+Del wipes a whole glyph and
   Cancel (the only previous recovery) throws away the entire modal session
   with it.
   A hand edit in the textarea CLEARS the stack: those snapshots describe a
   document the user has since rewritten, so restoring one would silently
   discard their typing — and the textarea has the browser's own undo anyway. */
const GLYPH_UNDO_CAP = 20;
const glyphUndo = [];
/* A HELD arrow key is one gesture and gets ONE entry, the way a DragNumberInput
   scrub brackets a whole pointer drag. Auto-repeat fires ~30 keydowns/s, so a
   snapshot each reached GLYPH_UNDO_CAP in about a second and shift() evicted the
   ⌘A+Delete snapshot — the one recovery this stack exists for.
   The signal is e.repeat and NOT a "last nudge was <n>ms ago" timer: repeat is
   exactly "the OS is repeating a held key", while a timer would also fold two
   deliberate taps into one entry, so ⌘Z would jump back further than the user's
   last action. `nudgeRun` guards the case where the FIRST event we see already
   carries repeat (key held across a focus change): without a snapshot pushed,
   the run has nothing to undo to. */
let nudgeRun = false;
let nudgeKind = '';                                   // 'move' | 'rot' — see rotateGlyphSelection
function pushGlyphUndo(before) {
  nudgeRun = false; nudgeKind = '';                   // any other snapshot ends the arrow run
  if (typeof before !== 'string') return;
  if (before === el('mSvg').value) return;            // the gesture changed nothing
  glyphUndo.push(before);
  if (glyphUndo.length > GLYPH_UNDO_CAP) glyphUndo.shift();
}
function undoGlyphEdit() {
  if (!glyphUndo.length) { toast('Nothing to undo — this stack holds point gestures and art replacements (the SVG box keeps its own undo).'); return; }
  el('mSvg').value = glyphUndo.pop();
  nudgeRun = false;                                   // the next nudge starts its own entry
  clearGlyphSel();                                    // indices mean nothing against restored art
  refreshMPreview();
  toast('Undid the last glyph edit.');                // a point gesture OR a whole-document replace
}

/* ---- marquee ----
   The backdrop spans the visible preview box (see renderGlyphPts), so a band may
   START outside the 0..56 canvas — nothing here clamps, and the band is min/max'd
   at endMarq, so a negative origin is ordinary. #mPtsLay is overflow:visible, so a
   handle sitting outside the canvas still takes its own pointerdown (it is appended
   after the backdrop); the move/up listeners are on window, so a drag begun anywhere
   still sweeps those handles up. */
function onMarqDown(e) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  focusPtCanvas();                       // must not scroll — see focusPtCanvas
  const v = viewPtOf(e); if (!v) return;
  ptMarq = { o: v, v: v, add: e.shiftKey || e.metaKey || e.ctrlKey, sub: e.altKey, moved: false, pid: grabPointer(e) };
  window.addEventListener('pointermove', onMarqMove);
  window.addEventListener('pointerup', endMarq);
  window.addEventListener('pointercancel', endMarq);
}
function onMarqMove(e) {
  if (!ptMarq) return;
  if (pointerReleased(e)) { endMarq(); return; }
  const v = viewPtOf(e); if (!v) return;
  ptMarq.v = v;
  if (!ptMarq.moved && Math.hypot(v.x - ptMarq.o.x, v.y - ptMarq.o.y) < .6) return; // ≈3px: a click isn't a band
  ptMarq.moved = true;
  renderGlyphPts();
}
function endMarq() {
  const m = ptMarq; ptMarq = null;
  window.removeEventListener('pointermove', onMarqMove);
  window.removeEventListener('pointerup', endMarq);
  window.removeEventListener('pointercancel', endMarq);
  if (!m) return;
  dropPointer(m.pid);
  if (!m.moved) { if (!m.add && !m.sub) clearGlyphSel(); renderGlyphPts(); return; } // plain click on empty = deselect
  const root = el('mPreview').querySelector('svg');
  if (!root) { renderGlyphPts(); return; }
  const x0 = Math.min(m.o.x, m.v.x), x1 = Math.max(m.o.x, m.v.x);
  const y0 = Math.min(m.o.y, m.v.y), y1 = Math.max(m.o.y, m.v.y);
  const pts = glyphPoints(root);
  if (!m.add && !m.sub) glyphSel.clear();
  pts.forEach((p, i) => {
    let o; try { const lp = p.get(); o = applyMat(ctmOf(p.el, root), lp.x, lp.y); } catch (err) { return; }
    if (o.x < x0 || o.x > x1 || o.y < y0 || o.y > y1) return;   // centre-inside, in view space = what the user sees
    if (m.sub) glyphSel.delete(i); else glyphSel.add(i);
  });
  markGlyphSel(pts);
  renderGlyphPts();
}
function selectAllGlyphPts() {
  const root = el('mPreview').querySelector('svg'); if (!root) return;
  const pts = glyphPoints(root);                    // capped: past PT_CAP there is no handle
  glyphSel.clear(); pts.forEach((_p, i) => glyphSel.add(i));
  markGlyphSel(pts); renderGlyphPts();
}

/* ---- scale gizmo (2+ selected) ----
   Anchored on the opposite corner, ⌥ = the bbox centre, ⇧ = uniform — what
   Illustrator/Figma/Inkscape do, which a dev tool should not reinvent. */
function onScaleDown(e, ix, iy, box) {   // ix/iy: 0 = min side, 1 = max side
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  focusPtCanvas();                       // must not scroll — see focusPtCanvas
  /* Same gate as delete, and it MUST sit above the listeners: onScalePts writes
     browser-normalized innerHTML back into #mSvg, so arming on art that doesn't
     parse would rewrite the user's half-typed markup under them. */
  if (el('mApply').disabled) { toast('Fix the SVG error first — points can’t be scaled in art that doesn’t parse.'); return; }
  const root = el('mPreview').querySelector('svg'); if (!root) return;
  const pts = glyphPoints(root);
  const sel = Array.from(glyphSel).filter((i) => i < pts.length).sort((a, b) => a - b);
  const items = [];
  sel.forEach((i) => {                   // snapshot ONCE — reading positions back
    const p = pts[i]; let m, o;          // mid-gesture would compound the scale
    try { m = ctmOf(p.el, root); const lp = p.get(); o = applyMat(m, lp.x, lp.y); } catch (err) { return; }
    if (!isFinite(o.x) || !isFinite(o.y)) return;
    items.push({ p: p, o: o, inv: invMat(m) });
  });
  if (items.length < 2) return;
  /* The grip is DRAWN PT_PAD outside the true corner, so the true corner is the
     wrong reference: the first pointermove reads the pointer AT the grip and
     sx = (corner+pad − opp)/(corner − opp) instantly rescales — 1.33× on a 9-wide
     bbox, 1.75× on a 4-wide one, from a press-and-release. Grab the POINTER, so
     sx/sy are exactly 1 at rest. */
  const g0 = viewPtOf(e);
  ptScale = {
    root: root, items: items,            // ASCENDING (sel was sorted)
    grab: g0 || { x: ix ? box.x1 : box.x0, y: iy ? box.y1 : box.y0 },   // corner = fallback only
    opp: { x: ix ? box.x0 : box.x1, y: iy ? box.y0 : box.y1 },
    ctr: { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 },
    /* the SELECTION's extent, NOT the grab lever: with the pointer as the grab a
       flat selection still has a ~2·PT_PAD lever, so a lever-only test would call
       a zero-extent axis scalable and ⇧-uniform could then adopt that meaningless
       factor for the other axis. */
    ext: { x: box.x1 - box.x0, y: box.y1 - box.y0 },
    before: el('mSvg').value, moved: false, pid: grabPointer(e),
  };
  window.addEventListener('pointermove', onScalePts);
  window.addEventListener('pointerup', endScalePts);
  window.addEventListener('pointercancel', endScalePts);
  renderGlyphPts();
}
function onScalePts(e) {
  if (!ptScale) return;
  if (pointerReleased(e)) { endScalePts(); return; }
  const v = viewPtOf(e); if (!v) return;
  /* a press that never travelled is a click, not a scale — write nothing */
  if (!ptScale.moved) {
    if (Math.hypot(v.x - ptScale.grab.x, v.y - ptScale.grab.y) < MOVE_T) return;
    ptScale.moved = true;
  }
  const a = e.altKey ? ptScale.ctr : ptScale.opp;
  const bx = ptScale.grab.x - a.x, by = ptScale.grab.y - a.y;
  /* A flat selection (a row of polyline vertices) has ZERO extent on one axis:
     that axis cannot scale and must never be divided by — the NaN would be
     serialized into the art by fmtN as the literal "NaN" and render as nothing,
     with no parse error and a happily-enabled Apply. */
  const okX = Math.abs(bx) > 1e-6 && Math.abs(ptScale.ext.x) > 1e-6;
  const okY = Math.abs(by) > 1e-6 && Math.abs(ptScale.ext.y) > 1e-6;
  let sx = okX ? (v.x - a.x) / bx : 1, sy = okY ? (v.y - a.y) / by : 1;
  if (!isFinite(sx)) sx = 1;
  if (!isFinite(sy)) sy = 1;
  if (e.shiftKey && okX && okY) { const s = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = s; sy = s; }
  /* TWO passes. A setter may clamp against a sibling on its OWN element that the
     same gesture is also moving — rect's top-left reads the CURRENT bottom-right
     — so a single ascending pass writes it against half-moved geometry (a 9-wide
     rect flicked +12 comes back 12.5 wide). Every target comes from the o/inv
     snapshot, never from a read-back, so the setters are idempotent and the
     second pass simply lands them against the settled siblings. */
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < ptScale.items.length; k++) {   // ASCENDING — see onPtMove
      const it = ptScale.items[k];
      const loc = applyMat(it.inv, a.x + (it.o.x - a.x) * sx, a.y + (it.o.y - a.y) * sy);
      if (!isFinite(loc.x) || !isFinite(loc.y)) continue;
      try { it.p.set(r2(loc.x), r2(loc.y)); } catch (err) {}   // fine only: a 0.5 grid would
    }                                                          // collapse points onto each other
  }
  el('mSvg').value = ptScale.root.innerHTML;
  renderGlyphPts();
}
function endScalePts() {
  const s = ptScale; if (!s) return;
  ptScale = null;
  window.removeEventListener('pointermove', onScalePts);
  window.removeEventListener('pointerup', endScalePts);
  window.removeEventListener('pointercancel', endScalePts);
  dropPointer(s.pid);
  pushGlyphUndo(s.before);
  refreshMPreview();
}

/* ---- arrow nudge ----
   Returns whether it ACTED: the caller only preventDefaults then, so with
   nothing selected the arrows still scroll the modal box.
   `held` = the keydown's own e.repeat bit — a continuation of a held run, which
   rides the snapshot its first press already pushed (see nudgeRun). */
function nudgeGlyphSelection(dx, dy, held) {
  if (!glyphSel.size || el('mApply').disabled) return false;
  const root = el('mPreview').querySelector('svg'); if (!root) return false;
  const pts = glyphPoints(root);
  const sel = Array.from(glyphSel).filter((i) => i < pts.length).sort((a, b) => a - b);
  /* Snapshot first. Reading a position back inside the write loop would
     double-move it: setting an earlier anchor of a relative path already dragged
     this point along, so get() would return the ALREADY nudged spot. */
  const items = [];
  sel.forEach((i) => {
    const p = pts[i];
    try { const m = ctmOf(p.el, root); const lp = p.get(); items.push({ p: p, o: applyMat(m, lp.x, lp.y), inv: invMat(m) }); } catch (e) {}
  });
  if (!items.length) return false;
  const before = el('mSvg').value;
  /* TWO passes — see onScalePts. A drag self-heals across frames; an arrow nudge
     is a single shot, so without the second pass a 1×1 rect nudged +2 lands
     0.5 wide (and a 0.5-wide one can never move at all). */
  for (let pass = 0; pass < 2; pass++) {
    items.forEach((it) => {              // ASCENDING — see onPtMove
      const loc = applyMat(it.inv, it.o.x + dx, it.o.y + dy);
      if (!isFinite(loc.x) || !isFinite(loc.y)) return;
      try { it.p.set(r2(loc.x), r2(loc.y)); } catch (e) {}
    });
  }
  el('mSvg').value = root.innerHTML;
  /* one entry per RUN: the first press snapshots, its repeats ride it */
  if (!held || !nudgeRun || nudgeKind !== 'move') { pushGlyphUndo(before); nudgeRun = true; nudgeKind = 'move'; }
  refreshMPreview();
  return true;
}

/* ---- delete ----
   Relative commands make every downstream point's absolute position depend on
   the removed segment's endpoint, so splicing a segment out of the token list
   silently translates the rest of the subpath. Snapshot absolutes → rewrite →
   write the absolutes back (set() already rebases relative args).
   pathSegEnds / degradeCurve live in ./glyphPath.ts with the rest of the model. */
function pathDelete(elm, rmSegs, ctrlSegs) {
  const segs = tokenizePath(elm.getAttribute('d') || '');
  const ends = pathSegEnds(segs);
  const snap = new Map();
  pathPointDefs(elm).forEach((d) => {
    const si = d.del.si; if (rmSegs.has(si)) return;
    let a = snap.get(si); if (!a) { a = []; snap.set(si, a); }
    try { a.push(d.get()); } catch (e) { a.push(null); }
  });
  /* A survivor that is now first, or whose subpath opener went with the removed
     run, becomes an absolute M at its own end: a path not starting with a
     moveto draws NOTHING, and a headless subpath silently joins the previous
     one with a connecting stroke nobody authored. */
  const out = [], keep = [];             // keep[newIdx] = old index, -1 = rewritten opener
  let opener = true;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], lc = s.cmd.toLowerCase();
    if (rmSegs.has(i)) { if (lc === 'm') opener = true; continue; }
    if (opener) {
      if (lc === 'z') continue;          // a Z can't open a subpath — and the NEXT survivor must still be rewritten
      opener = false;
      out.push({ cmd: 'M', args: [ends[i].x, ends[i].y] }); keep.push(-1); continue;
    }
    /* An h/H/v/V carries ONE axis and INHERITS the other from the segment before
       it — which set() cannot write, so the restore pass below silently drops it
       and the point slides to wherever the new predecessor ends (delete the L in
       "M 4 4 L 10 12 H 40 …" and the H point jumps from y 12 to y 4). Promote
       every survivor to an absolute L carrying BOTH snapshot coordinates.
       Unconditional on purpose: deciding "did my predecessor move" needs exactly
       the absolutes the snapshot already holds, and a conditional would be a
       second code path on art no shipped glyph exercises (H/V arrive from
       Illustrator/Figma exports dropped on the modal). */
    if (lc === 'h' || lc === 'v') {
      const w = (snap.get(i) || [])[0];
      if (w && isFinite(w.x) && isFinite(w.y)) { out.push({ cmd: 'L', args: [w.x, w.y] }); keep.push(i); continue; }
    }
    out.push(ctrlSegs.has(i) ? degradeCurve(s) : { cmd: s.cmd, args: s.args.slice() }); keep.push(i);
  }
  /* A moveto with no draw command after it is an ORPHAN: it paints nothing, yet
     collectGlyphPoints still hands it a handle the user can select, drag,
     band-select and scale. The anchors test below is per ELEMENT, so on its own
     it only catches that when the WHOLE path collapses — delete one endpoint of
     a 2-point SUBPATH inside a multi-subpath path and
     "M 4 4 L 20 4 M 4 20 L 20 20" becomes "M 4 4 M 4 20 L 20 20": a live shape
     carrying a phantom handle where a subpath used to be.
     BACKWARD, so a whole RUN of movetos collapses in one pass — removing n
     leaves n-1 looking at what followed n — and keep[] is spliced IN STEP,
     because the forward restore below reads snap by keep[n] and a drifted pair
     would write one survivor's absolutes onto another's segment.
     A Z after an M is left alone: "M 4 4 Z" is degenerate, but a round linecap
     still paints it, so that call belongs to the anchors test, not here. A lone
     moveto already sitting in the authored art gets swept up too — it never drew
     either, and it is the same phantom. */
  for (let n = out.length - 1; n >= 0; n--) {
    if (out[n].cmd.toLowerCase() !== 'm') continue;
    const nx = out[n + 1];
    if (nx && nx.cmd.toLowerCase() !== 'm') continue;
    out.splice(n, 1); keep.splice(n, 1);
  }
  /* Remove the shape only when fewer than two POINTS survive — one lone point is
     not a shape (the old behaviour for a 2-point line). With the prune above,
     deleting BOTH L anchors of "M 4 4 L 20 4 M 4 20 L 20 20" now takes the whole
     path: the two M's it used to keep drew nothing, and Apply would have shipped
     a <path> that renders as a blank glyph — the failure pruneEmptyGroups exists
     to prevent, one element down. The toast counts the real structural loss, so
     it says 4, not 2. */
  const anchors = out.filter((s) => s.cmd.toLowerCase() !== 'z').length;
  if (anchors < 2) { elm.remove(); return; }
  elm.setAttribute('d', serializePath(out));
  const byNew = new Map();
  pathPointDefs(elm).forEach((d) => { let a = byNew.get(d.del.si); if (!a) { a = []; byNew.set(d.del.si, a); } a.push(d); });
  /* FORWARD: a relative arg's base is whatever the segments before it now
     resolve to, so earlier segments have to be restored first. */
  for (let n = 0; n < out.length; n++) {
    const old = keep[n]; if (old < 0) continue;     // the rewritten opener is already absolute
    const want = snap.get(old), got = byNew.get(n);
    if (!want || !got) continue;
    /* match from the END: a degraded C→L has fewer defs than it had, and the
       ENDPOINT is last in both lists */
    for (let k = 1; k <= got.length && k <= want.length; k++) {
      const w = want[want.length - k]; if (!w) continue;
      try { got[got.length - k].set(w.x, w.y); } catch (e) {}
    }
  }
}
function polyDelete(elm, idxs) {
  const a = (elm.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
  idxs.slice().sort((x, y) => y - x).forEach((i) => { a.splice(i, 2); });   // DESCENDING: lower indices don't shift
  const pairs = Math.floor(a.length / 2);
  if (pairs < (elm.tagName.toLowerCase() === 'polygon' ? 3 : 2)) { elm.remove(); return; }
  elm.setAttribute('points', a.map(fmtN).join(' '));
}
/* collectGlyphPoints' selector never matches a 'g', and 26 of the 34 shipped
   glyphs are wrapped in <g transform="translate(28 28)">. Empty that wrapper and
   root.innerHTML is '<g transform="translate(28 28)"></g>' — a TRUTHY string, so
   currentDesign() saves a glyph that draws NOTHING while glyphCoverage's checks
   (balanced tags, no <svg> wrapper, no URL) all stay green: exactly the "renders
   as a bare titled box" failure that test exists to catch. Pruning makes
   "delete everything" produce '', which is the known-good Clear path. */
function pruneEmptyGroups(root) {
  const gs = root.querySelectorAll('g');
  for (let i = gs.length - 1; i >= 0; i--) {   // REVERSE document order: nested empties collapse outward
    if (!gs[i].children.length) gs[i].remove();
  }
  /* Whitespace BETWEEN top-level shapes survives as bare text nodes (cameraPosition
     ships two groups separated by "\n\n"), which is the difference between '' and a
     truthy leftover. normalizeSvg trims on Apply, so this only ever mattered to what
     the box shows — but "deleted everything" must LOOK deleted, like Clear. */
  if (!root.children.length && !(root.textContent || '').trim()) root.textContent = '';
}
function deleteGlyphSelection() {
  if (!el('mMove').checked || !glyphSel.size) return;
  /* Never rewrite art we could not parse: refreshMPreview injects the raw text
     either way, so a broken document would come back browser-normalized and the
     user's half-typed markup would be silently rewritten under them. */
  if (el('mApply').disabled) { toast('Fix the SVG error first — points can’t be deleted from art that doesn’t parse.'); return; }
  const root = el('mPreview').querySelector('svg'); if (!root) return;
  const before = el('mSvg').value;
  const pts = glyphPoints(root);
  const nBefore = glyphPointCount(root);          // UNCAPPED — see glyphPointCount
  const sel = Array.from(glyphSel).filter((i) => i < pts.length).sort((a, b) => a - b);
  /* grouped PER ELEMENT so no index shifts under another deletion on the same
     element (polyline vertices splice; path segments re-index) */
  const groups = new Map();
  const skips = [];                               // points Delete refuses (size handles)
  sel.forEach((i) => {
    const p = pts[i];
    if (!p.del) { skips.push(p); return; }         // r / rx / ry / rect size corner
    let g = groups.get(p.el);
    if (!g) { g = { elm: p.el, kill: false, poly: [], seg: new Set(), ctrl: new Set() }; groups.set(p.el, g); }
    if (p.del.k === 'elm') g.kill = true;
    else if (p.del.k === 'poly') g.poly.push(p.del.i);
    else if (p.del.k === 'seg') g.seg.add(p.del.si);
    else g.ctrl.add(p.del.si);
  });
  if (!groups.size) {
    if (!skips.length) { toast('Nothing to delete.'); return; }
    /* Name the handle that IS deletable, PER TAG. A rect has no centre handle —
       collectGlyphPoints gives it a top-left anchor and a bottom-right size
       control — so the old "pick the centre point" sent the user looking for a
       point that does not exist on the shape they had selected. */
    const tags = {}; skips.forEach((p) => { tags[(p.el.tagName || '').toLowerCase()] = 1; });
    const where = [];
    if (tags.circle || tags.ellipse) where.push('the centre ● of a circle/ellipse');
    if (tags.rect) where.push('the top-left ● of a rect');
    toast('Size handles (○) set a dimension, not a point — they can’t be deleted. Delete the shape from ' + (where.join(' or ') || 'its ● anchor') + '.');
    return;
  }
  groups.forEach((g) => {
    if (g.kill) { g.elm.remove(); return; }
    if (g.poly.length) { polyDelete(g.elm, g.poly); return; }
    g.seg.forEach((si) => g.ctrl.delete(si));     // removing the anchor beats degrading the curve
    pathDelete(g.elm, g.seg, g.ctrl);
  });
  pruneEmptyGroups(root);                         // before innerHTML — see pruneEmptyGroups
  /* the REAL structural loss, measured: removing one anchor can take a whole
     shape (a 2-point line, a path down to one point), and a refused size handle
     whose element went with its centre was never "kept" either — counting the
     SELECTION would report both wrongly. Both readings are UNCAPPED: glyphPoints
     truncates at PT_CAP, so on art with more points than that both sides clamp to
     the cap and a real delete reports 0 — and a dropped Illustrator/Figma export
     is exactly that art. */
  const nAfter = glyphPointCount(root);
  const n = (nBefore >= 0 && nAfter >= 0) ? Math.max(0, nBefore - nAfter) : -1;
  const kept = skips.filter((p) => root.contains(p.el)).length;
  clearGlyphSel();
  el('mSvg').value = root.innerHTML;              // same commit shape as endPtMove
  pushGlyphUndo(before);
  refreshMPreview();                              // → renderGlyphPts + error check + mApply gate
  /* never ASSERT a number we could not measure (a throw in collectGlyphPoints) */
  toast((n < 0 ? 'Deleted the selected points.' : 'Deleted ' + n + ' point' + (n === 1 ? '' : 's') + '.')
    + (kept ? ' (' + kept + ' size handle' + (kept === 1 ? '' : 's') + ' kept.)' : ''));
}

/* The handle layer's renderer has THREE early returns (no layer, points off, no
   parsed root), and two surfaces added later have to refresh past all of them:
   the source-highlight marks (which must clear when the handles go away, or blue
   blocks stay painted behind a textarea with no selection to explain them) and
   the paint bar (which would otherwise still read "5 shapes" against an empty
   selection after unticking "drag points"). Hence the wrapper — every one of the
   11 call sites reaches all three. */
function renderGlyphPts() {
  /* The inner renderer hands over the root and the point list it already built.
     Without that, syncGlyphHl, renderPaintBar and syncToolInfo would each run
     their own glyphPoints() — four collections per frame of a drag on art that
     can carry 240 points. */
  const ctx = renderGlyphPtsInner();
  syncGlyphHl(ctx);
  renderPaintBar(ctx);
  syncToolInfo(ctx);
}
function renderGlyphPtsInner() {
  const lay = el('mPtsLay'); if (!lay) return null;
  lay.innerHTML = '';
  if (!el('mMove').checked) { lay.style.display = 'none'; return null; }
  lay.style.display = '';
  const root = el('mPreview').querySelector('svg'); if (!root) return null;
  const mkRect = (x, y, w, h, cls) => {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', h);
    r.setAttribute('class', cls); lay.appendChild(r); return r;
  };
  /* marquee hit surface FIRST — SVG hit-testing is topmost-wins, so every
     handle appended after it still gets the pointerdown.
     It covers the whole VISIBLE preview box, not just the 0..56 canvas:
     #mPtsLay is a 280px layer centred in a 312px #mPrevBox, so the checkerboard
     shows a 16px ring (= 3.2 view units at 5px/unit) outside the canvas. Sized to
     0..56 that ring was dead — on art that fills the canvas (uv reaches 0.42..56.29)
     the only empty space to start a band in is exactly there, and a press produced
     no band AND no deselect, silently, which reads as the tool being broken. */
  mkRect(-3.2, -3.2, 62.4, 62.4, 'pt-bg').addEventListener('pointerdown', onCanvasDown);
  /* alignment guide lines (drawn under the handles) */
  if (ptDrag && ptDrag.guides) {
    const mk = (x1, y1, x2, y2) => {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      l.setAttribute('class', 'pt-guide'); lay.appendChild(l);
    };
    if (ptDrag.guides.x != null) mk(ptDrag.guides.x, 0, ptDrag.guides.x, 56);
    if (ptDrag.guides.y != null) mk(0, ptDrag.guides.y, 56, ptDrag.guides.y);
  }
  if (ptMarq && ptMarq.moved) {
    mkRect(Math.min(ptMarq.o.x, ptMarq.v.x), Math.min(ptMarq.o.y, ptMarq.v.y),
      Math.abs(ptMarq.v.x - ptMarq.o.x), Math.abs(ptMarq.v.y - ptMarq.o.y), 'pt-marq');
  }
  const pts = glyphPoints(root);
  /* backstop for every invalidation site an explicit clearGlyphSel() misses —
     notably a delete, which re-indexes the points it did not remove */
  if (glyphSel.size && ptsSig(pts) !== selSig) clearGlyphSel();
  /* Resolve every position FIRST. The bbox needs them all, and the grips must be
     appended BEFORE the handles: SVG hit-testing is topmost-wins, so grips
     appended last swallowed the pointerdown of any UNSELECTED point sitting
     within ~15px of a padded bbox corner — the click did nothing, and the only
     escape was clearing the very selection being extended. */
  const P = [];
  let nSel = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;
  pts.forEach((p, i) => {
    let pos; try { const lp = p.get(); pos = applyMat(ctmOf(p.el, root), lp.x, lp.y); } catch (e) { P.push(null); return; }
    if (!isFinite(pos.x) || !isFinite(pos.y)) { P.push(null); return; }
    P.push(pos);
    if (!glyphSel.has(i)) return;
    nSel++; bx0 = Math.min(bx0, pos.x); by0 = Math.min(by0, pos.y); bx1 = Math.max(bx1, pos.x); by1 = Math.max(by1, pos.y);
  });
  /* The selection frame and its grips belong to the SELECT tool. With a creation
     tool active they would sit between the pointer and the canvas it is drawing
     on; with Rotate active, every press is a rotation. */
  if (nSel >= 2 && toolMode === 'select') {
    const box = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    const bb = mkRect(bx0 - PT_PAD, by0 - PT_PAD, (bx1 - bx0) + PT_PAD * 2, (by1 - by0) + PT_PAD * 2, 'pt-bbox');
    /* The INTERIOR of the frame is a MOVE surface. It used to be inert
       (pointer-events:none) over a full-canvas marquee backdrop, so grabbing the
       middle of a selection and dragging — the move gesture every comparable
       editor has — started a fresh band and did the exact opposite: it replaced
       the selection, or a plain click cleared it. A modifier still means "start a
       NEW band" (and a press outside the frame always did), so nothing is lost. */
    bb.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) { onMarqDown(e); return; }
      e.preventDefault(); e.stopPropagation();
      focusPtCanvas();                   // must not scroll — see focusPtCanvas
      const v = viewPtOf(e); if (!v) return;
      /* Leader = the selected point NEAREST the press: every snap/alignment
         decision is made for the leader and the rest follow by its landed delta,
         so the closest one is the least surprising thing to see snap. */
      let lead = -1, best = Infinity;
      glyphSel.forEach((k) => {
        const q = P[k]; if (!q) return;
        const d = Math.hypot(q.x - v.x, q.y - v.y);
        if (d < best) { best = d; lead = k; }
      });
      if (lead < 0) return;
      beginPtDrag(e, lead, pts, root, false, { x: P[lead].x - v.x, y: P[lead].y - v.y }, true);
    });
    /* Grips sit on the PADDED corners so they don't cover the extreme point's own
       handle; they are also drawn BEFORE the handles so hit-testing prefers a
       point even where the two overlap. Hidden mid-gesture — they'd fight the
       cursor. */
    if (!ptDrag && !ptScale) [[0, 0, ''], [1, 0, 'nesw'], [0, 1, 'nesw'], [1, 1, '']].forEach((g) => {
      const ix = g[0], iy = g[1];
      const gx = ix ? bx1 + PT_PAD : bx0 - PT_PAD, gy = iy ? by1 + PT_PAD : by0 - PT_PAD;
      const r = mkRect(gx - PT_GRIP / 2, gy - PT_GRIP / 2, PT_GRIP, PT_GRIP, 'pt-scale' + (g[2] ? ' ' + g[2] : ''));
      r.setAttribute('rx', .4);
      r.addEventListener('pointerdown', (ev) => onScaleDown(ev, ix, iy, box));
    });
  }
  /* Tool overlays sit ABOVE the marquee backdrop (so they are visible) and BELOW
     the point handles (so a handle always wins an ambiguous press) — the same
     slot, and the same reason, as the scale grips. Every element they add is
     tagged `.pt-dec` unless it is meant to be grabbed; see the CSS note. */
  drawToolOverlays(lay, root, pts, P, { x0: bx0, y0: by0, x1: bx1, y1: by1 }, nSel);
  pts.forEach((p, i) => {
    const pos = P[i]; if (!pos) return;
    const on = glyphSel.has(i);
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', pos.x); c.setAttribute('cy', pos.y);
    c.setAttribute('r', p.kind === 'ctrl' ? (on ? 1.3 : 1) : (on ? 1.45 : 1.15));
    /* `#mPtsLay circle{pointer-events:all}` is an ELEMENT rule, so a handle is
       hittable unless a class says otherwise — `.pt-off` is that class. Outside
       Select the handles are a read-only picture of the selection: a press
       belongs to the active tool. */
    c.setAttribute('class', (p.kind === 'ctrl' ? 'pt-ctrl' : 'pt-anchor') + (on ? ' pt-sel' : '') + (toolMode === 'select' ? '' : ' pt-off'));
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      focusPtCanvas();                   // must not scroll — see focusPtCanvas
      /* ⇧ is BOTH "add to the selection" and the angle-lock DRAG modifier, so
         membership can only be decided at pointerup — see beginPtDrag's toggle. */
      beginPtDrag(e, i, pts, root, e.shiftKey || e.metaKey || e.ctrlKey, null);
    });
    lay.appendChild(c);
  });
  return { root: root, pts: pts };
}
/* Arms a point drag. Split out of the handle's own listener so the selection
   BOX can reuse it verbatim (see the bbox pointerdown): one gesture, one code
   path — a second "move the selection" implementation would drift from this
   one's snapshot/ordering/snapping rules within a release.
   `off` = leader-minus-pointer in view units. The handle path passes null (the
   press is inside a ~1.15-unit dot, and the leader has always tracked the
   cursor exactly); the bbox path passes the real offset, or grabbing the middle
   of a selection would teleport the leader onto the cursor.
   `bbox` = this press landed on empty space INSIDE the frame, so a click that
   never travelled still means "deselect" — the frame can cover the whole canvas
   (select-all on full-bleed art), and without this there would be no click left
   anywhere that could drop the selection. */
function beginPtDrag(e, i, pts, root, mod, off, bbox) {
  /* Same gate as scale and delete, and FIRST — above the selection bookkeeping,
     the pointer grab and the listeners. refreshMPreview injects the raw text
     whether or not it parses, so the HTML parser's RECONSTRUCTION of a half-typed
     document gets handles drawn on it; the first onPtMove then writes
     root.innerHTML back into #mSvg, replacing the user's source with that
     reconstruction — and since the rewrite parses, the red error clears and Apply
     enables, so it reads as the typo having been ACCEPTED. This was the one
     mutation path with no gate. It sits above the selection change because
     nothing below re-renders after an early return. */
  if (el('mApply').disabled) { toast('Fix the SVG error first — points can’t be moved in art that doesn’t parse.'); return; }
  const p = pts[i]; if (!p) return;
  /* grabbing OUTSIDE the selection makes it the selection: what you drag is
     always what is highlighted, so a multi-move can never surprise */
  if (!mod && !glyphSel.has(i)) { glyphSel.clear(); glyphSel.add(i); markGlyphSel(pts); }
  /* a modifier grab on a point that is NOT selected drags that point ALONE —
     the selection stays intact until pointerup decides the toggle */
  const withSel = glyphSel.has(i);
  let m, o;
  try { m = ctmOf(p.el, root); const lp = p.get(); o = applyMat(m, lp.x, lp.y); } catch (err) { return; }
  if (!isFinite(o.x) || !isFinite(o.y)) return;
  /* refs = every point that is NOT moving (a selected one would pin the
     drag to itself) + the canvas center. `all` comes out ASCENDING: a
     relative segment's base is written by the points before it, so writing
     out of order double-moves everything downstream. */
  const refs = [{ x: 28, y: 28 }];
  const all = [];
  pts.forEach((q, k) => {
    let qv, qm; try { qm = ctmOf(q.el, root); const ql = q.get(); qv = applyMat(qm, ql.x, ql.y); } catch (_) { return; }
    if (!isFinite(qv.x) || !isFinite(qv.y)) return;
    if (k === i || (withSel && glyphSel.has(k))) { all.push({ p: q, o: qv, inv: invMat(qm), lead: k === i }); return; }
    if (Math.hypot(qv.x - o.x, qv.y - o.y) > 1e-6) refs.push(qv);
  });
  ptDrag = {
    p: p, root: root, m: m, inv: invMat(m), o: o, refs: refs, all: all, guides: null,
    pd: viewPtOf(e) || o, moved: false,   // pd = the POINTER, which may sit off the handle's centre
    off: (off && isFinite(off.x) && isFinite(off.y)) ? off : { x: 0, y: 0 },
    toggle: mod ? i : -1, bbox: !!bbox, pts: pts, before: el('mSvg').value, pid: grabPointer(e),
  };
  window.addEventListener('pointermove', onPtMove);
  window.addEventListener('pointerup', endPtMove);
  window.addEventListener('pointercancel', endPtMove);
  renderGlyphPts();
}
function onPtMove(e) {
  if (!ptDrag) return;
  if (pointerReleased(e)) { endPtMove(); return; }
  const v = viewPtOf(e); if (!v) return;
  /* below the threshold this press is still a CLICK — write nothing, so a
     modifier-click can toggle at pointerup and a plain click can't snap the
     point onto the 0.5 grid on its own */
  if (!ptDrag.moved) {
    if (Math.hypot(v.x - ptDrag.pd.x, v.y - ptDrag.pd.y) < MOVE_T) return;
    ptDrag.moved = true;
  }
  /* the leader keeps the offset it was grabbed with (zero for a handle press) */
  let tx = v.x + ptDrag.off.x, ty = v.y + ptDrag.off.y, fine = false;
  if (e.shiftKey) {
    /* ⇧ angle lock: snap to nearest 30°/45°-family axis from the drag origin */
    ptDrag.guides = null;
    const d = angleLockVec(tx - ptDrag.o.x, ty - ptDrag.o.y);
    tx = ptDrag.o.x + d.x; ty = ptDrag.o.y + d.y; fine = true; // fine rounding — don't break the angle
  } else {
    /* alignment to other points' rows/columns beats the grid; aligned axes
       write exact coords (fine rounding), free drags keep the 0.5 grid */
    const a = alignSnap(tx, ty, ptDrag.refs, ALIGN_T);
    ptDrag.guides = (a.gx != null || a.gy != null) ? { x: a.gx, y: a.gy } : null;
    tx = a.x; ty = a.y; fine = !!ptDrag.guides;
  }
  /* Snap the LEADER, then hand every follower the leader's LANDED view delta —
     ONE grid decision per gesture, so the selection's internal geometry is
     preserved instead of each point being quantized on its own. The landed
     position is forward-transformed, not read back: the CTM can't change
     mid-drag and a read-back would double-move relative segments. */
  const lloc = applyMat(ptDrag.inv, tx, ty);
  const lx = fine ? r2(lloc.x) : rHalf(lloc.x), ly = fine ? r2(lloc.y) : rHalf(lloc.y);
  const landed = applyMat(ptDrag.m, lx, ly);
  const dx = landed.x - ptDrag.o.x, dy = landed.y - ptDrag.o.y;
  /* TWO passes — see onScalePts: a setter can clamp against a sibling on its own
     element that this same gesture is also moving (rect top-left reads the LIVE
     bottom-right), so pass 1 lands against half-moved geometry. */
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < ptDrag.all.length; k++) {   // ASCENDING — relative rebasing
      const it = ptDrag.all[k];
      if (it.lead) { try { it.p.set(lx, ly); } catch (err) {} continue; }
      const loc = applyMat(it.inv, it.o.x + dx, it.o.y + dy);   // each through its OWN inverse CTM
      if (!isFinite(loc.x) || !isFinite(loc.y)) continue;
      try { it.p.set(r2(loc.x), r2(loc.y)); } catch (err) {}
    }
  }
  el('mSvg').value = ptDrag.root.innerHTML;
  renderGlyphPts();
}
function endPtMove() {
  const d = ptDrag; if (!d) return;
  ptDrag = null;
  window.removeEventListener('pointermove', onPtMove);
  window.removeEventListener('pointerup', endPtMove);
  window.removeEventListener('pointercancel', endPtMove);
  dropPointer(d.pid);
  /* a click on empty space inside the frame is the deselect it always was */
  if (d.bbox && !d.moved) clearGlyphSel();
  /* a modifier press that never became a drag IS the membership toggle */
  if (d.toggle >= 0 && !d.moved) {
    if (glyphSel.has(d.toggle)) glyphSel.delete(d.toggle); else glyphSel.add(d.toggle);
    markGlyphSel(d.pts);                          // nothing structural changed — the sig still holds
  }
  if (d.moved) pushGlyphUndo(d.before);
  refreshMPreview();
}


/* =====================================================================
   TOOLS · ROTATE · SOURCE HIGHLIGHT · PAINT
   =====================================================================
   Everything below obeys the same five rules the point gestures do, and each of
   them is a real failure that happened once:
     1. the el('mApply').disabled gate is the FIRST statement of any arming path
        (refreshMPreview injects unparsed text, so a gesture on the HTML parser's
        reconstruction of half-typed markup writes that reconstruction back and
        the red error clears — reading as the typo having been accepted);
     2. focusPtCanvas() with preventScroll, or the modal scrolls between the hit
        test and viewPtOf and the coordinate is 28 units out;
     3. pointer capture on #mPtsLay, never on a child the next frame deletes;
     4. one glyphUndo entry per GESTURE, pushed AFTER the write;
     5. the commit is pruneEmptyGroups → el('mSvg').value = root.innerHTML →
        pushGlyphUndo(before) → refreshMPreview().
   Rule 5 is `commitGlyphEdit` below; every new mutation goes through it. */

/* The ONE commit path for every new gesture. */
function commitGlyphEdit(root, before) {
  pruneEmptyGroups(root);                         // before innerHTML — see pruneEmptyGroups
  el('mSvg').value = root.innerHTML;
  pushGlyphUndo(before);
  refreshMPreview();
}

/* Guard shared by every arming path. Returns true when the gesture must not run. */
function glyphEditBlocked(what) {
  if (el('mApply').disabled) { toast('Fix the SVG error first — ' + what + ' in art that doesn’t parse.'); return true; }
  return false;
}

/* ---------------- tools ----------------
   `select` is everything the editor did before. The others take over the canvas
   backdrop's pointerdown; nothing about the existing marquee/move/scale code
   changes, it simply is not reached while another tool is active. */
const TOOL_ICONS = {
  select: '<path d="M3.5 2.2 L3.5 13 L6.4 10.3 L8.4 13.8 L10.1 12.9 L8.2 9.6 L12.3 9.3 Z"/>',
  pen: '<path d="M2.5 13.5 L4.3 9.2 L10.8 2.7 L13.3 5.2 L6.8 11.7 Z"/><path d="M4.3 9.2 L6.8 11.7"/>',
  free: '<path d="M2 11.2 C4.2 4 6.2 14.2 8.6 8.4 C10 5 11.8 6.4 14 7.6"/>',
  line: '<path d="M4 12 L12 4"/><circle cx="3.4" cy="12.6" r="1.5"/><circle cx="12.6" cy="3.4" r="1.5"/>',
  rect: '<path d="M3 4.5 H13 V11.5 H3 Z"/>',
  ellipse: '<circle cx="8" cy="8" r="5.2"/>',
  insert: '<path d="M2 10.5 C5 10.5 6 5.5 8 5.5 C10 5.5 11 10.5 14 10.5"/><path d="M8 2.6 V8.4 M5.1 5.5 H10.9"/>',
  rotate: '<path d="M12.8 6.2 A5.2 5.2 0 1 0 13.1 9.6"/><path d="M9.2 5.9 L13.2 6.3 L12.6 2.4"/>',
};
const TOOLS = [
  { id: 'select', label: 'Select', hint: 'marquee, drag points, corner grips scale' },
  { id: 'pen', label: 'Pen', hint: 'click to place anchors, drag to curve · Enter or click the first anchor to finish · Esc cancels' },
  { id: 'free', label: 'Draw', hint: 'drag to draw freehand — the stroke is simplified to editable anchors' },
  { id: 'line', label: 'Line', hint: 'drag from end to end' },
  { id: 'rect', label: 'Rect', hint: 'drag a corner to corner · ⇧ square' },
  { id: 'ellipse', label: 'Ellipse', hint: 'drag a bounding box · ⇧ circle' },
  { id: 'insert', label: 'Add point', hint: 'click a line or curve to add an anchor — the shape does not move' },
  { id: 'rotate', label: 'Rotate', hint: 'drag anywhere to turn the selection about its centre · ⇧ 15° · ⌥←/→ by key' },
];
let toolMode = 'select';

function buildToolbar() {
  const bar = el('mTools'); if (!bar) return;
  bar.innerHTML = '';
  TOOLS.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'tool' + (t.id === toolMode ? ' is-on' : '');
    b.id = 'tool_' + t.id;
    b.title = t.label + ' — ' + t.hint;
    b.setAttribute('aria-pressed', t.id === toolMode ? 'true' : 'false');
    b.setAttribute('aria-label', t.label);
    b.innerHTML = '<svg viewBox="0 0 16 16">' + TOOL_ICONS[t.id] + '</svg>';
    b.onclick = () => setToolMode(t.id);
    bar.appendChild(b);
  });
  syncToolInfo();
}
function syncToolInfo(ctx) {
  const t = TOOLS.find((x) => x.id === toolMode);
  const info = el('mToolInfo'); if (!info || !t) return;
  if (ptDrag || ptScale || ptMarq || ptTool || ptRot) return;   // nothing here changes mid-gesture
  info.innerHTML = '';
  const b = document.createElement('b'); b.textContent = t.label;
  info.appendChild(b);
  info.appendChild(document.createTextNode(' — ' + t.hint));
  /* Where a new shape will land. Recomputed on every RENDER, not on every tool
     change, because it depends on the SELECTION — and selection changes never
     reach refreshMPreview, they only call renderGlyphPts. A label that goes
     stale the moment you marquee the group you meant to draw into is worse than
     no label at all, since it is the only thing that makes the coordinate space
     a new shape is authored in visible. */
  if (toolMode !== 'select' && toolMode !== 'rotate' && toolMode !== 'insert') {
    const root = (ctx && ctx.root) || el('mPreview').querySelector('svg');
    const tgt = root ? resolveDrawTarget(root, ctx && ctx.pts, toolMode) : null;
    if (tgt && tgt.el !== root) {
      const tr = (tgt.el.getAttribute('transform') || '').trim();
      info.appendChild(document.createTextNode(' · into ' + (tr ? '<g ' + tr + '>' : '<g>')));
    }
  }
}
function setToolMode(m) {
  if (!TOOLS.some((t) => t.id === m)) return;
  cancelToolGesture();
  cancelRotate();
  insHit = null;
  toolMode = m;
  /* Every tool needs the handle layer: it draws the previews, the insert marker
     and the rotate pivot. Forcing the checkbox is not enough — .checked assigns
     without firing `change`, and that handler is what un-hides the legend, so a
     user whose nd:pts is '0' would get handles and no documentation of the keys. */
  if (m !== 'select' && !el('mMove').checked) {
    el('mMove').checked = true;
    lsSet('nd:pts', '1');
    el('mPtsHint').style.display = '';
  }
  Array.prototype.forEach.call(el('mTools').children, (b) => {
    const on = b.id === 'tool_' + m;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  syncToolInfo();
  renderGlyphPts();
}

/* ---------------- where a new shape goes ----------------
   26 of the 34 shipped glyphs wrap their art in <g transform="translate(28 28)">,
   so a shape appended at the ROOT is authored in a different coordinate space
   from everything beside it: the numbers a user then reads in the source bear no
   relation to their neighbours', and moving the group later leaves the new shape
   behind. The container therefore follows the SELECTION first (draw next to what
   you just picked), then the document's single top-level group, then the root. */
function resolveDrawTarget(root, known, mode) {
  let host = null;
  if (glyphSel.size) {
    const pts = known || glyphPoints(root);
    const first = Array.from(glyphSel).sort((a, b) => a - b)[0];
    const p = pts[first];
    if (p && p.el && p.el.parentNode && p.el.parentNode !== root && root.contains(p.el.parentNode)) host = p.el.parentNode;
  }
  if (!host) {
    const kids = Array.prototype.filter.call(root.children, (k) => k.tagName.toLowerCase() === 'g');
    if (kids.length === 1 && root.children.length === 1) host = kids[0];
  }
  const el0 = host || root;
  let m;
  try { m = ctmOf(el0, root); } catch (e) { m = [1, 0, 0, 1, 0, 0]; }
  const det = m[0] * m[3] - m[1] * m[2];
  /* A degenerate container maps every point onto a line: the inverse is
     meaningless and fmtN would serialize the NaN as the literal "NaN", which
     renders as nothing with no parse error and a happily-enabled Apply. */
  if (!isFinite(det) || Math.abs(det) < 1e-9) return { el: root, m: [1, 0, 0, 1, 0, 0], inv: [1, 0, 0, 1, 0, 0], axis: true };
  /* An axis-aligned <rect>/<ellipse> cannot be authored inside a rotated or
     sheared group — its sides would not line up with the drag. Detect it and let
     those two tools fall back to the root. */
  const axis = Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6;
  /* The fallback is decided HERE and not at the call site, so the "· into <g …>"
     label cannot promise a container the box tools will refuse. */
  if (!axis && (mode === 'rect' || mode === 'ellipse')) return { el: root, m: [1, 0, 0, 1, 0, 0], inv: [1, 0, 0, 1, 0, 0], axis: true };
  return { el: el0, m: m, inv: invMat(m), axis: axis };
}

/* ---------------- shared snapping ----------------
   Same decision as onPtMove, in the same order: ⇧ angle-locks against an origin,
   otherwise the point aligns to other points' rows/columns, and alignment beats
   the 0.5 grid. The LOCAL coordinate is what gets rounded (that is what lands in
   the file) and the view position is forward-transformed from it — never read
   back, so nothing accumulates. */
function toolRefs(root) {
  const refs = [{ x: 28, y: 28 }];
  glyphPoints(root).forEach((q) => {
    try {
      const v = applyMat(ctmOf(q.el, root), q.get().x, q.get().y);
      if (isFinite(v.x) && isFinite(v.y)) refs.push(v);
    } catch (e) {}
  });
  return refs;
}
function snapToolPt(v, t, e, origin) {
  let tx = v.x, ty = v.y, fine = false;
  if (e && e.shiftKey && origin && (t.mode === 'rect' || t.mode === 'ellipse')) {
    /* A box tool's ⇧ means SQUARE — the angle lock is the point-DRAG rule and
       would snap the drag VECTOR to 30/45°, which on a rect is not the same
       thing: a 35° drag locks to 30° and comes out 1.73:1. */
    t.guides = null;
    const dx = tx - origin.x, dy = ty - origin.y;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    tx = origin.x + (dx < 0 ? -m : m); ty = origin.y + (dy < 0 ? -m : m); fine = true;
  } else if (e && e.shiftKey && origin) {
    t.guides = null;
    const d = angleLockVec(tx - origin.x, ty - origin.y);
    tx = origin.x + d.x; ty = origin.y + d.y; fine = true;
  } else {
    const a = alignSnap(tx, ty, t.refs, ALIGN_T);
    t.guides = (a.gx != null || a.gy != null) ? { x: a.gx, y: a.gy } : null;
    tx = a.x; ty = a.y; fine = !!t.guides;
  }
  const loc = applyMat(t.inv, tx, ty);
  const lx = fine ? r2(loc.x) : rHalf(loc.x), ly = fine ? r2(loc.y) : rHalf(loc.y);
  return { local: { x: lx, y: ly }, view: applyMat(t.m, lx, ly) };
}

/* ---------------- paint applied to NEW shapes ----------------
   Session-only and deliberately not persisted: it is the paint bar's reading
   when nothing is selected, which is a statement about the next shape, not a
   preference worth surviving a reload. */
const drawPaint = { fill: 'none', stroke: '#2B2B2B', 'stroke-width': '1.4' };

/* Read what an element WOULD inherit, so a shape drawn inside
   <g fill="none" stroke="#2B2B2B"> does not repeat its parent's paint. 23 of the
   50 shipped groups carry paint; writing it again on every child is noise in a
   file people read. */
function inheritedPaint(host, prop) {
  try {
    const cs = getComputedStyle(host);
    const raw = cs.getPropertyValue(prop);
    return prop === 'stroke-width' ? normalizePaintNumber(raw) : normalizePaintValue(raw);
  } catch (e) { return null; }
}
function applyDrawPaint(elm, host) {
  ['fill', 'stroke', 'stroke-width'].forEach((k) => {
    const want = drawPaint[k];
    if (want == null || want === '') return;
    const wantN = k === 'stroke-width' ? normalizePaintNumber(want) : normalizePaintValue(want);
    if (wantN != null && inheritedPaint(host, k) === wantN) return;      // already inherited
    elm.setAttribute(k, want);
  });
}
/* A shape with neither fill nor stroke paints nothing. It is reachable in one
   click — ⊘ on both rows with nothing selected sets exactly that for the next
   shape — and the result is a drag that appears to do nothing at all, with
   handles the user has no reason to look for. Must be asked BEFORE the commit:
   commitGlyphEdit runs refreshMPreview, which detaches the element. */
function shapeIsInvisible(elm) {
  try {
    const cs = getComputedStyle(elm);
    return normalizePaintValue(cs.getPropertyValue('fill')) === 'none'
      && (normalizePaintValue(cs.getPropertyValue('stroke')) === 'none'
        || normalizePaintNumber(cs.getPropertyValue('stroke-width')) === '0');
  } catch (e) { return false; }
}
function makeShape(tag, attrs, host) {
  const e = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k]));
  host.appendChild(e);
  applyDrawPaint(e, host);
  return e;
}

/* Newly drawn shapes are SELECTED, so the paint bar and the arrow keys act on
   what was just made.

   The element has to be re-found by POSITION, not held as a reference:
   commitGlyphEdit ends in refreshMPreview, which replaces #mPreview's innerHTML
   outright, so the node the gesture created is detached by the time anyone can
   select it. Document order is what survives that — the commit changes the
   markup, never the order. */
function drawableIndexOf(root, elm) {
  return Array.prototype.indexOf.call(root.querySelectorAll(DRAWABLE_TAGS.join(',')), elm);
}
function selectDrawableAt(idx, filter) {
  const root = el('mPreview').querySelector('svg'); if (!root || idx < 0) return 0;
  const elm = root.querySelectorAll(DRAWABLE_TAGS.join(','))[idx];
  if (!elm) return 0;
  const pts = glyphPoints(root);
  glyphSel.clear();
  pts.forEach((p, i) => { if (p.el === elm && (!filter || filter(p))) glyphSel.add(i); });
  markGlyphSel(pts);                      // structure changed — re-mark, or the backstop drops it
  return glyphSel.size;
}

/* ---------------- creation gestures ---------------- */
let ptTool = null;                       // drag tools + the pen's pending run
const TOOL_MIN_DRAG = 1.2;               // view units: below this a drag is a click
const PEN_CLOSE_T = 2.2;                 // click within this of the first anchor closes
const PEN_MAX_ANCHORS = 60;              // PT_CAP is 240 points; a pen path of this many is already unwieldy
const FREE_TOL = 0.55;                   // RDP tolerance in view units
const FREE_MAX_ANCHORS = 40;             // escalate the tolerance rather than mint 240 handles

function cancelToolGesture() {
  const t = ptTool; ptTool = null;
  if (!t) return;
  window.removeEventListener('pointermove', onToolMove);
  window.removeEventListener('pointerup', onToolUp);
  window.removeEventListener('pointercancel', onToolUp);
  dropPointer(t.pid);
}

function onCanvasDown(e) {
  if (toolMode === 'select') { onMarqDown(e); return; }
  if (toolMode === 'rotate') { onRotDown(e); return; }
  if (toolMode === 'insert') { doInsertPoint(e); return; }
  onDrawDown(e);
}

function onDrawDown(e) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  focusPtCanvas();                       // must not scroll — see focusPtCanvas
  if (glyphEditBlocked('shapes can’t be drawn')) return;
  const root = el('mPreview').querySelector('svg'); if (!root) return;
  const v = viewPtOf(e); if (!v) return;

  const host = resolveDrawTarget(root, null, toolMode);

  /* Continuing a pen run: this press is another anchor, not a new gesture. */
  if (toolMode === 'pen' && ptTool && ptTool.mode === 'pen') {
    const a = ptTool.anchors;
    const s = snapToolPt(v, ptTool, e, a.length ? { x: a[a.length - 1].vx, y: a[a.length - 1].vy } : null);
    if (a.length > 2 && Math.hypot(s.view.x - a[0].vx, s.view.y - a[0].vy) <= PEN_CLOSE_T) { finishPen(true); return; }
    if (a.length >= PEN_MAX_ANCHORS) { toast('That is ' + PEN_MAX_ANCHORS + ' anchors — finishing the path here (Enter finishes, Esc cancels).'); finishPen(false); return; }
    a.push({ x: s.local.x, y: s.local.y, vx: s.view.x, vy: s.view.y, hx: 0, hy: 0 });
    ptTool.dragging = a.length - 1;
    /* Each anchor is its own press: `moved` latched true by the FIRST anchor's
       handle drag would make every later click pull a handle on its first
       jitter. `pd` is the RAW press point (ptDrag's precedent) — measuring the
       threshold against the SNAPPED origin instead lets a press that never
       travelled read as a drag whenever the snap moved it. */
    ptTool.moved = false;
    ptTool.pd = viewPtOf(e) || s.view;
    ptTool.pid = grabPointer(e);
    window.addEventListener('pointermove', onToolMove);
    window.addEventListener('pointerup', onToolUp);
    window.addEventListener('pointercancel', onToolUp);
    renderGlyphPts();
    return;
  }

  ptTool = {
    mode: toolMode, host: host, m: host.m, inv: host.inv, refs: toolRefs(root), guides: null,
    root: root, moved: false, pid: grabPointer(e), anchors: [], trail: [], dragging: -1,
    before: el('mSvg').value,
  };
  const s = snapToolPt(v, ptTool, e, null);
  ptTool.o = s;
  ptTool.v = s;
  ptTool.pd = v;                         // the RAW press — see the pen branch above
  if (toolMode === 'pen') {
    ptTool.anchors.push({ x: s.local.x, y: s.local.y, vx: s.view.x, vy: s.view.y, hx: 0, hy: 0 });
    ptTool.dragging = 0;
  }
  if (toolMode === 'free') ptTool.trail.push({ x: v.x, y: v.y });
  window.addEventListener('pointermove', onToolMove);
  window.addEventListener('pointerup', onToolUp);
  window.addEventListener('pointercancel', onToolUp);
  renderGlyphPts();
}

function onToolMove(e) {
  const t = ptTool; if (!t) return;
  if (pointerReleased(e)) { onToolUp(); return; }
  const v = viewPtOf(e); if (!v) return;
  if (!t.moved && Math.hypot(v.x - (t.pd || t.o.view).x, v.y - (t.pd || t.o.view).y) >= TOOL_MIN_DRAG) t.moved = true;

  if (t.mode === 'free') { t.trail.push({ x: v.x, y: v.y }); renderGlyphPts(); return; }
  if (t.mode === 'pen') {
    /* Dragging just after placing an anchor pulls its handle out — the pen
       gesture every vector editor has. The IN handle is the mirror, so the
       anchor is always smooth. */
    const a = t.anchors[t.dragging];
    if (a && t.moved) {
      const loc = applyMat(t.inv, v.x, v.y);
      a.hx = r2(loc.x - a.x); a.hy = r2(loc.y - a.y);
    }
    renderGlyphPts();
    return;
  }
  t.v = snapToolPt(v, t, e, t.o.view);
  renderGlyphPts();
}

function onToolUp() {
  const t = ptTool; if (!t) return;
  if (t.mode === 'pen') {                 // the run continues; only the handle drag ended
    t.dragging = -1;
    dropPointer(t.pid); t.pid = null;
    window.removeEventListener('pointermove', onToolMove);
    window.removeEventListener('pointerup', onToolUp);
    window.removeEventListener('pointercancel', onToolUp);
    renderGlyphPts();
    return;
  }
  ptTool = null;                          // FIRST — commitGlyphEdit runs refreshMPreview, which cancels tool gestures
  window.removeEventListener('pointermove', onToolMove);
  window.removeEventListener('pointerup', onToolUp);
  window.removeEventListener('pointercancel', onToolUp);
  dropPointer(t.pid);
  if (!t.moved) { renderGlyphPts(); return; }   // a click is not a shape

  const host = t.host.el;
  let made = null;
  if (t.mode === 'line') {
    /* Same degeneracy guard the box tools have: snapping can pull both ends onto
       one point, and a zero-length line paints nothing while still carrying two
       handles. */
    const a = t.o.local, b = t.v.local;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.25) { renderGlyphPts(); return; }
    made = makeShape('line', { x1: fmtN(a.x), y1: fmtN(a.y), x2: fmtN(b.x), y2: fmtN(b.y) }, host);
  } else if (t.mode === 'rect' || t.mode === 'ellipse') {
    /* BOTH corners go through the inverse and the extent is measured in LOCAL
       space. Transforming a width would be wrong under any scaled group — the
       one shipped `scale(0.875)` wrapper would take a 12.5% oversized rect, and
       nowhere else would show it. */
    const a = t.o.local, b = t.v.local;
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < 0.25 || h < 0.25) { renderGlyphPts(); return; }
    made = t.mode === 'rect'
      ? makeShape('rect', { x: fmtN(x0), y: fmtN(y0), width: fmtN(w), height: fmtN(h) }, host)
      : makeShape('ellipse', { cx: fmtN(x0 + w / 2), cy: fmtN(y0 + h / 2), rx: fmtN(w / 2), ry: fmtN(h / 2) }, host);
  } else if (t.mode === 'free') {
    /* A long wiggly stroke can survive simplification with more anchors than the
       240-point handle cap can show. Coarsen until it fits rather than mint
       points the editor cannot then select, drag or delete. */
    let tol = FREE_TOL, raw = simplifyRdp(t.trail, tol);
    while (raw.length > FREE_MAX_ANCHORS && tol < 6) { tol *= 1.6; raw = simplifyRdp(t.trail, tol); }
    const kept = raw.map((q) => applyMat(t.inv, q.x, q.y)).map((q) => ({ x: r2(q.x), y: r2(q.y) }));
    if (kept.length < 2) { renderGlyphPts(); return; }
    if (tol > FREE_TOL) toast('Smoothed the stroke to ' + kept.length + ' anchors so every point stays editable.');
    const d = freehandPathData(kept, shouldCloseStroke(t.trail));
    if (!d) { renderGlyphPts(); return; }
    made = makeShape('path', { d: d }, host);
  }
  if (!made) { renderGlyphPts(); return; }
  const blind = shapeIsInvisible(made);
  const at = drawableIndexOf(t.root, made);
  commitGlyphEdit(t.root, t.before);
  const n = selectDrawableAt(at, null);
  renderGlyphPts();
  const what = t.mode === 'free' ? 'freehand path' : t.mode;
  toast('Added a ' + what + (n ? ' — ' + n + ' point' + (n === 1 ? '' : 's') + ' selected.' : '.')
    + (blind ? ' It has no fill and no stroke, so it paints nothing — pick a colour.' : ''));
}

/* Pen: Enter / double-click finishes open, clicking the first anchor closes. */
function finishPen(closed) {
  const t = ptTool; if (!t || t.mode !== 'pen') return;
  ptTool = null;
  window.removeEventListener('pointermove', onToolMove);
  window.removeEventListener('pointerup', onToolUp);
  window.removeEventListener('pointercancel', onToolUp);
  dropPointer(t.pid);
  if (t.anchors.length < 2) { renderGlyphPts(); toast('A path needs at least two anchors.'); return; }
  const d = penPathData(t.anchors, closed);
  if (!d) { renderGlyphPts(); return; }
  const made = makeShape('path', { d: d }, t.host.el);
  const blind = shapeIsInvisible(made);
  const at = drawableIndexOf(t.root, made);
  commitGlyphEdit(t.root, t.before);
  const n = selectDrawableAt(at, null);
  renderGlyphPts();
  toast('Added a path with ' + t.anchors.length + ' anchor' + (t.anchors.length === 1 ? '' : 's') + (closed ? ' (closed)' : '') + (n ? ' — selected.' : '.')
    + (blind ? ' It has no fill and no stroke, so it paints nothing — pick a colour.' : ''));
}

/* ---------------- add a point ----------------
   The inverse of Delete. The hit test runs in VIEW space (what the user sees),
   which is legitimate for Béziers because an affine transform maps control
   points and preserves the parameter t — so the t found on screen is the t to
   split at in the element's own space. */
let insHit = null;
function findInsertHit(root, v) {
  let best = null;
  const consider = (elm, kind, idx, hit, closed) => {
    /* A malformed `points` list yields NaN coordinates, and NaN fails every
       comparison — so an unusable candidate taken as `best` first would never be
       displaced, and the marker would stick to it for the rest of the session. */
    if (!Number.isFinite(hit.d2) || !Number.isFinite(hit.x) || !Number.isFinite(hit.y)) return;
    if (!best || hit.d2 < best.d2) best = { el: elm, kind: kind, idx: idx, t: hit.t, x: hit.x, y: hit.y, d2: hit.d2, closed: closed };
  };
  root.querySelectorAll('path,polyline,polygon,line').forEach((elm) => {
    let m; try { m = ctmOf(elm, root); } catch (e) { return; }
    const to = (q) => applyMat(m, q.x, q.y);
    const tag = elm.tagName.toLowerCase();
    if (tag === 'path') {
      const segs = tokenizePath(elm.getAttribute('d') || '');
      pathSpans(segs).forEach((sp) => {
        const seg = segs[sp.si];
        if (!seg || !canInsertInto(seg.cmd)) return;
        const w = sp.pts.map(to);
        const hit = w.length === 2 ? projectOnSegment(v, w[0], w[1]) : nearestOnCurve(v, w);
        consider(elm, 'path', sp.si, hit, false);
      });
      return;
    }
    if (tag === 'line') {
      const a = to({ x: parseFloat(elm.getAttribute('x1')) || 0, y: parseFloat(elm.getAttribute('y1')) || 0 });
      const b = to({ x: parseFloat(elm.getAttribute('x2')) || 0, y: parseFloat(elm.getAttribute('y2')) || 0 });
      consider(elm, 'line', 0, projectOnSegment(v, a, b), false);
      return;
    }
    const nums = (elm.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
    const count = Math.floor(nums.length / 2);
    const closed = tag === 'polygon';
    for (let i = 0; i < count; i++) {
      const j = i + 1 >= count ? (closed ? 0 : -1) : i + 1;
      if (j < 0) break;
      const a = to({ x: nums[i * 2], y: nums[i * 2 + 1] });
      const b = to({ x: nums[j * 2], y: nums[j * 2 + 1] });
      consider(elm, 'poly', i, projectOnSegment(v, a, b), closed);
    }
  });
  return best && best.d2 <= 2.6 * 2.6 ? best : null;
}
function onCanvasHover(e) {
  /* Attached once to #mPrevBox, so it fires during every other gesture too. */
  if (toolMode !== 'insert' || ptDrag || ptScale || ptMarq || ptTool || ptRot) return;
  if (!el('mMove').checked || el('mApply').disabled) return;
  const root = el('mPreview').querySelector('svg'); if (!root) return;
  const v = viewPtOf(e); if (!v) return;
  const hit = findInsertHit(root, v);
  const same = (!hit && !insHit) || (hit && insHit && hit.el === insHit.el && hit.idx === insHit.idx && Math.abs(hit.t - insHit.t) < 1e-4);
  insHit = hit;
  if (!same) renderGlyphPts();
}
function doInsertPoint(e) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  focusPtCanvas();                       // must not scroll — see focusPtCanvas
  if (glyphEditBlocked('points can’t be added')) return;
  const root = el('mPreview').querySelector('svg'); if (!root) return;
  const v = viewPtOf(e); if (!v) return;
  const hit = findInsertHit(root, v);
  if (!hit) { toast('Nothing to add a point to here — click on a line or a curve.'); return; }
  const before = el('mSvg').value;
  let target = hit.el, newIdx = -1;

  if (hit.kind === 'path') {
    const segs = tokenizePath(hit.el.getAttribute('d') || '');
    const r = insertIntoPath(segs, hit.idx, hit.t);
    if (!r) { toast('That segment can’t take an extra point (arcs are not supported).'); return; }
    hit.el.setAttribute('d', serializePath(r.segs));
    newIdx = r.anchorSeg;
  } else if (hit.kind === 'poly') {
    const nums = (hit.el.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
    const r = insertIntoPoly(nums, hit.idx, hit.t, hit.closed);
    if (!r) { toast('That segment can’t take an extra point.'); return; }
    hit.el.setAttribute('points', r.nums.map(fmtN).join(' '));
    newIdx = r.at;
  } else {
    /* A <line> has exactly two ends and no room for a third point, so it is
       PROMOTED to a <polyline>. fill must be written explicitly: a polyline's
       initial fill is black, so the promoted shape would suddenly paint a solid
       triangle where a stroke used to be. */
    const x1 = parseFloat(hit.el.getAttribute('x1')) || 0, y1 = parseFloat(hit.el.getAttribute('y1')) || 0;
    const x2 = parseFloat(hit.el.getAttribute('x2')) || 0, y2 = parseFloat(hit.el.getAttribute('y2')) || 0;
    const inv = (() => { try { return invMat(ctmOf(hit.el, root)); } catch (err) { return [1, 0, 0, 1, 0, 0]; } })();
    const mid = applyMat(inv, hit.x, hit.y);
    const poly = document.createElementNS(SVG_NS, 'polyline');
    Array.prototype.forEach.call(hit.el.attributes, (a) => {
      if (/^(x1|y1|x2|y2)$/.test(a.name)) return;
      poly.setAttribute(a.name, a.value);
    });
    poly.setAttribute('points', [x1, y1, r2(mid.x), r2(mid.y), x2, y2].map(fmtN).join(' '));
    if (!poly.hasAttribute('fill')) poly.setAttribute('fill', 'none');
    hit.el.parentNode.replaceChild(poly, hit.el);
    target = poly;
    newIdx = 2;
    toast('A line has only two ends — it is now a polyline, so the point could be added.');
  }
  insHit = null;
  const at = drawableIndexOf(root, target);
  commitGlyphEdit(root, before);

  /* Select ONLY the new anchor. Selecting the whole element — which is what a
     CREATION does — would mean the very next Delete took the entire shape,
     because pathDelete removes an element that drops below two anchors. */
  const poly = hit.kind !== 'path';
  const n = selectDrawableAt(at, (p) => (poly
    ? !!p.del && p.del.k === 'poly' && p.del.i === newIdx
    : !!p.del && p.del.k === 'seg' && p.del.si === newIdx));
  renderGlyphPts();
  if (!n) toast('Point added.');
}

/* ---------------- rotate ----------------
   A ROTATE TOOL rather than a grip on the selection frame. A grip has to live
   outside the frame, and on art that fills the canvas (uv reaches 0.42…56.29)
   there is ~1.6 units of room out there — the grip would be drawn on top of the
   selected points' own handles, and since grips are appended BEFORE handles so a
   point always wins an ambiguous press, it would be visible and unclickable in
   exactly the select-all case people reach for first.

   Two mechanisms, because a selection of POINTS cannot express every rotation:
     • coords — rotate each selected point about the pivot. Exact for line
       endpoints, polyline/polygon vertices, text/circle centres and path
       anchors and controls.
     • rigid — fold a rotate() into the element's own transform. A <rect> is
       axis-aligned by construction and an <ellipse>'s rx/ry ARE its axes, so
       rotating their points cannot rotate them: it just drags the corners, which
       reads as the shape being resized and skewed.
   Derived size handles (a circle's r, a rect's bottom-right) are skipped — they
   are a dimension, not a point, which is exactly what Delete already tells the
   user about them. */
let ptRot = null;
let rotRun = null;                       // { src, total, expect, sig } — see rotateGlyphSelection
const ROT_MIN_LEVER = 2.5;               // view units: closer to the pivot than this, the angle is noise

function isSimilarity(m) {
  const a = m[0] * m[0] + m[1] * m[1], b = m[2] * m[2] + m[3] * m[3];
  if (!isFinite(a) || !isFinite(b) || a < 1e-12 || b < 1e-12) return false;
  return Math.abs(a - b) < 1e-6 * Math.max(1, a) && Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-6 * Math.max(1, a);
}
/* A path point that cannot be rotated by coordinate: H/V carry ONE axis and
   inherit the other, and an arc's radii and x-rotation are not in its point. */
function rigidPathSeg(elm, si) {
  const segs = tokenizePath(elm.getAttribute('d') || '');
  const s = segs[si];
  return !!s && /^[hva]$/i.test(s.cmd);
}
function planRotation(root) {
  const pts = glyphPoints(root);
  const sel = Array.from(glyphSel).filter((i) => i < pts.length).sort((a, b) => a - b);
  const byEl = new Map();
  sel.forEach((i) => {
    const p = pts[i];
    let g = byEl.get(p.el);
    if (!g) { g = { el: p.el, idx: [], all: 0 }; byEl.set(p.el, g); }
    g.idx.push(i);
  });
  pts.forEach((p) => { const g = byEl.get(p.el); if (g) g.all++; });

  const coords = [], rigid = [];
  let refused = 0, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  const grow = (x, y) => { if (!isFinite(x) || !isFinite(y)) return; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  /* The pivot is the VISUAL centre of what was selected, so an element whose
     extent is not described by its handles has to contribute its own box.
     A <rect>'s two handles are its top-left ANCHOR and a bottom-right SIZE
     handle, and size handles are excluded from the writes (they are a dimension,
     not a point) — so a bbox built from writable handles alone put the pivot on
     the rect's top-left CORNER, and select-all + rotate swung the shape around
     its own corner. getBBox is in the element's own space; its four corners go
     through the CTM because a rotated container makes the box's image a
     parallelogram, and only its extent is wanted. */
  const growBBox = (elm) => {
    let b, m;
    try { b = elm.getBBox(); m = ctmOf(elm, root); } catch (e) { return false; }
    if (!b || !isFinite(b.width) || !isFinite(b.height)) return false;
    [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
      .forEach((c) => { const v = applyMat(m, c[0], c[1]); grow(v.x, v.y); });
    return true;
  };
  byEl.forEach((g) => {
    const tag = g.el.tagName.toLowerCase();
    const own = (g.el.getAttribute('transform') || '').trim();
    const whole = g.idx.length >= g.all;
    const isRigid = tag === 'rect' || tag === 'ellipse' || tag === 'text' || (!!own && whole);
    if (isRigid) {
      let mp;
      try { mp = ctmOf(g.el.parentNode && g.el.parentNode !== root ? g.el.parentNode : root, root); } catch (e) { mp = [1, 0, 0, 1, 0, 0]; }
      if (!isSimilarity(mp)) { refused += g.idx.length; return; }
      rigid.push({ el: g.el, orig: g.el.getAttribute('transform'), invParent: invMat(mp), mirrored: (mp[0] * mp[3] - mp[1] * mp[2]) < 0 });
    }
    /* An element takes its own box into the pivot when its handles do not
       describe its extent: every rigid element (it turns as a whole), and any
       element with a selected SIZE handle (a circle's r, a rect's corner). */
    const sized = isRigid || g.idx.some((i) => pts[i] && !pts[i].del);
    let boxed = false;
    if (sized) boxed = growBBox(g.el);
    g.idx.forEach((i) => {
      const p = pts[i];
      /* A derived size handle is a dimension; rotating it would change the
         radius. Its element's rotation is carried by the anchor (or by the
         rigid transform), so there is nothing to do for it. */
      if (!p.del) return;
      if (tag === 'path' && p.del && p.del.si != null && rigidPathSeg(p.el, p.del.si)) { refused++; return; }
      let m, o;
      try { m = ctmOf(p.el, root); const lp = p.get(); o = applyMat(m, lp.x, lp.y); } catch (e) { return; }
      if (!isFinite(o.x) || !isFinite(o.y)) return;
      if (!boxed) grow(o.x, o.y);
      if (!isRigid) coords.push({ p: p, o: o, inv: invMat(m) });
    });
  });
  if (x0 > x1 || y0 > y1) return null;
  return { pivot: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, coords: coords, rigid: rigid, refused: refused };
}
function applyRotation(plan, deg) {
  const rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  /* TWO ASCENDING passes. Nothing in `coords` clamps today — rect and ellipse,
     the only cross-clamping setters, are always rigid — so this is idempotent by
     construction; it is kept so a future clamping setter cannot silently break
     it, exactly as onScalePts and nudgeGlyphSelection do. */
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < plan.coords.length; k++) {
      const it = plan.coords[k];
      const w = rotatePt(it.o.x, it.o.y, plan.pivot.x, plan.pivot.y, cos, sin);
      const loc = applyMat(it.inv, w.x, w.y);
      if (!isFinite(loc.x) || !isFinite(loc.y)) continue;
      /* Fine rounding only: the 0.5 grid would collapse a small rotation to
         nothing and quantize a large one into a different shape. */
      try { it.p.set(r2(loc.x), r2(loc.y)); } catch (e) {}
    }
  }
  plan.rigid.forEach((r) => {
    const pp = applyMat(r.invParent, plan.pivot.x, plan.pivot.y);
    /* The rotate is written in the element's PARENT space; under a mirroring
       parent a view-space clockwise turn is counter-clockwise there. Always
       composed from the ORIGINAL transform, never from the last frame's output,
       so a drag cannot accumulate rotate() calls or drift on rounding. */
    r.el.setAttribute('transform', rotateTransform(r.orig, r.mirrored ? -deg : deg, pp.x, pp.y));
  });
}
function onRotDown(e) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  focusPtCanvas();                       // must not scroll — see focusPtCanvas
  if (glyphEditBlocked('the selection can’t be rotated')) return;
  const root = el('mPreview').querySelector('svg'); if (!root) return;
  if (glyphSel.size < 2) { toast('Select at least two points first — a rotation needs something to turn about.'); return; }
  const plan = planRotation(root);
  if (!plan || (!plan.coords.length && !plan.rigid.length)) { toast('Nothing in that selection can be rotated.'); return; }
  const v = viewPtOf(e); if (!v) return;
  ptRot = {
    root: root, plan: plan, raw: null, acc: 0, deg: 0, moved: false,
    pid: grabPointer(e), before: el('mSvg').value,
  };
  if (Math.hypot(v.x - plan.pivot.x, v.y - plan.pivot.y) >= ROT_MIN_LEVER) {
    ptRot.raw = Math.atan2(v.y - plan.pivot.y, v.x - plan.pivot.x);
  }
  window.addEventListener('pointermove', onRotMove);
  window.addEventListener('pointerup', endRot);
  window.addEventListener('pointercancel', endRot);
  renderGlyphPts();
}
function onRotMove(e) {
  const t = ptRot; if (!t) return;
  if (pointerReleased(e)) { endRot(); return; }
  const v = viewPtOf(e); if (!v) return;
  const lever = Math.hypot(v.x - t.plan.pivot.x, v.y - t.plan.pivot.y);
  if (lever < ROT_MIN_LEVER) { t.raw = null; renderGlyphPts(); return; }
  const raw = Math.atan2(v.y - t.plan.pivot.y, v.x - t.plan.pivot.x);
  /* Re-seed rather than accumulate when the pointer comes back out of the dead
     zone: an angle measured against a stale reading across the pivot is a ±180°
     step whose sign is decided by floating-point noise. */
  if (t.raw == null) { t.raw = raw; renderGlyphPts(); return; }
  /* Accumulate the per-frame delta, unwrapped: measuring against the gesture's
     FIRST angle would fold at half a turn, so dragging past 180° would spin the
     art back the other way. normalizeDeg is applied to the tiny frame delta,
     which is what makes the crossing continuous. */
  t.acc += normalizeDeg((raw - t.raw) * 180 / Math.PI);
  t.raw = raw;
  const deg = e.shiftKey ? snapDeg(t.acc, 15) : t.acc;
  t.deg = deg;
  if (!t.moved && Math.abs(deg) >= 0.5) t.moved = true;
  if (t.moved) {
    applyRotation(t.plan, deg);
    /* Write the source EVERY FRAME, exactly as onPtMove and onScalePts do. The
       art rotates in the preview either way, but #mSvg is the modal's single
       source of truth: leaving it stale until pointerup meant the markup box —
       and the highlight mirror behind it — silently disagreed with the picture
       for the whole drag. */
    el('mSvg').value = t.root.innerHTML;
  }
  renderGlyphPts();
}
function endRot() {
  const t = ptRot; if (!t) return;
  ptRot = null;
  window.removeEventListener('pointermove', onRotMove);
  window.removeEventListener('pointerup', endRot);
  window.removeEventListener('pointercancel', endRot);
  dropPointer(t.pid);
  if (!t.moved) { renderGlyphPts(); return; }
  commitGlyphEdit(t.root, t.before);
  if (t.plan.refused) toast('Rotated ' + Math.round(normalizeDeg(t.deg)) + '° — ' + t.plan.refused + ' point' + (t.plan.refused === 1 ? '' : 's') + ' could not follow (H/V/arc segments, or a sheared group).');
}
/* ABANDON, not end. `endRot` is the pointerup path and COMMITS; Escape, a tool
   change and closing the modal all mean "undo what this drag has done so far",
   and the art has been rewritten in place on every frame — so the source has to
   be put back. It restores `before` directly rather than pushing an undo entry:
   nothing was ever committed, so there is nothing for ⌘Z to step over. */
function cancelRotate() {
  const t = ptRot; if (!t) return;
  ptRot = null;
  window.removeEventListener('pointermove', onRotMove);
  window.removeEventListener('pointerup', endRot);
  window.removeEventListener('pointercancel', endRot);
  dropPointer(t.pid);
  if (t.moved) { el('mSvg').value = t.before; refreshMPreview(); return; }
  renderGlyphPts();
}

/* Keyboard rotation. ⌥←/→ by 1°, ⇧ by 15° — the arrows themselves are the
   translate nudge, and ⌥ is free inside the modal. */
function rotateGlyphSelection(deg, held) {
  if (!glyphSel.size || el('mApply').disabled) return false;
  if (glyphSel.size < 2) { toast('Select at least two points first — a rotation needs something to turn about.'); return false; }
  const before = el('mSvg').value;
  /* A RUN, and it is what makes the keys usable at all. Applying a per-press
     DELTA to the art the previous press produced is not the same operation as
     one rotation: `planRotation` takes its pivot from the CURRENT bounding box,
     and the AABB centre of a rotated point set is not the rotated AABB centre —
     so every press turns about a slightly different place and the selection
     WALKS. Measured on the shipped `dataviz` polyline: six ⇧⌥→ presses land the
     whole shape 1.38 view units from where one 90° drag puts it, as a pure
     translation, and an L-shaped selection spanning the canvas goes 9.3. It also
     violated `rotateTransform`'s contract (ORIGINAL transform + TOTAL angle),
     leaving one `rotate()` per keypress stacked in the saved art.
     So the run keeps the ORIGINAL source and the accumulated total, restores
     that source, and re-plans against it — the plan can NOT be cached, because
     refreshMPreview replaces #mPreview's innerHTML and every element reference
     in it goes with the old tree.
     The run is validated against the SOURCE TEXT rather than a list of
     invalidation sites: typing, an undo, a paint change and a tool gesture all
     move it, so one comparison covers every way the run can stop being valid.
     `selSig` joins it because a different selection is a different rotation. */
  if (!rotRun || rotRun.expect !== before || rotRun.sig !== selSig) {
    rotRun = { src: before, total: 0, expect: before, sig: selSig };
  } else if (rotRun.src !== before) {
    el('mSvg').value = rotRun.src;
    refreshMPreview();                            // … and with it a LIVE element tree
  }
  const root = el('mPreview').querySelector('svg'); if (!root) { rotRun = null; return false; }
  const plan = planRotation(root);
  if (!plan || (!plan.coords.length && !plan.rigid.length)) { rotRun = null; toast('Nothing in that selection can be rotated.'); return false; }
  rotRun.total += deg;
  applyRotation(plan, rotRun.total);              // TOTAL against ORIGINAL — idempotent
  el('mSvg').value = root.innerHTML;
  rotRun.expect = el('mSvg').value;
  /* `before` — this press's pre-state — stays the snapshot, so one ⌘Z steps back
     one tap rather than the whole run; the restored document then fails the
     `expect` test and the next press starts a fresh run from it. */
  if (!held || !nudgeRun || nudgeKind !== 'rot') { pushGlyphUndo(before); nudgeRun = true; nudgeKind = 'rot'; }
  refreshMPreview();
  return true;
}

/* ---------------- tool + rotate overlays ---------------- */
function drawToolOverlays(lay, root, pts, P, box, nSel) {
  const mk = (tag, attrs, cls) => {
    const e = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k]));
    e.setAttribute('class', cls + ' pt-dec');   // .pt-dec — see the CSS note about #mPtsLay circle
    lay.appendChild(e);
    return e;
  };
  /* alignment guides for the creation tools, same look as a point drag's */
  if (ptTool && ptTool.guides) {
    if (ptTool.guides.x != null) mk('line', { x1: ptTool.guides.x, y1: 0, x2: ptTool.guides.x, y2: 56 }, 'pt-guide');
    if (ptTool.guides.y != null) mk('line', { x1: 0, y1: ptTool.guides.y, x2: 56, y2: ptTool.guides.y }, 'pt-guide');
  }
  if (ptTool) {
    const o = ptTool.o && ptTool.o.view, v = ptTool.v && ptTool.v.view;
    if (ptTool.mode === 'line' && o && v) mk('line', { x1: o.x, y1: o.y, x2: v.x, y2: v.y }, 'pt-ink');
    if (ptTool.mode === 'rect' && o && v) mk('rect', { x: Math.min(o.x, v.x), y: Math.min(o.y, v.y), width: Math.abs(v.x - o.x), height: Math.abs(v.y - o.y) }, 'pt-ink');
    if (ptTool.mode === 'ellipse' && o && v) mk('ellipse', { cx: (o.x + v.x) / 2, cy: (o.y + v.y) / 2, rx: Math.abs(v.x - o.x) / 2, ry: Math.abs(v.y - o.y) / 2 }, 'pt-ink');
    if (ptTool.mode === 'free' && ptTool.trail.length > 1) {
      mk('polyline', { points: ptTool.trail.map((q) => r2(q.x) + ',' + r2(q.y)).join(' ') }, 'pt-ink');
    }
    if (ptTool.mode === 'pen' && ptTool.anchors.length) {
      const a = ptTool.anchors;
      /* The handle is transformed as a POINT and the view-space offset read back
         from it — scaling the offset by m[0]/m[3] would be wrong the moment a
         container rotates, and silently right everywhere else. */
      const vh = (q) => {
        const h = applyMat(ptTool.m, q.x + q.hx, q.y + q.hy);
        return { x: h.x - q.vx, y: h.y - q.vy };
      };
      if (a.length > 1) {
        const d = penPathData(a.map((q) => { const o = vh(q); return { x: q.vx, y: q.vy, hx: o.x, hy: o.y }; }), false);
        if (d) mk('path', { d: d }, 'pt-ink');
      }
      a.forEach((q, i) => {
        mk('circle', { cx: q.vx, cy: q.vy, r: i === 0 ? 1.5 : 1.1 }, 'pt-new');
        if (q.hx || q.hy) {
          const o = vh(q);
          mk('line', { x1: q.vx, y1: q.vy, x2: q.vx + o.x, y2: q.vy + o.y }, 'pt-ink-soft');
          mk('circle', { cx: q.vx + o.x, cy: q.vy + o.y, r: 0.9 }, 'pt-new-ctrl');
        }
      });
    }
  }
  if (toolMode === 'insert' && insHit && !ptTool) {
    mk('circle', { cx: insHit.x, cy: insHit.y, r: 1.3 }, 'pt-ins');
  }
  if (toolMode === 'rotate' && nSel >= 2) {
    /* The marker has to come from planRotation, not from the handle bbox the
       renderer already has: the plan folds each sized element's getBBox into the
       pivot (a rect's handles are a corner ANCHOR and a size handle, so the
       handle box is not the shape), and a cross drawn somewhere other than where
       the art will actually turn is worse than no cross. */
    const idle = ptRot ? ptRot.plan : planRotation(root);
    const c = (idle && idle.pivot) || { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
    mk('circle', { cx: c.x, cy: c.y, r: 2.2 }, 'pt-pivot');
    mk('line', { x1: c.x - 3.4, y1: c.y, x2: c.x + 3.4, y2: c.y }, 'pt-pivot');
    mk('line', { x1: c.x, y1: c.y - 3.4, x2: c.x, y2: c.y + 3.4 }, 'pt-pivot');
    if (ptRot && ptRot.moved) {
      const t = mk('text', { x: c.x + 4, y: c.y - 4 }, 'pt-lbl');
      t.textContent = (normalizeDeg(ptRot.deg) > 0 ? '+' : '') + (Math.round(normalizeDeg(ptRot.deg) * 10) / 10) + '°';
    }
  }
}

/* ---------------- source highlight ----------------
   The textarea is transparent and sits on a mirror div carrying the same text
   with <mark> spans behind the selected shapes' markup. The join between the two
   halves is DOCUMENT ORDER — the Nth drawable in the text is the Nth in the DOM
   — and it is VERIFIED (tagsAlign) rather than assumed, because the preview is
   built by the HTML parser and foreign-content rules can close the <svg> early
   on a breakout tag, shifting every index by one. */
let hlWidth = -1;
const HL_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'lineHeight',
  'letterSpacing', 'wordSpacing', 'tabSize', 'textIndent', 'direction',
  'whiteSpace', 'overflowWrap', 'wordBreak',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'];

function glyphSourceMap(root) {
  const text = el('mSvg').value || '';
  const scan = scanGlyphSource(text);
  const domEls = Array.prototype.slice.call(root.querySelectorAll(DRAWABLE_TAGS.join(',')));
  if (!tagsAlign(scan, domEls.map((e) => e.tagName.toLowerCase()))) return null;
  return { text: text, scan: scan, domEls: domEls };
}
function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function syncGlyphHl(ctx) {
  const ta = el('mSvg'), mir = el('mHl'); if (!ta || !mir) return;
  /* Never measure a hidden modal: clientWidth is 0 before .show, which would
     write a negative width and then cache it. */
  const ov = document.getElementById('overlay');
  if (!ov || !ov.classList.contains('show') || !ta.clientWidth) return;
  if (ta.clientWidth !== hlWidth) {
    const cs = getComputedStyle(ta);
    HL_PROPS.forEach((k) => { mir.style[k] = cs[k]; });
    mir.style.borderColor = 'transparent';
    hlWidth = ta.clientWidth;
  }
  const text = ta.value || '';
  const root = (ctx && ctx.root) || el('mPreview').querySelector('svg');
  const note = el('mMapNote');
  let ranges = [];
  let noteText = '';
  if (root && glyphSel.size) {
    const map = glyphSourceMap(root);
    if (!map) noteText = 'The markup and the preview disagree, so the source can’t be highlighted — fix the SVG and it comes back.';
    else {
      const pts = (ctx && ctx.pts) || glyphPoints(root);
      const want = new Set();
      glyphSel.forEach((i) => { const p = pts[i]; if (p) want.add(p.el); });
      want.forEach((e) => {
        const idx = map.domEls.indexOf(e);
        const r = idx >= 0 ? map.scan.drawables[idx] : null;
        if (r) ranges.push({ start: r.start, end: r.end });
      });
    }
  }
  ranges = mergeRanges(ranges);
  let html = '', at = 0;
  ranges.forEach((r) => {
    html += escHtml(text.slice(at, r.start)) + '<mark>' + escHtml(text.slice(r.start, r.end)) + '</mark>';
    at = r.end;
  });
  /* the trailing newline keeps a final empty line from collapsing, so the mirror
     scrolls exactly as far as the textarea does */
  mir.innerHTML = html + escHtml(text.slice(at)) + '\n';
  mir.scrollTop = ta.scrollTop; mir.scrollLeft = ta.scrollLeft;
  if (note) { note.textContent = noteText; note.style.display = noteText ? '' : 'none'; }
}

/* Caret → canvas. Clicking a line of markup selects that shape's points, which
   is the direction that makes the source usable as a picker. */
function selectFromCaret() {
  if (!el('mMove').checked || el('mApply').disabled) return;
  const root = el('mPreview').querySelector('svg'); if (!root) return;
  const map = glyphSourceMap(root); if (!map) return;
  const idx = drawableIndexAtOffset(map.scan, el('mSvg').selectionStart || 0);
  if (idx < 0 || idx >= map.domEls.length) return;
  const elm = map.domEls[idx];
  const pts = glyphPoints(root);
  const hits = [];
  pts.forEach((p, i) => { if (p.el === elm) hits.push(i); });
  if (!hits.length) {
    toast(pts.length >= PT_CAP
      ? 'That shape’s points are past the ' + PT_CAP + '-point editing cap — it has no handles.'
      : 'That shape has no editable points.');
    return;
  }
  glyphSel.clear();
  hits.forEach((i) => glyphSel.add(i));
  markGlyphSel(pts);
  renderGlyphPts();
}

/* ---------------- paint bar ---------------- */
function paintTargets(root, known) {
  const pts = known || glyphPoints(root);
  const out = [];
  glyphSel.forEach((i) => { const p = pts[i]; if (p && out.indexOf(p.el) < 0) out.push(p.el); });
  return out;
}
function effectivePaint(elm, prop) {
  try {
    const raw = getComputedStyle(elm).getPropertyValue(prop);
    return prop === 'stroke-width' ? normalizePaintNumber(raw) : normalizePaintValue(raw);
  } catch (e) { return null; }
}
function buildPaintChips() {
  [['fill', 'mFillChips'], ['stroke', 'mStrokeChips']].forEach((pair) => {
    const host = el(pair[1]); if (!host) return;
    host.innerHTML = '';
    const add = (value, cls, title) => {
      const b = document.createElement('button');
      b.className = 'pb-chip' + (cls ? ' ' + cls : '');
      b.dataset.prop = pair[0]; b.dataset.value = value;
      b.title = title;
      if (value !== 'none') b.style.background = value;
      b.onclick = () => applyPaint(pair[0], value);
      host.appendChild(b);
    };
    add('none', 'none', 'No ' + pair[0]);
    GLYPH_PALETTE.forEach((p) => add(p.hex, '', p.name + ' ' + p.hex + ' — ' + p.note));
  });
}
function renderPaintBar(ctx) {
  const bar = el('mPaint'); if (!bar) return;
  /* Skip while a gesture owns the POINTER: getComputedStyle forces a style recalc
     per shape per property, and paint cannot change mid-drag anyway. A pen run
     BETWEEN anchors holds no pointer (`dragging < 0`) and can last as long as the
     user likes, so it must not freeze the bar — that is exactly when someone
     picks the colour for the path they are drawing. */
  if (ptDrag || ptScale || ptMarq || ptRot || (ptTool && !(ptTool.mode === 'pen' && ptTool.dragging < 0))) return;
  const root = (ctx && ctx.root) || el('mPreview').querySelector('svg');
  const targets = (root && el('mMove').checked) ? paintTargets(root, ctx && ctx.pts) : [];
  const sums = {};
  ['fill', 'stroke', 'stroke-width'].forEach((prop) => {
    sums[prop] = targets.length
      ? summarizePaint(targets.map((e) => effectivePaint(e, prop)))
      : { value: prop === 'stroke-width' ? drawPaint['stroke-width'] : drawPaint[prop], mixed: false };
  });
  ['fill', 'stroke'].forEach((prop) => {
    const host = el(prop === 'fill' ? 'mFillChips' : 'mStrokeChips'); if (!host) return;
    const s = sums[prop];
    const norm = s.value == null ? null : (s.value === 'none' ? 'none' : normalizePaintValue(s.value));
    Array.prototype.forEach.call(host.children, (b) => {
      const v = b.dataset.value === 'none' ? 'none' : normalizePaintValue(b.dataset.value);
      b.classList.toggle('is-on', !s.mixed && norm != null && v === norm);
    });
  });
  const w = el('mStrokeW');
  /* Never rewrite a field the user is typing in — it would move the caret to the
     end on every keystroke. */
  if (w && document.activeElement !== w) w.value = sums['stroke-width'].mixed ? '' : displayPaintNumber(sums['stroke-width'].value);
  if (w) w.placeholder = sums['stroke-width'].mixed ? 'mixed' : '';
  const note = el('mPaintNote');
  if (note) {
    /* NAME the disagreement rather than ringing every chip: with the targets
       split, no swatch is pressed — and "no swatch pressed" already means both
       "they disagree" and "it is a colour outside the palette", which on its own
       says nothing. The width field says it in its placeholder for the same
       reason. */
    const mixed = ['fill', 'stroke', 'stroke-width'].filter((k) => sums[k].mixed)
      .map((k) => (k === 'stroke-width' ? 'width' : k));
    note.textContent = targets.length
      ? 'Restyling ' + targets.length + ' selected shape' + (targets.length === 1 ? '' : 's')
        + (mixed.length ? ' · ' + mixed.join(' and ') + ' differ' + (mixed.length === 1 ? 's' : '') : '') + '.'
      : 'Nothing selected — the colours the next shape will use.';
  }
}
function applyPaint(prop, value) {
  const root = el('mPreview').querySelector('svg');
  const targets = (root && el('mMove').checked) ? paintTargets(root) : [];
  if (!targets.length) {                 // set the pen's colours instead
    drawPaint[prop] = value;
    renderPaintBar();
    return;
  }
  if (glyphEditBlocked('colours can’t be changed')) return;
  const before = el('mSvg').value;
  const want = prop === 'stroke-width' ? normalizePaintNumber(value) : normalizePaintValue(value);
  if (want == null) return;
  let wrote = 0;
  targets.forEach((e) => {
    if (effectivePaint(e, prop) === want && e.hasAttribute(prop)) return;   // already says exactly this
    e.setAttribute(prop, value);
    wrote++;
  });
  drawPaint[prop] = value;               // what you last chose is what you draw with next
  if (!wrote) { renderPaintBar(); return; }
  /* A style change touches attributes only, and ptsSig folds tag + delete-kind +
     point-kind — so the selection survives it by construction. */
  commitGlyphEdit(root, before);
  /* WebKit and Firefox/macOS do not focus a <button> on click, so after a swatch
     press the caret can still be in #mSvg (the source→canvas link puts it there)
     — and the modal keydown bails above the ⌘Z branch on that, with the
     textarea's own undo empty because the value was assigned programmatically.
     The undo entry just pushed would be unreachable. Same trap replaceGlyphSource
     and the Format button document. */
  focusPtCanvas();
  renderGlyphPts();
}

/* ---------------- state ---------------- */
/* Node frame style is FIXED app-wide: radius 8px, border 1.5px (category color). */
const SOCK_SNAP = 4;                    // px snap increment for socket positions
const DEF_OFF = [-12.5, 12.5];          // default input offsets from body center (a, b)
const DEFAULTS = { justify: 'center', scale: 1, dx: 0, dy: 0, width: 0, height: 0, text: 1 };
const state = { type: null, glyph: '', justify: 'center', scale: 1, dx: 0, dy: 0, width: 0, height: 0, text: 1, sockets: {} };
function defOffFor(key) { if (key === 'out') return 0; const n = NODE_BY_TYPE[state.type]; const i = n ? n.in.findIndex((x) => x[0] === key) : -1; return DEF_OFF[i] ?? 0; }
/* op body height: explicit designer height wins (glyph NOT scaled with it);
   auto = 52px base grown just enough to fit the glyph */
function opBodyH() { return state.height > 0 ? Math.max(28, state.height) : Math.max(52, Math.round(34 * state.scale) + 10); }
/* operator layout = glyph present + exactly two inputs (NodeVisual's rule) */
/* Mirrors NodeGlyph's `usesOperatorLayout` (glyph OR socket-growing, 2 base
   inputs) over the DRAFT glyph. Gating on the glyph alone left `append` — the
   one glyphless growing node — measured against the rows layout the stage no
   longer draws for it. */
function layoutIsOp() { const n = NODE_BY_TYPE[state.type]; return !!n && n.in.length === 2 && (!!state.glyph || !!n.grows); }
const ui = { zoom: parseFloat(lsGet('nd:zoom', '1')) || 1, panX: 0, panY: 0, bg: lsGet('nd:stageBg', '#FAFAFA') };
/* Baseline = the app's LIVE saved designs (bridge import), so even without the
   dev endpoint or a linked folder (e.g. the deployed copy) the designer shows
   what is actually shipped — the old page silently showed registry defaults.
   probeDevApi/loadSaved replace this with the on-disk file text when available. */
let savedGlyphs = ND.savedDesignsBaseline();
let sessionEdits = Object.create(null);                  // per-type WIP designs (stash; null-proto — probed with `in`)
/* Rehydrate onto a prototype-free object: this JSON comes from localStorage, so
   "__proto__"/"constructor" can arrive as own keys, and every read below is an
   `in` check that would otherwise walk the prototype chain. */
try { Object.assign(sessionEdits, JSON.parse(lsGet('nd:edits', '{}')) || {}); } catch (e) { sessionEdits = Object.create(null); }
Object.values(sessionEdits).forEach((d) => sanitizeDesign(d)); // strip pre-rework fields
const previews = Object.create(null);                    // per-type socket preview states (session only; null-proto — keyed by node type, see NODE_BY_TYPE)
let copyBuf = null;
let dirHandle = null;
let devApi = false;                                      // dev-server save endpoint reachable
const DEV_API = '/__nd';

/* preview model: ins[id] = {mode:'un'|'live'|'inf', ch, val} ; out = {on, ch} ;
   vals[key] = display value for defaults-only settings rows */
function previewFor(type) {
  if (previews[type]) return previews[type];
  const n = NODE_BY_TYPE[type];
  const p = { ins: {}, out: { on: true, ch: n.out[0] ? (LINE_COUNT[n.out[0][1]] || 1) : 1 }, vals: {} };
  n.in.forEach(([id, ty]) => { const dv = n.def && n.def[id] != null ? String(n.def[id]) : '0.1'; p.ins[id] = { mode: 'un', ch: LINE_COUNT[ty] || 1, val: dv }; });
  previews[type] = p; return p;
}

/* Inspector nudge bound: glyph-space ±28 for glyph nodes, ±400 CSS px for art
   nodes (an art element can need to travel across a 400px-wide node). */
// One bound for glyphs AND art. Glyphs used to be clamped to ±28 (half the 56
// canvas), which stopped a drag dead after ~25 screen px — "the art won't move
// freely" — and the shipped uv design sits exactly AT dy 28, i.e. the wall was
// already being hit. dx/dy are decorative-only offsets rendered with
// overflow:visible, so a generous shared bound is safe.
function inputNudgeLim() { return 400; }
function syncLayoutInputs() {
  const set = (id, v) => { const e = el(id); if (e) e.value = v; };
  set('gScale', state.scale); set('just', state.justify); set('nW', state.width); set('nH', state.height); set('nT', state.text); set('gDx', state.dx); set('gDy', state.dy);
  const lim = inputNudgeLim();
  ['gDx', 'gDy'].forEach((id) => { const e = el(id); if (e) { e.min = -lim; e.max = lim; } });
  const k = Object.keys(state.sockets);
  el('sockInfo').textContent = k.length ? k.map((x) => x + ' ' + (state.sockets[x] > 0 ? '+' : '') + state.sockets[x]).join(' · ') : 'default';
}

/* the diff that would be written for the current node ({} = registry default) */
function currentDesign() {
  const d = {}, b = builtinGlyph(state.type);
  // empty can't override built-in art in the app; art nodes never persist an
  // svg (belt-and-braces behind the openGlyph guard — a stale stash or
  // hand-edited nd:edits must not sneak one into a save)
  if (state.glyph && state.glyph !== b && !ND.ART_NODE_TYPES.has(state.type)) d.svg = state.glyph;
  if (state.justify !== DEFAULTS.justify) d.justify = state.justify;
  if (state.scale !== DEFAULTS.scale) d.scale = state.scale;
  if (state.dx !== DEFAULTS.dx) d.dx = state.dx;
  if (state.dy !== DEFAULTS.dy) d.dy = state.dy;
  if (state.width > 0) d.width = state.width;
  if (state.height > 0) d.height = state.height;
  if (state.text !== DEFAULTS.text) d.text = state.text;
  if (Object.keys(state.sockets).length) d.sockets = { ...state.sockets };
  return d;
}
/* the COMPLETE draft the React preview renders (unlike currentDesign's diff) */
function draftDesign() {
  const d = {
    justify: state.justify, scale: state.scale, dx: state.dx, dy: state.dy,
    text: state.text, sockets: { ...state.sockets },
  };
  if (state.glyph && !ND.ART_NODE_TYPES.has(state.type)) d.svg = state.glyph;
  if (state.width > 0) d.width = state.width;
  if (state.height > 0) d.height = state.height;
  return d;
}
function applyDesignTo(st, type, d) {
  const b = builtinGlyph(type);
  st.glyph = (d && d.svg != null) ? d.svg : b;
  st.justify = (d && d.justify) || DEFAULTS.justify;
  st.scale = (d && d.scale != null) ? d.scale : DEFAULTS.scale;
  st.dx = (d && typeof d.dx === 'number') ? d.dx : 0;
  st.dy = (d && typeof d.dy === 'number') ? d.dy : 0;
  st.width = (d && d.width != null) ? d.width : DEFAULTS.width;
  st.height = (d && d.height != null) ? d.height : DEFAULTS.height;
  st.text = (d && typeof d.text === 'number' && d.text > 0) ? d.text : DEFAULTS.text;
  st.sockets = (d && d.sockets && typeof d.sockets === 'object') ? { ...d.sockets } : {};
}
/* drop fields from older designer versions (frame style is fixed app-wide now) */
function sanitizeDesign(d) { if (d && typeof d === 'object') { delete d.radius; delete d.border; } return d; }
function isDirty(type) {
  if (!(type in sessionEdits)) return false;
  return JSON.stringify(sessionEdits[type]) !== JSON.stringify(savedGlyphs[type] || {});
}
/* A node counts as dirty when its DESIGN or its NAME differs from disk — the two
   ride different files and different save calls, but one pill and one Save. */
/* Gated on canRename(): in the download tier a pending rename cannot be written
   at all, so counting it as dirty would park an "N unsaved" pill that no Save can
   ever clear — and would block the glyph save behind it. The edit stays in
   localStorage and becomes dirty again the moment a writable tier is available. */
function labelDirty(type) { return !!type && canRename() && (type in labelEdits); }
function anyDirty(type) { return isDirty(type) || labelDirty(type); }
function dirtyTypes() {
  const out = Object.keys(sessionEdits).filter(isDirty);
  const seen = new Set(out);
  // labelDirty, not a bare `in` check: it carries the canRename() gate, and without it
  // the count disagreed with anyDirty() — the pill read "1 unsaved" and enabled Save All
  // in a tier that cannot write names, while the dropdown showed no ● and no Save could
  // ever clear it.
  Object.keys(labelEdits).forEach((t) => { if (!seen.has(t) && labelDirty(t)) { seen.add(t); out.push(t); } });
  return out;
}
function stash() {
  sessionEdits[state.type] = currentDesign();
  if (!isDirty(state.type)) delete sessionEdits[state.type]; // identical to saved → drop
  lsSet('nd:edits', JSON.stringify(sessionEdits));
  refreshDirtyUI();
}
/* Name counterpart of stash(): keep only the halves that actually DIFFER from
   disk, so an edit typed back to the original clears the dirty flag instead of
   leaving a phantom rename that would be POSTed as a no-op. */
function stashLabel(type, en, lv) {
  const e = {};
  if (en !== savedEn(type)) e.en = en;
  if (lv !== savedLv(type)) e.lv = lv;
  if (Object.keys(e).length) labelEdits[type] = e; else delete labelEdits[type];
  lsSet('nd:labelEdits', JSON.stringify(labelEdits));
  refreshDirtyUI();
}
function refreshDirtyUI() {
  const n = dirtyTypes().length;
  const pill = el('dirtyPill'); pill.textContent = n + ' unsaved'; pill.classList.toggle('show', n > 0);
  el('saveAllBtn').disabled = n === 0;
  el('dirtyFlag').style.display = anyDirty(state.type) ? '' : 'none';
  rebuildDropdown();
}

/* ---------------- name validation ----------------
   Blocking problems mirror assertValidNodeLabels (the same rules the endpoint and
   the folder-write path enforce) so the field says NO before a save can fail. */
function nameProblem(type, en) {
  const v = String(en == null ? '' : en);
  if (!v.trim()) return 'Name must not be empty.';
  if (v.trim() !== v) return 'Name has leading or trailing space.';
  if (/[\u200B-\u200D\u2060\u180E\uFEFF]/.test(v)) return 'Name contains an invisible character.';
  const fold = v.toLowerCase();
  /* Check against EVERY labelled definition, not just the designable ones.
     NODES is designerNodes() — the 59 ShaderNode-rendered types — but the writers
     validate against all 74 label slots, so a collision with one of the 15 excluded
     labels ("Time", "Color", "Sine", "Output", "Perlin Noise", "Microphone"…) passed
     this field and then 400'd at save time, aborting the whole save including any
     glyph work in the same batch. savedLabels is the endpoint's full 74-slot map;
     fall back to NODES only before it has loaded. */
  const all = allLabelledTypes();
  for (let i = 0; i < all.length; i++) {
    const other = all[i];
    if (other === type) continue;
    // Case-insensitive: nodeMatchRank lowercases before matching, so "Multiply"
    // and "multiply" collide in search while looking distinct here.
    if (labelEn(other).toLowerCase() === fold) return 'Already the name of "' + other + '".';
  }
  return '';
}
/* Non-blocking. nodeSearch.test.ts asserts that no node can be outranked by
   another node's PROSE mentioning its name; renaming onto a word that appears in
   someone else's description is exactly what trips it, and the failure lands in a
   test file far from here. Say so at the point of the edit instead. */
/** Every labelled registry type, not just the designable ones (see nameProblem). */
function allLabelledTypes() {
  return Object.keys(savedLabels).length ? Object.keys(savedLabels) : NODES.map((n) => n.type);
}
function nameWarning(type, en) {
  const fold = String(en == null ? '' : en).trim().toLowerCase();
  if (!fold) return '';
  /* nodeMatchRank's top tier is FOUR names per node - label, type, tslFunction and the
     Latvian label - so a new label equal to another node's type or TSL function ties at
     rank 0 and registry order alone decides who wins the query. Renaming Multiply to
     "Sin" really does put Multiply above the Sine node for "sin".
     A WARNING rather than a refusal, because such ties are legitimate and already exist:
     Slider's tslFunction IS `float`, so it ties with the Float node today, and
     nodeSearch.test.ts documents that as correct ("Slider really is a float node").
     Scanned over ALL labelled types: `sin`, `time`, `color`, `output` and the noise
     family render through their own components and are absent from NODES, yet those
     short identifiers are exactly what a shortened display name lands on. */
  const all = allLabelledTypes();
  for (let i = 0; i < all.length; i++) {
    const other = all[i];
    if (other === type) continue;
    const def = ND.definitionOf(other);
    if (!def) continue;
    if (other.toLowerCase() === fold) {
      return 'Ties with the "' + other + '" node type in search - registry order decides which wins.';
    }
    if (def.tslFunction && String(def.tslFunction).toLowerCase() === fold) {
      return 'Ties with "' + other + '" TSL function `' + def.tslFunction + '` in search.';
    }
    const lv = labelLv(other);
    if (lv && lv.toLowerCase() === fold) {
      return 'Ties with the Latvian name of "' + other + '" in search.';
    }
  }
  if (fold.length < 4) return '';
  for (let i = 0; i < all.length; i++) {
    const other = all[i];
    if (other === type) continue;
    const def = ND.definitionOf(other);
    const desc = (def && def.description) || '';
    if (desc.toLowerCase().indexOf(fold) >= 0) {
      return '"' + other + '" mentions this word in its description - search may rank it above this node (nodeSearch.test.ts covers that).';
    }
  }
  return '';
}
/** Can names be written at all from here? Registry SOURCE needs the dev endpoint
 *  or a linked repo folder; the download tier has no source text to splice. */
function canRename() { return labelApi || !!dirHandle; }

/* ---------------- selection / dropdown / search ---------------- */
let filterText = '';
function visibleNodes() {
  const q = filterText.trim().toLowerCase();
  // labelEn/labelLv, not n.label — a node renamed this session must be findable
  // by its NEW name, and its old one must stop matching.
  return q ? NODES.filter((n) => n.type.toLowerCase().includes(q) || labelEn(n.type).toLowerCase().includes(q) || labelLv(n.type).toLowerCase().includes(q)) : NODES;
}
function rebuildDropdown() {
  const sel = el('nodeSel'); const cur = state.type; sel.innerHTML = '';
  const groups = {}; visibleNodes().forEach((n) => { (groups[n.cat] = groups[n.cat] || []).push(n); });
  Object.keys(groups).forEach((cat) => {
    const og = document.createElement('optgroup'); og.label = ndCatLabel(cat);
    groups[cat].forEach((n) => {
      const o = document.createElement('option'); o.value = n.type;
      const mark = anyDirty(n.type) ? '● ' : (savedGlyphs[n.type] ? '◆ ' : '');
      o.textContent = mark + ndBaseLabel(n.type) + ' (' + n.type + ')'; og.appendChild(o);
    });
    sel.appendChild(og);
  });
  if (cur && sel.querySelector('option[value="' + cur + '"]')) sel.value = cur;
}
function stepNode(dir) {
  const list = visibleNodes().map((n) => n.type); if (!list.length) return;
  let i = list.indexOf(state.type); i = (i < 0 ? 0 : (i + dir + list.length) % list.length);
  selectNode(list[i]);
}
function selectNode(type) {
  const n = NODE_BY_TYPE[type]; if (!n) return; state.type = type; sockRaw = {}; lsSet('nd:lastNode', type);
  const d = (type in sessionEdits) ? sessionEdits[type] : (savedGlyphs[type] || null);
  applyDesignTo(state, type, d);
  previewFor(type);
  const sel = el('nodeSel'); if (sel.value !== type && sel.querySelector('option[value="' + type + '"]')) sel.value = type;
  syncLayoutInputs(); renderInfo(); renderStates(); renderNode(); renderGlyphCard(); refreshDirtyUI();
}

/* ---------------- inspector rendering ---------------- */
function renderInfo() {
  const n = NODE_BY_TYPE[state.type]; const cat = ND.categoryHex(n.cat); const cost = COSTS[state.type] ?? 0;
  el('iType').textContent = n.type;
  const ic = el('iCat'); ic.querySelector('.dot').style.background = cat; ic.querySelector('span:last-child').textContent = ndCatLabel(n.cat);
  const io = el('iCost'); io.querySelector('.dot').style.background = costColor(cost); io.querySelector('span:last-child').textContent = cost + ' pts';
  el('pasteBtn').disabled = !copyBuf;
  syncNameInputs();
}
/* Push the model into the Name fields. Guarded on document.activeElement so a
   re-render triggered BY typing (the live preview re-renders on every keystroke)
   cannot rewrite the box under the caret and jump it to the end. */
let nameInputsType = null;   // which node the Name boxes currently show
function syncNameInputs() {
  const en = el('nName'); const lv = el('nNameLv');
  if (!en || !lv) return;
  const ok = canRename();
  /* The activeElement guard exists so a re-render triggered BY typing cannot rewrite the
     box under the caret. It must NOT suppress a SELECTION change: Alt+↑/↓ steps nodes
     with no typing-guard, so it fires from inside the focused Name field, and the box
     then kept the previous node's text while state.type, the stage and the LV box all
     moved on — the next keystroke stashed that text onto the NEW node and Save spliced
     it into the wrong label slot. When the node changes, both boxes are authoritative. */
  const switched = nameInputsType !== state.type;
  nameInputsType = state.type;
  if (switched || document.activeElement !== en) en.value = labelEn(state.type);
  if (switched || document.activeElement !== lv) lv.value = labelLv(state.type);
  en.disabled = !ok; lv.disabled = !ok;
  if (!ok) {
    en.title = lv.title = 'Renaming edits registry SOURCE (nodeRegistry.ts / node-i18n.json), so it needs the dev server (npm run dev) or a linked repo folder — a downloaded file cannot carry it.';
  } else {
    en.title = 'The node’s English display name (nodeRegistry.ts `label`). Display only — it never reaches generated code, a saved .fastshader, or any lookup.';
    lv.title = 'The Latvian display name (src/i18n/node-i18n.json). Empty = untranslated, which falls back to the English name.';
  }
  renderNameHint();
}
function renderNameHint() {
  const box = el('nameHint'); if (!box) return;
  const bad = canRename() ? nameProblem(state.type, labelEn(state.type)) : '';
  const warn = bad ? '' : (canRename() ? nameWarning(state.type, labelEn(state.type)) : '');
  const msg = bad || warn;
  box.textContent = msg;
  box.classList.toggle('bad', !!bad);
  box.style.display = msg ? '' : 'none';
}
function renderStates() {
  const n = NODE_BY_TYPE[state.type]; const p = previewFor(state.type); const box = el('stateList'); box.innerHTML = '';
  if (!n.in.length) { const d = document.createElement('div'); d.className = 'hintline'; d.style.margin = '0'; d.textContent = 'No input sockets.'; box.appendChild(d); }
  n.in.forEach(([id, ty]) => {
    const s = p.ins[id]; const r = document.createElement('div'); r.className = 'pstate';
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = ND.typeColor(ty); r.appendChild(dot);
    const l = document.createElement('label'); l.textContent = id; l.title = id + ' : ' + ty; r.appendChild(l);
    const mode = document.createElement('select'); mode.className = 'mode';
    [['un', 'unconnected'], ['live', 'connected · live'], ['inf', 'connected · range']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; mode.appendChild(o); });
    mode.value = s.mode; mode.onchange = () => { s.mode = mode.value; ch.disabled = s.mode === 'un'; renderNode(); }; r.appendChild(mode);
    const ch = document.createElement('select'); ch.className = 'ch'; ch.title = 'channels';
    [1, 2, 3, 4].forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c + 'ch'; ch.appendChild(o); });
    ch.value = s.ch; ch.disabled = s.mode === 'un'; ch.onchange = () => { s.ch = +ch.value; renderNode(); }; r.appendChild(ch);
    const v = document.createElement('input'); v.className = 'pv'; v.type = 'text'; v.value = s.val; v.title = 'preview value / range text';
    v.oninput = () => { s.val = v.value; renderNode(); }; r.appendChild(v);
    box.appendChild(r);
  });
  if (n.out.length) {
    const o0 = n.out[0]; const p2 = p.out; const r = document.createElement('div'); r.className = 'pstate'; r.style.marginTop = '8px';
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = ND.typeColor(o0[1]); r.appendChild(dot);
    const l = document.createElement('label'); l.textContent = 'out'; l.title = 'output · no label, ever'; r.appendChild(l);
    const cb = document.createElement('select'); cb.className = 'mode';
    [['1', 'connected'], ['0', 'unconnected']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; cb.appendChild(o); });
    cb.value = p2.on ? '1' : '0'; cb.onchange = () => { p2.on = cb.value === '1'; ch2.disabled = !p2.on; renderNode(); }; r.appendChild(cb);
    const ch2 = document.createElement('select'); ch2.className = 'ch';
    [1, 2, 3, 4].forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = c + 'ch'; ch2.appendChild(o); });
    ch2.value = p2.ch; ch2.disabled = !p2.on; ch2.onchange = () => { p2.ch = +ch2.value; renderNode(); }; r.appendChild(ch2);
    box.appendChild(r);
  }
}
function renderGlyphCard() {
  const card = el('glyphCard');
  card.innerHTML = state.glyph
    ? '<svg viewBox="0 0 56 56" width="56" height="56" style="overflow:visible">' + state.glyph + '</svg>'
    : '<svg viewBox="0 0 56 56" width="56" height="56"><text x="28" y="32" text-anchor="middle" fill="#aaa" style="font:11px Inter">empty</text></svg>';
  if (state.dx || state.dy) { const t = document.createElement('span'); t.className = 'nudge-tag'; t.textContent = 'nudge ' + state.dx + ',' + state.dy; card.appendChild(t); }
}

/* ---------------- stage: the REAL renderer draws the node ----------------
   renderNode() hands the draft + preview states to the React bridge, which
   renders NodeVisual — the exact component behind the asset cards and the
   node-editor overview, which itself mirrors the live ShaderNode per
   NODE_DESIGN_REQUIREMENTS. onRendered → layoutOverlays() re-measures the
   vanilla-owned overlays (corner resize handle, snap-ruler alignment, stubs). */
function cycleIn(id) { const s = previewFor(state.type).ins[id]; s.mode = s.mode === 'un' ? 'live' : s.mode === 'live' ? 'inf' : 'un'; renderStates(); renderNode(); }
function toggleOut() { const p = previewFor(state.type).out; p.on = !p.on; renderStates(); renderNode(); }

function renderNode() {
  const n = NODE_BY_TYPE[state.type]; if (!n) return;
  const p = previewFor(state.type);
  const ins = {};
  const values = { ...(p.vals || {}) };
  n.in.forEach(([id]) => {
    const s = p.ins[id];
    ins[id] = { mode: s.mode, ch: s.ch, val: s.val };
    const num = parseFloat(s.val);
    values[id] = Number.isFinite(num) ? num : 0;
  });
  ND.renderNodePreview(el('ndNode'), {
    type: state.type,
    design: draftDesign(),
    ins: ins,
    headerText: state.type === 'property_float'
      ? String((n.def && n.def.name) || 'property1')
      : ndNodeLabel(state.type),
    values: values,
    snapCol: sockDrag ? (sockDrag.key === 'out' ? 'r' : 'l') : null,
    onValueChange: (key, v) => {
      const s = p.ins[key];
      if (s) s.val = String(v); else p.vals[key] = v;
      renderNode(); // controlled widgets — the model change must render back
      renderStates();
    },
    onRendered: layoutOverlays,
  });
}

/* Position the vanilla overlays against the React-rendered card. Runs after
   every React commit and on zoom changes. All maths in nodeWrap-local px:
   screen = wrapLeft + local × zoom (the cost scale lives INSIDE the card's
   wrapper, so card rects already include it). */
function layoutOverlays() {
  const wrap = el('nodeWrap'); const card = wrap.querySelector('.node-base'); const rz = el('ndResize');
  if (!card) { if (rz) rz.style.display = 'none'; return; }
  const z = ui.zoom || 1;
  const wB = wrap.getBoundingClientRect(); const cB = card.getBoundingClientRect();
  if (rz) {
    rz.style.display = '';
    rz.style.left = ((cB.right - wB.left) / z - 7) + 'px';
    rz.style.top = ((cB.bottom - wB.top) / z - 7) + 'px';
  }
  const col = wrap.querySelector('.nd-snapcol');
  if (col) col.style.backgroundPosition = '0 ' + ((col.offsetHeight / 2) % SOCK_SNAP) + 'px';
  renderEdges();
}

/* ---------------- edge stubs (mirrors TypedEdge multi-channel rendering) ---------------- */
function rAFEdges() { requestAnimationFrame(renderEdges); }
function renderEdges() {
  const wrap = el('nodeWrap'); const node = wrap.querySelector('.node-base'); if (!node) return;
  let svg = wrap.querySelector('.stubs');
  if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'stubs'); wrap.insertBefore(svg, wrap.firstChild); }
  const wB = wrap.getBoundingClientRect(); if (wB.width === 0) return;
  const z = ui.zoom || 1;
  const W = wB.width / z + 180, H = wB.height / z + 180;
  svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  let out = '';
  const p = previewFor(state.type);
  const line = (x0, y0, x1, y1, ch) => {
    const colors = ch === 1 ? [contrast(ui.bg)] : (COUNT_EDGE_COLORS[ch] || ['#000']);
    const w = ch >= 4 ? 0.8 : ch >= 3 ? 1 : ch >= 2 ? 1.2 : 1.5;
    const half = (ch - 1) / 2; let s = '';
    for (let i = 0; i < ch; i++) {
      const off = (i - half) * EDGE_GAP;
      s += '<line x1="' + x0 + '" y1="' + (y0 + off) + '" x2="' + x1 + '" y2="' + (y1 + off) + '" stroke="' + colors[i] + '" stroke-width="' + w + '"' + (ch > 1 ? ' stroke-dasharray="4 0.5"' : '') + ' opacity="0.9"/>';
    }
    return s;
  };
  wrap.querySelectorAll('.typed-handle[data-port]').forEach((sock) => {
    const sB = sock.getBoundingClientRect();
    const cx = (sB.left + sB.width / 2 - wB.left) / z + 90, cy = (sB.top + sB.height / 2 - wB.top) / z + 90;
    if (sock.dataset.io === 'in') {
      const s = p.ins[sock.dataset.port];
      if (s && s.mode !== 'un') out += line(cx - STUB_LEN, cy, cx - 3, cy, s.ch);
    } else {
      if (p.out.on) out += line(cx + 3, cy, cx + STUB_LEN, cy, p.out.ch);
    }
  });
  svg.innerHTML = out;
}

/* ---------------- stage gestures (delegated onto the React-rendered card) ----------------
   The React replica owns the DOM; the designer identifies targets by the
   replica's data attributes and NEVER mutates its tree — every gesture edits
   the model (state/previews) and re-renders. Guards skip anything the real
   widgets own (DragNumberInput, the slider, colour swatches). */

/* glyph / art drag-to-nudge; plain click on a GLYPH opens the SVG editor.
   Glyph dx/dy are glyph-space units (px ÷ svg-px-per-unit); ART (the colormap
   ramp) nudges in plain CSS px — same fields, page-space element. */
let glyphDrag = null;
function onGlyphDown(e, target, isArt) {
  e.preventDefault(); e.stopPropagation();
  /* pxPerUnit converts SCREEN px → design units. Glyph: the rendered svg's
     rect already folds in zoom + cost scale (screen px per 56-space unit).
     Art (the colormap ramp): units ARE element-local CSS px, so divide by
     zoom × cost scale explicitly. Both share the ±400 clamp (nudgeLim). */
  let pxPerUnit;
  if (isArt) {
    pxPerUnit = (ui.zoom || 1) * costScaleOf(COSTS[state.type] ?? 0);
  } else {
    const svg = target.querySelector('svg'); if (!svg) return;
    pxPerUnit = svg.getBoundingClientRect().width / 56;
    if (!pxPerUnit) return;
  }
  glyphDrag = { x: e.clientX, y: e.clientY, dx0: state.dx, dy0: state.dy, pxPerUnit: pxPerUnit, moved: false, isArt: isArt };
  window.addEventListener('pointermove', onGlyphMove);
  window.addEventListener('pointerup', endGlyphMove);
  window.addEventListener('pointercancel', cancelGlyphMove);
}
/* One generous bound for both (matches inputNudgeLim): the old glyph-space
   ±28 clamp stopped a drag after ~25 screen px at default scale. */
function nudgeLim() { return 400; }
function onGlyphMove(e) {
  if (!glyphDrag) return;
  const mx = e.clientX - glyphDrag.x, my = e.clientY - glyphDrag.y;
  if (!glyphDrag.moved && Math.hypot(mx, my) < 3) return;
  glyphDrag.moved = true;
  const lim = nudgeLim();
  state.dx = Math.max(-lim, Math.min(lim, Math.round((glyphDrag.dx0 + mx / glyphDrag.pxPerUnit) * 2) / 2));
  state.dy = Math.max(-lim, Math.min(lim, Math.round((glyphDrag.dy0 + my / glyphDrag.pxPerUnit) * 2) / 2));
  syncLayoutInputs(); renderNode();
}
function unbindGlyphMove() {
  window.removeEventListener('pointermove', onGlyphMove);
  window.removeEventListener('pointerup', endGlyphMove);
  window.removeEventListener('pointercancel', cancelGlyphMove);
}
/* A cancelled pointer (second-finger gesture takeover, pen cancel) never
   fires pointerup — without this the window-level drag stays armed and every
   later pointermove keeps slamming dx/dy around with no button held. Old
   page had the same guard (drag = null on pointercancel); no stash, no
   editor open — the gesture is simply abandoned. */
function cancelGlyphMove() {
  glyphDrag = null;
  unbindGlyphMove();
  syncLayoutInputs(); renderNode();
}
function endGlyphMove() {
  const d = glyphDrag; glyphDrag = null;
  unbindGlyphMove();
  if (!d) return;
  if (d.moved) { stash(); renderNode(); renderGlyphCard(); }
  else if (!d.isArt) openGlyph();
}

/* ------- sockets: drag ↕ along the border (4px snap); plain click = cycle -------
   Operator layout: inputs + output, offsets from the body center.
   Rows layout: the FIRST OUTPUT is movable too — dragging detaches it from its
   row and anchors it to the below-header region's center. Rows overrides
   persist even at 0 (0 = region center ≠ the row default); "Reset positions"
   restores row anchoring. */
/* A socket's CURRENT visual offset from the region centre, in state units.
   Shared by the socket drag (so grabbing one never jumps) and the corner
   resize (so a row-anchored socket detaches exactly where it already sits).
   Divides by z * cs — the cost scale is inside the card's own wrapper. */
function measuredSockOff(sockEl, regionEl) {
  if (!sockEl || !regionEl) return null;
  const cs = costScaleOf(COSTS[state.type] ?? 0), z = ui.zoom || 1;
  const sb = sockEl.getBoundingClientRect(), rb = regionEl.getBoundingClientRect();
  return ((sb.top + sb.height / 2) - (rb.top + rb.height / 2)) / (z * cs);
}

/* Every socket the designer is allowed to author, with its EFFECTIVE offset
   right now: the stored value, else the operator default, else — for a
   row-anchored socket — where it is actually drawn. Keys mirror onSockDown:
   input ids plus 'out' for the FIRST output only. */
function effectiveSockOffsets() {
  const n = NODE_BY_TYPE[state.type];
  if (!n) return {};
  const rows = !layoutIsOp();
  const regionEl = rows ? el('nodeWrap').querySelector('.shader-node__region') : null;
  const out = {};
  const keys = n.in.map((x) => x[0]);
  if (n.out[0]) keys.push('out');
  for (const key of keys) {
    if (state.sockets[key] != null) { out[key] = state.sockets[key]; continue; }
    if (rows) {
      const sel = key === 'out'
        ? ".typed-handle[data-port][data-io='out']"
        : ".typed-handle[data-port='" + key + "']";
      const m = measuredSockOff(el('nodeWrap').querySelector(sel), regionEl);
      if (m != null) { out[key] = m; continue; }
    }
    out[key] = defOffFor(key);
  }
  return out;
}

/* Session-only EXACT (unsnapped) offsets, so repeated corner drags don't
   random-walk off the 4px grid: snapping every pointerup would turn
   20 → 16 → 20 → 24 across a grow/shrink/grow. Never saved, never part of a
   design — rebased whenever a socket is authored by another path. */
let sockRaw = {};

let sockDrag = null;
function onSockDown(e, sock) {
  if (e.button !== 0) return;
  const n = NODE_BY_TYPE[state.type];
  const io = sock.dataset.io, port = sock.dataset.port;
  /* only the first output is movable/toggleable (split's x/y/z/w stay put) */
  if (io === 'out' && (!n.out[0] || port !== n.out[0][0])) return;
  const key = io === 'out' ? 'out' : port;
  e.preventDefault(); e.stopPropagation();
  const rows = !layoutIsOp();
  const cs = costScaleOf(COSTS[state.type] ?? 0), z = ui.zoom || 1;
  const regionEl = rows ? el('nodeWrap').querySelector('.shader-node__region') : null;
  let off0;
  if (state.sockets[key] != null) off0 = state.sockets[key];
  else if (rows && regionEl) {
    off0 = measuredSockOff(sock, regionEl); // current visual spot → no jump on grab
    if (off0 == null) off0 = defOffFor(key);
  } else off0 = defOffFor(key);
  const limH = rows ? (regionEl ? regionEl.getBoundingClientRect().height / (z * cs) : 52) : opBodyH();
  sockDrag = { key, y0: e.clientY, off0, limH, rows, moved: false };
  window.addEventListener('pointermove', onSockMove);
  window.addEventListener('pointerup', endSockMove);
  window.addEventListener('pointercancel', cancelSockMove);
  renderNode(); // mounts the snap ruler
}
/* Same abandoned-gesture guard as the glyph drag (the old page lacked it here
   too, but a stuck window drag on iPad is exactly the failure this tool's
   platform invites). No stash, no click fallback — just unmount the ruler. */
function cancelSockMove() {
  sockDrag = null;
  window.removeEventListener('pointermove', onSockMove);
  window.removeEventListener('pointerup', endSockMove);
  window.removeEventListener('pointercancel', cancelSockMove);
  syncLayoutInputs(); renderNode();
}
function onSockMove(e) {
  if (!sockDrag) return;
  const cs = costScaleOf(COSTS[state.type] ?? 0), z = ui.zoom || 1;
  const dy = (e.clientY - sockDrag.y0) / (z * cs);
  if (!sockDrag.moved && Math.abs(dy) < 3) return;
  sockDrag.moved = true;
  const lim = Math.floor((sockDrag.limH / 2 - 5) / SOCK_SNAP) * SOCK_SNAP; // clamp stays on the snap grid
  let off = Math.round((sockDrag.off0 + dy) / SOCK_SNAP) * SOCK_SNAP;
  off = Math.max(-lim, Math.min(lim, off));
  if (!sockDrag.rows && off === defOffFor(sockDrag.key)) delete state.sockets[sockDrag.key];
  else state.sockets[sockDrag.key] = off;
  syncLayoutInputs(); renderNode();
}
function endSockMove() {
  const d = sockDrag; sockDrag = null;
  window.removeEventListener('pointermove', onSockMove);
  window.removeEventListener('pointerup', endSockMove);
  window.removeEventListener('pointercancel', cancelSockMove);
  if (!d) return;
  if (d.moved) { sockRaw[d.key] = state.sockets[d.key]; stash(); renderNode(); }
  else {
    renderNode(); // unmount the snap ruler
    if (d.key === 'out') toggleOut();
    else cycleIn(d.key);
  }
}

/* ------- corner handle: drag → width, ↕ → HEIGHT (the glyph never scales
   with the node — glyph size is its own `scale` control) ------- */
let scaleDrag = null;
function startScale(e) {
  e.preventDefault(); e.stopPropagation();
  const card = el('nodeWrap').querySelector('.node-base');
  const header = card ? card.querySelector('.node-base__header') : null;
  const h0 = state.height > 0 ? state.height
    : (card ? Math.max(28, card.offsetHeight - (header ? header.offsetHeight : 14) - 3) : 52); // minus actual (wrappable) header + borders
  // Seed the socket rescale from what is on screen RIGHT NOW: the stored
  // value, the operator default, or — for a row-anchored socket — its measured
  // spot, so it detaches without jumping. `s0raw` prefers the session's exact
  // (unsnapped) shadow so a second drag continues from the true number rather
  // than from the grid it was last rounded to. `sock0` is the undo snapshot.
  const eff = effectiveSockOffsets();
  const s0raw = {};
  for (const k of Object.keys(eff)) s0raw[k] = sockRaw[k] != null ? sockRaw[k] : eff[k];
  scaleDrag = {
    x0: e.clientX, y0: e.clientY,
    h0,
    w0: state.width || (card ? card.offsetWidth : 96),
    s0: eff,
    s0raw,
    sock0: { ...state.sockets },
  };
  e.currentTarget.setPointerCapture(e.pointerId);
  window.addEventListener('pointermove', onScale); window.addEventListener('pointerup', endScale);
  window.addEventListener('pointercancel', cancelScale);
}
function cancelScale() {
  // A cancelled gesture must UNDO, not merely stop: this handler used to leave
  // height/width wherever the pointer died, which was survivable — but it now
  // also leaves a fully rewritten socket map, so one stray pointercancel (an
  // iPad second finger) would silently re-author the node with no way back.
  const d = scaleDrag; scaleDrag = null;
  window.removeEventListener('pointermove', onScale);
  window.removeEventListener('pointerup', endScale);
  window.removeEventListener('pointercancel', cancelScale);
  if (d) {
    state.height = d.h0; state.width = d.w0; state.sockets = d.sock0;
    syncLayoutInputs(); renderNode();
  }
}
function onScale(e) {
  if (!scaleDrag) return; const z = ui.zoom || 1;
  let h = Math.round(scaleDrag.h0 + (e.clientY - scaleDrag.y0) / z); h = Math.max(28, Math.min(1200, h)); state.height = h;
  let w = Math.round(scaleDrag.w0 + (e.clientX - scaleDrag.x0) / z); w = Math.max(24, Math.min(400, w)); state.width = w;
  // Sockets travel WITH the frame: without this the ports stay a fixed px from
  // the body centre, so a growing node opens dead space around a knot of
  // sockets that never spreads (and a row-anchored one does not move at all).
  // Gated on a real height change, so a width-only drag leaves them untouched;
  // always derived from the pointerdown snapshot, so the gesture cannot drift.
  if (h !== scaleDrag.h0) {
    const k = h / scaleDrag.h0;
    state.sockets = { ...state.sockets, ...scaleSocketOffsets(scaleDrag.s0, scaleDrag.h0, h) };
    sockRaw = { ...sockRaw, ...scaleSocketOffsetsRaw(scaleDrag.s0raw, k) };
  }
  syncLayoutInputs(); renderNode();
}
function endScale() { if (scaleDrag) { scaleDrag = null; stash(); } window.removeEventListener('pointermove', onScale); window.removeEventListener('pointerup', endScale); window.removeEventListener('pointercancel', cancelScale); }

(function bindStageGestures() {
  const wrap = el('nodeWrap');
  wrap.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    /* the real widgets own their events (scrub/type/slide) */
    if (t.closest('.drag-num') || t.closest('input') || t.closest('select') || t.closest('textarea')) return;
    const sock = t.closest('.typed-handle[data-port]');
    if (sock) { onSockDown(e, sock); return; }
    const art = t.closest('[data-nd-art]');
    if (art) { onGlyphDown(e, art, true); return; }
    const glyph = t.closest('[data-nd-glyph]');
    if (glyph) { onGlyphDown(e, glyph, false); return; }
  });
  el('ndResize').addEventListener('pointerdown', startScale);
})();

/* ---------------- stage pan / zoom / bg ---------------- */
function applyView() {
  el('panzoom').style.transform = 'translate(' + ui.panX + 'px,' + ui.panY + 'px) scale(' + ui.zoom + ')';
  el('zVal').textContent = Math.round(ui.zoom * 100) + '%';
  lsSet('nd:zoom', String(ui.zoom));
}
function applyBg() {
  const stage = el('stage'); const dot = contrast(ui.bg) === '#000000' ? 'rgba(0,0,0,.16)' : 'rgba(255,255,255,.2)';
  stage.style.background = 'radial-gradient(circle,' + dot + ' 1px,transparent 1px) 0 0/18px 18px,' + ui.bg;
  el('bgInput').value = ui.bg; lsSet('nd:stageBg', ui.bg);
  /* cost badge + 1ch edges auto-contrast against the canvas, like the app:
     the SAME CSS-var mechanism NodeBase.css uses inside .react-flow */
  const wrap = el('nodeWrap');
  const c = contrast(ui.bg);
  wrap.style.setProperty('--node-cost-text', c);
  wrap.style.setProperty('--node-cost-text-shadow', c === '#000000' ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.6)');
  renderNode(); // badge + 1ch edge contrast flip
}
function setZoom(z) { ui.zoom = Math.max(0.5, Math.min(6, z)); applyView(); rAFEdges(); }
(function initStage() {
  const vp = el('viewport'); let pan = null;
  vp.addEventListener('pointerdown', (e) => {
    if (e.target !== vp && e.target !== el('panzoom')) return;
    pan = { x: e.clientX, y: e.clientY, px: ui.panX, py: ui.panY }; vp.classList.add('panning'); vp.setPointerCapture(e.pointerId);
  });
  vp.addEventListener('pointermove', (e) => { if (!pan) return; ui.panX = pan.px + (e.clientX - pan.x); ui.panY = pan.py + (e.clientY - pan.y); applyView(); });
  const end = () => { pan = null; vp.classList.remove('panning'); };
  vp.addEventListener('pointerup', end); vp.addEventListener('pointercancel', end);
  el('stage').addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) setZoom(ui.zoom * Math.exp(-e.deltaY * 0.0018));
    else { ui.panX -= e.deltaX; ui.panY -= e.deltaY; applyView(); }
  }, { passive: false });
  el('zIn').onclick = () => setZoom(ui.zoom * 1.2);
  el('zOut').onclick = () => setZoom(ui.zoom / 1.2);
  el('zVal').onclick = () => { ui.panX = 0; ui.panY = 0; setZoom(1); };
  el('bgInput').oninput = (e) => { ui.bg = e.target.value; applyBg(); };
  el('bgReset').onclick = () => { ui.bg = '#FAFAFA'; applyBg(); };
})();

/* ---------------- glyph modal ---------------- */
const overlay = el('overlay');
/* "load art from…" dropdown: pull any existing glyph into the editor —
   saved/session custom designs first, then every built-in. Rebuilt on each
   open so it always reflects the latest saves. Loading only fills the
   textarea/preview; nothing sticks until Apply. */
function populateLoadList() {
  const sel = el('mLoad'); if (!sel) return;
  sel.innerHTML = '<option value="">load art from…</option>';
  const addGroup = (label, items) => {
    if (!items.length) return;
    const og = document.createElement('optgroup'); og.label = label;
    items.forEach((it) => { const o = document.createElement('option'); o.value = it[0]; o.textContent = it[1]; og.appendChild(o); });
    sel.appendChild(og);
  };
  const custom = [], builtins = [];
  NODES.forEach((n) => {
    const t = n.type;
    const d = (t in sessionEdits) ? sessionEdits[t] : savedGlyphs[t];
    if (d && d.svg) custom.push(['c:' + t, ndBaseLabel(t) + ' (' + t + ')' + (t === state.type ? ' — current' : '')]);
    if (builtinGlyph(t)) builtins.push(['b:' + t, ndBaseLabel(t) + ' (' + t + ')']);
  });
  addGroup('Saved / session designs', custom);
  addGroup('Built-in glyphs', builtins);
}
/* The ONE path for replacing the WHOLE document (Clear / Built-in / Load /
   Upload / .svg drop). Writing .value by hand fires no `input` event, so the
   listener that drops stale point snapshots never ran: drag a point (snapshot
   pushed), press Built-in, hit ⌘Z — and the box came back holding neither the
   built-in art nor the dragged art, but the PRE-drag version, under a toast
   claiming "Undid the last point edit."
   The answer is to PUSH the outgoing document, not to drop the stack. Clearing
   it made ⌘Z answer "nothing to undo — this stack holds point gestures only"
   immediately after a run of real point gestures, which is simply false, and
   left Cancel — which throws the whole modal session away, including the work
   the user wanted — as the only recovery from a mis-clicked Clear (a mini button
   one slot from Built-in, two from Copy SVG).
   No new mechanism is needed: the stack already holds whole #mSvg strings and
   undoGlyphEdit already restores one wholesale and clears the selection, so a
   document-level replacement is exactly the shape it handles. The stack is still
   cleared on the TEXTAREA input path (those snapshots describe a document the
   user has since retyped, and the browser's own undo covers typing) and by
   openGlyph (the history belongs to ONE glyph session). */
function replaceGlyphSource(text) {
  const before = el('mSvg').value;
  clearGlyphSel();
  /* AFTER the write, never before: pushGlyphUndo drops no-op entries by comparing
     `before` against the LIVE value, so pushing first would always self-cancel —
     and pushing after is what makes "Clear on an already-empty box" leave no
     entry. It also clears nudgeRun, so no held-arrow run can ride a snapshot that
     describes replaced art. */
  el('mSvg').value = text;
  pushGlyphUndo(before);
  /* Hand the keyboard to the canvas, or the entry just pushed is UNREACHABLE:
     the modal keydown handler bails at `if (caret) return;` before the ⌘Z
     branch, and the textarea's own native undo is empty because the value was
     assigned programmatically — so ⌘Z is a dead key and Cancel (which throws the
     whole session away) is the only recovery left. openGlyph parks the caret in
     #mSvg and a file drop on a <div> moves focus nowhere, so the DROP path sat
     in exactly that state; Clear / Built-in / Load / Upload escaped it only by
     accident, each having put focus on its own button or select first.
     Doing it here covers all five callers uniformly (a no-op for the four whose
     focus is already off the textarea). Nothing is lost: replacing the whole
     document is not a text-entry gesture. */
  focusPtCanvas();                       // must not scroll — see focusPtCanvas
  refreshMPreview();
}
el('mLoad').onchange = (e) => {
  const v = e.target.value; e.target.value = '';
  if (!v) return;
  const t = v.slice(2);
  let art = '';
  if (v[0] === 'c') { const d = (t in sessionEdits) ? sessionEdits[t] : savedGlyphs[t]; art = (d && d.svg) || ''; }
  else art = builtinGlyph(t);
  if (!art) { toast('No art found for "' + t + '".'); return; }
  replaceGlyphSource(art);
  toast('Loaded "' + t + '" art — Apply to keep it.');
};
function openGlyph() {
  /* ART nodes must stay glyph-less — the movable-art contract gives their
     dx/dy CSS-px meaning, and a saved svg would also fail glyphCoverage's
     stale-exemption assertion. Refuse here (the inspector glyph card is the
     only route in; the stage already treats art clicks as inert). */
  if (ND.ART_NODE_TYPES.has(state.type)) { toast('"' + state.type + '" draws its real art (the ramp) — it has no SVG glyph. Drag the ramp on the canvas to move it.'); return; }
  clearGlyphSel();
  glyphUndo.length = 0;                           // the gesture history belongs to ONE glyph session
  nudgeRun = false; nudgeKind = '';
  /* Tools reset with the session too: opening a different node with the Rect
     tool still armed from the last one would turn the first press into a shape. */
  cancelToolGesture(); cancelRotate(); insHit = null; rotRun = null;
  toolMode = 'select'; buildToolbar();
  hlWidth = -1;                                   // the mirror re-measures once the modal is shown
  /* "Built-in" can only restore art the APP ships (NODE_GLYPH_TYPES), and 15 of
     the designable nodes' glyphs were AUTHORED here and have no built-in twin —
     builtinGlyphSvg() returns '' for them. The button used to write that '',
     i.e. silently DELETE the art it advertised restoring; Apply then dropped the
     svg key and the node rendered as a bare titled box in the app. Gate it on
     the fact. (Nothing is lost where it greys out: the recovery that always
     works is ⌘Z for the last gesture, Cancel for the whole window.) */
  const hasBuiltin = !!builtinGlyph(state.type);
  el('mBuiltin').disabled = !hasBuiltin;
  el('mBuiltin').title = hasBuiltin
    ? 'Restore the built-in FastShaders art'
    : 'This node has no built-in art — its glyph was authored in this designer (⌘Z undoes the last point edit, Cancel discards this window)';
  /* The caret stays in #mSvg on open — pasting SVG source is the modal's primary
     job. The point-editor keys therefore act on #mPrevBox, which every marquee /
     point / grip gesture focuses by hand, and the hint says so. */
  /* `.show` FIRST: syncGlyphHl refuses to touch the mirror while the modal is
     hidden (clientWidth is 0 there and the copied width would cache negative),
     so refreshing before it left the mirror holding the PREVIOUS glyph's text
     and that session's <mark> spans — blue blocks over unrelated lines of a
     different document, cleared only by the next real gesture. `.overlay.show`
     is `display:flex`, applied synchronously, and the focus() stays last because
     focusing a display:none element is a no-op. */
  el('mType').textContent = state.type; el('mSvg').value = state.glyph; populateLoadList();
  overlay.classList.add('show'); refreshMPreview(); el('mSvg').focus();
}
/* Closing is DESTRUCTIVE: mApply is the only commit path, so every move, scale,
   nudge and delete since the modal opened lives in #mSvg and nowhere else (and
   the next openGlyph resets the gesture stack). Ask before throwing that away;
   an untouched document still closes silently, as it always did. */
function closeGlyphModal() {
  endPtMove(); endScalePts(); endMarq();          // a live gesture must not outlive the modal
  cancelToolGesture(); cancelRotate();
  const dirty = normalizeSvg(el('mSvg').value) !== state.glyph;
  if (dirty && !window.confirm('Discard the glyph edits made in this window?')) return;
  clearGlyphSel();
  overlay.classList.remove('show');
}
function refreshMPreview() {
  /* A pending pen run describes a document that is about to be replaced (the
     user typed, undid, or loaded other art), so it cannot survive this. Commits
     null ptTool BEFORE calling in, so this never eats their own gesture. */
  cancelToolGesture();
  const txt = el('mSvg').value || '';
  el('mPreview').innerHTML = '<svg viewBox="0 0 56 56" width="280" height="280" style="overflow:visible">' + txt + '</svg>';
  const err = svgError(txt); const e = el('mErr');
  e.classList.toggle('show', !!err); e.textContent = err || '';
  el('mApply').disabled = !!err;
  /* Gated HERE and not in the handle renderer: Format is a SOURCE control, and
     the renderer returns early when "drag points" is unticked — which would
     leave the button permanently disabled with a tooltip blaming an SVG error
     the user had already fixed. */
  if (el('mFmt')) {
    el('mFmt').disabled = !!err;
    el('mFmt').title = err
      ? 'Fix the SVG error first — the markup can’t be reformatted while it doesn’t parse'
      : 'Rewrite the markup with one element per line (groups indented) — the drawing is untouched';
  }
  renderGlyphPts();
}
/* A caret in the textarea can restructure the art arbitrarily, and ptsSig
   cannot tell a paste of same-shaped art from an edit — so a TYPED change always
   drops the selection; the sig backstop only covers what the gestures do.
   It drops the gesture-undo stack too: those snapshots describe the document the
   user has just rewritten, and restoring one would throw the typing away. */
el('mSvg').addEventListener('input', () => { clearGlyphSel(); glyphUndo.length = 0; refreshMPreview(); });
/* The mirror only exists to sit exactly under the textarea's text, so it has to
   follow every scroll — including the ones the browser does on its own when the
   caret leaves the viewport. */
el('mSvg').addEventListener('scroll', () => { const m = el('mHl'); if (m) { m.scrollTop = el('mSvg').scrollTop; m.scrollLeft = el('mSvg').scrollLeft; } });
/* Caret → canvas. Clicking a line of markup picks that shape, which is what
   makes the source usable as a list. Bound to click and to the caret-moving keys
   only: `input` already clears the selection, and re-selecting on every
   keystroke would fight someone typing. */
el('mSvg').addEventListener('click', selectFromCaret);
el('mSvg').addEventListener('keyup', (e) => { if (/^(Arrow|Home|End|Page)/.test(e.key)) selectFromCaret(); });
/* Hover marker for the Add-point tool. Bound once, so it fires during every
   other gesture too — hence the guards at the top of onCanvasHover. */
el('mPrevBox').addEventListener('pointermove', onCanvasHover);
el('mPrevBox').addEventListener('pointerleave', () => { if (insHit) { insHit = null; renderGlyphPts(); } });
/* A double-click anywhere finishes an open pen path — the gesture every vector
   editor has, beside Enter and clicking the first anchor. */
el('mPrevBox').addEventListener('dblclick', (e) => { if (ptTool && ptTool.mode === 'pen') { e.preventDefault(); finishPen(false); } });
el('mFmt').onclick = () => {
  if (glyphEditBlocked('the markup can’t be reformatted')) return;
  const before = el('mSvg').value;
  const out = formatGlyphSource(before);
  if (out === before) { toast('Already one element per line.'); return; }
  el('mSvg').value = out;
  pushGlyphUndo(before);
  /* Hand the keyboard to the canvas or the entry just pushed is UNREACHABLE —
     the modal's keydown bails at `if (caret) return;` before the ⌘Z branch, and
     the textarea's native undo is empty because the value was assigned
     programmatically. replaceGlyphSource documents the same trap; WebKit makes
     it certain, since clicking a <button> there does not move focus at all. */
  focusPtCanvas();
  refreshMPreview();
  toast('Formatted — one element per line. The drawing is unchanged.');
};
/* Stroke width commits on `change`, never on `input`: on every keystroke it
   would be 2-3 undo entries per number typed, and arrow-stepping the field 20
   times would fill GLYPH_UNDO_CAP and evict the ⌘A+Delete snapshot the stack
   exists for — exactly what nudgeRun prevents for a held arrow key. */
el('mStrokeW').addEventListener('change', () => {
  const v = normalizePaintNumber(el('mStrokeW').value);
  if (v == null) { renderPaintBar(); return; }
  applyPaint('stroke-width', v);
});
buildPaintChips();
buildToolbar();
el('mGrid').checked = lsGet('nd:grid', '0') === '1';
el('mGridLay').style.display = el('mGrid').checked ? '' : 'none';
el('mGrid').onchange = (e) => { el('mGridLay').style.display = e.target.checked ? '' : 'none'; lsSet('nd:grid', e.target.checked ? '1' : '0'); };
el('mMove').checked = lsGet('nd:pts', '1') === '1';
el('mPtsHint').style.display = el('mMove').checked ? '' : 'none';
/* The legend defaults OPEN — every gesture has to be discoverable — but it is a
   <details> so someone who knows them can fold it away for good, same
   per-browser pref shape as the two checkboxes above. */
el('mPtsHint').open = lsGet('nd:hint', '1') === '1';
el('mPtsHint').addEventListener('toggle', () => lsSet('nd:hint', el('mPtsHint').open ? '1' : '0'));
/* unchecking hides every handle — a selection nobody can see must not stay
   armed for the Delete key */
el('mMove').onchange = (e) => {
  lsSet('nd:pts', e.target.checked ? '1' : '0');
  /* setToolMode, not a bare clearGlyphSel: the handle layer is where a tool
     draws its preview, so with it hidden a pending pen run would be invisible
     and still live — the next canvas click would add an anchor to a path nobody
     can see. It cancels the gesture, resets to Select and re-renders. */
  if (!e.target.checked) { clearGlyphSel(); setToolMode('select'); }
  el('mPtsHint').style.display = e.target.checked ? '' : 'none';
  renderGlyphPts();
};
el('mClose').onclick = closeGlyphModal;
el('mClear').onclick = () => replaceGlyphSource('');
el('mBuiltin').onclick = () => {
  const art = builtinGlyph(state.type);
  /* belt and braces beside the disabled state openGlyph sets: this handler is
     the one that would WIPE the art, so it refuses on its own evidence */
  if (!art) { toast('"' + state.type + '" has no built-in art — this glyph was authored in the designer. ⌘Z undoes the last point edit; Cancel discards this window.'); return; }
  replaceGlyphSource(art);
};
el('mCopy').onclick = async () => { try { await navigator.clipboard.writeText(el('mSvg').value); toast('SVG copied to clipboard.'); } catch (e) { toast('Clipboard unavailable.'); } };
el('mUpload').onclick = () => el('mFile').click();
el('mFile').onchange = (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => replaceGlyphSource(normalizeSvg(String(r.result))); r.readAsText(f); e.target.value = ''; };
el('mApply').onclick = () => { clearGlyphSel(); state.glyph = normalizeSvg(el('mSvg').value); stash(); renderNode(); renderGlyphCard(); overlay.classList.remove('show'); };
el('glyphCard').onclick = openGlyph;
const drop = el('drop');
['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (ev) => { const f = ev.dataTransfer.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => replaceGlyphSource(normalizeSvg(String(r.result))); r.readAsText(f); });

/* ---------------- File System Access: save to FastShaders ---------------- */
const GLYPH_REL = ['src', 'components', 'NodeEditor', 'nodes', 'glyphs', 'customGlyphs.ts'];
const FILE_HEADER = '/**\n * Per-node design overrides authored with node-designer.html (repo root).\n * { svg?: inner SVG (0 0 56 56), justify?: left|center|right, scale?: glyph-only scale,\n *   dx?/dy?: glyph nudge, width?: exact node width (>=24; header text wraps + header auto-grows),\n *   height?: EXACT body height (>=28, both layouts; shorter than content shrinks\n *   the node, content overflows; independent of glyph scale), text?: text-size\n *   multiplier (0.4-2.5, default 1; header/value/edge-label fonts), sockets?:\n *   per-socket offsets from body center (4px snap; keys = input ids + "out";\n *   the CORNER DRAG rescales them with the height, the W/H number\n *   fields do not — renderer semantics unchanged, so no saved design moves) }\n * Node frame style (corner radius, border) is fixed app-wide.\n * Rewritten wholesale by the designer on save.\n */\n';

/* tiny IndexedDB k/v so the folder link survives reloads */
function idb() { return new Promise((res, rej) => { const r = indexedDB.open('fastshaders-node-designer', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbSet(k, v) { try { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); } catch (e) {} }
async function idbGet(k) { try { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readonly'); const q = t.objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); } catch (e) { return undefined; } }

async function adoptFolder(h) {
  dirHandle = h; await loadSaved(); await loadSavedLabelsFromFolder();
  el('fsStatus').textContent = 'linked: ' + h.name;
  selectNode(state.type || 'mul');
}

/* Folder-tier counterpart of loadSavedLabels(). Worth the one-off babel import at
   link time: this page is a BUILT copy, so its compiled labels are frozen at build
   and the linked checkout may have been renamed since — showing the compiled name
   would invite overwriting a newer one with an older one. */
async function loadSavedLabelsFromFolder() {
  try {
    const splice = await import('@/registry/descriptionSplice');
    const regSrc = await (await (await getRelFile(REGISTRY_REL, false)).getFile()).text();
    const next = Object.create(null);
    splice.locateRegistryLabels(regSrc).forEach((s) => { next[s.key] = s.value; });
    const lvSrc = await (await (await getRelFile(I18N_REL, false)).getFile()).text();
    const data = JSON.parse(lvSrc);
    savedLabels = next;
    savedLvLabels = Object.assign(Object.create(null), (data && data.nodes) || {});
    return true;
  } catch (e) { return false; }
}
async function linkFolder() {
  if (!window.showDirectoryPicker) { toast('This browser has no folder access — Save downloads customGlyphs.ts instead.'); return false; }
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite' }); await idbSet('dir', h); await adoptFolder(h); return true;
  } catch (e) { if (e && e.name !== 'AbortError') toast('Could not link folder: ' + e.message); return false; }
}
async function tryRestoreFolder() {
  try {
    if (devApi) return; // dev-server endpoint already handles persistence
    const h = await idbGet('dir'); if (!h) return;
    const p = await h.queryPermission({ mode: 'readwrite' });
    if (p === 'granted') { await adoptFolder(h); return; }
    if (p === 'prompt') {
      const st = el('fsStatus'); st.textContent = 'relink: ' + h.name + ' (1 click)';
      st.onclick = async () => {
        try {
          const q = await h.requestPermission({ mode: 'readwrite' });
          if (q === 'granted') { await adoptFolder(h); st.onclick = linkFolder; }
          else linkFolder();
        } catch (e) { linkFolder(); }
      };
    }
  } catch (e) {}
}
async function getRelFile(parts, create) {
  let d = dirHandle; for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i], { create });
  return d.getFileHandle(parts[parts.length - 1], { create });
}
function parseGlyphs(text) { try { const m = text.match(/=\s*(\{[\s\S]*\})\s*;/); return m ? JSON.parse(m[1]) : {}; } catch (e) { return {}; } }
async function loadSaved() { try { const fh = await getRelFile(GLYPH_REL, false); const f = await fh.getFile(); savedGlyphs = parseGlyphs(await f.text()); Object.values(savedGlyphs).forEach(sanitizeDesign); } catch (e) { savedGlyphs = {}; } }
/* (The old /__nd/costs + complexity.json refresh is gone: costs, colours,
   labels and built-in art are now IMPORTS of the live modules — under the dev
   server they HMR with the source, and a built copy matches its own app build
   by construction.) */

/* ---- dev-server endpoint (vite plugin /__nd) — saves work in ANY browser ---- */
async function probeDevApi() {
  try {
    const r = await fetch(DEV_API + '/glyphs');
    if (!r.ok) return false;
    const j = await r.json();
    devApi = true;
    const dn = el('devNote'); if (dn) dn.style.display = 'none'; // running correctly — drop the notice
    savedGlyphs = parseGlyphs(j.content || ''); Object.values(savedGlyphs).forEach(sanitizeDesign);
    const st = el('fsStatus');
    st.textContent = 'saving via dev server'; st.style.color = '#2E7D32';
    st.title = 'customGlyphs.ts is read & written through the vite dev server (/__nd) — no folder link or Chromium needed.';
    st.onclick = () => toast('Already saving through the dev server — no folder link needed.');
    await loadSavedLabels();
    selectNode(state.type || 'mul');
    return true;
  } catch (e) { return false; }
}

/* On-disk display names. Read alongside the glyphs so the Name fields show the
   FILE's text rather than what this bundle was compiled with — the two diverge as
   soon as anything is renamed, and a stale box would silently re-save the old
   name over a newer one. A failure here is not fatal: canRename() stays false and
   the fields explain themselves. */
async function loadSavedLabels() {
  try {
    const r = await fetch(DEV_API + '/labels');
    if (!r.ok) return false;
    const j = await r.json();
    savedLabels = Object.assign(Object.create(null), j.registry || {});
    savedLvLabels = Object.assign(Object.create(null), j.lv || {});
    labelApi = true;
    return true;
  } catch (e) { return false; }
}
function fileContent(obj) { return FILE_HEADER + 'export const CUSTOM_GLYPHS: Record<string, { svg?: string; justify?: string; scale?: number; dx?: number; dy?: number; width?: number; height?: number; text?: number; sockets?: Record<string, number> }> = ' + JSON.stringify(obj, null, 2) + ';\n'; }

async function writeGlyphFile() {
  const fh = await getRelFile(GLYPH_REL, true); const w = await fh.createWritable(); await w.write(fileContent(savedGlyphs)); await w.close();
}
function mergeInto(types) {
  types.forEach((t) => {
    // ONLY design-dirty types may touch savedGlyphs.
    //
    // A type can be in `types` because only its NAME changed; falling through would
    // take the `else delete savedGlyphs[t]` branch and DESTROY that node's saved glyph
    // design as a side effect of renaming it. The guard must NOT exempt state.type:
    // doSaveDesigns deliberately re-reads the file immediately before calling this
    // (because the file can have moved on), so for the selected node `currentDesign()`
    // is a diff of in-memory state that was applied from an OLDER savedGlyphs — if a
    // design for it was authored elsewhere meanwhile, currentDesign() is {} and the
    // delete branch would wipe the design we just read in.
    //
    // `t in sessionEdits` is exactly "this node's design differs from disk", because
    // both save() and saveAll() call stash() first — which writes currentDesign() into
    // sessionEdits and drops it again when it matches what was saved.
    if (!(t in sessionEdits)) return;
    const d = (t === state.type) ? currentDesign() : sessionEdits[t];
    if (d && Object.keys(d).length) savedGlyphs[t] = d; else delete savedGlyphs[t];
  });
}

/* ---------------- name saving (registry source) ----------------
   Names live in nodeRegistry.ts + node-i18n.json, NOT customGlyphs.ts, so they
   travel their own path: a key→text PATCH that is spliced into the hand-formatted
   registry by byte range (descriptionSplice.ts) rather than a regenerated file.
   Tier 1 posts the patch to /__nd/labels and the dev server splices; tier 2 does
   the identical splice in the browser against the linked folder. There is no tier
   3: a download cannot carry a rename, because the designer holds nodeRegistry.ts
   only as a compiled module — the source text, comments and section banners it
   would have to splice are not in the bundle. */
const REGISTRY_REL = ['src', 'registry', 'nodeRegistry.ts'];
const I18N_REL = ['src', 'i18n', 'node-i18n.json'];

/** Collect the pending {en, lv} patches for `types`. */
function labelPatchFor(types) {
  /* Null-prototype, like every other keyed map on this page: labelEdits is rehydrated
     from localStorage and JSON.parse makes "__proto__" an OWN property, so it can reach
     here as a key. On a PLAIN object `registry['__proto__'] = 'x'` hits Object.prototype's
     setter and is silently discarded — the entry vanishes from the patch while still
     counting as dirty, so Save reports success and the edit never clears. */
  const registry = Object.create(null), lv = Object.create(null);
  types.forEach((t) => {
    const e = labelEdits[t]; if (!e) return;
    if (typeof e.en === 'string') registry[t] = e.en;
    if (typeof e.lv === 'string') lv[t] = e.lv;
  });
  return { registry: registry, lv: lv, empty: !Object.keys(registry).length && !Object.keys(lv).length };
}

/** Splice both files through the LINKED FOLDER (File System Access API). */
async function writeLabelsToFolder(patch) {
  // Dynamic import: descriptionSplice pulls in @babel/parser, and nothing else on
  // this page needs it — deferring keeps that weight out of the designer's initial
  // load for everyone who never renames through a folder link.
  const splice = await import('@/registry/descriptionSplice');

  // Compute BOTH outputs before writing EITHER. The two files must not be able to
  // disagree: an English rename that landed followed by a rejected Latvian one
  // would leave the registry renamed and node-i18n.json still pointing the old way.
  let regFile = null, regOut = null, regSrc = null;
  if (Object.keys(patch.registry).length) {
    regFile = await getRelFile(REGISTRY_REL, false);
    regSrc = await (await regFile.getFile()).text();
    const slots = splice.locateRegistryLabels(regSrc);
    const next = Object.create(null);   // see labelPatchFor: keys can be "__proto__"
    slots.forEach((s) => { next[s.key] = s.value; });
    Object.keys(patch.registry).forEach((k) => {
      if (!(k in next)) throw new Error('unknown node type: ' + k);
      next[k] = patch.registry[k];
    });
    splice.assertValidNodeLabels(next);
    regOut = splice.spliceDescriptions(regSrc, slots, patch.registry, 'label');
  }

  let lvFile = null, lvOut = null, lvSrc = null;
  if (Object.keys(patch.lv).length) {
    lvFile = await getRelFile(I18N_REL, false);
    lvSrc = await (await lvFile.getFile()).text();
    const data = JSON.parse(lvSrc);
    Object.keys(patch.lv).forEach((k) => {
      if (String(patch.lv[k]).trim()) data.nodes[k] = patch.lv[k];
      else delete data.nodes[k]; // '' means untranslated, not a stored empty name
    });
    splice.assertValidNodeLabels(data.nodes, 'lv label');
    lvOut = JSON.stringify(data, null, 2) + '\n';
  }

  if (regOut != null && regOut !== regSrc) { const w = await regFile.createWritable(); await w.write(regOut); await w.close(); }
  if (lvOut != null && lvOut !== lvSrc) { const w = await lvFile.createWritable(); await w.write(lvOut); await w.close(); }
}

/** Persist pending renames for `types`. Returns '' on success, else the reason. */
async function saveLabels(types) {
  if (!canRename()) return '';   // see labelDirty: not writable here, and not blocking
  const patch = labelPatchFor(types);
  if (patch.empty) return '';

  // Block on the same rules the writers enforce, so a rejected save is reported
  // by the field rather than as a 400 after the glyph half already landed.
  const names = Object.keys(patch.registry);
  for (let i = 0; i < names.length; i++) {
    const p = nameProblem(names[i], patch.registry[names[i]]);
    if (p) return names[i] + ': ' + p;
  }

  try {
    if (labelApi) {
      const r = await fetch(DEV_API + '/labels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      if (!r.ok) {
        let why = 'HTTP ' + r.status;
        try { const j = await r.json(); if (j && j.error) why = j.error; } catch (e) {}
        throw new Error(why);
      }
    } else {
      await writeLabelsToFolder(patch);
    }
  } catch (e) { return e.message; }

  // Adopt what we just wrote as the new on-disk truth: the compiled registry in
  // this bundle still holds the OLD name (a dev-server save reloads the page via
  // HMR, but not before this runs), so without this the field would snap back.
  Object.keys(patch.registry).forEach((t) => { savedLabels[t] = patch.registry[t]; });
  Object.keys(patch.lv).forEach((t) => { savedLvLabels[t] = patch.lv[t]; });
  types.forEach((t) => delete labelEdits[t]);
  lsSet('nd:labelEdits', JSON.stringify(labelEdits));
  return '';
}
/* Names first, and a failed rename ABORTS the whole save.
   The two halves land in different files, so a partial save is possible in
   principle — but the failure mode that matters is a rejected rename (duplicate
   name, empty, stale slot) passing unnoticed because the glyph half toasted
   "Saved". Stopping here leaves everything dirty, which is the honest state. */
async function doSave(types, label) {
  if (!types.length) { toast('Nothing to save.'); return; }
  const pending = labelPatchFor(types);
  const renamed = canRename() ? Object.keys(pending.registry).length + Object.keys(pending.lv).length : 0;
  const why = await saveLabels(types);
  if (why) { toast('Rename failed — nothing saved: ' + why); renderNameHint(); return; }
  await doSaveDesigns(types, label + (renamed ? ' (+' + renamed + ' name' + (renamed > 1 ? 's' : '') + ')' : ''));
  syncNameInputs();
}
async function doSaveDesigns(types, label) {
  if (devApi) {
    try {
      try { const r0 = await fetch(DEV_API + '/glyphs'); if (r0.ok) { savedGlyphs = parseGlyphs((await r0.json()).content || ''); Object.values(savedGlyphs).forEach(sanitizeDesign); } } catch (e) {}
      mergeInto(types);
      const r = await fetch(DEV_API + '/glyphs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: fileContent(savedGlyphs) }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      types.forEach((t) => delete sessionEdits[t]);
      lsSet('nd:edits', JSON.stringify(sessionEdits));
      refreshDirtyUI();
      toast('Saved ' + label + ' → customGlyphs.ts (dev server)');
    } catch (e) { toast('Save failed: ' + e.message); }
    return;
  }
  if (dirHandle) {
    try {
      try { const fh0 = await getRelFile(GLYPH_REL, false); savedGlyphs = parseGlyphs(await (await fh0.getFile()).text()); } catch (e) {}
      mergeInto(types);
      await writeGlyphFile();
      types.forEach((t) => delete sessionEdits[t]);
      lsSet('nd:edits', JSON.stringify(sessionEdits));
      refreshDirtyUI();
      toast('Saved ' + label + ' → customGlyphs.ts');
    } catch (e) { await loadSaved(); refreshDirtyUI(); toast('Save failed: ' + e.message); }
  } else {
    mergeInto(types);
    types.forEach((t) => delete sessionEdits[t]);
    lsSet('nd:edits', JSON.stringify(sessionEdits));
    refreshDirtyUI();
    /* The download baseline is the BUNDLED designs (savedDesignsBaseline),
       frozen at this build — if the repo's customGlyphs.ts has moved on since
       (uncommitted saves, a newer checkout), replacing the file wholesale
       with this download would silently revert those. Stamp the provenance
       + the exact session-authored entries so the file says how to use it. */
    const v = (typeof __APP_VERSION__ !== 'undefined') ? __APP_VERSION__ : 'unknown';
    const stamp = '/*\n'
      + ' * DOWNLOADED from FastShaders v' + v + ' — only these entries were authored in this session:\n'
      + ' *   ' + types.join(', ') + '\n'
      + ' * Every OTHER entry is that build\'s bundled snapshot and may be OLDER than the repo file.\n'
      + ' * MERGE the listed entries into src/components/NodeEditor/nodes/glyphs/customGlyphs.ts —\n'
      + ' * do NOT replace the file wholesale.\n'
      + ' */\n';
    downloadFile('customGlyphs.ts', stamp + fileContent(savedGlyphs));
    toast('Downloaded customGlyphs.ts — MERGE the entries listed in its header into src/.../glyphs/ (link the folder or run the dev server to save in place).');
  }
}
async function save() { if (!state.type) { toast('Pick a node first.'); return; } stash(); await doSave([state.type], '"' + state.type + '"'); }
async function saveAll() {
  stash(); const t = dirtyTypes();
  if (!t.length) { toast('No unsaved changes.'); return; }
  await doSave(t, t.length + ' node' + (t.length > 1 ? 's' : ''));
}
function downloadFile(name, text) { const b = new Blob([text], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

/* ---------------- design ops: copy / paste / reset ----------------
   Copy/paste transfers the LAYOUT design (justify, scale, dx/dy, width,
   height, text, sockets) — everything EXCEPT the glyph art: each node keeps
   its own svg. Socket offsets keyed to input ids the target doesn't have are
   simply ignored by the renderer. */
el('copyBtn').onclick = () => {
  copyBuf = currentDesign(); delete copyBuf.svg; el('pasteBtn').disabled = false;
  try { navigator.clipboard.writeText(JSON.stringify(copyBuf, null, 2)); } catch (e) {}
  toast('Design copied (without glyph art)' + (Object.keys(copyBuf).length ? '' : ' — registry defaults') + '.');
};
el('pasteBtn').onclick = () => {
  if (!copyBuf) return;
  const keepGlyph = state.glyph; // never overwrite the target's art
  applyDesignTo(state, state.type, { ...copyBuf, svg: undefined });
  state.glyph = keepGlyph;
  stash(); syncLayoutInputs(); renderNode(); renderGlyphCard(); toast('Design pasted onto "' + state.type + '" (glyph kept).');
};
el('resetBtn').onclick = () => {
  applyDesignTo(state, state.type, null);
  stash(); syncLayoutInputs(); renderNode(); renderGlyphCard(); toast('Reset "' + state.type + '" to built-in defaults (save to persist).');
};

/* ---------------- wiring ---------------- */
el('nodeSel').onchange = (e) => selectNode(e.target.value);
el('prevBtn').onclick = () => stepNode(-1);
el('nextBtn').onclick = () => stepNode(1);
el('search').addEventListener('input', (e) => { filterText = e.target.value; rebuildDropdown(); });
el('search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const v = visibleNodes(); if (v.length) selectNode(v[0].type); }
  if (e.key === 'Escape') { e.target.value = ''; filterText = ''; rebuildDropdown(); e.target.blur(); }
});
el('gScale').oninput = (e) => { state.scale = Math.max(0.2, Math.min(3, parseFloat(e.target.value) || 1)); stash(); renderNode(); renderGlyphCard(); };
el('gDx').oninput = (e) => { const lim = inputNudgeLim(); state.dx = Math.max(-lim, Math.min(lim, parseFloat(e.target.value) || 0)); stash(); renderNode(); renderGlyphCard(); };
el('gDy').oninput = (e) => { const lim = inputNudgeLim(); state.dy = Math.max(-lim, Math.min(lim, parseFloat(e.target.value) || 0)); stash(); renderNode(); renderGlyphCard(); };
el('nudge0').onclick = () => { state.dx = 0; state.dy = 0; syncLayoutInputs(); stash(); renderNode(); renderGlyphCard(); };
el('just').onchange = (e) => { state.justify = e.target.value; stash(); renderNode(); };
el('nW').oninput = (e) => { const v = parseInt(e.target.value) || 0; state.width = v <= 0 ? 0 : Math.max(24, Math.min(400, v)); stash(); renderNode(); };
el('nH').oninput = (e) => { const v = parseInt(e.target.value) || 0; state.height = v <= 0 ? 0 : Math.max(28, Math.min(1200, v)); stash(); renderNode(); };
el('nT').oninput = (e) => { state.text = Math.max(0.4, Math.min(2.5, parseFloat(e.target.value) || 1)); stash(); renderNode(); };
el('sockReset').onclick = () => { state.sockets = {}; sockRaw = {}; syncLayoutInputs(); stash(); renderNode(); toast('Socket positions reset to defaults.'); };
/* Renaming. `input` (not `change`) so the stage header updates as you type — the
   header is what the designer sizes glyph width and text scale against, so seeing
   the real string live is the point. */
function onNameInput() {
  if (!state.type || !canRename()) return;
  stashLabel(state.type, el('nName').value, el('nNameLv').value);
  renderNameHint();
  renderNode();
}
el('nName').addEventListener('input', onNameInput);
el('nNameLv').addEventListener('input', onNameInput);
el('fsStatus').onclick = linkFolder;
el('saveBtn').onclick = async () => { if (!devApi && !dirHandle && window.showDirectoryPicker) await linkFolder(); await save(); };
el('saveAllBtn').onclick = async () => { if (!devApi && !dirHandle && window.showDirectoryPicker) await linkFolder(); await saveAll(); };

function saveFromKey() { (dirtyTypes().length ? saveAll : save)(); }
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName || '') || (document.activeElement && document.activeElement.isContentEditable);
  if (overlay.classList.contains('show')) {
    /* ⌘S is INSIDE the modal gate, and that is the whole fix: mApply is the SOLE
       commit path, so save()/saveAll() serialise currentDesign() from
       `state.glyph` — the art as it was BEFORE this window opened. Above the gate
       it happily reported "Downloaded customGlyphs.ts…" for a session whose every
       move, scale, nudge and delete was still sitting in #mSvg and in no saved
       file; the very next Cancel then asks "Discard the glyph edits made in this
       window?", a question someone who believes they just saved will accept.
       preventDefault ALWAYS (never the browser's save-page dialog), but only
       REFUSE when there is something to lose: with the document still equal to
       state.glyph — the same test closeGlyphModal calls dirty — Apply would be a
       no-op and the save really is complete, so blocking it would be a refusal
       with nothing behind it. */
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (normalizeSvg(el('mSvg').value) !== state.glyph) { toast('Apply the glyph first — this window’s edits are not in a save until you do.'); return; }
      saveFromKey();
      return;
    }
    /* Point-editor keys. openGlyph leaves the caret in #mSvg and every pointer
       gesture preventDefaults the implicit focus change, so the gestures focus
       #mPrevBox (tabindex=0) by hand precisely to get OUT of that state; without
       it Delete would edit the SVG source.
       `caret`, NOT the outer `typing`: that regex is INPUT|TEXTAREA|SELECT, and
       #mSvg is the modal's only text surface — the others are the 56-grid and
       drag-points CHECKBOXES and the load-art SELECT, none of which take a
       character. Gating the keys on `typing` meant ticking "56-grid" to check
       alignment, or focusing the Load select, silently killed Del / ⌘A / the
       arrow nudge while the selection stayed drawn on screen, with no feedback of
       any kind — and no plain click could hand focus back without destroying that
       selection (empty canvas deselects, inside the frame deselects, on a point
       replaces it), so the only recovery was ⇧-clicking a selected point twice.
       Escape below was already special-cased out of exactly this trap; the other
       four keys were left in it. ⌘A still falls through to the textarea's own
       select-all, because that is precisely when the caret IS in #mSvg.
       The one thing this takes: with a live selection the arrows no longer walk
       #mLoad's options. That select LOADS on change (and resets its value), so
       arrowing it was never browsing — it was replacing the art one press at a
       time; and with nothing selected the nudge doesn't act, so it still
       navigates normally. */
    const pts = el('mMove').checked;
    const caret = document.activeElement === el('mSvg');
    /* Delete / ⌘A / the arrows must also stay out of the OTHER field that takes
       characters (the stroke-width number). A KIND test, not an id list: the
       distinguishing property is "this control consumes the keystroke", and the
       reason the page-level `typing` regex cannot be reused is that it also
       matches the two checkboxes and the load <select>, none of which do. */
    const a0 = document.activeElement;
    const keysDead = !!a0 && (a0.tagName === 'TEXTAREA'
      || (a0.tagName === 'INPUT' && !/^(checkbox|radio|button|file|range)$/.test(a0.type)));
    if (e.key === 'Escape') {
      /* Escape while the caret is in the MARKUP box closes — that is what this
         has always argued, and #mSvg is the only place it holds. Everywhere else
         on the modal, a live selection is dismissed first.
         Requiring focus to be exactly on #mPrevBox was far too narrow: only a
         marquee/point/grip gesture ever focuses it, so ticking "56-grid" to check
         alignment (focus → an INPUT) and then pressing Escape to drop the
         selection CLOSED the modal instead — silently discarding every move,
         scale, nudge and delete of the session, since mApply is the only commit.
         Same after Built-in, Clear, Copy, Upload or the Load select. */
      /* A pending pen run owns Escape first — cancelling the shape is what the
         key means while one is being drawn, and it must not also close. */
      if (ptTool || ptRot) { cancelToolGesture(); cancelRotate(); renderGlyphPts(); toast('Cancelled.'); return; }
      /* The `!caret` term is GONE. It was defensible while a selection and a
         caret in the markup box were hard to hold at once; the source→canvas
         link makes that the ORDINARY state — clicking a line of markup selects
         its shape and deliberately leaves the caret where the user is reading —
         so Escape from there would discard the whole modal session with the
         dirty confirm. It still closes on the second press, from anywhere. */
      if (pts && glyphSel.size) { clearGlyphSel(); renderGlyphPts(); return; }  // 1st Esc clears, 2nd closes
      closeGlyphModal();
      return;
    }
    if (caret) return;                                // the textarea keeps its own undo / select-all
    /* A pending pen run owns Enter — but BELOW the caret bail, or Enter typed in
       the markup box would commit a path and rewrite the text under the cursor
       instead of inserting a newline. It still sits above the gesture guard and
       the ⌘Z branch, which is what it needs: below those, undoGlyphEdit would
       restore an earlier document and refreshMPreview would cancel the run, so
       one press would lose the placed anchors AND revert an unrelated edit.
       (Escape is handled higher up, where it has to be — it must also work while
       the caret IS in the box.) */
    if (ptTool && ptTool.mode === 'pen' && e.key === 'Enter') { e.preventDefault(); finishPen(false); return; }
    /* A gesture owns the pointer: every key below rewrites #mSvg and refreshes
       the preview, which REPLACES the <svg> the live gesture holds a reference
       to. The next pointermove would then mutate that DETACHED tree and write
       its stale markup back — reverting the delete (or the undo) entirely, and
       pushing a snapshot of a state the user never saw.
       ptRot and ptTool are in the list for the same reason, and a PENDING pen
       run counts even though no pointer is down: it owns Enter and Escape (the
       branch above), and ⌘Z below would otherwise cancel the run AND revert an
       unrelated earlier edit from one press. */
    if (ptDrag || ptScale || ptMarq || ptRot || ptTool) return;
    /* gesture undo — deliberately NOT gated on `pts`: switching the point editor
       off must not strand the last delete with no way back */
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoGlyphEdit(); return; }
    if (!pts) return;
    if (keysDead) return;                             // a number/text field owns the character keys
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteGlyphSelection(); return; }  // preventDefault: no browser Back
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAllGlyphPts(); return; }
    /* ⌥←/→ rotates. The bare arrows are the translate nudge and ⌥ is otherwise
       free inside the modal (outside it, ⌥↑/↓ steps the node list — that branch
       is below this gate). */
    if (e.altKey && !e.metaKey && !e.ctrlKey && /^Arrow(Left|Right)$/.test(e.key)) {
      const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 15 : 1);
      if (rotateGlyphSelection(d, e.repeat)) e.preventDefault();
      return;
    }
    if (!e.altKey && !e.metaKey && !e.ctrlKey && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
      const s = e.shiftKey ? 2 : .5;                  // 0.5 = the editor's own grid
      /* preventDefault only when the nudge ACTED: with nothing selected the
         arrows must still scroll .modal (max-height:92vh — on a short viewport
         Apply/Cancel sit below the fold). The default action runs after this
         handler returns, so deciding late is fine. */
      if (nudgeGlyphSelection(e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0,
        e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0, e.repeat)) e.preventDefault();
      return;
    }
    return;
  }
  /* first below the gate, so it still fires while the caret is in the search box
     or a number field — the inspector commits every field on `input`, so there is
     never anything unsaved held in one */
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFromKey(); return; }
  if (e.key === '/' && !typing) { e.preventDefault(); el('search').focus(); return; }
  if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); stepNode(-1); }
  if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); stepNode(1); }
});

/* init */
applyBg(); applyView();
rebuildDropdown();
/* ?node=<type> deep-link. The param is attacker-controllable (it arrives in a
   link), so it is ONLY ever a key lookup into NODE_BY_TYPE and is echoed with
   textContent, never innerHTML. An unknown/undesignable type must NOT silently
   fall back — say so, then use the normal last-node behaviour. */
const last = lsGet('nd:lastNode', 'mul');
const fallback = NODE_BY_TYPE[last] ? last : 'mul';
const want = new URLSearchParams(location.search).get('node');
if (want && !NODE_BY_TYPE[want]) {
  el('ndNoticeType').textContent = want; el('ndNoticeFallback').textContent = fallback;
  el('ndNotice').classList.add('show');
  el('ndNoticeX').onclick = () => el('ndNotice').classList.remove('show');
}
selectNode(want && NODE_BY_TYPE[want] ? want : fallback);
/* language toggle (EN/LV). Display-only — nothing about the design changes.
   The labels come straight from the app's i18n module via the bridge. */
el('langBtn').onclick = () => { ND_LANG = (ND_LANG === 'lv') ? 'en' : 'lv'; lsSet('nd:lang', ND_LANG); updateLangBtn(); rebuildDropdown(); selectNode(state.type); };
updateLangBtn();
/* Persistence, in order of preference:
   1. dev-server endpoint (/__nd, any browser) → 2. File System Access API
   (Chromium) → 3. download fallback (with the LIVE bundled designs as the
   read baseline). Explain WHY when only download remains. */
(async () => {
  if (await probeDevApi()) return;
  if (window.showDirectoryPicker) { tryRestoreFolder(); return; }
  const st = el('fsStatus'); st.style.color = '#B45309';
  st.textContent = 'Save downloads here — run `npm run dev` to save in place (any browser)';
  st.title = 'This browser has no File System Access API and the vite dev endpoint isn’t reachable from this URL. Open the designer via the dev server to save in place in any browser, or use Chrome/Edge to link the folder. Save still downloads customGlyphs.ts for you to drop into src/components/NodeEditor/nodes/glyphs/.';
})();
window.addEventListener('load', rAFEdges);
/* The app fonts (@fontsource woff2) swap in AFTER first layout and reflow the
   card without a React commit — the overlays (corner grip, stubs) would keep
   the pre-swap geometry until the next render. Re-measure once the faces land. */
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => requestAnimationFrame(layoutOverlays));
}
