import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import { autoLayout } from '@/engine/layoutEngine';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { computeReachableCost } from '@/utils/nodeCost';
import { findDefaultOutput } from '@/utils/outputMaterials';
import { isDirectAssignmentCode } from '@/engine/evaluateTSLScript';
import { autoExposeConnectedParamPorts } from '@/utils/exposedPorts';
import { sameGraphSemantics } from '@/utils/graphSemantics';
import type { AppNode } from '@/types';
import { generateEdgeId } from '@/utils/idGenerator';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';


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
  const setSyncInProgress = useAppStore((s) => s.setSyncInProgress);
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
      // Clear cached code so graph→code sync regenerates after undo/redo
      lastSyncedCodeRef.current = '';
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
    // Position/selection-only updates (every drag pointermove mints a new
    // array identity) can't change generated code — skip the whole pass, not
    // just the store writes. Never skip while isUndoRedo is set: this effect
    // doubles as the undo path's reconciliation point and must reach the
    // flag-clearing `finally` below (undo/redo structuredClones the arrays,
    // so its `data` refs are always fresh and the predicate is false anyway —
    // this guard covers the empty-graph corner where the scan is vacuous).
    const inert =
      !useAppStore.getState().isUndoRedo &&
      sameGraphSemantics(prevNodesRef.current, nodes, prevEdgesRef.current, edges);
    prevNodesRef.current = nodes;
    prevEdgesRef.current = edges;
    if (inert) return;

    setSyncInProgress(true);
    try {
      const result = graphToCode(nodes, edges, NODE_REGISTRY);
      setCode(result.code, 'graph');
      lastSyncedCodeRef.current = result.code;
      // Update node variable names for display
      const names: Record<string, string> = {};
      result.varNames.forEach((v, k) => { names[k] = v; });
      useAppStore.getState().setNodeVarNames(names);
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
      if (isDirectAssignmentCode(codeStr)) {
        setCodeErrors([]);
        return;
      }

      setSyncInProgress(true);
      try {
        const result = codeToGraph(codeStr);
        const hasBlockingErrors = result.errors.some(e => e.severity !== 'warning');
        if (!hasBlockingErrors) {
          if (!skipHistory) {
            useAppStore.getState().pushHistory();
          }
          const oldNodes = useAppStore.getState().nodes;
          // Routing waypoints live on edge.data and aren't reconstructable from
          // the code text — carry them across the resync by matching edges on
          // their (source,sourceHandle,target,targetHandle) tuple, mirroring how
          // group nodes are preserved below. Keyed on the OLD node ids (the
          // remapped edges resolve back to those via idMap).
          const oldEdges = useAppStore.getState().edges;
          const waypointKey = (s: string, sh: string | null | undefined, t: string, th: string | null | undefined) =>
            `${s}\0${sh ?? 'out'}\0${t}\0${th ?? 'in'}`;
          const oldWaypoints = new Map<string, Array<{ x: number; y: number }>>();
          for (const oe of oldEdges) {
            const wps = (oe.data as { waypoints?: Array<{ x: number; y: number }> } | undefined)?.waypoints;
            if (wps && wps.length) {
              oldWaypoints.set(waypointKey(oe.source, oe.sourceHandle, oe.target, oe.targetHandle), wps);
            }
          }

          // Build ID mapping: newId → oldId (preserves React Flow identity)
          const idMap = new Map<string, string>();
          const usedOldIds = new Set<string>();
          const positioned: AppNode[] = [];

          // Index old nodes by registryType+label and registryType for O(n) lookup.
          //
          // Pass-1 identity. Per-mesh materials live INSIDE the one Output
          // node, so there is only ever one to pair and its materials ride
          // along with it — no per-material key is needed here. (While each
          // targeted mesh had its own Output NODE this key had to fold the
          // mesh in: every parsed Output is labelled literally "Output", so
          // they all collapsed into one bucket and paired by array order,
          // silently swapping one material's values and settings onto
          // another. That whole class is gone with the extra nodes.)
          const matchKey = (n: AppNode): string =>
            `${n.data.registryType}\0${n.data.label}`;
          const oldByExactKey = new Map<string, AppNode[]>();
          const oldByType = new Map<string, AppNode[]>();
          for (const old of oldNodes) {
            const exactKey = matchKey(old);
            if (!oldByExactKey.has(exactKey)) oldByExactKey.set(exactKey, []);
            oldByExactKey.get(exactKey)!.push(old);
            if (!oldByType.has(old.data.registryType)) oldByType.set(old.data.registryType, []);
            oldByType.get(old.data.registryType)!.push(old);
          }

          // Merge a matched old node with a new node: preserve position + UI-only data
          const mergeMatch = (newNode: AppNode, match: AppNode): AppNode => {
            const merged = {
              ...newNode,
              id: match.id,
              position: { ...match.position },
            };
            // Preserve exposedPorts from the old node — mostly not
            // reconstructed by codeToGraph. For the OUTPUT node, union in the
            // channels that carry STORED VALUES in the new parse (an inline
            // `metalness: float(0.9)` typed in the code panel must stay
            // visible — its emission is exposure-gated, so hiding it would
            // silently drop the very line the user just typed on the next
            // graph→code pass). ONLY the valued channels, never the parse's
            // whole seeded list: that list includes the implicit defaults,
            // and unioning those resurrected a default channel the user had
            // explicitly hidden in Shader Settings.
            // Carry the old OUTPUT node's stored channel values for channels
            // that are WIRED in the new parse. A wired channel's stored value
            // cannot appear in the code text (the edge ref wins at emission),
            // so the parse can never legitimately clear it — without this,
            // any code-panel Apply wiped the value the widget deliberately
            // retains under a wire, and a later disconnect landed on UNSET
            // instead of the user's number/color. Unwired channels stay
            // code-authoritative: literal present → value, absent → cleared.
            if (merged.data.registryType === 'output') {
              const oldValues = (match.data as { values?: Record<string, string | number> })
                .values;
              if (oldValues) {
                const carried = {
                  ...((merged.data as { values?: Record<string, string | number> }).values ?? {}),
                };
                let changed = false;
                for (const [ch, v] of Object.entries(oldValues)) {
                  const wired = result.edges.some(
                    (e) => e.target === newNode.id && e.targetHandle === ch,
                  );
                  if (carried[ch] === undefined && wired) {
                    carried[ch] = v;
                    changed = true;
                  }
                }
                if (changed) {
                  (merged.data as Record<string, unknown>).values = carried;
                }
              }
            }
            const oldExposed = (match.data as { exposedPorts?: string[] }).exposedPorts;
            if (oldExposed) {
              let next: string[] = oldExposed;
              if (merged.data.registryType === 'output') {
                const valued = Object.keys(
                  (merged.data as { values?: Record<string, unknown> }).values ?? {},
                );
                if (valued.length > 0) {
                  next = Array.from(new Set([...oldExposed, ...valued]));
                }
              }
              (merged.data as Record<string, unknown>).exposedPorts = next;
            }
            // Preserve materialSettings on output nodes
            const oldMatSettings = (match.data as Record<string, unknown>).materialSettings;
            if (oldMatSettings) {
              (merged.data as Record<string, unknown>).materialSettings = oldMatSettings;
            }
            return merged;
          };

          // Pass 1: exact match by registryType + label
          for (const newNode of result.nodes) {
            const exactKey = matchKey(newNode);
            const candidates = oldByExactKey.get(exactKey);
            const match = candidates?.find((old) => !usedOldIds.has(old.id));
            if (match) {
              usedOldIds.add(match.id);
              idMap.set(newNode.id, match.id);
              positioned.push(mergeMatch(newNode, match));
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
              positioned.push(mergeMatch(newNode, match));
            } else {
              unpositioned.push(newNode);
            }
          }

          // Remap edges to use preserved node IDs, then drop any edge whose
          // endpoint doesn't resolve to an actual parsed node — defensive
          // against parser changes; today the parser only emits self-consistent
          // edges, but the cost of one Set membership check is worth it.
          const parsedNodeIds = new Set(result.nodes.map((n) => n.id));
          const remappedEdges = result.edges
            .filter((e) => parsedNodeIds.has(e.source) && parsedNodeIds.has(e.target))
            .map((e) => {
              const src = idMap.get(e.source) ?? e.source;
              const tgt = idMap.get(e.target) ?? e.target;
              const wps = oldWaypoints.get(waypointKey(src, e.sourceHandle, tgt, e.targetHandle));
              return {
                ...e,
                source: src,
                target: tgt,
                id: generateEdgeId(src, e.sourceHandle ?? 'out', tgt, e.targetHandle ?? 'out'),
                ...(wps ? { data: { ...e.data, dataType: e.data?.dataType ?? 'any', waypoints: wps } } : {}),
              };
            });

          let finalNodes: AppNode[];
          if (unpositioned.length > 0) {
            // New or changed nodes — auto-layout ALL to maintain left-to-right flow
            finalNodes = autoLayout([...positioned, ...unpositioned], remappedEdges, 'LR');
          } else {
            finalNodes = positioned;
          }

          // Preserve group nodes from the old graph — codeToGraph doesn't know about
          // them, so they'd otherwise be lost on every Save. Carry over both the
          // group containers themselves AND any parentId/extent on members whose
          // ID survived the merge. Skip when autoLayout ran: positions are now
          // absolute and reattaching them as group-relative would put children in
          // the wrong place.
          const oldGroups =
            unpositioned.length > 0 ? [] : oldNodes.filter((n) => n.type === 'group');
          if (oldGroups.length > 0) {
            const survivingIds = new Set(finalNodes.map((n) => n.id));
            const oldById = new Map(oldNodes.map((n) => [n.id, n]));

            // Restore parentId/extent on surviving children whose old node had them.
            finalNodes = finalNodes.map((n) => {
              const old = oldById.get(n.id);
              if (!old || !old.parentId) return n;
              // Only re-attach if the parent group is also surviving (it always
              // should be since we re-add groups below, but guard regardless).
              const restored = { ...n, parentId: old.parentId } as AppNode;
              if ((old as { extent?: 'parent' }).extent) {
                (restored as { extent?: 'parent' }).extent = 'parent';
              }
              return restored;
            });

            // Append surviving group nodes — but keep them BEFORE their children
            // in the array, since React Flow requires parent-before-child ordering.
            const groupsToKeep = oldGroups.filter((g) =>
              // A group is worth keeping if it still has at least one child
              // among the surviving (or freshly created) nodes.
              finalNodes.some((n) => (n as { parentId?: string }).parentId === g.id),
            );
            // Drop dangling parentIds for any child whose group is not kept.
            const keptGroupIds = new Set(groupsToKeep.map((g) => g.id));
            finalNodes = finalNodes.map((n) => {
              const pid = (n as { parentId?: string }).parentId;
              if (pid && !keptGroupIds.has(pid)) {
                const { parentId: _p, extent: _e, ...rest } = n as AppNode & { parentId?: string; extent?: unknown };
                void _p; void _e;
                return rest as AppNode;
              }
              return n;
            });
            // Groups must come first; suppress duplicates and prepend.
            const groupIdSet = new Set(groupsToKeep.map((g) => g.id));
            const withoutGroups = finalNodes.filter((n) => !groupIdSet.has(n.id));
            // Note: surviving group nodes from oldNodes carry their original
            // position/width/height/data — that's exactly what we want.
            // Survival check above already accounts for `survivingIds`.
            void survivingIds;
            finalNodes = [...groupsToKeep, ...withoutGroups];
          }

          // Auto-expose ports that have incoming edges (so handles render).
          // Shared with the load/import paths — one predicate, one union rule
          // (incl. the Output node's implicit default channels).
          autoExposeConnectedParamPorts(finalNodes, remappedEdges);

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
    [setNodes, setEdges, setCodeErrors, setSyncInProgress]
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

  // Recalculate complexity (use ref to avoid double-run when updating output node cost)
  const lastCostRef = useRef(-1);
  const prevCostGraphRef = useRef<{ nodes: AppNode[]; edges: typeof edges } | null>(null);
  useEffect(() => {
    // Same inert-frame skip as the graph→code effect above: cost reads node
    // data + reachability only, so a position/selection-only identity change
    // would re-run the BFS for an answer that cannot differ.
    const prev = prevCostGraphRef.current;
    prevCostGraphRef.current = { nodes, edges };
    if (prev && sameGraphSemantics(prev.nodes, nodes, prev.edges, edges)) return;

    // Reachable-cost BFS lives in nodeCost.ts (shared with the store's device
    // selection, so activating a measured cost profile reprices the total even
    // though it doesn't change nodes/edges). Reads the override-aware ACTIVE table.
    // Same entry-point unwrap graphToCode and cpuEvaluator do: collapse state
    // must not change the compiled output, and it must not change the budget.
    const total = computeReachableCost(nodes, unwrapCollapsedGroupEdges(nodes, edges));

    if (total === lastCostRef.current) return;
    lastCostRef.current = total;

    // Collapse the `setTotalCost` write and the output-node cost writes into a
    // single setState so we don't re-enter this effect twice for one change.
    //
    // The Output node's badge is the whole-shader total — it is one node, and
    // every material's chain is reachable from it.
    const outputNode = findDefaultOutput(nodes);
    const needsOutputUpdate = !!(outputNode && outputNode.data.cost !== total);
    useAppStore.setState((state) => ({
      totalCost: total,
      ...(needsOutputUpdate
        ? {
            nodes: state.nodes.map((n) =>
              n.id === outputNode!.id
                ? { ...n, data: { ...n.data, cost: total } }
                : n
            ) as AppNode[],
          }
        : {}),
    }));
  }, [nodes, edges]);
}
