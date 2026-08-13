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

const PATH_ARGC = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
function tokenizePath(d) {
  const toks = []; const re = /([MLHVCSQTAZmlhvcsqtaz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g; let m;
  while ((m = re.exec(d || ''))) toks.push(m[1] != null ? m[1] : parseFloat(m[2]));
  const segs = []; let i = 0, cmd = null;
  while (i < toks.length) {
    if (typeof toks[i] === 'string') cmd = toks[i++];
    if (cmd == null) break;
    const lc = cmd.toLowerCase();
    if (lc === 'z') { segs.push({ cmd, args: [] }); cmd = null; continue; }
    const n = PATH_ARGC[lc]; if (n == null) break;
    const args = []; let ok = true;
    for (let k = 0; k < n; k++) { if (typeof toks[i] === 'number') args.push(toks[i++]); else { ok = false; break; } }
    if (!ok) break;
    segs.push({ cmd, args });
    if (cmd === 'M') cmd = 'L'; else if (cmd === 'm') cmd = 'l';
  }
  return segs;
}
function fmtN(v) { return String(Math.round(v * 100) / 100); }
function serializePath(segs) { return segs.map((s) => s.cmd + (s.args.length ? ' ' + s.args.map(fmtN).join(' ') : '')).join(' '); }
function segEnd(s, cur, sub) {
  const lc = s.cmd.toLowerCase(), rel = s.cmd === lc, a = s.args; let x = cur.x, y = cur.y, sx = sub.x, sy = sub.y;
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
function segStart(segs, idx) {
  let cur = { x: 0, y: 0 }, sub = { x: 0, y: 0 };
  for (let i = 0; i < idx; i++) { const r = segEnd(segs[i], cur, sub); cur = r.cur; sub = r.sub; }
  return cur;
}
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
function collectGlyphPoints(root) {
  const pts = [];
  root.querySelectorAll('line,circle,ellipse,rect,polyline,polygon,text,path').forEach((elm) => {
    const tag = elm.tagName.toLowerCase();
    const g = (n) => parseFloat(elm.getAttribute(n)) || 0;
    const S = (n, v) => elm.setAttribute(n, fmtN(v));
    const add = (get, set, kind) => pts.push({ el: elm, get: get, set: set, kind: kind || 'anchor' });
    if (tag === 'line') {
      add(() => ({ x: g('x1'), y: g('y1') }), (x, y) => { S('x1', x); S('y1', y); });
      add(() => ({ x: g('x2'), y: g('y2') }), (x, y) => { S('x2', x); S('y2', y); });
    } else if (tag === 'circle') {
      add(() => ({ x: g('cx'), y: g('cy') }), (x, y) => { S('cx', x); S('cy', y); });
      add(() => ({ x: g('cx') + g('r'), y: g('cy') }), (x, _y) => { S('r', Math.max(.5, Math.abs(x - g('cx')))); }, 'ctrl');
    } else if (tag === 'ellipse') {
      add(() => ({ x: g('cx'), y: g('cy') }), (x, y) => { S('cx', x); S('cy', y); });
      add(() => ({ x: g('cx') + g('rx'), y: g('cy') }), (x, _y) => { S('rx', Math.max(.5, Math.abs(x - g('cx')))); }, 'ctrl');
      add(() => ({ x: g('cx'), y: g('cy') + g('ry') }), (_x, y) => { S('ry', Math.max(.5, Math.abs(y - g('cy')))); }, 'ctrl');
    } else if (tag === 'rect') {
      add(() => ({ x: g('x'), y: g('y') }), (x, y) => {
        const brx = g('x') + g('width'), bry = g('y') + g('height');
        const nx = Math.min(x, brx - .5), ny = Math.min(y, bry - .5);
        S('x', nx); S('y', ny); S('width', brx - nx); S('height', bry - ny);
      });
      add(() => ({ x: g('x') + g('width'), y: g('y') + g('height') }), (x, y) => { S('width', Math.max(.5, x - g('x'))); S('height', Math.max(.5, y - g('y'))); }, 'ctrl');
    } else if (tag === 'polyline' || tag === 'polygon') {
      const nums = () => (elm.getAttribute('points') || '').split(/[\s,]+/).filter(Boolean).map(Number);
      const count = nums().length;
      for (let i = 0; i + 1 < count; i += 2) {
        ((idx) => { add(() => { const a = nums(); return { x: a[idx] || 0, y: a[idx + 1] || 0 }; }, (x, y) => { const a = nums(); a[idx] = x; a[idx + 1] = y; elm.setAttribute('points', a.map(fmtN).join(' ')); }); })(i);
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
function renderGlyphPts() {
  const lay = el('mPtsLay'); if (!lay) return;
  lay.innerHTML = '';
  if (!el('mMove').checked) { lay.style.display = 'none'; return; }
  lay.style.display = '';
  const root = el('mPreview').querySelector('svg'); if (!root) return;
  /* alignment guide lines (drawn under the handles) */
  if (ptDrag && ptDrag.guides) {
    const mk = (x1, y1, x2, y2) => {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      l.setAttribute('class', 'pt-guide'); lay.appendChild(l);
    };
    if (ptDrag.guides.x != null) mk(ptDrag.guides.x, 0, ptDrag.guides.x, 56);
    if (ptDrag.guides.y != null) mk(0, ptDrag.guides.y, 56, ptDrag.guides.y);
  }
  let pts; try { pts = collectGlyphPoints(root); } catch (e) { return; }
  if (pts.length > 240) pts = pts.slice(0, 240); // sanity cap for pathological art
  pts.forEach((p) => {
    let pos; try { const lp = p.get(); pos = applyMat(ctmOf(p.el, root), lp.x, lp.y); } catch (e) { return; }
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', pos.x); c.setAttribute('cy', pos.y); c.setAttribute('r', p.kind === 'ctrl' ? 1 : 1.15);
    c.setAttribute('class', p.kind === 'ctrl' ? 'pt-ctrl' : 'pt-anchor');
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const m = ctmOf(p.el, root), lp = p.get();
      const o = applyMat(m, lp.x, lp.y);
      /* alignment refs: every OTHER point's view position + the canvas center
         (coincident-with-origin points are excluded so the point isn't pinned) */
      const refs = [{ x: 28, y: 28 }];
      try {
        collectGlyphPoints(root).forEach((q) => {
          try {
            const ql = q.get(); const qv = applyMat(ctmOf(q.el, root), ql.x, ql.y);
            if (Math.hypot(qv.x - o.x, qv.y - o.y) > 1e-6) refs.push(qv);
          } catch (_) {}
        });
      } catch (_) {}
      ptDrag = { p: p, root: root, inv: invMat(m), o: o, refs: refs, guides: null };
      window.addEventListener('pointermove', onPtMove);
      window.addEventListener('pointerup', endPtMove);
    });
    lay.appendChild(c);
  });
}
function onPtMove(e) {
  if (!ptDrag) return;
  const box = el('mPtsLay').getBoundingClientRect(); if (!box.width) return;
  let vx = (e.clientX - box.left) / box.width * 56, vy = (e.clientY - box.top) / box.height * 56;
  if (e.shiftKey) {
    /* ⇧ angle lock: snap to nearest 30°/45°-family axis from the drag origin */
    ptDrag.guides = null;
    const v = angleLockVec(vx - ptDrag.o.x, vy - ptDrag.o.y);
    vx = ptDrag.o.x + v.x; vy = ptDrag.o.y + v.y;
    const loc = applyMat(ptDrag.inv, vx, vy);
    ptDrag.p.set(Math.round(loc.x * 100) / 100, Math.round(loc.y * 100) / 100); // fine rounding — don't break the angle
  } else {
    /* alignment to other points' rows/columns beats the grid; aligned axes
       write exact coords (fine rounding), free drags keep the 0.5 grid */
    const a = alignSnap(vx, vy, ptDrag.refs, ALIGN_T);
    ptDrag.guides = (a.gx != null || a.gy != null) ? { x: a.gx, y: a.gy } : null;
    const loc = applyMat(ptDrag.inv, a.x, a.y);
    if (ptDrag.guides) ptDrag.p.set(Math.round(loc.x * 100) / 100, Math.round(loc.y * 100) / 100);
    else ptDrag.p.set(Math.round(loc.x * 2) / 2, Math.round(loc.y * 2) / 2); // 0.5 grid snap
  }
  el('mSvg').value = ptDrag.root.innerHTML;
  renderGlyphPts();
}
function endPtMove() {
  if (!ptDrag) return;
  ptDrag = null;
  window.removeEventListener('pointermove', onPtMove);
  window.removeEventListener('pointerup', endPtMove);
  refreshMPreview();
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
function layoutIsOp() { const n = NODE_BY_TYPE[state.type]; return !!state.glyph && n && n.in.length === 2; }
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
el('mLoad').onchange = (e) => {
  const v = e.target.value; e.target.value = '';
  if (!v) return;
  const t = v.slice(2);
  let art = '';
  if (v[0] === 'c') { const d = (t in sessionEdits) ? sessionEdits[t] : savedGlyphs[t]; art = (d && d.svg) || ''; }
  else art = builtinGlyph(t);
  if (!art) { toast('No art found for "' + t + '".'); return; }
  el('mSvg').value = art; refreshMPreview();
  toast('Loaded "' + t + '" art — Apply to keep it.');
};
function openGlyph() {
  /* ART nodes must stay glyph-less — the movable-art contract gives their
     dx/dy CSS-px meaning, and a saved svg would also fail glyphCoverage's
     stale-exemption assertion. Refuse here (the inspector glyph card is the
     only route in; the stage already treats art clicks as inert). */
  if (ND.ART_NODE_TYPES.has(state.type)) { toast('"' + state.type + '" draws its real art (the ramp) — it has no SVG glyph. Drag the ramp on the canvas to move it.'); return; }
  el('mType').textContent = state.type; el('mSvg').value = state.glyph; populateLoadList(); refreshMPreview(); overlay.classList.add('show'); el('mSvg').focus();
}
function refreshMPreview() {
  const txt = el('mSvg').value || '';
  el('mPreview').innerHTML = '<svg viewBox="0 0 56 56" width="280" height="280" style="overflow:visible">' + txt + '</svg>';
  const err = svgError(txt); const e = el('mErr');
  e.classList.toggle('show', !!err); e.textContent = err || '';
  el('mApply').disabled = !!err;
  renderGlyphPts();
}
el('mSvg').addEventListener('input', refreshMPreview);
el('mGrid').checked = lsGet('nd:grid', '0') === '1';
el('mGridLay').style.display = el('mGrid').checked ? '' : 'none';
el('mGrid').onchange = (e) => { el('mGridLay').style.display = e.target.checked ? '' : 'none'; lsSet('nd:grid', e.target.checked ? '1' : '0'); };
el('mMove').checked = lsGet('nd:pts', '1') === '1';
el('mMove').onchange = (e) => { lsSet('nd:pts', e.target.checked ? '1' : '0'); renderGlyphPts(); };
el('mClose').onclick = () => overlay.classList.remove('show');
el('mClear').onclick = () => { el('mSvg').value = ''; refreshMPreview(); };
el('mBuiltin').onclick = () => { el('mSvg').value = builtinGlyph(state.type); refreshMPreview(); };
el('mCopy').onclick = async () => { try { await navigator.clipboard.writeText(el('mSvg').value); toast('SVG copied to clipboard.'); } catch (e) { toast('Clipboard unavailable.'); } };
el('mUpload').onclick = () => el('mFile').click();
el('mFile').onchange = (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { el('mSvg').value = normalizeSvg(String(r.result)); refreshMPreview(); }; r.readAsText(f); e.target.value = ''; };
el('mApply').onclick = () => { state.glyph = normalizeSvg(el('mSvg').value); stash(); renderNode(); renderGlyphCard(); overlay.classList.remove('show'); };
el('glyphCard').onclick = openGlyph;
const drop = el('drop');
['dragenter', 'dragover'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((e) => drop.addEventListener(e, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (ev) => { const f = ev.dataTransfer.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { el('mSvg').value = normalizeSvg(String(r.result)); refreshMPreview(); }; r.readAsText(f); });

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

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName || '') || (document.activeElement && document.activeElement.isContentEditable);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); (dirtyTypes().length ? saveAll : save)(); return; }
  if (overlay.classList.contains('show')) { if (e.key === 'Escape') overlay.classList.remove('show'); return; }
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
