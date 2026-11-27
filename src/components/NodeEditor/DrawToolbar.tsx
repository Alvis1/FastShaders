import { memo, type ReactNode } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { OPACITY_STEP } from '@/utils/drawings';
import { t, type Language } from '@/i18n';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { SettingButton } from '@/components/inputs/SettingButton';

/**
 * Draw-mode control cluster, rendered inside NodeEditor's bottom-center
 * canvas bar (the bar's Panel carries `nodrag nowheel`; the button/input
 * targets keep NodeEditor's draw-capture handler off the controls
 * themselves). A pencil toggle enters/leaves draw mode; while active, the
 * color / opacity / width / eraser / scissors / clear controls appear in their OWN
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
  const cut = useAppStore((s) => s.drawCut);
  const color = useAppStore((s) => s.drawColor);
  const opacity = useAppStore((s) => s.drawOpacity);
  const width = useAppStore((s) => s.drawWidth);
  const hasInk = useAppStore((s) => s.drawings.length > 0);
  const setActive = useAppStore((s) => s.setDrawToolActive);
  const setEraser = useAppStore((s) => s.setDrawEraser);
  const setCut = useAppStore((s) => s.setDrawCut);
  const setColor = useAppStore((s) => s.setDrawColor);
  const setOpacity = useAppStore((s) => s.setDrawOpacity);
  const setWidth = useAppStore((s) => s.setDrawWidth);
  const clear = useAppStore((s) => s.clearDrawings);
  const language = useAppStore((s) => s.language);

  return (
    <DrawToolbarView
      active={active}
      eraser={eraser}
      cut={cut}
      opacity={opacity}
      width={width}
      hasInk={hasInk}
      language={language}
      onActive={setActive}
      onEraser={setEraser}
      onCut={setCut}
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

type DrawTool = 'off' | 'pencil' | 'eraser' | 'cut';

/** The draw tools, in the list's order. */
const DRAW_TOOLS: readonly { value: DrawTool; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'pencil', label: 'Pencil' },
  { value: 'eraser', label: 'Eraser' },
  { value: 'cut', label: 'Scissors' },
];

/**
 * The cluster as drawn: the pencil toggle and, while active, the floating box
 * of ink settings. DrawToolbar owns the store; the intro window's stage draws
 * the same cluster inert (intro/DrawScene.tsx), with a plain swatch where the
 * app has its colour picker.
 */
export function DrawToolbarView({
  active, eraser, cut, opacity, width, hasInk, language, swatch,
  onActive, onEraser, onCut, onOpacity, onWidth, onClear, inert = false,
}: {
  active: boolean;
  eraser: boolean;
  /** The scissors: a drag cuts the wires it crosses (NodeEditor's cut stroke). */
  cut: boolean;
  opacity: number;
  width: number;
  hasInk: boolean;
  language: Language;
  swatch: ReactNode;
  onActive: (on: boolean) => void;
  onEraser: (on: boolean) => void;
  onCut: (on: boolean) => void;
  onOpacity: (v: number) => void;
  onWidth: (v: number) => void;
  onClear: () => void;
  /** A picture of the controls: nothing focusable. */
  inert?: boolean;
}) {
  const tab = inert ? -1 : undefined;
  // Pencil, eraser and scissors are ONE choice in the store, so the three
  // buttons share one list (owner, 2026-11-26: every setting button lists its
  // options on a right-click): off, or the tool in hand.
  const tool: DrawTool = !active ? 'off' : eraser ? 'eraser' : cut ? 'cut' : 'pencil';
  const pickTool = (to: DrawTool) => {
    if (to === 'off') return onActive(false);
    onActive(true);
    if (to === 'eraser') onEraser(true);
    else if (to === 'cut') onCut(true);
    else {
      onEraser(false);
      onCut(false);
    }
  };
  const toolMenu = {
    options: DRAW_TOOLS.map((o) => ({ value: o.value, label: t(o.label, language) })),
    value: tool,
    onSelect: pickTool,
    menuLabel: t('Drawing', language),
    inert,
    // The canvas bar sits just above the asset bar, which is drawn on top.
    placement: 'above' as const,
  };
  const more = t('Right-click: all options.', language);
  return (
    <>
      <SettingButton
        {...toolMenu}
        className={`fs-draw-btn fs-draw-btn--icon${active ? ' is-active' : ''}`}
        aria-pressed={active}
        aria-label={t('Draw', language)}
        title={`${active ? t('Exit draw mode (Esc)', language) : t('Draw on the board', language)}. ${more}`}
        onClick={() => onActive(!active)}
      >
        <span aria-hidden="true">✏️</span>
      </SettingButton>

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

          <SettingButton
            {...toolMenu}
            className={`fs-draw-btn fs-draw-btn--sm${eraser ? ' is-active' : ''}`}
            aria-pressed={eraser}
            title={`${t('Eraser — drag over strokes to remove them', language)}. ${more}`}
            onClick={() => onEraser(!eraser)}
          >
            <span aria-hidden="true">🩹</span> {t('Erase', language)}
          </SettingButton>

          {/* The cut stroke for touch and the laser, which have no Alt key:
              a drag cuts every wire it crosses (NodeEditor, useCutStroke). */}
          <SettingButton
            {...toolMenu}
            className={`fs-draw-btn fs-draw-btn--sm${cut ? ' is-active' : ''}`}
            aria-pressed={cut}
            title={`${t('Scissors — drag across wires to cut them. With a mouse: Alt/⌥ + drag on the canvas', language)}. ${more}`}
            onClick={() => onCut(!cut)}
          >
            <span aria-hidden="true">✂️</span> {t('Scissors', language)}
          </SettingButton>

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
