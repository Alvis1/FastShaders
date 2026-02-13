import { useCallback, useRef, type ReactNode } from 'react';
import { useAppStore } from '@/store/useAppStore';

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
}

export function SplitPane({ left, right }: SplitPaneProps) {
  const splitRatio = useAppStore((s) => s.splitRatio);
  const setSplitRatio = useAppStore((s) => s.setSplitRatio);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const handleMouseDown = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      setSplitRatio(ratio);
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
  }, [setSplitRatio]);

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
      }}
    >
      <div style={{ width: `${splitRatio * 100}%`, overflow: 'hidden' }}>
        {left}
      </div>
      <div
        onMouseDown={handleMouseDown}
        style={{
          width: '4px',
          cursor: 'col-resize',
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
