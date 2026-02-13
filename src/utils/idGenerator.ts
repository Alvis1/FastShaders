let counter = 0;

export function generateId(): string {
  return `node_${Date.now()}_${++counter}`;
}

export function generateEdgeId(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string
): string {
  return `e-${source}-${sourceHandle}-${target}-${targetHandle}`;
}
