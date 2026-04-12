import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { CATEGORIES } from '@/registry/nodeCategories';
import { getAllDefinitions } from '@/registry/nodeRegistry';
import { NodePreviewCard } from './NodePreviewCard';
import { SavedGroupCard } from './SavedGroupCard';
import { useAppStore } from '@/store/useAppStore';
import type { NodeCategory, NodeDefinition } from '@/types';
import { CATEGORY_COLORS } from '@/utils/colorUtils';
import complexityData from '@/registry/complexity.json';
import './ContentBrowser.css';

const displayCategories = CATEGORIES.filter((c) => c.id !== 'output');
const costs = complexityData.costs as Record<string, number>;

/** Pseudo-category id for the user's saved-group library. */
type BrowserCategory = NodeCategory | 'all' | 'saved';

const SAVED_GROUPS_COLOR = '#6366f1';

/** Raw hex colors for alpha-suffixed backgrounds (CATEGORY_COLORS uses CSS vars). */
const CAT_HEX: Record<string, string> = {
  input: '#4CAF50',
  type: '#2196F3',
  arithmetic: '#FF9800',
  math: '#9C27B0',
  interpolation: '#00BCD4',
  vector: '#E91E63',
  noise: '#795548',
  color: '#FF5722',
  unknown: '#9E9E9E',
  saved: SAVED_GROUPS_COLOR,
};

export function ContentBrowser() {
  const [activeCategory, setActiveCategory] = useState<BrowserCategory>('all');
  const [search, setSearch] = useState('');
  const savedGroups = useAppStore((s) => s.savedGroups);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  const allDefs = useMemo(() => {
    return getAllDefinitions().filter((d) => d.type !== 'output');
  }, []);

  const filteredDefs = useMemo<NodeDefinition[]>(() => {
    let defs: NodeDefinition[];
    if (activeCategory === 'all') defs = allDefs;
    else if (activeCategory === 'noise') {
      defs = allDefs
        .filter((d) => d.category === 'noise')
        .sort((a, b) => (costs[a.type] ?? 50) - (costs[b.type] ?? 50));
    } else {
      defs = allDefs.filter((d) => d.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      defs = defs.filter(
        (d) =>
          d.label.toLowerCase().includes(q) ||
          d.type.toLowerCase().includes(q) ||
          (d.description ?? '').toLowerCase().includes(q),
      );
    }
    return defs;
  }, [allDefs, activeCategory, search]);

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

  return (
    <div className="content-browser">
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
        {displayCategories.map((cat) => {
          const hex = CAT_HEX[cat.id];
          return (
            <button
              key={cat.id}
              className={`content-browser__cat-btn ${activeCategory === cat.id ? 'content-browser__cat-btn--active' : ''}`}
              style={
                activeCategory === cat.id
                  ? { background: `${hex}33`, borderColor: `${hex}66` }
                  : { background: `${hex}15`, borderColor: `${hex}33` }
              }
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.label}
            </button>
          );
        })}
        <button
          className={`content-browser__cat-btn ${activeCategory === 'saved' ? 'content-browser__cat-btn--active' : ''}`}
          style={
            activeCategory === 'saved'
              ? { background: `${CAT_HEX.saved}33`, borderColor: `${CAT_HEX.saved}66` }
              : { background: `${CAT_HEX.saved}15`, borderColor: `${CAT_HEX.saved}33` }
          }
          onClick={() => setActiveCategory('saved')}
        >
          Saved Groups {savedGroups.length > 0 ? `(${savedGroups.length})` : ''}
        </button>
      </div>
      <div
        className="content-browser__items"
        ref={scrollRef}
        style={{ background: activeCategory !== 'all'
          ? `${CAT_HEX[activeCategory]}1A`
          : undefined
        }}
      >
        {activeCategory === 'saved'
          ? savedGroups.length === 0
            ? (
              <div className="content-browser__empty">
                Right-click a group on the canvas → Save to Library to store it here.
              </div>
            )
            : savedGroups.map((g) => <SavedGroupCard key={g.id} group={g} />)
          : filteredDefs.map((item) => (
              <NodePreviewCard key={item.type} def={item} onDragStart={onDragStart} />
            ))}
      </div>
    </div>
  );
}
