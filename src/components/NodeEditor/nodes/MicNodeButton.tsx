import { useMemo, useSyncExternalStore } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import {
  subscribeMic,
  getMicStatus,
  micSupported,
  armMic,
  disarmMic,
} from '@/utils/micSession';
import { readMicSettings } from '@/utils/micNode';
import { micStatusMessage } from '@/utils/micStatusMessage';

/**
 * The arm/disarm control ON the Mic node card.
 *
 * A round light: GREEN when a microphone is available and idle, blinking RED
 * while capturing, grey when it cannot run. Putting it on the node (rather than
 * only in the preview chrome) means the control sits where the capability is —
 * you see which node is listening, not just that the tab is.
 *
 * It is one of exactly TWO click paths into `armMic` (the other is the
 * preview's MicControl). It must stay a real click: in this app a node's
 * presence in a graph IS its execution, so the gesture is the whole consent
 * model. See the header of `utils/micSession.ts`.
 *
 * Node visuals are theme-invariant by convention, so every colour here is a
 * literal rather than a token — this button must look identical in light and
 * dark, like the rest of the node body.
 */
export function MicNodeButton({ nodeId, values }: {
  nodeId: string;
  values: Record<string, string | number> | undefined;
}) {
  const language = useAppStore((s) => s.language);
  const status = useSyncExternalStore(subscribeMic, getMicStatus, getMicStatus);

  // Arming a mic that drives nothing is the case the pump's auto-disarm exists
  // to prevent, so don't offer it: an unwired Mic node emits no uniforms at all
  // (only CONSUMED channels are emitted). Narrow boolean selector — `s.edges`
  // changes identity on every graph edit but the boolean compares by value.
  const wired = useAppStore((s) => s.edges.some((e) => e.source === nodeId));

  const supported = micSupported();
  const settings = useMemo(() => readMicSettings(values), [values]);

  const live = status === 'on';
  const starting = status === 'starting';
  const failed = status !== 'off' && !live && !starting;
  const disabled = !supported || (!wired && !live && !starting);

  const title = (): string => {
    if (!supported) {
      return t('Microphone unavailable — needs a secure connection (https) and browser support.', language);
    }
    if (!wired && !live && !starting) {
      return t('Connect one of this node’s outputs first, then turn the microphone on.', language);
    }
    // Status wording is shared with the preview's MicControl
    // (micStatusMessage); only the idle line is this surface's own.
    return (
      micStatusMessage(status, language) ??
      t('Turn the microphone on. Nothing is recorded, and the downloaded shader does not capture audio.', language)
    );
  };

  return (
    <button
      type="button"
      // `nodrag` so pressing the button never starts a node drag — React Flow
      // would otherwise treat the pointerdown as the start of a move.
      className={
        'shader-node__mic-btn nodrag' +
        (live ? ' is-live' : '') +
        (starting ? ' is-starting' : '') +
        (failed ? ' is-failed' : '')
      }
      disabled={disabled}
      onClick={(e) => {
        // The card itself selects the node on click; the button is its own
        // control and must not also change the selection.
        e.stopPropagation();
        if (live || starting) disarmMic();
        else armMic(settings);
      }}
      title={title()}
      aria-label={live ? t('Stop microphone', language) : t('Start microphone', language)}
      aria-pressed={live}
    />
  );
}
