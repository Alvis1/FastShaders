import { useEffect, useRef, useCallback } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useAppStore } from './store/useAppStore';
import { AppLayout } from './components/Layout/AppLayout';
import { graphToCode } from './engine/graphToCode';
import { codeToGraph } from './engine/codeToGraph';
import { NODE_REGISTRY } from './registry/nodeRegistry';
import complexityData from './registry/complexity.json';
import type { AppNode, AppEdge, OutputNodeData, ShaderNodeData } from './types';
import { generateId, generateEdgeId } from './utils/idGenerator';

function SyncController() {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const code = useAppStore((s) => s.code);
  const syncSource = useAppStore((s) => s.syncSource);
  const syncInProgress = useAppStore((s) => s.syncInProgress);
  const setCode = useAppStore((s) => s.setCode);
  const setNodes = useAppStore((s) => s.setNodes);
  const setEdges = useAppStore((s) => s.setEdges);
  const setCodeErrors = useAppStore((s) => s.setCodeErrors);
  const setTotalCost = useAppStore((s) => s.setTotalCost);
  const setSyncInProgress = useAppStore((s) => s.setSyncInProgress);

  const prevNodesRef = useRef(nodes);
  const prevEdgesRef = useRef(edges);
  const codeTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Graph → Code (immediate)
  useEffect(() => {
    if (syncSource !== 'graph' || syncInProgress) return;
    if (nodes === prevNodesRef.current && edges === prevEdgesRef.current) return;
    prevNodesRef.current = nodes;
    prevEdgesRef.current = edges;

    setSyncInProgress(true);
    try {
      const result = graphToCode(nodes, edges, NODE_REGISTRY);
      setCode(result.code, 'graph');
    } finally {
      setSyncInProgress(false);
    }
  }, [nodes, edges, syncSource, syncInProgress, setCode, setSyncInProgress]);

  // Code → Graph (debounced 400ms)
  const doCodeSync = useCallback(
    (codeStr: string) => {
      setSyncInProgress(true);
      try {
        const result = codeToGraph(codeStr, NODE_REGISTRY);
        if (result.errors.length === 0 && result.nodes.length > 0) {
          setNodes(result.nodes, 'code');
          setEdges(result.edges, 'code');
        }
        setCodeErrors(result.errors);
      } finally {
        setSyncInProgress(false);
      }
    },
    [setNodes, setEdges, setCodeErrors, setSyncInProgress]
  );

  useEffect(() => {
    if (syncSource !== 'code' || syncInProgress) return;
    clearTimeout(codeTimerRef.current);
    codeTimerRef.current = setTimeout(() => doCodeSync(code), 400);
    return () => clearTimeout(codeTimerRef.current);
  }, [code, syncSource, syncInProgress, doCodeSync]);

  // Recalculate complexity
  useEffect(() => {
    const costs = complexityData.costs as Record<string, number>;
    let total = 0;
    for (const node of nodes) {
      total += costs[node.data.registryType] ?? 0;
    }
    setTotalCost(total);

    // Update cost on output node
    const outputNode = nodes.find((n) => n.data.registryType === 'output');
    if (outputNode && outputNode.data.cost !== total) {
      // Update inline without triggering full sync cycle
      useAppStore.setState((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === outputNode.id
            ? { ...n, data: { ...n.data, cost: total } }
            : n
        ) as AppNode[],
      }));
    }
  }, [nodes, setTotalCost]);

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
      position: { x: 0, y: 150 },
      data: {
        registryType: 'positionGeometry',
        label: 'Position',
        cost: costs.positionGeometry ?? 0,
        values: {},
      } as ShaderNodeData,
    },
    {
      id: noiseId,
      type: 'shader',
      position: { x: 250, y: 100 },
      data: {
        registryType: 'noise',
        label: 'Noise',
        cost: costs.noise ?? 0,
        values: {},
      } as ShaderNodeData,
    },
    {
      id: colorId,
      type: 'shader',
      position: { x: 250, y: 300 },
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
      position: { x: 500, y: 180 },
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
      position: { x: 750, y: 180 },
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

    const { nodes, edges } = createInitialNodes();
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
