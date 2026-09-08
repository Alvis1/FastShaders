import { useSyncExternalStore, type RefObject } from 'react';
import { t } from '@/i18n';
import type { Language } from '@/i18n';
import { soundStatusMessage } from '@/utils/soundStatusMessage';
import { getSoundSource, subscribeSound } from '@/utils/soundSession';
import type { SoundStatus } from './useSoundPump';

/**
 * Arm/disarm control for the Sound node's live capture, plus a level meter.
 *
 * Rendered ONLY when the current shader actually reads one of that node's
 * uniforms, so it never advertises a capability the graph isn't using — and
 * clicking it is one of exactly two paths into `armSound` (the other is the arm
 * light on the node itself).
 *
 * It does NOT offer the source picker. That lives on the node, which is the
 * control surface for what is being heard; a second picker here would be a
 * second place for the same setting to disagree with itself. What this surface
 * does need is to SAY which source it will open, because the click means two
 * different dialogs — a microphone permission or the browser's share sheet.
 *
 * The source is read through the session's own subscription rather than passed
 * down: `setSoundSource` emits on the same listener set as the status, and the
 * value is a module-level object whose identity only changes when the source
 * does, so it is a valid `useSyncExternalStore` snapshot. Threading it through
 * the pump and this component's props would give the same answer with two more
 * places to forget.
 *
 * The meter matters beyond looking nice: the browser's own recording indicator
 * is per-origin and per-tab, so it can tell the user *that* something is
 * listening but never *what*. This one is attached to the thing that is
 * actually consuming the signal, and it doubles as the only feedback that the
 * gain setting is sane.
 */
export function SoundControl(props: {
  status: SoundStatus;
  onArm: () => void;
  onDisarm: () => void;
  meterRef: RefObject<HTMLSpanElement>;
  language: Language;
}) {
  const { status, onArm, onDisarm, meterRef, language } = props;
  const source = useSyncExternalStore(subscribeSound, getSoundSource, getSoundSource);
  const system = source.kind === 'system';

  const live = status === 'on';
  const starting = status === 'starting';
  const failed = status !== 'off' && !live && !starting;

  // Status wording is shared with the node's arm light (soundStatusMessage);
  // only the idle line is this surface's own.
  const message = (): string =>
    soundStatusMessage(status, source, language) ??
    (system
      ? t('Start listening. You will be asked which tab, window or screen to take the sound from. Nothing is recorded, and the downloaded shader does not capture audio.', language)
      : t('Use a live microphone to drive this shader. Nothing is recorded, and the downloaded shader does not capture audio.', language));

  const label = live
    ? (system ? t('Stop listening', language) : t('Stop microphone', language))
    : (system ? t('Start listening', language) : t('Start microphone', language));

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
        {/* The glyph follows the SOURCE for the same reason the label does: a
            microphone drawn on a button that opens a tab-share sheet is a
            stale signal, and this is the only place in the preview chrome that
            says what is being listened to. */}
        <span aria-hidden="true">{failed ? '⚠' : system ? '🔊' : '🎤'}</span>
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
