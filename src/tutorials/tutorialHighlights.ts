/**
 * The canvas marks for a lesson step: the two sockets a wire must join, the
 * node a value lives on, and the nodes whose socket LABELS the step holds
 * open. ATTRIBUTES on React Flow's wrapper and on the handle element, never
 * classes — React rewrites the wrapper's whole `className` on every
 * select/drag and a hand-added class went with it (Preview mode's
 * `data-fs-preview` learned this; NodeEditor's mark effect explains). Styled in
 * nodes/NodeBase.css and handles/TypedHandle.css. The panel re-runs this on
 * every nodes/edges change because a handle REMOUNTS when its node's exposure
 * changes; a handful of `querySelector`s per pass is nothing.
 *
 * The labels are the double-click label peek's (labelPeek.ts) — the same
 * socket tooltips, the same placement, in Latvian the node's name above its
 * header too — under an attribute of their OWN. NodeEditor owns
 * `data-fs-labels-shown` for the one node the user peeked and removes it when
 * that peek ends; a lesson writing the same attribute would have its labels
 * put away by a double-click on a node it is teaching.
 */

import { nodeEl, handleEl } from '@/components/NodeEditor/nodeElement';
import type { StepTargets } from './tutorialRun';

export const TUTORIAL_MARK_ATTR = 'data-fs-tutorial';
/** On a node wrapper: every socket label of this node is shown (TypedHandle.css). */
export const TUTORIAL_LABELS_ATTR = 'data-fs-tutorial-labels';

/** Mark the step's targets; returns the remover. A hidden socket (an Output
 *  channel not yet exposed) has no element and is simply not marked. */
export function markStepTargets(targets: StepTargets): () => void {
  if (typeof document === 'undefined') return () => {};
  const undo: Array<() => void> = [];
  const mark = (el: Element | null, attr: string, value: string) => {
    if (!el) return;
    el.setAttribute(attr, value);
    undo.push(() => el.removeAttribute(attr));
  };
  for (const id of targets.nodes) mark(nodeEl(id), TUTORIAL_MARK_ATTR, 'node');
  for (const [id, kind, handle] of targets.handles) {
    mark(handleEl(nodeEl(id), kind, handle), TUTORIAL_MARK_ATTR, 'socket');
  }
  for (const id of targets.labels) mark(nodeEl(id), TUTORIAL_LABELS_ATTR, '');
  return () => { for (const u of undo) u(); };
}
