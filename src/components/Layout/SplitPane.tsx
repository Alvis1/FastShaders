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

  const handleMouseDown = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = isH ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newRatio = isH
        ? (e.clientX - rect.left) / rect.width
        : (e.clientY - rect.top) / rect.height;
      onRatioChange(newRatio);
    };

    const handleMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [isH, onRatioChange]);

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
        onMouseDown={handleMouseDown}
        style={{
          [isH ? 'width' : 'height']: '4px',
          cursor: isH ? 'col-resize' : 'row-resize',
          background: 'var(--border-subtle)',
          flexShrink: 0,
          transition: 'background var(--transition-fast)',
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
