import { useSyncExternalStore } from 'react';

/**
 * Which Portal In's name is being edited IN PLACE on the canvas, if any
 * (docs/dev/canvas-interaction.md, "Portal"). A session-only UI fact, like the
 * label peek: opening the field is not an edit, so it never touches the store,
 * history or a saved file. The menus' Rename rows ask for it; the entrance's
 * card (nodes/TunnelNode.tsx) shows the field while it names that card.
 */
let editing: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Open the in-place name field on the entrance `id`. */
export function startPortalRename(id: string): void {
  if (editing === id) return;
  editing = id;
  emit();
}

/** Close it (the field committed or cancelled), only when it names `id`. */
export function endPortalRename(id: string): void {
  if (editing !== id) return;
  editing = null;
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Is the field open on the entrance `id`? A boolean per card, so only the
 *  card that opens or closes re-renders. */
export function usePortalRenaming(id: string): boolean {
  return useSyncExternalStore(subscribe, () => editing === id, () => false);
}
