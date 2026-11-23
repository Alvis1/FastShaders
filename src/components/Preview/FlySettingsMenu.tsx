import { useState } from 'react';
import { createPortal } from 'react-dom';
import { NumberField } from '@/components/inputs/NumberField';
import { formatFieldNumber, parseFieldNumber } from '@/utils/numberField';
import {
  FLY_FOV_MAX,
  FLY_FOV_MIN,
  FLY_SETTINGS_DEFAULT,
  FLY_SPEED_MAX,
  FLY_SPEED_MIN,
  flySettings,
  type FlySettings,
} from '@/engine/tslToPreviewHTML';
import { t } from '@/i18n';
import type { Language } from '@/i18n';
import { hiddenUntilPlaced, usePreviewPopover } from './usePreviewPopover';

/** Speed spans 500×, so its slider runs on a LOG scale: equal travel, equal ratio. */
const LOG_MIN = Math.log10(FLY_SPEED_MIN);
const LOG_MAX = Math.log10(FLY_SPEED_MAX);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One setting: a slider and the app's number field (a dot whatever the locale).
 * The field keeps a draft while typed, commits every parse, and drops the draft
 * on Enter / blur so it shows the stored (clamped) value again — BoundInput's
 * rule. A preview preference, never graph state: no history.
 */
function FlyRow({
  label,
  unit,
  value,
  step,
  min,
  max,
  slider,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  step: number;
  min: number;
  max: number;
  /** The slider's own scale: its value for a setting, and back. */
  slider: { min: number; max: number; step: number; to: (v: number) => number; from: (s: number) => number };
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="fly-menu__row">
      <span className="fly-menu__label">{label}</span>
      <input
        type="range"
        className="fly-menu__slider"
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={slider.to(value)}
        onChange={(e) => onChange(slider.from(parseFloat(e.target.value)))}
        aria-label={label}
      />
      <NumberField
        className="fly-menu__field"
        value={value}
        step={step}
        min={min}
        max={max}
        text={draft ?? formatFieldNumber(value)}
        onText={(text) => {
          setDraft(text);
          const n = parseFieldNumber(text);
          if (n !== null) onChange(n);
        }}
        onEnter={() => setDraft(null)}
        onEscape={(e) => e.currentTarget.blur()}
        onBlur={() => setDraft(null)}
        aria-label={label}
      />
      <span className="fly-menu__unit">{unit}</span>
    </label>
  );
}

/**
 * The Fly button's settings: how fast the fly-through moves and how wide the
 * camera sees while flying. Opened by right-click (long-press on touch) on the
 * Fly button, which stays a plain on/off toggle. Every change is clamped by
 * `flySettings`, so the parent stores and posts only numbers in range.
 */
export function FlySettingsMenu({
  anchor,
  open,
  settings,
  onChange,
  onClose,
  language,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  settings: FlySettings;
  onChange: (next: FlySettings) => void;
  onClose: () => void;
  language: Language;
}) {
  const { menuRef, host, pos } = usePreviewPopover<HTMLDivElement>({ open, anchor, onClose });
  if (!open || !host) return null;
  const set = (patch: Partial<FlySettings>) => onChange(flySettings({ ...settings, ...patch }));
  const isDefault = settings.speed === FLY_SETTINGS_DEFAULT.speed && settings.fov === FLY_SETTINGS_DEFAULT.fov;

  return createPortal(
    <div
      ref={menuRef}
      className="anim-clip-menu fly-menu"
      role="dialog"
      aria-label={t('Fly settings', language)}
      style={hiddenUntilPlaced(pos)}
    >
      <div className="anim-clip-menu__head">{t('Fly settings', language)}</div>
      <FlyRow
        label={t('Speed', language)}
        unit="×"
        value={settings.speed}
        step={0.1}
        min={FLY_SPEED_MIN}
        max={FLY_SPEED_MAX}
        slider={{
          min: LOG_MIN,
          max: LOG_MAX,
          step: 0.01,
          to: (v) => Math.log10(v),
          from: (s) => round2(10 ** s),
        }}
        onChange={(speed) => set({ speed })}
      />
      <FlyRow
        label={t('Field of view', language)}
        unit="°"
        value={settings.fov}
        step={1}
        min={FLY_FOV_MIN}
        max={FLY_FOV_MAX}
        slider={{ min: FLY_FOV_MIN, max: FLY_FOV_MAX, step: 1, to: (v) => v, from: (s) => s }}
        onChange={(fov) => set({ fov })}
      />
      <button
        type="button"
        className="anim-clip-menu__item fly-menu__default"
        onClick={() => onChange({ ...FLY_SETTINGS_DEFAULT })}
        disabled={isDefault}
      >
        {t('Default', language)}
      </button>
    </div>,
    host,
  );
}
