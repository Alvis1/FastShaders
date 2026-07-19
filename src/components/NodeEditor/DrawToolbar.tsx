import { Panel } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { OPACITY_STEP } from '@/utils/drawings';

/**
 * Draw-mode control cluster, floated top-center over the canvas as a React Flow
 * Panel. A pencil toggle enters/leaves draw mode; while active it expands to
 * color / opacity / width, an eraser toggle, and clear. `nodrag` + the button/
 * input targets keep NodeEditor's draw-capture handler off the controls
 * themselves.
 *
 * Opacity steps in OPACITY_STEP increments — that quantization is what bounds
 * the number of `<g opacity>` isolation groups (the render cost driver) and
 * makes "same opacity" exact for the constant-overlap semantic.
 */
export function DrawToolbar() {
  const active = useAppStore((s) => s.drawToolActive);
  const eraser = useAppStore((s) => s.drawEraser);
  const color = useAppStore((s) => s.drawColor);
  const opacity = useAppStore((s) => s.drawOpacity);
  const width = useAppStore((s) => s.drawWidth);
  const hasInk = useAppStore((s) => s.drawings.length > 0);
  const setActive = useAppStore((s) => s.setDrawToolActive);
  const setEraser = useAppStore((s) => s.setDrawEraser);
  const setColor = useAppStore((s) => s.setDrawColor);
  const setOpacity = useAppStore((s) => s.setDrawOpacity);
  const setWidth = useAppStore((s) => s.setDrawWidth);
  const clear = useAppStore((s) => s.clearDrawings);

  return (
    <Panel position="top-center" className="fs-draw-toolbar nodrag nowheel">
      <button
        type="button"
        className={`fs-draw-btn${active ? ' is-active' : ''}`}
        aria-pressed={active}
        title={active ? 'Exit draw mode (Esc)' : 'Draw on the board'}
        onClick={() => setActive(!active)}
      >
        <span aria-hidden="true">✏️</span> Draw
      </button>

      {active && (
        <div className="fs-draw-controls">
          <label className="fs-draw-swatch" title="Stroke color">
            <span style={{ background: color }} />
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>

          <label className="fs-draw-field" title="Opacity">
            <span>α</span>
            <input
              type="range"
              min={OPACITY_STEP}
              max={1}
              step={OPACITY_STEP}
              value={opacity}
              onChange={(e) => setOpacity(parseFloat(e.target.value))}
            />
            <b>{Math.round(opacity * 100)}%</b>
          </label>

          <label className="fs-draw-field" title="Width">
            <span>◍</span>
            <input
              type="range"
              min={1}
              max={40}
              step={1}
              value={width}
              onChange={(e) => setWidth(parseFloat(e.target.value))}
            />
            <b>{width}</b>
          </label>

          <button
            type="button"
            className={`fs-draw-btn fs-draw-btn--sm${eraser ? ' is-active' : ''}`}
            aria-pressed={eraser}
            title="Eraser — drag over strokes to remove them"
            onClick={() => setEraser(!eraser)}
          >
            <span aria-hidden="true">🩹</span> Erase
          </button>

          <button
            type="button"
            className="fs-draw-btn fs-draw-btn--sm"
            disabled={!hasInk}
            title="Remove all strokes"
            onClick={clear}
          >
            Clear
          </button>
        </div>
      )}
    </Panel>
  );
}
