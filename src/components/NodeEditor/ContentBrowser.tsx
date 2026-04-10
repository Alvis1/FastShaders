import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { CATEGORIES } from '@/registry/nodeCategories';
import { getAllDefinitions } from '@/registry/nodeRegistry';
import { NodePreviewCard } from './NodePreviewCard';
import type { NodeCategory, NodeDefinition } from '@/types';
import { CATEGORY_COLORS } from '@/utils/colorUtils';
import complexityData from '@/registry/complexity.json';
import './ContentBrowser.css';

const displayCategories = CATEGORIES.filter((c) => c.id !== 'output' && c.id !== 'noise');
const costs = complexityData.costs as Record<string, number>;

/** Nodes pinned at the start of the texture section (order matters). */
const PINNED_TEXTURE_ORDER = ['tslTex_perlinNoise', 'voronoi'] as const;
const PINNED_TEXTURE_TYPES = new Set<string>(PINNED_TEXTURE_ORDER);

/** A spacer slot inserted into the browser items list (rendered as an empty gap). */
type SpacerItem = { kind: 'spacer' };
type BrowserItem = NodeDefinition | SpacerItem;
const SPACER: SpacerItem = { kind: 'spacer' };
const isSpacer = (item: BrowserItem): item is SpacerItem => 'kind' in item && item.kind === 'spacer';

export function ContentBrowser() {
  const [activeCategory, setActiveCategory] = useState<NodeCategory | 'all'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  const allDefs = useMemo(() => {
    const defs = getAllDefinitions().filter((d) => d.type !== 'output');
    // Sort texture nodes by cost (ascending)
    defs.sort((a, b) => {
      if (a.category === 'texture' && b.category === 'texture') {
        const costA = costs[a.type] ?? 50;
        const costB = costs[b.type] ?? 50;
        return costA - costB;
      }
      return 0;
    });
    return defs;
  }, []);

  const filteredDefs = useMemo<BrowserItem[]>(() => {
    if (activeCategory === 'all') return allDefs;
    if (activeCategory === 'texture') {
      // Pin perlinNoise & voronoi at start (in order), then all noise + texture nodes sorted by cost
      const pinned = PINNED_TEXTURE_ORDER
        .map((type) => allDefs.find((d) => d.type === type))
        .filter((d): d is NodeDefinition => d != null);
      const rest = allDefs
        .filter((d) => (d.category === 'texture' || d.category === 'noise') && !PINNED_TEXTURE_TYPES.has(d.type))
        .sort((a, b) => (costs[a.type] ?? 50) - (costs[b.type] ?? 50));
      return [...pinned, SPACER, ...rest];
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
      </div>
      <div className="content-browser__items" ref={scrollRef}>
        {filteredDefs.map((item, i) =>
          isSpacer(item) ? (
            <div key={`spacer-${i}`} style={{ width: 12, flexShrink: 0 }} />
          ) : (
            <NodePreviewCard key={item.type} def={item} onDragStart={onDragStart} />
          )
        )}
      </div>
    </div>
  );
}
