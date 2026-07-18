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
import { formatNodeLabel, formatCategoryLabel, nodeDescription, t } from '@/i18n';
import type { NodeDefinition, AppNode, AppEdge, ShaderNodeData, OutputNodeData } from '@/types';
import { getNodeValues } from '@/types';
import { generateId } from '@/utils/idGenerator';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { getCostTextColor } from '@/utils/colorUtils';
import { nextPropertyName } from '@/utils/propertyConvert';
import { getRecentNodeTypes, noteNodeUsed } from './recentNodes';
import complexityData from '@/registry/complexity.json';

const COSTS = complexityData.costs as Record<string, number>;

/**
 * Flat, render-order action item used for keyboard navigation. Mirrors what's
 * actually drawn (group entry, output entry, then defs in their grouped or
 * flat-search order) so ArrowUp/Down + Enter behaviour matches what the user
 * sees.
 */
type ActionItem =
  | { kind: 'organize'; key: string; run: () => void }
  | { kind: 'group'; key: string; run: () => void }
  | { kind: 'output'; key: string; run: () => void }
  | { kind: 'note'; key: string; run: () => void }
  | { kind: 'def'; key: string; def: NodeDefinition; run: () => void };

export function AddNodeMenu() {
  const [query, setQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  // MRU node types, read once when the menu opens (it remounts each open, so
  // the previous add is already persisted). Stable for this menu's lifetime.
  const [recentTypes] = useState(getRecentNodeTypes);
  const listRef = useRef<HTMLDivElement>(null);
  const contextMenu = useAppStore((s) => s.contextMenu);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const addNode = useAppStore((s) => s.addNode);
  const addNote = useAppStore((s) => s.addNote);
  const setEdges = useAppStore((s) => s.setEdges);
  const nodes = useAppStore((s) => s.nodes);
  const groupSelection = useAppStore((s) => s.groupSelection);
  const organizeSelection = useAppStore((s) => s.organizeSelection);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const language = useAppStore((s) => s.language);
  const { screenToFlowPosition } = useReactFlow();

  // Selected nodes eligible for grouping — excludes groups + notes (annotations).
  const selectedGroupable = useMemo(
    () => nodes.filter((n) => n.selected && n.type !== 'group' && n.type !== 'note'),
    [nodes],
  );
  const canGroup = selectedGroupable.length >= 2;
  // Organize re-lays the selection: groups participate as single units (their
  // members ride along), only notes are excluded (annotations have no place in
  // the dataflow layout).
  const selectedOrganizable = useMemo(
    () => nodes.filter((n) => n.selected && n.type !== 'note'),
    [nodes],
  );
  const canOrganize = selectedOrganizable.length >= 2;

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

  // "Recent" nodes floated to the top of the browse view (no active search):
  // the MRU list resolved to real, addable defs. `output` is excluded (it has
  // its own add row and is a singleton) and stale/hidden types are dropped.
  const recentDefs = useMemo(() => {
    if (query.trim() || recentTypes.length === 0) return [];
    const addable = new Set(getAllDefinitions().map((d) => d.type));
    const defs: NodeDefinition[] = [];
    for (const type of recentTypes) {
      if (type === 'output' || !addable.has(type)) continue;
      const def = NODE_REGISTRY.get(type);
      if (def) defs.push(def);
    }
    return defs;
  }, [query, recentTypes]);

  const handleAddNode = useCallback((def: NodeDefinition) => {
    const position = screenToFlowPosition({
      x: contextMenu.x,
      y: contextMenu.y,
    });
    const cost = COSTS[def.type] ?? 0;

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

      // Auto-name property nodes: max existing suffix + 1 (shared with the
      // convert-to-uniform path so both mint from one sequence).
      let values = { ...def.defaultValues };
      if (def.type === 'property_float' || def.type === 'property_color') {
        const prefix = def.type === 'property_color' ? 'color' : 'property';
        values = { ...values, name: nextPropertyName(prefix, nodes) };
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
      // Remember this type so it floats to the top of the menu next time.
      noteNodeUsed(def.type);
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

  const handleOrganizeSelection = useCallback(() => {
    organizeSelection();
    closeContextMenu();
  }, [organizeSelection, closeContextMenu]);

  const handleAddNote = useCallback(() => {
    addNote(screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y }));
    closeContextMenu();
  }, [addNote, screenToFlowPosition, contextMenu.x, contextMenu.y, closeContextMenu]);

  // Build the flat keyboard-traversable list in the same order things render.
  // ArrowUp/Down step through this list; Enter runs the focused item's action.
  const actionItems: ActionItem[] = useMemo(() => {
    const items: ActionItem[] = [];
    if (!query.trim() && canOrganize) {
      items.push({ kind: 'organize', key: '__organize__', run: handleOrganizeSelection });
    }
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
    // Recent nodes render above the category list (distinct `recent:` keys so a
    // def appearing here AND in its category stays two independent focus stops).
    for (const def of recentDefs) {
      items.push({ kind: 'def', key: `recent:${def.type}`, def, run: () => handleAddNode(def) });
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
  }, [query, canGroup, canOrganize, nodes, grouped, results, recentDefs, handleGroupSelection, handleOrganizeSelection, handleAddNode, handleAddNote]);

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
  const renderDefRow = (def: NodeDefinition, keyOverride?: string) => {
    // The Recent section reuses this row but under a `recent:`-prefixed key so
    // it's a distinct focus stop from the same def down in its category.
    const key = keyOverride ?? def.type;
    const cost = COSTS[def.type] ?? 0;
    return (
      <button
        key={key}
        className={`${itemClass(key)} context-menu__item--stacked`}
        data-add-node-focused={focusedAttr(key)}
        onClick={() => handleAddNode(def)}
        onMouseEnter={() => setFocusedIndex(itemIndexByKey.get(key) ?? 0)}
      >
        <span className="context-menu__item-head">
          <span>
            {formatNodeLabel(def.label, def.type, language)}
            {/* GPU cost, same badge colour ramp (and the same `> 0` hide rule)
                the node itself uses, so the number the user picks by is the
                number they'll see on the canvas. */}
            {cost > 0 && (
              <span
                className="context-menu__item-cost"
                style={{ color: getCostTextColor(cost, costColorLow, costColorHigh) }}
              >
                {cost}
              </span>
            )}
          </span>
          <span className="context-menu__item-category">
            {formatCategoryLabel(def.category, def.category, language)}
          </span>
        </span>
        {def.description && (
          <span className="context-menu__item-desc">
            {nodeDescription(def.description, def.type, language)}
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      <input
        className="context-menu__search"
        placeholder={t('Search nodes...', language)}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />
      <div className="context-menu__list" ref={listRef}>
        {/* Selection actions — only when 2+ eligible nodes are selected */}
        {!query.trim() && (canOrganize || canGroup) && (
          <>
            <div className="context-menu__category">{t('Selection', language)}</div>
            {canOrganize && (
              <button
                className={itemClass('__organize__')}
                data-add-node-focused={focusedAttr('__organize__')}
                onClick={handleOrganizeSelection}
                onMouseEnter={() => setFocusedIndex(itemIndexByKey.get('__organize__') ?? 0)}
              >
                <span>{t('Organize', language)}</span>
                <span className="context-menu__item-category">
                  {selectedOrganizable.length} {t('nodes', language)}
                </span>
              </button>
            )}
            {canGroup && (
              <button
                className={itemClass('__group__')}
                data-add-node-focused={focusedAttr('__group__')}
                onClick={handleGroupSelection}
                onMouseEnter={() => setFocusedIndex(itemIndexByKey.get('__group__') ?? 0)}
              >
                <span>{t('Group Selection', language)}</span>
                <span className="context-menu__item-category">
                  {selectedGroupable.length} {t('nodes', language)}
                </span>
              </button>
            )}
            <div className="context-menu__divider" />
          </>
        )}

        {/* Add output node option */}
        {!query.trim() && !nodes.some((n) => n.data.registryType === 'output') && (
          <>
            <div className="context-menu__category">
              {formatCategoryLabel('Output', 'output', language, true)}
            </div>
            <button
              className={itemClass('__output__')}
              data-add-node-focused={focusedAttr('__output__')}
              onClick={() => handleAddNode(NODE_REGISTRY.get('output')!)}
              onMouseEnter={() => setFocusedIndex(itemIndexByKey.get('__output__') ?? 0)}
            >
              <span>{formatNodeLabel('Output', 'output', language)}</span>
              <span className="context-menu__item-category">output</span>
            </button>
          </>
        )}

        {/* Add a free-floating sticky note */}
        {!query.trim() && (
          <>
            <div className="context-menu__category">{t('Annotate', language)}</div>
            <button
              className={itemClass('__note__')}
              data-add-node-focused={focusedAttr('__note__')}
              onClick={handleAddNote}
              onMouseEnter={() => setFocusedIndex(itemIndexByKey.get('__note__') ?? 0)}
            >
              <span>{t('Add Note', language)}</span>
              <span className="context-menu__item-category">note</span>
            </button>
            <div className="context-menu__divider" />
          </>
        )}

        {/* Recently-used nodes, newest first — floated above the category list */}
        {!query.trim() && recentDefs.length > 0 && (
          <>
            <div className="context-menu__category">{t('Recent', language)}</div>
            {recentDefs.map((def) => renderDefRow(def, `recent:${def.type}`))}
            <div className="context-menu__divider" />
          </>
        )}

        {grouped
          ? // Grouped by category
            CATEGORIES.filter((c) => grouped.has(c.id) && c.id !== 'output').map((cat) => (
              <div key={cat.id}>
                <div className="context-menu__category">
                  {formatCategoryLabel(cat.label, cat.id, language, true)}
                </div>
                {grouped.get(cat.id)!.map((def) => renderDefRow(def))}
              </div>
            ))
          : // Flat search results
            results.map((def) => renderDefRow(def))}
      </div>
    </>
  );
}
