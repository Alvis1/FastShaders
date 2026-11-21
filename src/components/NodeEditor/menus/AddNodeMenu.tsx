import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { findSingletonNode } from '../singletonNodes';
import { focusNode } from '../outputFocus';
import { useAppStore } from '@/store/useAppStore';
import { connectDroppedWire, spliceNodeIntoEdge } from '../edgeInsert';
import {
  searchNodes,
  getEditorDefinitions,
  NODE_REGISTRY,
  getFlowNodeType,
  displayDescription,
} from '@/registry/nodeRegistry';
import { CATEGORIES } from '@/registry/nodeCategories';
import { formatNodeLabel, formatCategoryLabel, nodeDescription, t } from '@/i18n';
import type { NodeDefinition, AppNode, ShaderNodeData, OutputNodeData } from '@/types';
import { generateId } from '@/utils/idGenerator';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { getCostTextColor } from '@/utils/colorUtils';
import { initialNodeValues } from '@/utils/newNodeValues';
import { wantedNodeValues } from '@/tutorials/tutorialRun';
import { getRecentNodeTypes, noteNodeUsed } from './recentNodes';
import { hiddenOptionalCategories } from '@/registry/optionalCategories';
import { freshNodeCost } from '@/utils/nodeCost';
import { toBudgetPoints } from '@/utils/budgetPoints';
import { useBudgetUnlimited, useDeviceBudget } from '@/hooks/useDeviceBudget';
import { Points } from '@/components/Points/Points';
import { evalTask } from '@/eval/evalTask';
import { noteMatchesQuery } from '../noteSearch';
import { detectPrompt, shortPrompt } from '@/utils/promptDetect';
import { fillTemplate } from '@/utils/fillTemplate';
import { useGeneratorOffer } from '@/hooks/useGeneratorOffer';
import { knownNodeNames } from '../promptKnownNames';
import { pictureFrom } from '@/utils/pictureTransfer';
import { bakeQueryMatches, bakeSelectionCount, bakeSelectionIds } from '@/utils/bakeQuery';
import { isEmbedMode } from '@/embed/embedMode';

/** Selected nodes eligible for grouping: not groups, not notes (annotations). */
const isGroupable = (n: AppNode) => !!n.selected && n.type !== 'group' && n.type !== 'note';
/** Organize re-lays the selection; groups ride as single units, notes never. */
const isOrganizable = (n: AppNode) => !!n.selected && n.type !== 'note';
function countNodes(nodes: AppNode[], pred: (n: AppNode) => boolean): number {
  let count = 0;
  for (const n of nodes) if (pred(n)) count++;
  return count;
}

/**
 * Flat, render-order action item used for keyboard navigation. Mirrors what's
 * actually drawn (group entry, output entry, then defs in their grouped or
 * flat-search order) so ArrowUp/Down + Enter behaviour matches what the user
 * sees.
 */
