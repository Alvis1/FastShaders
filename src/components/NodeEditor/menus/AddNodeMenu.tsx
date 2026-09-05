import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import {
  searchNodes,
  getEditorDefinitions,
  NODE_REGISTRY,
  getFlowNodeType,
  displayDescription,
} from '@/registry/nodeRegistry';
import { CATEGORIES } from '@/registry/nodeCategories';
import { formatNodeLabel, formatCategoryLabel, nodeDescription, t } from '@/i18n';
import type { NodeDefinition, AppNode, AppEdge, ShaderNodeData, OutputNodeData } from '@/types';
import { generateId } from '@/utils/idGenerator';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { getCostTextColor } from '@/utils/colorUtils';
import { initialNodeValues } from '@/utils/newNodeValues';
import { getRecentNodeTypes, noteNodeUsed } from './recentNodes';
import { hiddenOptionalCategories } from '@/registry/optionalCategories';
import complexityData from '@/registry/complexity.json';
import { evalTask } from '@/eval/evalTask';

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
  /** Did this focus move come from the keyboard (or a list swap)? Only those
   *  may scroll the list — see the scroll effect below. */
  const scrollOnFocusRef = useRef(false);
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

  // getEditorDefinitions (and searchNodes, which filters the same way): a node
  // switched off in node-editor.html is not offerable here either — browse or
  // search. See registry/editorVisibility.ts. Both take `hidden`, the optional
  // categories the user has not switched on (Distance fields is off by
  // default — registry/optionalCategories.ts): an add surface passes it on
  // EVERY call, or the search box types the family back into existence.
  const optional = useAppStore((s) => s.optionalCategories);
  const hidden = useMemo(() => hiddenOptionalCategories(optional), [optional]);
  const results = useMemo(() => {
    if (query.trim()) return searchNodes(query, hidden);
    return getEditorDefinitions(hidden).filter((d) => d.type !== 'output');
  }, [query, hidden]);

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
    const addable = new Set(getEditorDefinitions(hidden).map((d) => d.type));
    const defs: NodeDefinition[] = [];
    for (const type of recentTypes) {
      if (type === 'output' || !addable.has(type)) continue;
      const def = NODE_REGISTRY.get(type);
      if (def) defs.push(def);
    }
    return defs;
  }, [query, recentTypes, hidden]);

  const handleAddNode = useCallback((def: NodeDefinition) => {
    const position = screenToFlowPosition({
      x: contextMenu.x,
      y: contextMenu.y,
    });
    const cost = COSTS[def.type] ?? 0;

    let newNodeId: string;

    if (def.type === 'output') {
      // Several Outputs may coexist; exactly one is ACTIVE (utils/sdfPartition.ts
      // `activeSink`), chosen by clicking a node's preview socket. A new one
      // arrives INACTIVE unless it is the graph's first, so adding it changes
      // nothing on screen until the user picks it.
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

      // Property auto-naming + a random colour for colour nodes — shared with
      // the palette-tile drop path so both surfaces add identical nodes.
      const values = initialNodeValues(def, nodes);

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
    if (!query.trim()) {
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
    scrollOnFocusRef.current = true;   // a new list: bring row 0 back into view
    setFocusedIndex(0);
  }, [actionItems.length, query]);

  // Scroll the focused item into view as the user arrows past the visible
  // bounds. `block: 'nearest'` keeps the menu from jumping when the item is
  // already visible.
  //
  // ONLY for keyboard moves and list swaps. Hover sets `focusedIndex` too, and
  // scrolling then is both pointless — the row is under the cursor, so it is on
  // screen — and actively harmful: a row clipped by the list's bottom edge got
  // nudged into view, the resulting `scroll` event is one of TooltipLayer's
  // dismiss triggers, and it fired inside the 1s dwell of the tooltip that the
  // very same hover had just armed. The pointer is then at rest, so no further
  // `mouseover` ever re-arms it: those rows could never show their description,
  // which since the description moved into the tooltip is the only place it
  // exists. (Measured: hovering the clipped row moved scrollTop 47 → 66 and the
  // tooltip never appeared.)
  useEffect(() => {
    if (!scrollOnFocusRef.current) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      '[data-add-node-focused="true"]',
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex, actionItems.length]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Every key below that MOVES the focus wants the list to follow it — the
    // point of arrowing is to reach rows that are off screen.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      scrollOnFocusRef.current = true;
    }
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
    } else if (e.key === 'Escape') {
      // The search box autofocuses, so Escape lands HERE, not on the document
      // listener in ContextMenu (which skips INPUT targets so a DragNumberInput
      // edit can still cancel without closing its menu).
      e.preventDefault();
      closeContextMenu();
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

  /** Hover-focus: the same focus move, minus the scroll (see the effect). */
  const hoverFocus = (key: string) => {
    scrollOnFocusRef.current = false;
    setFocusedIndex(itemIndexByKey.get(key) ?? 0);
  };

  // One row renderer for both the grouped and flat-search lists.
  //
  // The description rides the row's `title`, NOT a second line inside it: the
  // app-wide TooltipLayer (mounted in AppLayout) delegates from `document`,
  // borrows the title and draws the styled, viewport-clamped tooltip — the
  // same explanation, in the same place, as the palette tiles'. Rendering it
  // in the row turned a list you SCAN into a wall of prose: every one of ~74
  // nodes carried a paragraph, and the widest of them (Data Viz, 274 chars) is
  // what forced `.context-menu--add-node`'s fixed width in the first place.
  //
  // Keyboard note: ArrowUp/Down move `focusedIndex`, not DOM focus (the search
  // box keeps it), so arrowing a row does not raise its tooltip — hovering it
  // does. That is the trade the inline line was paying for.
  const renderDefRow = (def: NodeDefinition, keyOverride?: string) => {
    // The Recent section reuses this row but under a `recent:`-prefixed key so
    // it's a distinct focus stop from the same def down in its category.
    const key = keyOverride ?? def.type;
    const cost = COSTS[def.type] ?? 0;
    // displayDescription strips the `Also: …` alias tail — that tail is search
    // fodder for nodeMatchRank, never UI text, and the inline line printed it.
    const desc = def.description
      ? nodeDescription(displayDescription(def), def.type, language)
      : undefined;
    return (
      <button
        key={key}
        className={itemClass(key)}
        title={desc}
        data-add-node-focused={focusedAttr(key)}
        onClick={() => handleAddNode(def)}
        onMouseEnter={() => hoverFocus(key)}
      >
        <span>
          {formatNodeLabel(def.label, def.type, language)}
          {/* GPU cost, same badge colour ramp (and the same `> 0` hide rule)
              the node itself uses, so the number the user picks by is the
              number they'll see on the canvas. */}
          {/* Gated in React rather than by the CSS sweep in eval/eval.css: this
              is prose in a flex row, and hiding it would leave a gap where a
              number was. See the pointless-arm rule there. */}
          {cost > 0 && evalTask().pointsVisible && (
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
                onMouseEnter={() => hoverFocus('__organize__')}
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
                onMouseEnter={() => hoverFocus('__group__')}
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

        {/* The Output row, always offered: a graph may hold several output
            nodes (one ACTIVE — utils/sdfPartition.ts), so this simply adds
            one, inactive unless it is the first. A row that vanished would
            read as the node not existing at all. */}
                {!query.trim() && (
          <>
            <div className="context-menu__category">
              {formatCategoryLabel('Output', 'output', language, true)}
            </div>
            <button
              className={itemClass('__output__')}
              title={NODE_REGISTRY.get('output')?.description
                ? nodeDescription(displayDescription(NODE_REGISTRY.get('output')!), 'output', language)
                : undefined}
              data-add-node-focused={focusedAttr('__output__')}
              onClick={() => handleAddNode(NODE_REGISTRY.get('output')!)}
              onMouseEnter={() => hoverFocus('__output__')}
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
              onMouseEnter={() => hoverFocus('__note__')}
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
