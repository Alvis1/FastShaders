/**
 * Turns off graph autosave for the node-editor.html entry. Import this FIRST, before
 * any other import in `nodeEditor.tsx`.
 *
 * Why a whole module for one line: `useAppStore` autosaves the graph to
 * localStorage 'fs:graph' from a module-scope subscribe, on any change of node
 * or edge identity. node-editor.html shares an origin with the real editor and mounts
 * the same store purely to render read-only previews, so its `nodes` are never
 * the user's work — a single write from here would overwrite the real graph, and
 * undo history is in-memory only, so a reload makes that permanent. The store's
 * actions `.map()` over `nodes`, which produces a fresh array even when nothing
 * matches, so even an incidental action against an empty store is enough to arm
 * the subscribe and persist `{nodes: [], edges: []}`.
 *
 * Putting the call in `nodeEditor.tsx`'s body does NOT work, however "first" it
 * looks: `import` declarations are hoisted and their modules evaluate before any
 * body statement, so `GraphsPage` (and everything it pulls in) would run first.
 * Import order, by contrast, IS guaranteed — module subtrees evaluate depth-first
 * in the order their import declarations appear. So being the first import of the
 * entry is what actually makes the guard land before anything can write.
 *
 * This is what makes GraphModal's store population safe.
 */
import { setGraphPersistence } from './store/useAppStore';

setGraphPersistence(false);
