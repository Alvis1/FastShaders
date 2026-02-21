/** Transient flag: true when an edge is being disconnected via drag.
 *  Used by NodeEditor to suppress the AddNodeMenu on drop-to-empty-space. */
export let isEdgeDisconnecting = false;
export function setEdgeDisconnecting(v: boolean) { isEdgeDisconnecting = v; }
