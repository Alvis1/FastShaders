import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import { autoLayout } from '@/engine/layoutEngine';
import { topologicalSort } from '@/engine/topologicalSort';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import complexityData from '@/registry/complexity.json';
import { isTSLTexturesCode } from '@/engine/evaluateTSLScript';
import type { AppNode, AppEdge } from '@/types';

const NODE_W = 100;
const NODE_H = 40;
const RANK_GAP = NODE_W + 40;

function findFreePosition(occupied: { x: number; y: number }[]): { x: number; y: number } {
  const cx = occupied.length > 0
    ? occupied.reduce((s, p) => s + p.x, 0) / occupied.length
    : 0;
  const cy = occupied.length > 0
    ? occupied.reduce((s, p) => s + p.y, 0) / occupied.length
    : 0;

  for (let r = 1; r < 20; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = cx + dx * (NODE_W + 40);
        const y = cy + dy * (NODE_H + 30);
        const overlaps = occupied.some(
          (p) => Math.abs(p.x - x) < NODE_W + 20 && Math.abs(p.y - y) < NODE_H + 20,
        );
        if (!overlaps) return { x, y };
      }
    }
  }
  return { x: cx + occupied.length * (NODE_W + 40), y: cy };
}

function enforceFlowOrder(nodes: AppNode[], edges: AppEdge[]): AppNode[] {
  const posMap = new Map<string, { x: number; y: number }>();
  for (const n of nodes) posMap.set(n.id, { ...n.position });

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }

  const sorted = topologicalSort(nodes, edges);

  for (const node of sorted) {
    const srcPos = posMap.get(node.id);
    if (!srcPos) continue;
    for (const tgt of adj.get(node.id) ?? []) {
      const tgtPos = posMap.get(tgt);
      if (!tgtPos) continue;
      const minX = srcPos.x + RANK_GAP;
      if (tgtPos.x < minX) {
        tgtPos.x = minX;
      }
    }
  }

  return nodes.map((n) => ({ ...n, position: posMap.get(n.id) ?? n.position }));
}

export function useSyncEngine() {
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
  const setActiveScript = useAppStore((s) => s.setActiveScript);
  const codeSyncRequested = useAppStore((s) => s.codeSyncRequested);

  // Undo / Redo keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z') return;

      const active = document.activeElement;
      if (active?.closest('.monaco-editor')) return;

      e.preventDefault();
      if (e.shiftKey) {
        useAppStore.getState().redo();
      } else {
        useAppStore.getState().undo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const prevNodesRef = useRef(nodes);
  const prevEdgesRef = useRef(edges);

  // Graph → Code
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
      if (useAppStore.getState().isUndoRedo) {
        useAppStore.setState({ isUndoRedo: false });
      }
    }
  }, [nodes, edges, syncSource, syncInProgress, setCode, setSyncInProgress]);

  // Code → Graph
  const doCodeSync = useCallback(
    (codeStr: string) => {
      if (isTSLTexturesCode(codeStr)) {
        setActiveScript(codeStr);
        setCodeErrors([]);
        return;
      }

      setActiveScript(null);
      setSyncInProgress(true);
      try {
        const result = codeToGraph(codeStr, NODE_REGISTRY);
        if (result.errors.length === 0 && result.nodes.length > 0) {
          useAppStore.getState().pushHistory();
          const oldNodes = useAppStore.getState().nodes;

          const usedOldIds = new Set<string>();
          const positioned: AppNode[] = [];
          const unpositioned: AppNode[] = [];

          for (const newNode of result.nodes) {
            const match = oldNodes.find(
              (old) =>
                !usedOldIds.has(old.id) &&
                old.data.label === newNode.data.label &&
                old.data.registryType === newNode.data.registryType,
            );
            if (match) {
              usedOldIds.add(match.id);
              positioned.push({ ...newNode, position: { ...match.position } });
            } else {
              unpositioned.push(newNode);
            }
          }

          let finalNodes: AppNode[];
          if (unpositioned.length > 0 && positioned.length === 0) {
            finalNodes = autoLayout([...unpositioned], result.edges, 'LR');
          } else {
            if (unpositioned.length > 0) {
              const occupied = positioned.map((n) => n.position);
              for (const node of unpositioned) {
                node.position = findFreePosition(occupied);
                occupied.push(node.position);
                positioned.push(node);
              }
            }
            finalNodes = positioned;
          }

          finalNodes = enforceFlowOrder(finalNodes, result.edges);
          setNodes(finalNodes, 'code');
          setEdges(result.edges, 'code');
        }
        setCodeErrors(result.errors);
      } finally {
        setSyncInProgress(false);
      }
    },
    [setNodes, setEdges, setCodeErrors, setSyncInProgress, setActiveScript]
  );

  // Code → Graph (triggered by Save button)
  useEffect(() => {
    if (!codeSyncRequested || syncInProgress) return;
    useAppStore.setState({ codeSyncRequested: false });
    doCodeSync(code);
  }, [codeSyncRequested, syncInProgress, doCodeSync, code]);

  // Recalculate complexity
  useEffect(() => {
    const costs = complexityData.costs as Record<string, number>;
    const outputNode = nodes.find((n) => n.data.registryType === 'output');

    let total = 0;
    if (outputNode) {
      const visited = new Set<string>();
      const queue = [outputNode.id];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        for (const e of edges) {
          if (e.target === id && !visited.has(e.source)) queue.push(e.source);
        }
      }
      for (const node of nodes) {
        if (visited.has(node.id) && node.id !== outputNode.id) {
          total += costs[node.data.registryType] ?? 0;
        }
      }
    }

    setTotalCost(total);

    if (outputNode && outputNode.data.cost !== total) {
      useAppStore.setState((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === outputNode.id
            ? { ...n, data: { ...n.data, cost: total } }
            : n
        ) as AppNode[],
      }));
    }
  }, [nodes, edges, setTotalCost]);
}
