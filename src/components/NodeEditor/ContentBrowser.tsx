import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { CATEGORIES } from '@/registry/nodeCategories';
import { getAllDefinitions } from '@/registry/nodeRegistry';
import { NodePreviewCard } from './NodePreviewCard';
import type { NodeCategory, NodeDefinition } from '@/types';
import { CATEGORY_COLORS } from '@/utils/colorUtils';
import './ContentBrowser.css';

const displayCategories = CATEGORIES.filter((c) => c.id !== 'output');

export function ContentBrowser() {
  const [activeCategory, setActiveCategory] = useState<NodeCategory | 'all'>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  const allDefs = useMemo(() => getAllDefinitions().filter((d) => d.type !== 'output'), []);

  const filteredDefs = useMemo(() => {
    if (activeCategory === 'all') return allDefs;
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
        {filteredDefs.map((def) => (
          <NodePreviewCard key={def.type} def={def} onDragStart={onDragStart} />
        ))}
      </div>
    </div>
  );
}
