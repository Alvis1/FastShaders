import { useState, useMemo, useRef, useCallback, useEffect, type RefObject } from 'react';
import { CATEGORIES } from '@/registry/nodeCategories';
import { getAllDefinitions } from '@/registry/nodeRegistry';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { NodePreviewCard } from './NodePreviewCard';
import { SavedGroupCard } from './SavedGroupCard';
import { TextureCard } from './TextureCard';
import { useAppStore } from '@/store/useAppStore';
import type { NodeCategory, NodeDefinition } from '@/types';
import { CAT_HEX } from '@/utils/colorUtils';
import complexityData from '@/registry/complexity.json';
import './ContentBrowser.css';

// Exclude 'output' (the graph has at most one, not draggable from the palette)
// and 'unknown' (the registry hides unknown defs, so the tab would always be empty).
const displayCategories = CATEGORIES.filter((c) => c.id !== 'output' && c.id !== 'unknown');
const costs = complexityData.costs as Record<string, number>;

/** Track overflow state of a horizontally scrollable element and provide scroll actions. */
function useScrollArrows(ref: RefObject<HTMLDivElement | null>) {
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [ref, update]);

  const scrollBy = useCallback(
    (dir: -1 | 1) => {
      ref.current?.scrollBy({ left: dir * 200, behavior: 'smooth' });
    },
    [ref],
  );

  return { canLeft, canRight, scrollBy };
}

function ScrollArrow({ direction, onClick }: { direction: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      className={`content-browser__arrow content-browser__arrow--${direction}`}
      onClick={onClick}
      aria-label={`Scroll ${direction}`}
    >
      {direction === 'left' ? '\u2039' : '\u203A'}
    </button>
  );
}

/** Pseudo-category id for the user's saved-group library. */
type BrowserCategory = NodeCategory | 'all' | 'saved';

/** Tab style for a colored category button (active = stronger tint). */
function tabStyle(hex: string, active: boolean) {
  return active
    ? { background: `${hex}33`, borderColor: `${hex}66` }
    : { background: `${hex}15`, borderColor: `${hex}33` };
}

