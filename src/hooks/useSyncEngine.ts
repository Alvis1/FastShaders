import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import { autoLayout } from '@/engine/layoutEngine';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import complexityData from '@/registry/complexity.json';
import { isTSLTexturesCode } from '@/engine/evaluateTSLScript';
import type { AppNode } from '@/types';
import { generateEdgeId } from '@/utils/idGenerator';


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

  // Track last synced code to prevent sync loops
  const lastSyncedCodeRef = useRef('');

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
      lastSyncedCodeRef.current = result.code;
    } finally {
      setSyncInProgress(false);
      if (useAppStore.getState().isUndoRedo) {
        useAppStore.setState({ isUndoRedo: false });
      }
    }
  }, [nodes, edges, syncSource, syncInProgress, setCode, setSyncInProgress]);

  // Code → Graph (with stable node matching)
  const doCodeSync = useCallback(
    (codeStr: string, skipHistory = false) => {
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
          if (!skipHistory) {
            useAppStore.getState().pushHistory();
          }
          const oldNodes = useAppStore.getState().nodes;

          // Build ID mapping: newId → oldId (preserves React Flow identity)
          const idMap = new Map<string, string>();
          const usedOldIds = new Set<string>();
          const positioned: AppNode[] = [];

          // Index old nodes by registryType+label and registryType for O(n) lookup
          const oldByExactKey = new Map<string, AppNode[]>();
          const oldByType = new Map<string, AppNode[]>();
          for (const old of oldNodes) {
            const exactKey = `${old.data.registryType}\0${old.data.label}`;
            if (!oldByExactKey.has(exactKey)) oldByExactKey.set(exactKey, []);
            oldByExactKey.get(exactKey)!.push(old);
            if (!oldByType.has(old.data.registryType)) oldByType.set(old.data.registryType, []);
            oldByType.get(old.data.registryType)!.push(old);
          }

          // Pass 1: exact match by registryType + label
          for (const newNode of result.nodes) {
            const exactKey = `${newNode.data.registryType}\0${newNode.data.label}`;
            const candidates = oldByExactKey.get(exactKey);
            const match = candidates?.find((old) => !usedOldIds.has(old.id));
            if (match) {
              usedOldIds.add(match.id);
              idMap.set(newNode.id, match.id);
              positioned.push({
                ...newNode,
                id: match.id,
                position: { ...match.position },
              });
            }
          }

          // Pass 2: match remaining by registryType only
          const unpositioned: AppNode[] = [];
          for (const newNode of result.nodes) {
            if (idMap.has(newNode.id)) continue;
            const candidates = oldByType.get(newNode.data.registryType);
            const match = candidates?.find((old) => !usedOldIds.has(old.id));
            if (match) {
              usedOldIds.add(match.id);
              idMap.set(newNode.id, match.id);
              positioned.push({
                ...newNode,
                id: match.id,
                position: { ...match.position },
              });
            } else {
              unpositioned.push(newNode);
            }
          }

          // Remap edges to use preserved node IDs
          const remappedEdges = result.edges.map((e) => {
            const src = idMap.get(e.source) ?? e.source;
            const tgt = idMap.get(e.target) ?? e.target;
            return {
              ...e,
              source: src,
              target: tgt,
              id: generateEdgeId(src, e.sourceHandle ?? 'out', tgt, e.targetHandle ?? 'out'),
            };
          });

          let finalNodes: AppNode[];
          if (unpositioned.length > 0) {
            // New or changed nodes — auto-layout ALL to maintain left-to-right flow
            finalNodes = autoLayout([...positioned, ...unpositioned], remappedEdges, 'LR');
          } else {
            finalNodes = positioned;
          }

          setNodes(finalNodes, 'code');
          setEdges(remappedEdges, 'code');
        }
        if (!skipHistory) {
          setCodeErrors(result.errors);
        }
      } finally {
        setSyncInProgress(false);
      }
    },
    [setNodes, setEdges, setCodeErrors, setSyncInProgress, setActiveScript]
  );

  // Code → Graph (manual Save trigger)
  useEffect(() => {
    if (!codeSyncRequested || syncInProgress) return;
    useAppStore.setState({ codeSyncRequested: false });

    // Skip code→graph sync if the code hasn't been manually edited
    // (i.e. it was generated from the graph — nothing to parse back)
    if (code === lastSyncedCodeRef.current) return;

    lastSyncedCodeRef.current = code;
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
