/**
 * NODE → CODE: while a node is selected on the canvas, the TSL panel marks
 * every line it produced (owner, 2026-10-27) — a tint, a bar in the gutter, a
 * tick on the overview ruler; a Split's reads inside its consumers get a
 * dotted underline. Never the other way: the caret selects nothing.
 *
 * Imperative on purpose: Monaco decorations and a store subscription, no
 * React state, so a selection change re-renders nothing.
 *
 * WHICH TEXT. The spans come from the graph→code pass (graphToCode's
 * `nodeSpans`, the store's `codeNodeSpans`), but Monaco shows the SETTLED
 * text (CodeEditor's CODE_SETTLE_MS), which can be a pass or two behind, and
 * whatever the user has typed since. So a pair is used only while Monaco's
 * text EQUALS its `code` — the last few pairs are kept (`RING`), and the check
 * is a length compare first, then one `getValue` per model version. On a
 * match every emitted node's spans are seeded as INVISIBLE tracked ranges;
 * Monaco then moves them with the user's typing, which is what keeps a mark on
 * its lines while the user edits above it, and lets a selection made mid-edit
 * still find its node. The visible marks are derived from those ranges and
 * repainted in the content-change event itself (synchronous, before Monaco's
 * next render), so a settle never flashes. A whole-document replace that
 * matches no pair (an imported script, a paste over everything) drops them.
 *
 * The comparison is against the pair's text as Monaco HOLDS it (monacoText:
 * every CR normalized), since codegen can emit one and Monaco never keeps it.
 *
 * REVEAL. Only a CLICK that changes the selection to one thing scrolls the
 * panel, and only when that code is out of view: a drag, a marquee, Select
 * all and the keyboard never move it. A click while the user is typing in the
 * panel is dropped, never parked — "typing" decided at the PRESS, since the
 * press itself takes the focus away (Monaco notices a tick later, well before
 * a human's click lands); a click while the panel is hidden (another tab, a
 * collapsed pane) is parked and flushed ONCE when it shows lines again.
 *
 * A study session gets none of it (isEvalMode(), sampled once per page): the
 * panel stays the one its participants started with.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { OnMount } from '@monaco-editor/react';
import { useAppStore } from '@/store/useAppStore';
import { isEvalMode } from '@/eval/evalMode';
import type { CodeNodeSpans, CodeSpan } from '@/types';
import { expandSelection, monacoText, planHighlight, revealTarget, selectionKey, type HighlightItem } from './nodeCodeHighlight';

type Ed = Parameters<OnMount>[0];
type Mo = Parameters<OnMount>[1];
type Deco = NonNullable<Parameters<Ed['createDecorationsCollection']>[0]>[number];

/** Recent graph→code pairs kept for Monaco's settled text to match. */
const RING = 4;
/** A press that travelled further than this is a drag, not a click. */
const CLICK_SLOP_PX = 4;
/** How long a click waits for its node's code to settle before giving up. */
const REVEAL_WAIT_MS = 600;
/** A reveal centres at most this many lines of a long block. */
const REVEAL_MAX_LINES = 8;

/** The `onMount` half: CodeEditor calls it with the TSL editor. */
export function useNodeCodeHighlight(): (editor: Ed, monaco: Mo) => void {
  const ctrl = useRef<{ dispose(): void } | null>(null);
  const last = useRef<[Ed, Mo] | null>(null);
  useEffect(() => {
    // StrictMode (and a fast refresh) replays effects on a LIVE editor: attach
    // again to the one already mounted.
    if (!ctrl.current && last.current && !isEvalMode()) ctrl.current = attachNodeCodeHighlight(...last.current);
    return () => {
      ctrl.current?.dispose();
      ctrl.current = null;
    };
  }, []);
  return useCallback((editor: Ed, monaco: Mo) => {
    ctrl.current?.dispose();
    ctrl.current = null;
    last.current = [editor, monaco];
    if (isEvalMode()) return;
    ctrl.current = attachNodeCodeHighlight(editor, monaco);
  }, []);
}

/** The highlight on one editor — exported for its behavioural test
 *  (nodeCodeHighlightEditor.test.ts drives it with a fake editor). */