export function ContentBrowser() {
  const [activeCategory, setActiveCategory] = useState<BrowserCategory>('all');
  const [search, setSearch] = useState('');
  const savedGroups = useAppStore((s) => s.savedGroups);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabsArrows = useScrollArrows(tabsRef);
  const itemsArrows = useScrollArrows(scrollRef);

  const allDefs = useMemo(() => {
    return getAllDefinitions().filter((d) => d.type !== 'output');
  }, []);

  const q = search.trim().toLowerCase();

  const matchesDef = useCallback(
    (d: NodeDefinition) =>
      d.label.toLowerCase().includes(q) ||
      d.type.toLowerCase().includes(q) ||
      (d.description ?? '').toLowerCase().includes(q),
    [q],
  );

  const filteredDefs = useMemo<NodeDefinition[]>(() => {
    // saved/texture render their own tiles; defs unused there.
    let defs: NodeDefinition[];
    if (activeCategory === 'noise') {
      defs = allDefs
        .filter((d) => d.category === 'noise')
        .sort((a, b) => (costs[a.type] ?? 50) - (costs[b.type] ?? 50));
    } else if (activeCategory === 'all' || activeCategory === 'saved' || activeCategory === 'texture') {
      defs = allDefs;
    } else {
      defs = allDefs.filter((d) => d.category === activeCategory);
    }
    if (!q) return defs;
    const scoped = defs.filter(matchesDef);
    // Fallback: if the active category has no matches, broaden to all node defs
    // so the user isn't left staring at an empty panel while typing.
    if (scoped.length === 0 && activeCategory !== 'all') return allDefs.filter(matchesDef);
    return scoped;
  }, [allDefs, activeCategory, q, matchesDef]);

  const filteredSavedGroups = useMemo(() => {
    if (!q) return savedGroups;
    return savedGroups.filter((g) => g.name.toLowerCase().includes(q));
  }, [savedGroups, q]);

  const filteredTextures = useMemo(() => {
    const all = getBuiltinTextures();
    if (!q) return all;
    return all.filter(
      (t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q),
    );
  }, [q]);

  const onDragStart = useCallback((event: React.DragEvent, def: NodeDefinition) => {
    event.dataTransfer.setData('application/reactflow-type', def.type);
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  // Convert vertical scroll to horizontal scroll (native listener for non-passive)
  useEffect(() => {
    const els = [scrollRef.current, tabsRef.current];
    const handlers: (() => void)[] = [];
    for (const el of els) {
      if (!el) continue;
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY !== 0) {
          event.preventDefault();
          el.scrollLeft += event.deltaY;
        }
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      handlers.push(() => el.removeEventListener('wheel', onWheel));
    }
    return () => handlers.forEach((h) => h());
  }, []);

  const empty = (msg: string) => <div className="content-browser__empty">{msg}</div>;

  let items: React.ReactNode;
  if (activeCategory === 'saved') {
    items = savedGroups.length === 0
      ? empty('Right-click a group on the canvas → Save to Library to store it here.')
      : filteredSavedGroups.length === 0
        ? empty(`No saved groups match “${search.trim()}”.`)
        : filteredSavedGroups.map((g) => <SavedGroupCard key={g.id} group={g} />);
  } else if (activeCategory === 'texture') {
    items = filteredTextures.length === 0
      ? empty(`No textures match “${search.trim()}”.`)
      : filteredTextures.map((t) => <TextureCard key={t.id} texture={t} />);
  } else {
    items = filteredDefs.map((item) => (
      <NodePreviewCard key={item.type} def={item} onDragStart={onDragStart} />
    ));
  }

  return (
    <div className="content-browser">
      <div className="content-browser__scroll-wrapper">
        {tabsArrows.canLeft && <ScrollArrow direction="left" onClick={() => tabsArrows.scrollBy(-1)} />}
        <div className="content-browser__categories" ref={tabsRef}>
          <input
            className="content-browser__search"
            type="text"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className={`content-browser__cat-btn ${activeCategory === 'all' ? 'content-browser__cat-btn--active' : ''}`}
            style={
              activeCategory === 'all'
                ? { background: 'rgba(0,0,0,0.08)', borderColor: 'var(--border-subtle)' }
                : {}
            }
            onClick={() => setActiveCategory('all')}
          >
            All
          </button>
          {displayCategories.map((cat) => (
            <button
              key={cat.id}
              className={`content-browser__cat-btn ${activeCategory === cat.id ? 'content-browser__cat-btn--active' : ''}`}
              style={tabStyle(CAT_HEX[cat.id], activeCategory === cat.id)}
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.label}
            </button>
          ))}
          <button
            className={`content-browser__cat-btn ${activeCategory === 'saved' ? 'content-browser__cat-btn--active' : ''}`}
            style={tabStyle(CAT_HEX.saved, activeCategory === 'saved')}
            onClick={() => setActiveCategory('saved')}
          >
            Saved Groups {savedGroups.length > 0 ? `(${savedGroups.length})` : ''}
          </button>
        </div>
        {tabsArrows.canRight && <ScrollArrow direction="right" onClick={() => tabsArrows.scrollBy(1)} />}
      </div>
      <div className="content-browser__scroll-wrapper">
        {itemsArrows.canLeft && <ScrollArrow direction="left" onClick={() => itemsArrows.scrollBy(-1)} />}
        <div
          className="content-browser__items"
          ref={scrollRef}
          style={{ background: activeCategory !== 'all'
            ? `${CAT_HEX[activeCategory]}1A`
            : undefined
          }}
        >
          {items}
        </div>
        {itemsArrows.canRight && <ScrollArrow direction="right" onClick={() => itemsArrows.scrollBy(1)} />}
      </div>
    </div>
  );
}
