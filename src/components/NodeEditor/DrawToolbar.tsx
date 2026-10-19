import { memo, type ReactNode } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { OPACITY_STEP } from '@/utils/drawings';
import { t, type Language } from '@/i18n';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';

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
// memo(): rendered by NodeEditor, which re-renders every drag frame; all
// inputs come from this component's own store selectors.
export const DrawToolbar = memo(function DrawToolbar() {
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
    <DrawToolbarView
      active={active}
      eraser={eraser}
      opacity={opacity}
      width={width}
      hasInk={hasInk}
      language={language}
      onActive={setActive}
      onEraser={setEraser}
      onOpacity={setOpacity}
      onWidth={setWidth}
      onClear={clear}
      swatch={
        /* `history="none"`: the ink colour is a draw-tool PREFERENCE —
           `setDrawColor` validates the hex, writes `fs:drawColor` and sets
           the store, with no pushHistory anywhere — so bracketing would push
           an undo entry that restores nothing and wipe the redo stack on
           every pick. (Committed STROKES do ride history; the pen colour
           they are drawn with does not.) */
        <PaletteColorPicker
          className="fs-draw-swatch"
          history="none"
          value={color}
          onPick={setColor}
          title={t('Stroke color', language)}
        />
      }
    />
  );
});

/**
 * The cluster as drawn: the pencil toggle and, while active, the floating box
 * of ink settings. DrawToolbar owns the store; the intro window's stage draws
 * the same cluster inert (intro/DrawScene.tsx), with a plain swatch where the
 * app has its colour picker.
 */
export function DrawToolbarView({
  active, eraser, opacity, width, hasInk, language, swatch,
  onActive, onEraser, onOpacity, onWidth, onClear, inert = false,
}: {
  active: boolean;
  eraser: boolean;
  opacity: number;
  width: number;
  hasInk: boolean;
  language: Language;
  swatch: ReactNode;
  onActive: (on: boolean) => void;
  onEraser: (on: boolean) => void;
  onOpacity: (v: number) => void;
  onWidth: (v: number) => void;
  onClear: () => void;
  /** A picture of the controls: nothing focusable. */
  inert?: boolean;
}) {
  const tab = inert ? -1 : undefined;
  return (
    <>
      <button
        type="button"
        tabIndex={tab}
        className={`fs-draw-btn${active ? ' is-active' : ''}`}
        aria-pressed={active}
        title={active ? t('Exit draw mode (Esc)', language) : t('Draw on the board', language)}
        onClick={() => onActive(!active)}
      >
        <span aria-hidden="true">✏️</span> {t('Draw', language)}
      </button>

      {active && (
        <div className="fs-draw-controls" role="group" aria-label={t('Draw settings', language)}>
          {swatch}

          <label className="fs-draw-field" title={t('Opacity', language)}>
            <span>α</span>
            <input
              type="range"
              tabIndex={tab}
              min={OPACITY_STEP}
              max={1}
              step={OPACITY_STEP}
              value={opacity}
              onChange={(e) => onOpacity(parseFloat(e.target.value))}
            />
            <b>{Math.round(opacity * 100)}%</b>
          </label>

          <label className="fs-draw-field" title={t('Width', language)}>
            <span>◍</span>
            <input
              type="range"
              tabIndex={tab}
              min={1}
              max={40}
              step={1}
              value={width}
              onChange={(e) => onWidth(parseFloat(e.target.value))}
            />
            <b>{width}</b>
          </label>

          <button
            type="button"
            tabIndex={tab}
            className={`fs-draw-btn fs-draw-btn--sm${eraser ? ' is-active' : ''}`}
            aria-pressed={eraser}
            title={t('Eraser — drag over strokes to remove them', language)}
            onClick={() => onEraser(!eraser)}
          >
            <span aria-hidden="true">🩹</span> {t('Erase', language)}
          </button>

          <button
            type="button"
            tabIndex={tab}
            className="fs-draw-btn fs-draw-btn--sm"
            disabled={!hasInk}
            title={t('Remove all strokes', language)}
            onClick={onClear}
          >
            {t('Clear', language)}
          </button>
        </div>
      )}
    </>
  );
}