type ActionItem =
  | { kind: 'organize'; key: string; run: () => void }
  | { kind: 'group'; key: string; run: () => void }
  | { kind: 'bake'; key: string; run: () => void }
  | { kind: 'output'; key: string; run: () => void }
  | { kind: 'note'; key: string; run: () => void }
  | { kind: 'ai'; key: string; run: () => void }
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
  // Two COUNTS, not `s.nodes` (a new array per notify); the handlers read the
  // live graph from getState().
  const groupableCount = useAppStore((s) => countNodes(s.nodes, isGroupable));
  const organizableCount = useAppStore((s) => countNodes(s.nodes, isOrganizable));
  // Bake to texture (docs/dev/baking.md) works on ANY selection, one node or
  // many, grouped or not; never in the embed, where no preview renders it.
  const bakeableCount = useAppStore((s) => (isEmbedMode() ? 0 : bakeSelectionCount(s.nodes)));
  const groupSelection = useAppStore((s) => s.groupSelection);
  const organizeSelection = useAppStore((s) => s.organizeSelection);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  // What a row's price is divided by to print (utils/budgetPoints.ts); it
  // re-renders the rows on a device change, which reprices them.
  const deviceBudget = useDeviceBudget();
  // "Unlimited": the figure stays, in the colourless grey every card uses.
  const costUnlimited = useBudgetUnlimited();
  const language = useAppStore((s) => s.language);
  const { screenToFlowPosition, fitView } = useReactFlow();

  const canGroup = groupableCount >= 2;
  const canOrganize = organizableCount >= 2;
  const canBake = bakeableCount >= 1;

  // Source pin info for auto-connect when dragged from an output handle
  const sourceNodeId = contextMenu.sourceNodeId;
  const sourceHandleId = contextMenu.sourceHandleId;
  /** Which END of the wire opened this menu — see `DroppedPin`. Pulling from an
   *  output means the new node is FED by that pin; pulling from an input means
   *  it feeds it. Both open this menu, and only the first used to connect. */
  const sourceHandleType = contextMenu.sourceHandleType;
  /**
   * Set when this menu was opened by an edge's **Insert node** — the chosen
   * node is spliced into that wire instead of landing loose beside it.
   *
   * It reuses the existing `edgeId` field rather than adding a tenth positional
   * argument to `openContextMenu`; the field already means "the edge this menu
   * is about", which is exactly what it means here.
   */
  const spliceEdgeId = contextMenu.edgeId;

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

  const noteMatches = useMemo(() => noteMatchesQuery(query), [query]);

  // "Generate “…” with AI": the LAST row, when the query reads as a request
  // (utils/promptDetect.ts; docs/dev/node-generator.md § The search-box
  // entry). Never on a menu opened by a dropped wire or an edge's Insert
  // node — a generated group cannot take that wire's place.
  const aiOffered = useGeneratorOffer();
  const aiDetected = useMemo(() => {
    if (!aiOffered || sourceNodeId || spliceEdgeId) return false;
    return detectPrompt(query, { hasResults: results.length > 0 || noteMatches, known: knownNodeNames() });
  }, [aiOffered, sourceNodeId, spliceEdgeId, query, results, noteMatches]);
  /** Open the generator on this query; an unwired result lands where the menu
   *  was opened. `autostart` is Ctrl/Cmd+Enter with a route that already works. */
  const handleGenerate = useCallback((autostart = false) => {
    const at = screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y });
    closeContextMenu();
    useAppStore.getState().openGenerator({ prompt: query.trim(), at, autostart });
  }, [screenToFlowPosition, contextMenu.x, contextMenu.y, closeContextMenu, query]);

  // A picture pasted on the box (a screenshot, or a file copied in Finder) is
  // a request too: it opens the dialog with that picture and the typed words,
  // as the palette's box does. Without this the browser's own paste wrote the
  // FILE NAME into the box. Pasted text goes on as before.
  const onPaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    if (!aiOffered || sourceNodeId || spliceEdgeId) return;
    const picture = pictureFrom(e.clipboardData);
    if (!picture) return;
    e.preventDefault();
    const at = screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y });
    closeContextMenu();
    useAppStore.getState().openGenerator({ prompt: query.trim(), at, picture });
  }, [aiOffered, sourceNodeId, spliceEdgeId, screenToFlowPosition, contextMenu.x, contextMenu.y, closeContextMenu, query]);

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

  // ONE undo entry for the whole add, including the auto-connect the wire-drop
  // route performs. `addNode` pushes its own history and the edge add used to
  // push a second, so one of the five documented placement paths needed two
  // Cmd+Z to reverse. The bracket snapshots once, up front, and every
  // pushHistory inside it bails; there is no early return in this body, so
  // nothing that must stay outside a bracket is caught by it.
  const handleAddNode = useCallback((def: NodeDefinition) => asOneHistoryEntry(() => {
    const position = screenToFlowPosition({
      x: contextMenu.x,
      y: contextMenu.y,
    });
    const cost = freshNodeCost(def.type) ?? 0;
    const nodes = useAppStore.getState().nodes;

    // A singleton type already on the canvas is not added twice — the row
    // becomes "take me to it" (singletonNodes.ts). Before the auto-connect
    // below on purpose: when this menu was opened by dropping a wire, there is
    // no new node to connect to, and wiring the drop's source into the
    // EXISTING node would be a connection the user never aimed at.
    const existingSingleton = findSingletonNode(nodes, def.type);
    if (existingSingleton) {
      focusNode(fitView, nodes, existingSingleton.id);
      closeContextMenu();
      return;
    }

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
      // the palette-tile drop path so both surfaces add identical nodes. A
      // running lesson waiting for THIS type lays its own values on top, as
      // on the tile path (`wantedNodeValues`).
      const values = {
        ...initialNodeValues(def, nodes),
        ...wantedNodeValues(useAppStore.getState().tutorial, def.type),
      };

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

    // Auto-connect from source pin if this menu was opened by dragging from an
    // output. Deliberately NO pushHistory of its own: `addNode` above already
    // snapshotted the pre-add state, and a second push made the add and the
    // wire two undo steps — the first Cmd+Z left the freshly added node
    // standing unwired, a state the user never authored. The sibling
    // palette-tile path states the same rule ("add + connect + snap = one undo
    // step", NodeEditor.tsx), and the whole handler runs inside one bracket.
    if (sourceNodeId && sourceHandleId && sourceHandleType) {
      connectDroppedWire(
        { nodeId: sourceNodeId, handleId: sourceHandleId, handleType: sourceHandleType },
        newNodeId,
        def,
      );
    }

    // …or splice into the edge this menu was opened from (its Insert node row).
    // Same bracket, so the node and its two wires are ONE undo step, and the
    // same rules as a node dropped on that wire — `spliceNodeIntoEdge` picks
    // the first FREE input and refuses a def that cannot pass a signal on
    // (both sinks declare `outputs: []`), in which case the node is simply
    // added where the menu was opened.
    if (spliceEdgeId) {
      spliceNodeIntoEdge(newNodeId, def, spliceEdgeId);
    }

    closeContextMenu();
  }), [contextMenu.x, contextMenu.y, screenToFlowPosition, fitView, addNode, closeContextMenu, sourceNodeId, sourceHandleId, sourceHandleType, spliceEdgeId]);

  const handleGroupSelection = useCallback(() => {
    groupSelection(useAppStore.getState().nodes.filter(isGroupable).map((n) => n.id));
    closeContextMenu();
  }, [groupSelection, closeContextMenu]);

  const handleBakeSelection = useCallback(() => {
    const ids = bakeSelectionIds(useAppStore.getState().nodes);
    if (ids.length === 0) return;
    closeContextMenu();
    useAppStore.getState().openBake(ids);
  }, [closeContextMenu]);

  // A search for "bake" ("iecept") offers the same row — never while this
  // menu wires or splices, which adds ONE node. With nothing selected the row
  // stays, inert, and says what to do first.
  const bakeQueried = !isEmbedMode() && !sourceNodeId && !spliceEdgeId && bakeQueryMatches(query);

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
    if (!query.trim() && canBake) {
      items.push({ kind: 'bake', key: '__bake__', run: handleBakeSelection });
    }
    // A bake search: the row FIRST, as the one thing the query names.
    if (bakeQueried) {
      items.push({ kind: 'bake', key: '__bake__', run: handleBakeSelection });
    }
    if (!query.trim()) {
      items.push({
        kind: 'output',
        key: '__output__',
        run: () => handleAddNode(NODE_REGISTRY.get('output')!),
      });
      // …and the category's OTHER sinks (the Raymarch Output, while Distance
      // fields is switched on — it is that family's companion and `grouped` is
      // built from the narrowed editor set) directly beneath it. The grouped
      // loop below skips `output` wholesale, so without this they are reachable
      // only by typing their name — findable if you already know they exist,
      // invisible if you do not.
      for (const def of grouped?.get('output') ?? []) {
        items.push({ kind: 'def', key: def.type, def, run: () => handleAddNode(def) });
      }
    }
    if (!query.trim()) {
      items.push({ kind: 'note', key: '__note__', run: handleAddNote });
    }
    // Recent nodes render above the category list (distinct `recent:` keys so a
    // def appearing here AND in its category stays two independent focus stops).
    // A search naming the note offers it AFTER the node results, so a node
    // match keeps the Enter key ("tex" is Texture before it is text).
    if (query.trim() && noteMatches) {
      for (const def of results) {
        items.push({ kind: 'def', key: def.type, def, run: () => handleAddNode(def) });
      }
      items.push({ kind: 'note', key: '__note__', run: handleAddNote });
      if (aiDetected) items.push({ kind: 'ai', key: '__ai__', run: () => handleGenerate() });
      return items;
    }
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
    // Last, so a real match keeps the Enter key; with no match it is the only
    // row and Enter opens the generator (it never sends).
    if (aiDetected) items.push({ kind: 'ai', key: '__ai__', run: () => handleGenerate() });
    return items;
  }, [query, noteMatches, canGroup, canOrganize, canBake, bakeQueried, grouped, results, recentDefs, handleGroupSelection, handleOrganizeSelection, handleBakeSelection, handleAddNode, handleAddNote, aiDetected, handleGenerate]);

  // Reset focus to the first item whenever the visible list changes (typing in
  // the search box, selection toggling, output-node presence flipping, etc.).
  useEffect(() => {
    scrollOnFocusRef.current = true;   // a new list: bring row 0 back into view
    setFocusedIndex(0);
  }, [actionItems.length, query]);

  // Scroll the focused row into view for keyboard moves and list swaps ONLY:
  // a hover-driven scroll fires inside the tooltip's dwell (TooltipLayer
  // DELAY_MS) and dismisses it for good. See docs/dev/canvas-interaction.md.
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
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      // The explicit door, for any query: open the generator on it, and start
      // at once when a route already worked this session.
      if (!aiOffered || sourceNodeId || spliceEdgeId || e.nativeEvent.isComposing || e.repeat) return;
      e.preventDefault();
      handleGenerate(useAppStore.getState().generatorRouteReady && query.trim() !== '');
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
    const cost = freshNodeCost(def.type) ?? 0;
    // Printed, and coloured, as the selected device's budget points.
    const points = toBudgetPoints(cost, deviceBudget);
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
              style={{ color: getCostTextColor(costUnlimited ? 0 : points, costColorLow, costColorHigh) }}
            >
              <Points value={points} />
            </span>
          )}
        </span>
        <span className="context-menu__item-category">
          {formatCategoryLabel(def.category, def.category, language)}
        </span>
      </button>
    );
  };

  /** The bake row — the Selection section's, or a "bake" search's. Inert
   *  (aria-disabled, never `disabled`, so its title still explains) while
   *  nothing is selected. */
  const renderBakeRow = () => (
    <button
      className={itemClass('__bake__')}
      data-add-node-focused={focusedAttr('__bake__')}
      aria-haspopup="dialog"
      aria-disabled={!canBake}
      title={canBake
        ? t('Render what leaves the selection into a picture on an Image node, and park the originals unwired', language)
        : t('Select the nodes to bake first', language)}
      onClick={handleBakeSelection}
      onMouseEnter={() => hoverFocus('__bake__')}
    >
      <span>{t('Bake Selection to Texture…', language)}</span>
      {canBake && (
        <span className="context-menu__item-category">
          {bakeableCount} {t('nodes', language)}
        </span>
      )}
    </button>
  );

  return (
    <>
      <input
        className="context-menu__search"
        // The same words as the palette's box where a request can be made here
        // (never while the menu wires or splices: it adds ONE node then).
        placeholder={t(aiOffered && !sourceNodeId && !spliceEdgeId ? 'Find nodes or write a prompt' : 'Search nodes...', language)}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        autoFocus
      />
      <div className="context-menu__list" ref={listRef}>
        {/* Selection actions — only when 2+ eligible nodes are selected */}
        {!query.trim() && (canOrganize || canGroup || canBake) && (
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
                  {organizableCount} {t('nodes', language)}
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
                  {groupableCount} {t('nodes', language)}
                </span>
              </button>
            )}
            {canBake && renderBakeRow()}
            <div className="context-menu__divider" />
          </>
        )}

        {/* "bake" typed: the same row, above the node results. */}
        {bakeQueried && (
          <>
            {renderBakeRow()}
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
            {(grouped?.get('output') ?? []).map((def) => renderDefRow(def))}
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

        {/* …and the note, when the search names it (noteSearch.ts). */}
        {query.trim() && noteMatches && (
          <button
            className={itemClass('__note__')}
            data-add-node-focused={focusedAttr('__note__')}
            onClick={handleAddNote}
            onMouseEnter={() => hoverFocus('__note__')}
          >
            <span>{t('Add Note', language)}</span>
            <span className="context-menu__item-category">{t('note', language)}</span>
          </button>
        )}

        {aiDetected && (
          <>
            <div className="context-menu__divider" />
            <button
              className={itemClass('__ai__')}
              data-add-node-focused={focusedAttr('__ai__')}
              aria-haspopup="dialog"
              onClick={() => handleGenerate()}
              onMouseEnter={() => hoverFocus('__ai__')}
            >
              <span>{fillTemplate(t('Generate “{query}” with AI', language), { query: shortPrompt(query) })}</span>
            </button>
          </>
        )}
      </div>
    </>
  );
}
