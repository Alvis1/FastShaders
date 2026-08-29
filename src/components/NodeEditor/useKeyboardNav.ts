import { useEffect, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import type { AppNode } from '@/types';
import {
  nextInTabOrder,
  traverseGraph,
  arrowDelta,
  arrowDirection,
  nextPane,
  PANES,
  type PaneDef,
} from './keyboardNav';

/**
 * App-wide keyboard navigation.
 *
 * ONE window listener in CAPTURE phase. Capture is load-bearing rather than
 * stylistic: React Flow's node wrapper has its own `onKeyDown` (a React
 * synthetic handler, so it runs from the root container in the bubble phase)
 * which already moves the SELECTED set on arrows. A bubble-phase listener would
 * fire IN ADDITION and move every node twice. Capturing on window lets this
 * handler run first and `stopPropagation()` the events it owns, so React Flow's
 * version simply never sees them — which is what makes it safe to keep
 * `disableKeyboardA11y` off and inherit its Tab stops, Enter/Space selection and
 * `aria-roledescription`.
 *
 * WHAT IS DELIBERATELY NOT REIMPLEMENTED: Tab's DOM focus movement (React Flow
 * already makes every node `tabIndex=0`), Enter/Space selection, and the
 * existing Cmd+C/V/D/G/Z accelerators in NodeEditor and useSyncEngine.
 */

/** The strict "user is typing" guard — the ContextMenu.tsx form, which is the
 *  only one in the codebase that covers `<select>` (the Audio Input node puts a
 *  real one ON the canvas) and contentEditable. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true ||
    el.closest?.('[role="dialog"]') != null
  );
}

function focusedNodeId(): string | null {
  const el = document.activeElement as HTMLElement | null;
  const wrapper = el?.closest?.('.react-flow__node') as HTMLElement | null;
  return wrapper?.getAttribute('data-id') ?? null;
}

function focusNodeById(id: string): boolean {
  const el = document.querySelector(
    `.react-flow__node[data-id="${CSS.escape(id)}"]`,
  ) as HTMLElement | null;
  if (!el) return false;
  // preventScroll: React Flow's own `autoPanOnNodeFocus` already centres an
  // off-screen node, and letting the browser ALSO scroll the pane fights it.
  el.focus({ preventScroll: true });
  return true;
}

function paneOf(el: Element | null): PaneDef | null {
  for (const p of PANES) if (el?.closest(p.selector)) return p;
  return null;
}

interface Options {
  /** Draw mode owns the arrows for its own purposes; navigation stands down. */
  drawToolActive: boolean;
}

