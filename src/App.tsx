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

  const perlinId = generateId();
  const color1Id = generateId();
  const color2Id = generateId();
  const subId = generateId();
  const mixId = generateId();
  const outputId = generateId();

  const nodes: AppNode[] = [
    {
      id: perlinId,
      type: 'preview',
      position: { x: 0, y: 130 },
      data: {
        registryType: 'perlin',
        label: 'Perlin Noise',
        cost: costs.perlin ?? 35,
        values: {
          pos: 'positionGeometry',
          scale: 1.1,
        },
      } as ShaderNodeData,
    },
    {
      id: color1Id,
      type: 'color',
      position: { x: 270, y: 0 },
      data: {
        registryType: 'color',
        label: 'Color',
        cost: costs.color ?? 0,
        values: { hex: '#fec700' },
      } as ShaderNodeData,
    },
    {
      id: color2Id,
      type: 'color',
      position: { x: 270, y: 130 },
      data: {
        registryType: 'color',
        label: 'Color',
        cost: costs.color ?? 0,
        values: { hex: '#e32400' },
      } as ShaderNodeData,
    },
    {
      id: subId,
      type: 'shader',
      position: { x: 450, y: 260 },
      data: {
        registryType: 'sub',
        label: 'Subtract',
        cost: costs.sub ?? 0,
        values: { b: 0.5 },
      } as ShaderNodeData,
    },
    {
      id: mixId,
      type: 'shader',
      position: { x: 450, y: 40 },
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
      position: { x: 650, y: 120 },
      data: {
        registryType: 'output',
        label: 'Output',
        cost: 0,
        exposedPorts: ['color', 'position'],
      } as OutputNodeData,
    },
  ];

  const edges = [
    {
      id: generateEdgeId(perlinId, 'out', mixId, 't'),
      source: perlinId,
      target: mixId,
      sourceHandle: 'out',
      targetHandle: 't',
      type: 'typed' as const,
      animated: true,
      data: { dataType: 'color' as const },
    },
    {
      id: generateEdgeId(perlinId, 'out', subId, 'a'),
      source: perlinId,
      target: subId,
      sourceHandle: 'out',
      targetHandle: 'a',
      type: 'typed' as const,
      animated: true,
      data: { dataType: 'color' as const },
    },
    {
      id: generateEdgeId(color1Id, 'out', mixId, 'a'),
      source: color1Id,
      target: mixId,
      sourceHandle: 'out',
      targetHandle: 'a',
      type: 'typed' as const,
      animated: true,
      data: { dataType: 'color' as const },
    },
    {
      id: generateEdgeId(color2Id, 'out', mixId, 'b'),
      source: color2Id,
      target: mixId,
      sourceHandle: 'out',
      targetHandle: 'b',
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
    {
      id: generateEdgeId(subId, 'out', outputId, 'position'),
      source: subId,
      target: outputId,
      sourceHandle: 'out',
      targetHandle: 'position',
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
