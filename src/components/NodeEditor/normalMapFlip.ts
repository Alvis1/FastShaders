/**
 * Auto-linearize an image wired into an Output's Normal socket. The codegen
 * decodes it as a tangent-space normal MAP via normalMap(), which needs LINEAR
 * sampling — so the Image node flips to the 'data' colorSpace.
 *
 * Skipped when the same image also drives an sRGB channel (color/emissive):
 * one texture carries a single colorSpace and can't satisfy both, so the
 * user's choice is left alone rather than silently wrong-coloured. Only the
 * image's Color (`out`) socket is decoded as a normal map, so only it needs
 * linear sampling: a channel wire (Alpha/R/G/B) into Normal is a raw scalar,
 * and flipping the texture's colour space for it would silently change every
 * other consumer of the image. The `feedsSrgb` scan stays handle-blind — any
 * edge from the image into color/emissive is the conservative answer.
 *
 * Through Branches and Portals (utils/passThrough.ts) both ends are what the
 * wire RESOLVES to: a wire OUT of one into Normal reads the image it carries,
 * and a wire INTO one reaches Normal whenever the pass-through feeds it — the
 * Branch → Normal wire made first, the image second. Pure: NodeEditor's
 * `applyConnection` writes the flip under the caller's single pushHistory, so
 * one undo reverses the connect and the flip together.
 */
import type { AppEdge, AppNode } from '@/types';
import { getNodeValues } from '@/types';
import { isImageChannelHandle } from '@/utils/imageChannels';
import { unwrapCollapsedGroupEdges, unwrapGroupsOnly } from '@/utils/edgeUtils';
import { isPassThroughNode, passThroughConsumers, resolvePassThroughEndpoint } from '@/utils/passThrough';

export interface MadeConnection {
  source: string;
  sourceHandle: string | null | undefined;
  target: string;
  targetHandle: string | null | undefined;
}

/**
 * The id of the Image node to switch to the 'data' colour space now that
 * `connection` is in `edges` (read AFTER the connect), or null for none.
 */
export function imageToLinearize(
  nodes: AppNode[],
  edges: AppEdge[],
  connection: MadeConnection,
): string | null {
  const intoPassThrough = isPassThroughNode(nodes.find((n) => n.id === connection.target));
  const groupView = unwrapGroupsOnly(nodes, edges);
  const intoNormal =
    connection.targetHandle === 'normal' ||
    (intoPassThrough &&
      passThroughConsumers(nodes, groupView, connection.target).some((e) => e.targetHandle === 'normal'));
  if (!intoNormal) return null;
  const from = resolvePassThroughEndpoint(nodes, groupView, connection.source, connection.sourceHandle);
  const srcId = from?.source;
  const src = srcId === undefined ? undefined : nodes.find((n) => n.id === srcId);
  if (src?.data.registryType !== 'imageNode' || isImageChannelHandle(from?.sourceHandle)) return null;
  // The raw list for a direct wire (the edge just made targets `normal`, so it
  // never matches the two handles below); folded only when a pass-through is
  // involved, so every other graph reads exactly as before.
  const readEdges =
    src.id === connection.source && !intoPassThrough ? edges : unwrapCollapsedGroupEdges(nodes, edges);
  const feedsSrgb = readEdges.some(
    (e) => e.source === src.id && (e.targetHandle === 'color' || e.targetHandle === 'emissive'),
  );
  if (feedsSrgb || getNodeValues(src).colorSpace === 'data') return null;
  return src.id;
}
