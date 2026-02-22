import { useState, useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import {
  searchNodes,
  getAllDefinitions,
  NODE_REGISTRY,
  getFlowNodeType,
} from '@/registry/nodeRegistry';
import { CATEGORIES } from '@/registry/nodeCategories';
import type { NodeDefinition, AppNode, AppEdge, ShaderNodeData, OutputNodeData } from '@/types';
import { generateId, generateEdgeId } from '@/utils/idGenerator';
import complexityData from '@/registry/complexity.json';

export function AddNodeMenu() {
  const [query, setQuery] = useState('');
  const contextMenu = useAppStore((s) => s.contextMenu);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const addNode = useAppStore((s) => s.addNode);
  const setEdges = useAppStore((s) => s.setEdges);
  const nodes = useAppStore((s) => s.nodes);
  const { screenToFlowPosition } = useReactFlow();

  // Source pin info for auto-connect when dragged from an output handle
  const sourceNodeId = contextMenu.sourceNodeId;
  const sourceHandleId = contextMenu.sourceHandleId;

  const results = useMemo(() => {
    if (query.trim()) return searchNodes(query);
    return getAllDefinitions().filter((d) => d.type !== 'output');
  }, [query]);

  // Group by category when not searching
  const grouped = useMemo(() => {
    if (query.trim()) return null;
    const groups = new Map<string, NodeDefinition[]>();
    for (const def of results) {
      const cat = def.category;
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(def);
    }
    return groups;
  }, [results, query]);

  const handleAddNode = (def: NodeDefinition) => {
    const position = screenToFlowPosition({
      x: contextMenu.x,
      y: contextMenu.y,
    });
    const costs = complexityData.costs as Record<string, number>;
    const cost = costs[def.type] ?? 0;

    let newNodeId: string;

    if (def.type === 'output') {
      // Only allow one output node
      if (nodes.some((n) => n.data.registryType === 'output')) {
        closeContextMenu();
        return;
      }
      newNodeId = generateId();
      const newNode: AppNode = {
        id: newNodeId,
        type: 'output',
        position,
        data: {
          registryType: 'output',
          label: 'Output',
          cost: 0,
        } as OutputNodeData,
      };
      addNode(newNode);
    } else {
      newNodeId = generateId();

      // Auto-name property nodes: use max existing number + 1 to avoid collisions
      let values = { ...def.defaultValues };
      if (def.type === 'property_float') {
        let maxNum = 0;
        for (const n of nodes) {
          if (n.data.registryType !== 'property_float') continue;
          const name = String((n.data as { values?: Record<string, string | number> }).values?.name ?? '');
          const m = name.match(/^property(\d+)$/);
          if (m) maxNum = Math.max(maxNum, Number(m[1]));
        }
        values = { ...values, name: `property${maxNum + 1}` };
      }

      const newNode = {
        id: newNodeId,
        type: getFlowNodeType(def),
        position,
        data: {
          registryType: def.type,
          label: def.label,
          cost,
          values,
        } as ShaderNodeData,
      } as AppNode;
      addNode(newNode);
    }

    // Auto-connect from source pin if this menu was opened by dragging from an output
    if (sourceNodeId && sourceHandleId) {
      const targetDef = NODE_REGISTRY.get(def.type);
      const firstInput = targetDef?.inputs[0];
      if (firstInput) {
        const store = useAppStore.getState();
        const newEdge: AppEdge = {
          id: generateEdgeId(sourceNodeId, sourceHandleId, newNodeId, firstInput.id),
          source: sourceNodeId,
          target: newNodeId,
          sourceHandle: sourceHandleId,
          targetHandle: firstInput.id,
          type: 'typed',
          animated: true,
          data: { dataType: 'any' },
        };
        setEdges([...store.edges, newEdge] as AppEdge[]);
      }
    }

    closeContextMenu();
  };

  return (
    <>
      <input
        className="context-menu__search"
        placeholder="Search nodes..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="context-menu__list">
        {/* Add output node option */}
        {!query.trim() && !nodes.some((n) => n.data.registryType === 'output') && (
          <>
            <div className="context-menu__category">Output</div>
            <button
              className="context-menu__item"
              onClick={() => handleAddNode(NODE_REGISTRY.get('output')!)}
            >
              <span>Output Node</span>
              <span className="context-menu__item-category">output</span>
            </button>
          </>
        )}

        {grouped
          ? // Grouped by category
            CATEGORIES.filter((c) => grouped.has(c.id) && c.id !== 'output').map((cat) => (
              <div key={cat.id}>
                <div className="context-menu__category">{cat.label}</div>
                {grouped.get(cat.id)!.map((def) => (
                  <button
                    key={def.type}
                    className="context-menu__item"
                    onClick={() => handleAddNode(def)}
                  >
                    <span>{def.label}</span>
                    <span className="context-menu__item-category">{def.category}</span>
                  </button>
                ))}
              </div>
            ))
          : // Flat search results
            results.map((def) => (
              <button
                key={def.type}
                className="context-menu__item"
                onClick={() => handleAddNode(def)}
              >
                <span>{def.label}</span>
                <span className="context-menu__item-category">{def.category}</span>
              </button>
            ))}
      </div>
    </>
  );
}
