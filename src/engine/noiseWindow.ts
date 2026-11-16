import type { AppEdge, AppNode } from '@/types';
import { evaluateEdgeRange, evaluateEdgeSource, getTargetEdges } from './cpuEvaluator';
import { DEFAULT_NOISE_WINDOW, type NoiseWindow } from '@/utils/noisePreview';

/**
 * A noise card's window (noisePreview's NoiseWindow): the RANGE of the node's
 * first `pos` wire at `time` — the span of values the shader feeds the noise
 * over the surface — or Position's when `pos` is unwired (which is what an
 * unwired noise samples). `Position + Time` therefore slides the card exactly
 * as it slides the mesh's input, at the wire's own speed and direction, and
 * `Position × 3` widens it. A wire with no bound reads its point value, and
 * failing that Position's span. Kept out of PreviewNode so it is testable and
 * out of noisePreview so the card renderer stays free of the evaluator.
 */
export function noiseWindowAt(nodeId: string, nodes: AppNode[], edges: AppEdge[], time: number): NoiseWindow {
  const posEdge = getTargetEdges(nodes, edges, nodeId).find((e) => e.targetHandle === 'pos');
  if (!posEdge) return DEFAULT_NOISE_WINDOW;
  const range = evaluateEdgeRange(posEdge, nodes, edges, time);
  if (range && range.min.length > 0) return range;
  const point = evaluateEdgeSource(posEdge, nodes, edges, time);
  if (point && point.length > 0) return { min: point, max: point };
  return DEFAULT_NOISE_WINDOW;
}
