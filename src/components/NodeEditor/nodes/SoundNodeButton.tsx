import { useMemo, useSyncExternalStore } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import {
  subscribeSound,
  getSoundStatus,
  getSoundSource,
  soundSupported,
  armSound,
  disarmSound,
} from '@/utils/soundSession';
import { readSoundSettings } from '@/utils/soundSettings';
import { soundStatusMessage } from '@/utils/soundStatusMessage';

/**
 * The arm/disarm control ON the Sound node card.
 *
 * A round light: GREEN when capture is available and idle, blinking RED while
 * listening, grey when it cannot run. Putting it on the node (rather than only
 * in the preview chrome) means the control sits where the capability is — you
 * see which node is listening, not just that the tab is.
 *
 * It is one of exactly TWO click paths into `armSound` (the other is the
 * preview's SoundControl). It must stay a real click: in this app a node's
 * presence in a graph IS its execution, so the gesture is the whole consent
 * model. See the header of `utils/soundSession.ts`. The SOURCE picker beside it
 * is deliberately not such a path — choosing a source only redirects a capture
 * that is already running.
 *
 * The idle wording is this surface's own (soundStatusMessage returns null for
 * `off`), and it branches on the source: with `system` selected the click opens
 * the browser's share sheet rather than a microphone prompt, so promising a
 * microphone would describe the wrong dialog. Every FAILURE line comes from the
 * shared table, so the node and the preview cannot word one differently.
 *
 * Node visuals are theme-invariant by convention, so every colour here is a
 * literal rather than a token — this button must look identical in light and
 * dark, like the rest of the node body.
 */
export function SoundNodeButton({ nodeId, values }: {
  nodeId: string;
  values: Record<string, string | number> | undefined;
}) {
  const language = useAppStore((s) => s.language);
  const status = useSyncExternalStore(subscribeSound, getSoundStatus, getSoundStatus);
  // Read at render rather than subscribed separately: `setSoundSource` emits on
  // the same listener set as the status, so the useSyncExternalStore above
  // already re-renders this component whenever the source changes.
  const source = getSoundSource();

  // Arming a capture that drives nothing is the case the pump's auto-disarm
  // exists to prevent, so don't offer it: an unwired Sound node emits no
  // uniforms at all (only CONSUMED channels are emitted). Narrow boolean
  // selector — `s.edges` changes identity on every graph edit but the boolean
  // compares by value.
  const wired = useAppStore((s) => s.edges.some((e) => e.source === nodeId));

  const supported = soundSupported();
  const settings = useMemo(() => readSoundSettings(values), [values]);

  const live = status === 'on';
  const starting = status === 'starting';
  const failed = status !== 'off' && !live && !starting;
  const disabled = !supported || (!wired && !live && !starting);

  const title = (): string => {
    if (!supported) {
      return t('Audio capture unavailable — needs a secure connection (https) and browser support.', language);
    }
    if (!wired && !live && !starting) {
      return t('Connect one of this node’s outputs first, then start listening.', language);
    }
    // Status wording is shared with the preview's SoundControl
    // (soundStatusMessage, which takes the source because the two capture paths
    // fail differently); only the idle line is this surface's own.
    return (
      soundStatusMessage(status, source, language) ??
      (source.kind === 'system'
        ? t('Start listening. You will be asked which tab, window or screen to take the sound from. Nothing is recorded, and the downloaded shader does not capture audio.', language)
        : t('Start listening to the selected input. Nothing is recorded, and the downloaded shader does not capture audio.', language))
    );
  };

  return (
    <button
      type="button"
      // `nodrag` so pressing the button never starts a node drag — React Flow
      // would otherwise treat the pointerdown as the start of a move.
      className={
        'shader-node__sound-btn nodrag' +
        (live ? ' is-live' : '') +
        (starting ? ' is-starting' : '') +
        (failed ? ' is-failed' : '')
      }
      disabled={disabled}
      onClick={(e) => {
        // The card itself selects the node on click; the button is its own
        // control and must not also change the selection.
        e.stopPropagation();
        if (live || starting) disarmSound();
        else armSound(settings);
      }}
      title={title()}
      aria-label={live ? t('Stop listening', language) : t('Start listening', language)}
      aria-pressed={live}
    />
  );
}
