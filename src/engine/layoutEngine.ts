import dagre from '@dagrejs/dagre';
import type { AppNode, AppEdge } from '@/types';
import { getCostScale } from '@/utils/colorUtils';

const BASE_WIDTH = 180;
const BASE_HEIGHT = 80;

export function autoLayout(
  nodes: AppNode[],
  edges: AppEdge[],
  direction: 'LR' | 'TB' = 'LR'
): AppNode[] {
  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 120 });

  for (const node of nodes) {
    const scale = getCostScale(node.data.cost ?? 0);
    g.setNode(node.id, { width: BASE_WIDTH * scale, height: BASE_HEIGHT * scale });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    if (!pos) return node;
    return {
      ...node,
      position: {
        x: pos.x - pos.width / 2,
        y: pos.y - pos.height / 2,
      },
    };
  });
}
