import { useCallback, useRef, type ReactNode } from 'react';

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  direction?: 'horizontal' | 'vertical';
  ratio: number;
  onRatioChange: (ratio: number) => void;
}

export function SplitPane({
  left,
  right,
  direction = 'horizontal',
  ratio,
  onRatioChange,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const isH = direction === 'horizontal';

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [isH]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const newRatio = isH
      ? (e.clientX - rect.left) / rect.width
      : (e.clientY - rect.top) / rect.height;
    onRatioChange(Math.max(0.05, Math.min(0.95, newRatio)));
  }, [isH, onRatioChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const firstSize = isH
    ? { width: `${ratio * 100}%` }
    : { height: `${ratio * 100}%` };

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: isH ? 'row' : 'column',
        flex: 1,
        overflow: 'hidden',
      }}
    >
      <div style={{ ...firstSize, overflow: 'hidden' }}>
        {left}
      </div>
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          [isH ? 'width' : 'height']: '4px',
          cursor: isH ? 'col-resize' : 'row-resize',
          background: 'var(--border-subtle)',
          flexShrink: 0,
          transition: 'background var(--transition-fast)',
          touchAction: 'none',
        }}
        onMouseEnter={(e) => {
          (e.target as HTMLElement).style.background = 'var(--border-focus)';
        }}
        onMouseLeave={(e) => {
          if (!dragging.current) {
            (e.target as HTMLElement).style.background = 'var(--border-subtle)';
          }
        }}
      />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {right}
      </div>
    </div>
  );
}
