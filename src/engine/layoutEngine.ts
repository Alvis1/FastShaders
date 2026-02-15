import dagre from '@dagrejs/dagre';
import type { AppNode, AppEdge } from '@/types';
import { getCostScale } from '@/utils/colorUtils';

const NODE_WIDTH = 90;
const NODE_HEIGHT = 40;

export function autoLayout(
  nodes: AppNode[],
  edges: AppEdge[],
  direction: 'LR' | 'TB' = 'LR'
): AppNode[] {
  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 25, ranksep: 60 });

  for (const node of nodes) {
    const scale = getCostScale((node.data as { cost?: number }).cost ?? 0);
    g.setNode(node.id, { width: NODE_WIDTH * scale, height: NODE_HEIGHT * scale });
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
