import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t, type Language } from '@/i18n';
import type { CostProfile } from '@/utils/costOverride';
import './CsvImportModal.css';
import './CostProfileModal.css';

export type CostProfileModalMode = 'new' | 'export';
export type ExportScope = 'current' | 'all';

interface Props {
  mode: CostProfileModalMode;
  language: Language;
  profiles: CostProfile[];
  /** The selected profile, or null when a built-in headset is active. */
  activeProfile: CostProfile | null;
  onClose: () => void;
  onCreate: (label: string) => void;
  onExport: (scope: ExportScope) => void;
}

/**
 * The two cost-profile dialogs behind the CostBar's device dropdown:
 * "New profile…" (name it) and "Export profiles…" (this one, or all).
 *
 * One component because they are the same 3-line dialog with a different
 * middle, and because both must satisfy the same two constraints. They are
 * PORTALLED to `document.body`: the CostBar lives inside a React Flow panel,
 * and a `position: fixed` backdrop rendered under any transformed ancestor
 * would be positioned against that ancestor instead of the viewport. And the
 * name field is a real input rather than `window.prompt`, which the desktop
 * build's WKWebView is not obliged to implement at all — the same reason
 * nothing else in this app prompts.
 */
export function CostProfileModal({
  mode, language, profiles, activeProfile, onClose, onCreate, onExport,
}: Props) {
  const [name, setName] = useState(() => t('My device', language));
  const [scope, setScope] = useState<ExportScope>(activeProfile ? 'current' : 'all');
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus the field (or the panel) so keyboard users land inside the dialog
  // and screen readers announce it, rather than being left on the canvas.
  useEffect(() => {
    if (mode === 'new') inputRef.current?.select();
    else panelRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const trimmed = name.trim();
  const submit = () => {
    if (mode === 'new') {
      if (!trimmed) return;
      onCreate(trimmed);
    } else {
      onExport(scope);
    }
    onClose();
  };

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="csv-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cost-profile-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="cost-profile-modal-title">
          {mode === 'new' ? t('New performance profile', language) : t('Export performance profiles', language)}
        </div>

        {mode === 'new' ? (
          <>
            <div className="csv-import-modal__message">
              {t('Starts from the shipped node prices and this device’s budget, so nothing changes until you edit it. Use “Edit profile…” to download it as JSON, type your own numbers, and drop the file back here.', language)}
            </div>
            <label className="cost-profile-modal__field">
              <span>{t('Profile name', language)}</span>
              <input
                ref={inputRef}
                type="text"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
            </label>
          </>
        ) : (
          <>
            <div className="csv-import-modal__message">
              {t('Saves a JSON file you can keep, share, or edit and drop back in.', language)}
            </div>
            <div className="cost-profile-modal__choices">
              <label className={`cost-profile-modal__choice${activeProfile ? '' : ' cost-profile-modal__choice--off'}`}>
                <input
                  type="radio"
                  name="cost-profile-export-scope"
                  checked={scope === 'current'}
                  disabled={!activeProfile}
                  onChange={() => setScope('current')}
                />
                <span>
                  {t('This profile', language)}
                  {activeProfile
                    ? ` — ${activeProfile.label}`
                    : ` — ${t('no profile selected (a built-in headset is active)', language)}`}
                </span>
              </label>
              <label className="cost-profile-modal__choice">
                <input
                  type="radio"
                  name="cost-profile-export-scope"
                  checked={scope === 'all'}
                  onChange={() => setScope('all')}
                />
                <span>
                  {t('All profiles', language)}
                  {` — ${profiles.length} ${profiles.length === 1 ? t('profile', language) : t('profiles', language)}`}
                </span>
              </label>
            </div>
          </>
        )}

        <div className="csv-import-modal__buttons">
          <button className="csv-import-modal__button" onClick={onClose}>
            {t('Cancel', language)}
          </button>
          <button
            className="csv-import-modal__button csv-import-modal__button--primary"
            onClick={submit}
            disabled={mode === 'new' ? !trimmed : mode === 'export' && scope === 'all' && profiles.length === 0}
          >
            {mode === 'new' ? t('Create', language) : t('Export', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
