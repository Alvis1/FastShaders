import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { getNodeValues } from '@/types';
import { generateId } from '@/utils/idGenerator';
import { makeTypedEdge } from '@/utils/edgeUtils';
import complexityData from '@/registry/complexity.json';

/**
 * Flat, render-order action item used for keyboard navigation. Mirrors what's
 * actually drawn (group entry, output entry, then defs in their grouped or
 * flat-search order) so ArrowUp/Down + Enter behaviour matches what the user
 * sees.
 */
type ActionItem =
  | { kind: 'group'; key: string; run: () => void }
  | { kind: 'output'; key: string; run: () => void }
  | { kind: 'note'; key: string; run: () => void }
  | { kind: 'def'; key: string; def: NodeDefinition; run: () => void };

export function AddNodeMenu() {
  const [query, setQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const contextMenu = useAppStore((s) => s.contextMenu);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const addNode = useAppStore((s) => s.addNode);
  const addNote = useAppStore((s) => s.addNote);
  const setEdges = useAppStore((s) => s.setEdges);
  const nodes = useAppStore((s) => s.nodes);
  const groupSelection = useAppStore((s) => s.groupSelection);
  const { screenToFlowPosition } = useReactFlow();

  // Selected nodes eligible for grouping — excludes groups + notes (annotations).
  const selectedGroupable = useMemo(
    () => nodes.filter((n) => n.selected && n.type !== 'group' && n.type !== 'note'),
    [nodes],
  );
  const canGroup = selectedGroupable.length >= 2;

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

  const handleAddNode = useCallback((def: NodeDefinition) => {
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
          const name = String(getNodeValues(n)?.name ?? '');
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
        store.pushHistory();
        const newEdge = makeTypedEdge(sourceNodeId, sourceHandleId, newNodeId, firstInput.id);
        setEdges([...store.edges, newEdge] as AppEdge[]);
      }
    }

    closeContextMenu();
  }, [contextMenu.x, contextMenu.y, screenToFlowPosition, nodes, addNode, closeContextMenu, sourceNodeId, sourceHandleId, setEdges]);

  const handleGroupSelection = useCallback(() => {
    groupSelection(selectedGroupable.map((n) => n.id));
    closeContextMenu();
  }, [groupSelection, selectedGroupable, closeContextMenu]);

  const handleAddNote = useCallback(() => {
    addNote(screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y }));
    closeContextMenu();
  }, [addNote, screenToFlowPosition, contextMenu.x, contextMenu.y, closeContextMenu]);

  // Build the flat keyboard-traversable list in the same order things render.
  // ArrowUp/Down step through this list; Enter runs the focused item's action.
  const actionItems: ActionItem[] = useMemo(() => {
    const items: ActionItem[] = [];
    if (!query.trim() && canGroup) {
      items.push({ kind: 'group', key: '__group__', run: handleGroupSelection });
    }
    if (!query.trim() && !nodes.some((n) => n.data.registryType === 'output')) {
      items.push({
        kind: 'output',
        key: '__output__',
        run: () => handleAddNode(NODE_REGISTRY.get('output')!),
      });
    }
    if (!query.trim()) {
      items.push({ kind: 'note', key: '__note__', run: handleAddNote });
    }
    if (grouped) {
      for (const cat of CATEGORIES) {
        if (cat.id === 'output' || !grouped.has(cat.id)) continue;
        for (const def of grouped.get(cat.id)!) {
          items.push({ kind: 'def', key: def.type, def, run: () => handleAddNode(def) });
        }
      }
    } else {
      for (const def of results) {
        items.push({ kind: 'def', key: def.type, def, run: () => handleAddNode(def) });
      }
    }
    return items;
  }, [query, canGroup, nodes, grouped, results, handleGroupSelection, handleAddNode, handleAddNote]);

  // Reset focus to the first item whenever the visible list changes (typing in
  // the search box, selection toggling, output-node presence flipping, etc.).
  useEffect(() => {
    setFocusedIndex(0);
  }, [actionItems.length, query]);

  // Scroll the focused item into view as the user arrows past the visible
  // bounds. `block: 'nearest'` keeps the menu from jumping when the item is
  // already visible.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      '[data-add-node-focused="true"]',
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex, actionItems.length]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (actionItems.length === 0) return;
      setFocusedIndex((i) => (i + 1) % actionItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (actionItems.length === 0) return;
      setFocusedIndex((i) => (i - 1 + actionItems.length) % actionItems.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusedIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      if (actionItems.length === 0) return;
      setFocusedIndex(actionItems.length - 1);
    } else if (e.key === 'Enter') {
      if (actionItems.length === 0) return;
      e.preventDefault();
      const item = actionItems[focusedIndex] ?? actionItems[0];
      item.run();
    }
  };

  const itemIndexByKey = useMemo(() => {
    const m = new Map<string, number>();
    actionItems.forEach((it, i) => m.set(it.key, i));
    return m;
  }, [actionItems]);

  const itemClass = (key: string) => {
    const i = itemIndexByKey.get(key);
    return i === focusedIndex
      ? 'context-menu__item context-menu__item--focused'
      : 'context-menu__item';
  };

  const focusedAttr = (key: string) =>
    itemIndexByKey.get(key) === focusedIndex ? 'true' : undefined;

  // One row renderer for both the grouped and flat-search lists. Surfacing
  // def.description here puts the explanation at the moment of choosing —
  // previously it only existed as a palette-tile hover tooltip, so users picked
  // between ~68 node types by bare name.
  const renderDefRow = (def: NodeDefinition) => (
    <button
      key={def.type}
      className={`${itemClass(def.type)} context-menu__item--stacked`}
      data-add-node-focused={focusedAttr(def.type)}
      onClick={() => handleAddNode(def)}
      onMouseEnter={() => setFocusedIndex(itemIndexByKey.get(def.type) ?? 0)}
    >
      <span className="context-menu__item-head">
        <span>{def.label}</span>
        <span className="context-menu__item-category">{def.category}</span>
      </span>
      {def.description && <span className="context-menu__item-desc">{def.description}</span>}
    </button>
  );

  return (
    <>
      <input
        className="context-menu__search"
        placeholder="Search nodes..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />
      <div className="context-menu__list" ref={listRef}>
        {/* Group selection — only when 2+ groupable nodes are selected */}
        {!query.trim() && canGroup && (
          <>
            <div className="context-menu__category">Selection</div>
            <button
              className={itemClass('__group__')}
              data-add-node-focused={focusedAttr('__group__')}
              onClick={handleGroupSelection}
              onMouseEnter={() => setFocusedIndex(itemIndexByKey.get('__group__') ?? 0)}
            >
              <span>Group Selection</span>
              <span className="context-menu__item-category">
                {selectedGroupable.length} nodes
              </span>
            </button>
            <div className="context-menu__divider" />
          </>
        )}

        {/* Add output node option */}
        {!query.trim() && !nodes.some((n) => n.data.registryType === 'output') && (
          <>
            <div className="context-menu__category">Output</div>
            <button
              className={itemClass('__output__')}
              data-add-node-focused={focusedAttr('__output__')}
              onClick={() => handleAddNode(NODE_REGISTRY.get('output')!)}
              onMouseEnter={() => setFocusedIndex(itemIndexByKey.get('__output__') ?? 0)}
            >
              <span>Output Node</span>
              <span className="context-menu__item-category">output</span>
            </button>
          </>
        )}

        {/* Add a free-floating sticky note */}
        {!query.trim() && (
          <>
            <div className="context-menu__category">Annotate</div>
            <button
              className={itemClass('__note__')}
              data-add-node-focused={focusedAttr('__note__')}
              onClick={handleAddNote}
              onMouseEnter={() => setFocusedIndex(itemIndexByKey.get('__note__') ?? 0)}
            >
              <span>Add Note</span>
              <span className="context-menu__item-category">note</span>
            </button>
            <div className="context-menu__divider" />
          </>
        )}

        {grouped
          ? // Grouped by category
            CATEGORIES.filter((c) => grouped.has(c.id) && c.id !== 'output').map((cat) => (
              <div key={cat.id}>
                <div className="context-menu__category">{cat.label}</div>
                {grouped.get(cat.id)!.map(renderDefRow)}
              </div>
            ))
          : // Flat search results
            results.map(renderDefRow)}
      </div>
    </>
  );
}