export function useKeyboardNav({ drawToolActive }: Options): void {
  const drawRef = useRef(drawToolActive);
  drawRef.current = drawToolActive;

  // The move bracket. `beginInteraction` snapshots once and suppresses
  // pushHistory until the matching end, so a held arrow (auto-repeat ~30/s) is
  // ONE undo entry rather than thirty — the DragNumberInput scrub rule. This
  // keeps its OWN boolean rather than reading the store's depth counter,
  // because that counter has no notion of who owns a level and an unpaired end
  // would close whichever bracket another gesture is riding.
  const bracketRef = useRef(false);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const endBracket = () => {
      if (idleRef.current) {
        clearTimeout(idleRef.current);
        idleRef.current = null;
      }
      if (!bracketRef.current) return;
      bracketRef.current = false;
      useAppStore.getState().endInteraction();
    };

    const touchBracket = () => {
      if (!bracketRef.current) {
        bracketRef.current = true;
        useAppStore.getState().beginInteraction();
      }
      if (idleRef.current) clearTimeout(idleRef.current);
      // Idle close rather than keyup: a run of separate taps inside 600ms reads
      // as one gesture, and the timer is the safety net that guarantees the
      // bracket cannot be left open (which would silently stop history
      // recording for the rest of the session).
      idleRef.current = setTimeout(endBracket, 600);
    };

    const moveNode = (id: string, dx: number, dy: number) => {
      const store = useAppStore.getState();
      touchBracket();
      // Move the whole SELECTION when the focused node is part of one — that is
      // what React Flow does and what a pointer drag does, so the keyboard must
      // not be the one path that quietly moves a single node out of a group it
      // was selected with.
      const selected = store.nodes.filter((n) => n.selected);
      const movingIds = new Set(
        selected.some((n) => n.id === id) ? selected.map((n) => n.id) : [id],
      );
      store.setNodes(
        store.nodes.map((n) =>
          movingIds.has(n.id)
            ? ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } as AppNode)
            : n,
        ),
      );
    };

    const selectOnly = (id: string) => {
      const store = useAppStore.getState();
      // Spread-only: `selectionOnlyGraphChange` compares `data` and `position`
      // by REFERENCE, so keeping both makes a pure selection change inert to the
      // 300ms full-graph autosave (a multi-MB JSON.stringify once images are
      // embedded).
      store.setNodes(store.nodes.map((n) => ({ ...n, selected: n.id === id }) as AppNode));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;

      const active = document.activeElement as HTMLElement | null;

      // ── Alt/Option + Left/Right: cycle panes ────────────────────────────
      // preventDefault matters on Windows/Linux, where Alt+Arrow is the
      // browser's Back/Forward. Unlike Ctrl+Tab this one really is preventable.
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const from = paneOf(active);
        const target = nextPane(from?.id ?? null, e.key === 'ArrowRight' ? 1 : -1, (p) =>
          document.querySelector(p.selector) != null,
        );
        if (!target) return;
        const el = document.querySelector(target.selector) as HTMLElement | null;
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        // tabIndex is set here rather than in the markup so these containers
        // never become ordinary Tab stops — Alt+Arrow is the only way in.
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: true });
        return;
      }

      if (drawRef.current) return;

      const inCanvas = active?.closest('.node-editor__canvas') != null;
      const nodeId = focusedNodeId();

      // ── Tab / Shift+Tab: cycle nodes, CANVAS-SCOPED ─────────────────────
      // Scoped so the toolbar, asset bar and code panel keep their normal focus
      // order — taking Tab app-wide would remove the only keyboard route into
      // them, which is the opposite of the point.
      if (e.key === 'Tab' && inCanvas && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const nodes = useAppStore.getState().nodes;
        const next = nextInTabOrder(nodes, nodeId, e.shiftKey ? -1 : 1);
        if (!next) return;
        e.preventDefault();
        e.stopPropagation();
        focusNodeById(next);
        return;
      }

      const dir = arrowDirection(e.key);
      if (!dir) return;

      // ── Cmd/Ctrl + Arrow: move the SELECTION along the graph ────────────
      if ((e.metaKey || e.ctrlKey) && !e.altKey && nodeId) {
        const { nodes, edges } = useAppStore.getState();
        const next = traverseGraph(nodes, edges, nodeId, dir);
        if (!next) return;
        e.preventDefault();
        e.stopPropagation();
        selectOnly(next);
        focusNodeById(next);
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // ── Arrows: move the focused node (Shift moves further) ─────────────
      if (nodeId) {
        const d = arrowDelta(e.key, e.shiftKey);
        if (!d) return;
        e.preventDefault();
        // stopPropagation is what keeps React Flow's own arrow handler from
        // ALSO moving the selection — its version pushes no history and does no
        // group reparenting, so a node nudged out of its frame would stay
        // parented-but-outside and vanish on the next collapse.
        e.stopPropagation();
        moveNode(nodeId, d.dx, d.dy);
      }
    };

    // Ending the bracket on keyup as well as on idle: a released key is a
    // finished gesture, and waiting out the timer would fold a following
    // unrelated edit into the same undo entry.
    const onKeyUp = (e: KeyboardEvent) => {
      if (arrowDirection(e.key)) endBracket();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    // A blur can strand a held key, and an unclosed bracket silently stops
    // history recording for the rest of the session.
    window.addEventListener('blur', endBracket);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', endBracket);
      endBracket();
    };
  }, []);
}
