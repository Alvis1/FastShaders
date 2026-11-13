import { useEffect } from 'react';
import { useStore } from '@xyflow/react';
import type { AppNode } from '@/types';
import { mutedMarkKey } from '@/utils/nodeMute';
import { nodeEl } from './nodeElement';

/** The wrapper attribute NodeBase.css dims a muted node by. */
export const MUTED_ATTR = 'data-fs-muted';

/**
 * Marks every MUTED node's wrapper (utils/nodeMute.ts) with `data-fs-muted`,
 * which NodeBase.css draws as switched off. An ATTRIBUTE, for Preview mode's
 * reason: React writes the wrapper's whole `className` on every select/drag
 * and a hand-added class goes with it.
 *
 * Mounted INSIDE `<ReactFlow>` and keyed on React Flow's OWN node list, not
 * the app store's: React Flow renders a node's wrapper from its internal
 * store, one pass after the app hands it a new array, so an effect keyed on
 * the app store can run before a pasted, undone or un-collapsed muted node
 * has a wrapper to mark. This one re-renders in the same pass that draws the
 * wrappers, so its effect always finds them. The key holds only the VISIBLE
 * muted ids, so a drag (which mints new node objects every frame) leaves it —
 * and the marks — alone.
 */
export function MutedMarks() {
  const key = useStore((s) => mutedMarkKey(s.nodes as AppNode[]));
  useEffect(() => {
    if (!key) return;
    const marked: HTMLElement[] = [];
    for (const id of key.split('\n')) {
      const el = nodeEl(id);
      if (!el) continue;
      el.setAttribute(MUTED_ATTR, '');
      marked.push(el);
    }
    return () => {
      for (const el of marked) el.removeAttribute(MUTED_ATTR);
    };
  }, [key]);
  return null;
}
