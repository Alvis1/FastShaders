/**
 * ONE setup box (SEARCH-AI-PLAN §13 R-a), drawn from `setupStates.ts`'s data:
 *  - `status` — a transient line (checking, starting): no button, never blocks
 *    Cancel;
 *  - `done` — the collapsed ✓ line of a finished step;
 *  - `info` / `error` — a box with at most one primary button and one text
 *    link. An error is `role="alert"`, and focus moves to its primary button
 *    when the box appears, so the fix is one key away.
 *
 * The text is the English sentence through `t()`, filled by `fillTemplate`
 * AFTER translation; `vars` and `detail` are DATA (a GPU's name, the system's
 * words) and render as React text, never markup.
 */
import { useEffect, useRef } from 'react';
import { t, type Language } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { ACTION_LABELS, type SetupAction, type SetupBox } from './setupStates';

export interface SetupBoxViewProps {
  box: SetupBox;
  language: Language;
  disabled: boolean;
  onAction: (action: SetupAction) => void;
}

export function SetupBoxView({ box, language, disabled, onAction }: SetupBoxViewProps) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const text = fillTemplate(t(box.text, language), box.vars ?? {});
  const identity = `${box.variant}|${box.text}`;
  useEffect(() => {
    if (box.variant === 'error') primaryRef.current?.focus();
  }, [identity, box.variant]);

  if (box.variant === 'status') {
    return <div className="generator-dialog__step" role="status">{text}</div>;
  }
  if (box.variant === 'done') {
    return <div className="generator-dialog__step generator-dialog__step--done" role="status">{text}</div>;
  }
  return (
    <div
      className={`generator-dialog__box generator-dialog__box--${box.variant}`}
      role={box.variant === 'error' ? 'alert' : 'status'}
    >
      <div>{text}</div>
      {box.body && <div className="generator-dialog__box-body">{fillTemplate(t(box.body, language), box.vars ?? {})}</div>}
      {box.progress !== undefined && (
        <div
          className="generator-dialog__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(box.progress * 100)}
        >
          <div className="generator-dialog__bar-fill" style={{ width: `${Math.round(box.progress * 1000) / 10}%` }} />
        </div>
      )}
      {box.detail && <div className="generator-dialog__detail">{box.detail}</div>}
      {(box.primary || box.secondary) && (
        <div className="generator-dialog__box-actions">
          {box.primary && (
            <button
              ref={primaryRef}
              type="button"
              className="csv-import-modal__button csv-import-modal__button--primary"
              disabled={disabled}
              onClick={() => onAction(box.primary!)}
            >
              {fillTemplate(t(ACTION_LABELS[box.primary], language), box.vars ?? {})}
            </button>
          )}
          {box.secondary && (
            <button type="button" className="generator-dialog__link" disabled={disabled} onClick={() => onAction(box.secondary!)}>
              {fillTemplate(t(ACTION_LABELS[box.secondary], language), box.vars ?? {})}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
