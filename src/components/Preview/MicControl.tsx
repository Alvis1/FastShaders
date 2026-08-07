import type { RefObject } from 'react';
import { t } from '@/i18n';
import type { Language } from '@/i18n';
import { micStatusMessage } from '@/utils/micStatusMessage';
import type { MicStatus } from './useMicPump';

/**
 * Arm/disarm control for live microphone input, plus a live level meter.
 *
 * Rendered ONLY when the current shader actually reads a mic uniform, so it
 * never advertises a capability the graph isn't using — and clicking it is the
 * one and only path to `getUserMedia` in this app.
 *
 * The meter matters beyond looking nice: the browser's own recording indicator
 * is per-origin and per-tab, so it can tell the user *that* something is
 * listening but never *what*. This one is attached to the thing that is
 * actually consuming the signal, and it doubles as the only feedback that the
 * gain setting is sane.
 */
export function MicControl(props: {
  status: MicStatus;
  onArm: () => void;
  onDisarm: () => void;
  meterRef: RefObject<HTMLSpanElement>;
  language: Language;
}) {
  const { status, onArm, onDisarm, meterRef, language } = props;

  const live = status === 'on';
  const starting = status === 'starting';
  const failed = status !== 'off' && !live && !starting;

  // Status wording is shared with the node's arm light (micStatusMessage);
  // only the idle line is this surface's own.
  const message = (): string =>
    micStatusMessage(status, language) ??
    t('Use a live microphone to drive this shader. Nothing is recorded, and the downloaded shader does not capture audio.', language);

  const label = live
    ? t('Stop microphone', language)
    : t('Start microphone', language);

  return (
    <div className="shader-preview__mic">
      <button
        type="button"
        className={
          'shader-preview__mic-btn' +
          (live ? ' is-live' : '') +
          (starting ? ' is-starting' : '') +
          (failed ? ' is-failed' : '')
        }
        onClick={live || starting ? onDisarm : onArm}
        title={message()}
        aria-label={label}
        aria-pressed={live}
      >
        <span aria-hidden="true">{failed ? '⚠' : '🎤'}</span>
        {/* Level meter. The fill's transform is written imperatively by the
            rAF pump — never React state, which would re-render this panel 60
            times a second. */}
        <span className="shader-preview__mic-meter">
          <span ref={meterRef} className="shader-preview__mic-meter-fill" />
        </span>
      </button>
      {/* An error has to be READABLE, not just a tooltip on a button the user
          already clicked and moved away from. */}
      {failed && <span className="shader-preview__mic-error">{message()}</span>}
    </div>
  );
}
