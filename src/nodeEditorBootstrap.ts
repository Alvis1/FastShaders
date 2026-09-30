/**
 * Turns off graph autosave for node-editor.html and node-designer.html. Must be
 * the FIRST import of the entry.
 *
 * Both pages share the real editor's origin and mount the same store, which
 * autosaves 'fs:graph' from a module-scope subscribe on any change of node or
 * edge identity. The store's actions `.map()` a fresh array even when nothing
 * matches, so one incidental action would persist an empty graph over the user's.
 *
 * A call in the entry's BODY is too late: imports are hoisted and evaluate
 * depth-first in declaration order, so only being the first import lands the
 * guard before anything (GraphModal's store population included) can write.
 */
import { setGraphPersistence } from './store/useAppStore';

setGraphPersistence(false);
