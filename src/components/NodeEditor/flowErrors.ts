/**
 * Reading React Flow's error MESSAGES back into something the app can act on.
 *
 * A LEAF — it imports nothing, so a node test can execute it against the real
 * `errorMessages` table from `@xyflow/system` (which is exactly what
 * `flowErrors.test.ts` does: it FORMATS a message with the library's own
 * function rather than transcribing the format, so a message-shape change on a
 * React Flow bump fails loudly instead of silently disarming the one
 * suppression NodeEditor allows).
 */

/**
 * The template `@xyflow/system`'s `errorMessages.error008` fills in:
 *
 *   `Couldn't create edge for ${handleType} handle id: "${handle}", edge id: ${id}.`
 *
 * Two facts are load-bearing and both were READ out of the installed package
 * rather than assumed:
 *  - the message names WHICH SIDE failed (`source` or `target`), and
 *  - it carries the EDGE ID, which is what lets the suppression resolve the
 *    node the edge lands on. The handle id alone cannot: it is shared by every
 *    Output on the canvas.
 */
const ERROR_008_PREFIX = "Couldn't create edge for target handle id: ";
const EDGE_ID_SEP = ', edge id: ';

/**
 * The id of the edge React Flow could not place, but ONLY when it is the
 * TARGET handle that is missing — else null.
 *
 * The side test is not pedantry. `getEdgePosition` reports `source` whenever
 * the SOURCE handle is the one it could not find, and an absent source handle
 * is always the missing-`useUpdateNodeInternals` bug this file's one
 * suppression must never hide — even when the same edge happens to end on a
 * dormant Output, which would otherwise excuse it.
 *
 * The id is taken from the LAST `, edge id: ` rather than the first: the
 * separator is appended after the handle id, and a handle id comes out of a
 * `.fastshader` file, so it may spell anything at all. A crafted handle can
 * still make this read the wrong id — it then names no edge in the store and
 * the warning is PRINTED, which is the safe direction.
 */
export function edgeIdFromError008(message: string): string | null {
  if (!message.startsWith(ERROR_008_PREFIX)) return null;
  const at = message.lastIndexOf(EDGE_ID_SEP);
  if (at < 0) return null;
  const tail = message.slice(at + EDGE_ID_SEP.length);
  // The template appends a full stop after the id; an id may itself end in one
  // (`generateEdgeId` splices in mesh-derived handles like `Body.001`), so only
  // the final character is dropped.
  return tail.endsWith('.') ? tail.slice(0, -1) : null;
}
