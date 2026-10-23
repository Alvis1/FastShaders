/**
 * The canvas marks for a lesson step: the two sockets a wire must join, the
 * node a value lives on. ATTRIBUTES on React Flow's wrapper and on the handle
 * element, never classes — React rewrites the wrapper's whole `className` on
 * every select/drag and a hand-added class went with it (Preview mode's
 * `data-fs-preview` learned this; NodeEditor's mark effect explains). Styled in
 * nodes/NodeBase.css and handles/TypedHandle.css. The panel re-runs this on
 * every nodes/edges change because a handle REMOUNTS when its node's exposure
 * changes; four `querySelector`s per pass is nothing.
 */

import { nodeEl, handleEl } from '@/components/NodeEditor/nodeElement';
import type { StepTargets } from './tutorialRun';

export const TUTORIAL_MARK_ATTR = 'data-fs-tutorial';

/** Mark the step's targets; returns the remover. A hidden socket (an Output
 *  channel not yet exposed) has no element and is simply not marked. */
export function markStepTargets(targets: StepTargets): () => void {
  if (typeof document === 'undefined') return () => {};
  const marked: Element[] = [];
  for (const id of targets.nodes) {
    const el = nodeEl(id);
    if (el) { el.setAttribute(TUTORIAL_MARK_ATTR, 'node'); marked.push(el); }
  }
  for (const [id, kind, handle] of targets.handles) {
    const el = handleEl(nodeEl(id), kind, handle);
    if (el) { el.setAttribute(TUTORIAL_MARK_ATTR, 'socket'); marked.push(el); }
  }
  return () => { for (const el of marked) el.removeAttribute(TUTORIAL_MARK_ATTR); };
}
