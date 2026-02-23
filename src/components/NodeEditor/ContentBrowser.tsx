import { useState, useMemo, useRef, useCallback } from 'react';
import { CATEGORIES } from '@/registry/nodeCategories';
import { getAllDefinitions } from '@/registry/nodeRegistry';
import { NodePreviewCard } from './NodePreviewCard';
import type { NodeCategory, NodeDefinition } from '@/types';
import './ContentBrowser.css';

const CATEGORY_COLORS: Record<NodeCategory, string> = {
  input: 'var(--cat-input)',
  type: 'var(--cat-type)',
  arithmetic: 'var(--cat-arithmetic)',
  math: 'var(--cat-math)',
  interpolation: 'var(--cat-interpolation)',
  vector: 'var(--cat-vector)',
  noise: 'var(--cat-noise)',
  color: 'var(--cat-color)',
  texture: 'var(--cat-texture)',
  output: 'var(--cat-output)',
};

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

  // Convert vertical scroll to horizontal scroll
  const onWheel = useCallback((event: React.WheelEvent) => {
    if (scrollRef.current && event.deltaY !== 0) {
      event.preventDefault();
      scrollRef.current.scrollLeft += event.deltaY;
    }
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
      <div className="content-browser__items" ref={scrollRef} onWheel={onWheel}>
        {filteredDefs.map((def) => (
          <NodePreviewCard key={def.type} def={def} onDragStart={onDragStart} />
        ))}
      </div>
    </div>
  );
}