export function attachNodeCodeHighlight(editor: Ed, monaco: Mo): { dispose(): void } {
  const E = monaco.editor;
  const LF = E.EndOfLinePreference.LF;
  const NEVER = E.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
  // A registered theme colour, so the ruler follows the editor theme.
  const ruler = { color: { id: 'editorOverviewRuler.rangeHighlightForeground' }, position: E.OverviewRulerLane.Left };
  const TRACK: Deco['options'] = { stickiness: NEVER };
  const OWN_LINE: Deco['options'] = {
    isWholeLine: true,
    className: 'fs-code-node-line',
    linesDecorationsClassName: 'fs-code-node-bar',
    overviewRuler: ruler,
    stickiness: NEVER,
  };
  const OWN_INLINE: Deco['options'] = {
    className: 'fs-code-node-range',
    linesDecorationsClassName: 'fs-code-node-bar',
    overviewRuler: ruler,
    stickiness: NEVER,
  };
  const USE: Deco['options'] = {
    inlineClassName: 'fs-code-node-use',
    linesDecorationsClassName: 'fs-code-node-bar fs-code-node-bar--use',
    stickiness: NEVER,
  };

  const tracking = editor.createDecorationsCollection();
  const visible = editor.createDecorationsCollection();
  /** Node id → its first slot in `tracking` and the spans seeded from there. */
  let index: Map<string, { at: number; spans: readonly CodeSpan[] }> | null = null;
  const ring: CodeNodeSpans[] = [];
  const nodes0 = useAppStore.getState().nodes;
  let key = selectionKey(nodes0);
  let sel = expandSelection(nodes0);
  let items: HighlightItem[] = [];
  /** A reveal waiting for the panel to show lines again (the key it was for). */
  let parked: string | null = null;
  /** A reveal waiting for its node's code to settle. */
  let pending: { key: string; until: number } | null = null;
  /** The press a click is judged by: where it was, and whether the user was
   *  typing in the panel then (the press itself moves the focus away). */
  let down: { x: number; y: number; typing: boolean } | null = null;
  let clickOnNode = false;

  let textVersion = -1;
  let text = '';
  const modelText = (): string => {
    const model = editor.getModel();
    if (!model) return '';
    if (model.getVersionId() !== textVersion) {
      text = model.getValue(LF);
      textVersion = model.getVersionId();
    }
    return text;
  };
  const matches = (pair: CodeNodeSpans | null): boolean => {
    const model = editor.getModel();
    if (!pair || !model) return false;
    const text = monacoText(pair);
    return model.getValueLength(LF) === text.length && modelText() === text;
  };
  const findMatch = (): CodeNodeSpans | null => {
    for (let i = ring.length - 1; i >= 0; i--) if (matches(ring[i])) return ring[i];
    return null;
  };

  const seed = (pair: CodeNodeSpans): void => {
    const decos: Deco[] = [];
    index = new Map();
    for (const [id, spans] of pair.spans) {
      index.set(id, { at: decos.length, spans });
      for (const s of spans) decos.push({ range: s, options: TRACK });
    }
    tracking.set(decos);
  };
  const clearTracking = (): void => {
    tracking.clear();
    index = null;
  };
  const paint = (): void => {
    const found: HighlightItem[] = [];
    if (index) {
      for (const id of sel.ids) {
        const slot = index.get(id);
        if (!slot) continue;
        slot.spans.forEach((s, k) => {
          const r = tracking.getRange(slot.at + k);
          if (!r || r.isEmpty()) return;
          found.push({
            startLineNumber: r.startLineNumber,
            startColumn: r.startColumn,
            endLineNumber: r.endLineNumber,
            endColumn: r.endColumn,
            kind: s.kind,
            inline: s.inline,
          });
        });
      }
    }
    // Nothing selected and nothing drawn: a keystroke costs no decoration pass.
    if (found.length === 0 && items.length === 0) return;
    items = planHighlight(found);
    visible.set(items.map((it) => ({ range: it, options: it.kind === 'use' ? USE : it.inline ? OWN_INLINE : OWN_LINE })));
  };
  /** Seed, paint, then let a click that was waiting for this code reveal it. */
  const seedAndPaint = (pair: CodeNodeSpans): void => {
    seed(pair);
    paint();
    if (!pending) return;
    if (pending.key === key && performance.now() < pending.until) requestReveal();
    else pending = null;
  };

  // A hidden tab or a collapsed pane lays the editor out a few px tall.
  const showsLines = (): boolean => editor.getLayoutInfo().height >= 3 * editor.getOption(E.EditorOption.lineHeight);
  const requestReveal = (): void => {
    parked = null;
    const target = revealTarget(items);
    if (!target) {
      // Its code has not settled yet (a node just added): wait one settle
      // window for it, never longer — the deadline is not moved by a retry.
      if (pending?.key !== key) pending = { key, until: performance.now() + REVEAL_WAIT_MS };
      return;
    }
    pending = null;
    if (editor.hasWidgetFocus()) return; // typing in the panel: dropped, never parked
    if (!showsLines()) {
      parked = key; // flushed ONCE, when the panel shows lines again
      return;
    }
    editor.revealLinesInCenterIfOutsideViewport(
      target.startLineNumber,
      Math.min(target.endLineNumber, target.startLineNumber + REVEAL_MAX_LINES - 1),
      E.ScrollType.Immediate,
    );
  };

  const subs = [
    // SYNCHRONOUS: runs before Monaco renders the edit, so a settle never
    // shows a frame of collapsed marks.
    editor.onDidChangeModelContent((e) => {
      const pair = findMatch();
      const model = editor.getModel();
      const whole =
        e.isFlush ||
        (e.changes.length === 1 && e.changes[0].rangeOffset === 0 && !!model && e.changes[0].text.length === model.getValueLength());
      if (pair) {
        seedAndPaint(pair);
        return;
      }
      // Typing: Monaco has already moved the tracked ranges with the text.
      if (whole) clearTracking();
      paint();
    }),
    editor.onDidLayoutChange(() => {
      if (parked !== null && parked === key && showsLines()) requestReveal();
    }),
    editor.onDidChangeModel(() => {
      clearTracking();
      const pair = findMatch();
      if (pair) seedAndPaint(pair);
      else paint();
    }),
    editor.onDidDispose(() => dispose()),
  ];

  const unsubscribe = useAppStore.subscribe((s, prev) => {
    if (s.codeNodeSpans !== prev.codeNodeSpans && s.codeNodeSpans) {
      ring.push(s.codeNodeSpans);
      if (ring.length > RING) ring.shift();
      // The spans moved and the text did not (an undo, or a pass whose text
      // is unchanged — an edit to a node the panel does not show): nothing
      // reaches Monaco, so seed from here.
      if (matches(s.codeNodeSpans)) seedAndPaint(s.codeNodeSpans);
    }
    if (s.nodes !== prev.nodes) {
      const next = selectionKey(s.nodes);
      if (next !== key) {
        key = next;
        sel = expandSelection(s.nodes);
        parked = null;
        pending = null;
        paint();
        // A CLICK that changed the selection to one thing — nothing else.
        if (clickOnNode && sel.units.length === 1) requestReveal();
      }
    }
  });

  // Capture phase: runs before React's handlers, where React Flow selects a
  // clicked node (its NodeWrapper onClick), so the subscription above knows
  // the selection came from a click. A drag past React Flow's threshold has
  // already selected at drag start, mid-move.
  const onPointerDown = (e: PointerEvent): void => {
    down = { x: e.clientX, y: e.clientY, typing: editor.hasWidgetFocus() };
  };
  const onClick = (e: MouseEvent): void => {
    const onNode = e.target instanceof Element ? e.target.closest('.node-editor .react-flow__node') : null;
    clickOnNode = !!onNode && !!down && !down.typing && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= CLICK_SLOP_PX;
    if (clickOnNode) window.setTimeout(() => { clickOnNode = false; }, 0);
  };
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('click', onClick, true);

  const first = useAppStore.getState().codeNodeSpans;
  if (first) {
    ring.push(first);
    if (matches(first)) seed(first);
  }
  paint();

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    for (const d of subs) d.dispose();
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('click', onClick, true);
    try {
      tracking.clear();
      visible.clear();
    } catch {
      // The editor is already gone, and its decorations with it.
    }
  }
  return { dispose };
}
