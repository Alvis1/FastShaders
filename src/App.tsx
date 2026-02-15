import { useEffect, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useAppStore, loadGraph } from './store/useAppStore';
import { AppLayout } from './components/Layout/AppLayout';
import { useSyncEngine } from './hooks/useSyncEngine';
import complexityData from './registry/complexity.json';
import type { AppNode, AppEdge, OutputNodeData, ShaderNodeData } from './types';
import { generateId, generateEdgeId } from './utils/idGenerator';

function SyncController() {
  useSyncEngine();
  return null;
}

function createInitialNodes(): { nodes: AppNode[]; edges: AppEdge[] } {
  const costs = complexityData.costs as Record<string, number>;

  const posId = generateId();
  const noiseId = generateId();
  const colorId = generateId();
  const mixId = generateId();
  const outputId = generateId();

  const nodes: AppNode[] = [
    {
      id: posId,
      type: 'shader',
      position: { x: 0, y: 100 },
      data: {
        registryType: 'positionGeometry',
        label: 'Position',
        cost: costs.positionGeometry ?? 0,
        values: {},
      } as ShaderNodeData,
    },
    {
      id: noiseId,
      type: 'preview',
      position: { x: 160, y: 60 },
      data: {
        registryType: 'noise',
        label: 'Noise',
        cost: costs.noise ?? 0,
        values: {},
      } as ShaderNodeData,
    },
    {
      id: colorId,
      type: 'color',
      position: { x: 160, y: 200 },
      data: {
        registryType: 'color',
        label: 'Color',
        cost: costs.color ?? 0,
        values: { hex: '#6C63FF' },
      } as ShaderNodeData,
    },
    {
      id: mixId,
      type: 'shader',
      position: { x: 320, y: 120 },
      data: {
        registryType: 'mix',
        label: 'Mix',
        cost: costs.mix ?? 0,
        values: {},
      } as ShaderNodeData,
    },
    {
      id: outputId,
      type: 'output',
      position: { x: 480, y: 120 },
      data: {
        registryType: 'output',
        label: 'Output',
        cost: 0,
      } as OutputNodeData,
    },
  ];

  const edges = [
    {
      id: generateEdgeId(posId, 'out', noiseId, 'pos'),
      source: posId,
      target: noiseId,
      sourceHandle: 'out',
      targetHandle: 'pos',
      type: 'typed' as const,
      animated: true,
      data: { dataType: 'vec3' as const },
    },
    {
      id: generateEdgeId(noiseId, 'out', mixId, 't'),
      source: noiseId,
      target: mixId,
      sourceHandle: 'out',
      targetHandle: 't',
      type: 'typed' as const,
      animated: true,
      data: { dataType: 'float' as const },
    },
    {
      id: generateEdgeId(colorId, 'out', mixId, 'a'),
      source: colorId,
      target: mixId,
      sourceHandle: 'out',
      targetHandle: 'a',
      type: 'typed' as const,
      animated: true,
      data: { dataType: 'color' as const },
    },
    {
      id: generateEdgeId(mixId, 'out', outputId, 'color'),
      source: mixId,
      target: outputId,
      sourceHandle: 'out',
      targetHandle: 'color',
      type: 'typed' as const,
      animated: true,
      data: { dataType: 'any' as const },
    },
  ];

  return { nodes, edges };
}

export default function App() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const saved = loadGraph();
    const { nodes, edges } = saved ?? createInitialNodes();
    useAppStore.getState().setNodes(nodes, 'graph');
    useAppStore.getState().setEdges(edges, 'graph');
  }, []);

  return (
    <ReactFlowProvider>
      <SyncController />
      <AppLayout />
    </ReactFlowProvider>
  );
}
