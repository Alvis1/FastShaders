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

export function ContentBrowser() {
  const [activeCategory, setActiveCategory] = useState<BrowserCategory>('all');
  const savedGroups = useAppStore((s) => s.savedGroups);
  const scrollRef = useRef<HTMLDivElement>(null);

  const allDefs = useMemo(() => {
    return getAllDefinitions().filter((d) => d.type !== 'output');
  }, []);

  const filteredDefs = useMemo<NodeDefinition[]>(() => {
    if (activeCategory === 'all') return allDefs;
    if (activeCategory === 'noise') {
      // Sort noise nodes by ascending GPU cost so the cheapest ones surface first
      return allDefs
        .filter((d) => d.category === 'noise')
        .sort((a, b) => (costs[a.type] ?? 50) - (costs[b.type] ?? 50));
    }
    return allDefs.filter((d) => d.category === activeCategory);
  }, [allDefs, activeCategory]);

  const onDragStart = useCallback((event: React.DragEvent, def: NodeDefinition) => {
    event.dataTransfer.setData('application/reactflow-type', def.type);
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  // Convert vertical scroll to horizontal scroll (native listener for non-passive)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) {
        event.preventDefault();
        el.scrollLeft += event.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div className="content-browser">
      <div className="content-browser__categories">
        <button
          className={`content-browser__cat-btn ${activeCategory === 'all' ? 'content-browser__cat-btn--active' : ''}`}
          style={
            activeCategory === 'all'
              ? { background: 'var(--text-secondary)', borderColor: 'var(--text-secondary)' }
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
            style={
              activeCategory === cat.id
                ? { background: CATEGORY_COLORS[cat.id], borderColor: CATEGORY_COLORS[cat.id] }
                : { borderColor: CATEGORY_COLORS[cat.id], color: CATEGORY_COLORS[cat.id] }
            }
            onClick={() => setActiveCategory(cat.id)}
          >
            {cat.label}
          </button>
        ))}
        <button
          className={`content-browser__cat-btn ${activeCategory === 'saved' ? 'content-browser__cat-btn--active' : ''}`}
          style={
            activeCategory === 'saved'
              ? { background: SAVED_GROUPS_COLOR, borderColor: SAVED_GROUPS_COLOR }
              : { borderColor: SAVED_GROUPS_COLOR, color: SAVED_GROUPS_COLOR }
          }
          onClick={() => setActiveCategory('saved')}
        >
          Saved Groups {savedGroups.length > 0 ? `(${savedGroups.length})` : ''}
        </button>
      </div>
      <div className="content-browser__items" ref={scrollRef}>
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
