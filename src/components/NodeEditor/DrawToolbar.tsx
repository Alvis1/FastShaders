import { useAppStore } from '@/store/useAppStore';
import { OPACITY_STEP } from '@/utils/drawings';
import { t } from '@/i18n';

/**
 * Draw-mode control cluster, rendered inside NodeEditor's bottom-center
 * canvas bar (the bar's Panel carries `nodrag nowheel`; the button/input
 * targets keep NodeEditor's draw-capture handler off the controls
 * themselves). A pencil toggle enters/leaves draw mode; while active, the
 * color / opacity / width / eraser / clear controls appear in their OWN
 * floating box stacked above the bar (see .fs-draw-controls) rather than
 * widening the bar and shifting every other button.
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
  const language = useAppStore((s) => s.language);

  return (
    <>
      <button
        type="button"
        className={`fs-draw-btn${active ? ' is-active' : ''}`}
        aria-pressed={active}
        title={active ? t('Exit draw mode (Esc)', language) : t('Draw on the board', language)}
        onClick={() => setActive(!active)}
      >
        <span aria-hidden="true">✏️</span> {t('Draw', language)}
      </button>

      {active && (
        <div className="fs-draw-controls" role="group" aria-label={t('Draw settings', language)}>
          <label className="fs-draw-swatch" title={t('Stroke color', language)}>
            <span style={{ background: color }} />
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>

          <label className="fs-draw-field" title={t('Opacity', language)}>
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

          <label className="fs-draw-field" title={t('Width', language)}>
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
            title={t('Eraser — drag over strokes to remove them', language)}
            onClick={() => setEraser(!eraser)}
          >
            <span aria-hidden="true">🩹</span> {t('Erase', language)}
          </button>

          <button
            type="button"
            className="fs-draw-btn fs-draw-btn--sm"
            disabled={!hasInk}
            title={t('Remove all strokes', language)}
            onClick={clear}
          >
            {t('Clear', language)}
          </button>
        </div>
      )}
    </>
  );
}
