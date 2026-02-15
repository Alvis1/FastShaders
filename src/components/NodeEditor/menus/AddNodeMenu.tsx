import { useState, useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import {
  searchNodes,
  getAllDefinitions,
  NODE_REGISTRY,
} from '@/registry/nodeRegistry';
import { CATEGORIES } from '@/registry/nodeCategories';
import type { NodeDefinition, AppNode, ShaderNodeData, OutputNodeData } from '@/types';
import { generateId } from '@/utils/idGenerator';
import complexityData from '@/registry/complexity.json';

export function AddNodeMenu() {
  const [query, setQuery] = useState('');
  const contextMenu = useAppStore((s) => s.contextMenu);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const addNode = useAppStore((s) => s.addNode);
  const nodes = useAppStore((s) => s.nodes);
  const { screenToFlowPosition } = useReactFlow();

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

    if (def.type === 'output') {
      // Only allow one output node
      if (nodes.some((n) => n.data.registryType === 'output')) {
        closeContextMenu();
        return;
      }
      const newNode: AppNode = {
        id: generateId(),
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
      const newNode: AppNode = {
        id: generateId(),
        type: def.type === 'color' ? 'color' : def.category === 'noise' ? 'preview' : 'shader',
        position,
        data: {
          registryType: def.type,
          label: def.label,
          cost,
          values: { ...def.defaultValues },
        } as ShaderNodeData,
      };
      addNode(newNode);
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
