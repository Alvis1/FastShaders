import { Fragment, useMemo } from 'react';
import { t, type Language } from '@/i18n';
import { KEY_ROWS, isApplePlatform, rowCombos, type PrintedKey } from './introKeys';

/**
 * One combination, compact: its keys in ONE cap ("⌘+Shift+G"), and a mouse
 * gesture after the cap as a word ("⌥ + Drag").
 */
function ComboView({ combo, language }: { combo: PrintedKey[]; language: Language }) {
  const keys = combo.filter((k) => !k.mouse).map((k) => (k.translate ? t(k.label, language) : k.label));
  const gesture = combo.find((k) => k.mouse);
  return (
    <span className="fs-intro__keys-combo">
      {keys.length > 0 && <kbd className="fs-intro__kbd">{keys.join('+')}</kbd>}
      {keys.length > 0 && gesture && <span className="fs-intro__keys-plus">+</span>}
      {gesture && <span className="fs-intro__gesture">{t(gesture.label, language)}</span>}
    </span>
  );
}

/**
 * The intro window's Keys tab: `KEY_ROWS` as one compact list in two columns,
 * no headings — each row's keys on the left (⌘/⌥ on Apple, Ctrl/Alt
 * elsewhere) and what they do on the right. Static: nothing animates, nothing
 * is written.
 */
export function KeysTab({ language }: { language: Language }) {
  const mac = useMemo(() => isApplePlatform(typeof navigator === 'undefined' ? undefined : navigator), []);
  return (
    <dl className="fs-intro__keys">
      {KEY_ROWS.map((row) => {
        const combos = rowCombos(row, mac);
        if (combos.length === 0) return null;
        return (
          <div key={row.does} className="fs-intro__keys-row">
            <dt className="fs-intro__keys-combos">
              {combos.map((combo, i) => (
                <Fragment key={i}>
                  {i > 0 && <span className="fs-intro__keys-or">/</span>}
                  <ComboView combo={combo} language={language} />
                </Fragment>
              ))}
            </dt>
            <dd className="fs-intro__keys-does">{t(row.does, language)}</dd>
          </div>
        );
      })}
    </dl>
  );
}
