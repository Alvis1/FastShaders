import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NEW_COLOR_PALETTE } from '@/utils/newNodeValues';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import './PaletteColorPicker.css';

/**
 * Preset palettes offered in the popover. The Fiesta row leads because it is
 * the palette that already seeds new Color nodes (`NEW_COLOR_PALETTE`), so a
 * user who picks from it keeps the canvas in one family.
 */
const PALETTES: ReadonlyArray<{ name: string; colors: readonly string[] }> = [
  { name: 'Fiesta', colors: NEW_COLOR_PALETTE },
  { name: 'Ocean', colors: ['#03045e', '#0077b6', '#00b4d8', '#90e0ef', '#caf0f8'] },
  { name: 'Earth', colors: ['#606c38', '#9c6644', '#dda15e', '#bc6c25', '#fefae0'] },
  { name: 'Neutral', colors: ['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff'] },
];

const POPOVER_W = 132; // matches the CSS width; used for viewport clamping

/** Only one palette popover may be open app-wide. Mouse gets this for free —
 *  opening picker B fires a pointerdown that lands outside A and closes it —
 *  but KEYBOARD activation (Enter/Space on a focused swatch) fires a click
 *  with no pointerdown, so without this registry two popovers could stack at
 *  nearly the same fixed coordinates. */
let closeOpenPicker: (() => void) | null = null;

interface PaletteColorPickerProps {
  /** Current hex, or null when the channel has no stored value yet. */
  value: string | null;
  onPick: (hex: string) => void;
  /** When set, the popover leads with a reset entry that CLEARS the stored
   *  value — the channel returns to its default (previewed as `clearColor`)
   *  and stops emitting. This is how a normal override is re-applied to
   *  "default normal / none" after a color was picked. */
  onClear?: () => void;
  /** The channel's default color, shown on the reset entry's swatch. */
  clearColor?: string;
  className?: string;
  title?: string;
}

/**
 * A small color swatch that opens a palette popover — preset swatch rows plus
 * a native custom picker. The popover is a `position: fixed` portal (the
 * AssetTooltip pattern), NOT a child of the node: a node-embedded popover
 * would scale with the canvas zoom and land under neighbouring nodes.
 *
 * History: every pick routes through the same `useHistoryBracket` the native
 * ColorNode picker uses, so picks in QUICK SUCCESSION coalesce into one undo
 * entry. NB the hook's 600 ms idle gap also closes the bracket — a slow,
 * deliberate second pick starts a fresh entry (same behavior as the native
 * picker's burst coalescing; per-pick undo at that pace is intended).
 */
export function PaletteColorPicker({
  value,
  onPick,
  onClear,
  clearColor,
  className = '',
  title,
}: PaletteColorPickerProps) {
  const language = useAppStore((s) => s.language);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const { bracket, closeBracket } = useHistoryBracket();

  const close = useCallback(() => {
    setOpen(false);
    closeBracket();
    if (closeOpenPicker === close) closeOpenPicker = null;
  }, [closeBracket]);

  const toggle = useCallback(() => {
    if (open) {
      close();
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Close any other picker first (keyboard activation bypasses the
    // outside-pointerdown close — see closeOpenPicker).
    if (closeOpenPicker && closeOpenPicker !== close) closeOpenPicker();
    closeOpenPicker = close;
    // Below the swatch, clamped to the viewport; flips above when the bottom
    // edge would clip (the popover height is bounded, ~120px).
    const left = Math.min(Math.max(4, r.left), window.innerWidth - POPOVER_W - 4);
    const below = r.bottom + 4;
    const top = below + 130 > window.innerHeight ? Math.max(4, r.top - 134) : below;
    setPos({ left, top });
    setOpen(true);
  }, [open, close]);

  // Outside pointerdown + Escape close the popover. Capture phase so a click
  // that React Flow swallows (pane pan start) still closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t0 = e.target as Node | null;
      if (popRef.current?.contains(t0 as Node) || btnRef.current?.contains(t0 as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  // The bracket must never outlive an unmounting popover (node deleted while
  // open) — useHistoryBracket closes on unmount, but the portal can unmount
  // without the component; close explicitly, and drop the singleton
  // registration so a stale closure can't be invoked later.
  useEffect(
    () => () => {
      if (closeOpenPicker === close) closeOpenPicker = null;
      closeBracket();
    },
    [close, closeBracket],
  );

  const pick = useCallback(
    (hex: string) => {
      bracket();
      onPick(hex);
    },
    [bracket, onPick],
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`palette-swatch nodrag ${value ? '' : 'palette-swatch--unset'} ${className}`}
        style={value ? { background: value } : undefined}
        onClick={toggle}
        title={title ?? value ?? t('Pick a color', language)}
      />
      {open &&
        createPortal(
          <div ref={popRef} className="palette-pop nodrag" style={{ left: pos.left, top: pos.top }}>
            {onClear && (
              <button
                type="button"
                className="palette-pop__clear"
                onClick={() => {
                  bracket();
                  onClear();
                }}
              >
                <span
                  className="palette-pop__clear-swatch"
                  // The slash rides ON TOP of the channel's default color —
                  // inline because a bare background would replace the class's
                  // gradient layer.
                  style={
                    clearColor
                      ? {
                          background: `linear-gradient(to top right, transparent calc(50% - 1px), rgba(0, 0, 0, 0.45) calc(50% - 0.5px), rgba(0, 0, 0, 0.45) calc(50% + 0.5px), transparent calc(50% + 1px)), ${clearColor}`,
                        }
                      : undefined
                  }
                />
                {t('Default (none)', language)}
              </button>
            )}
            {PALETTES.map((p) => (
              <div key={p.name} className="palette-pop__row">
                {p.colors.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    className={`palette-pop__swatch ${value === hex ? 'palette-pop__swatch--current' : ''}`}
                    style={{ background: hex }}
                    title={hex}
                    onClick={() => pick(hex)}
                  />
                ))}
              </div>
            ))}
            <label className="palette-pop__custom">
              <span>{t('Custom', language)}</span>
              <input
                type="color"
                value={value ?? '#ffffff'}
                onChange={(e) => pick(e.target.value)}
                onBlur={closeBracket}
              />
            </label>
          </div>,
          document.body,
        )}
    </>
  );
}
