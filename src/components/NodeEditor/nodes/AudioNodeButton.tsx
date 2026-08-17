import { useMemo, useSyncExternalStore } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import {
  subscribeAudio,
  getAudioStatus,
  getAudioSource,
  audioInputSupported,
  armAudio,
  disarmAudio,
} from '@/utils/audioSession';
import { readMicSettings } from '@/utils/micNode';
import { audioStatusMessage } from '@/utils/audioStatusMessage';

/**
 * The arm/disarm control ON the Audio Input node card.
 *
 * Reuses the Mic node's light (`.shader-node__mic-btn`) rather than growing a
 * second visual for the same idea: green when capture is available and idle,
 * blinking red while listening, grey when it cannot run. One look for "this node
 * is listening" across both audio nodes.
 *
 * It is the ONLY click path into `armAudio`. It must stay a real click: in this
 * app a node's presence in a graph IS its execution, so the gesture is the whole
 * consent model. See the header of `utils/audioSession.ts`.
 *
 * Node visuals are theme-invariant by convention, so every colour lives in
 * ShaderNode.css as a literal — this button looks identical in light and dark,
 * like the rest of the node body.
 */
export function AudioNodeButton({ nodeId, values }: {
  nodeId: string;
  values: Record<string, string | number> | undefined;
}) {
  const language = useAppStore((s) => s.language);
  const status = useSyncExternalStore(subscribeAudio, getAudioStatus, getAudioStatus);
  const source = getAudioSource();

  // Arming a capture that drives nothing is the case the pump's auto-disarm
  // exists to prevent, so don't offer it: an unwired node emits no uniforms at
  // all (only CONSUMED channels are emitted). Narrow boolean selector — `s.edges`
  // changes identity on every graph edit but the boolean compares by value.
  const wired = useAppStore((s) => s.edges.some((e) => e.source === nodeId));

  const supported = audioInputSupported();
  const settings = useMemo(() => readMicSettings(values), [values]);

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
    // Status wording is shared with every other Audio Input surface
    // (audioStatusMessage); only the idle line is this surface's own.
    return (
      audioStatusMessage(status, source, language) ??
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
        if (live || starting) disarmAudio();
        else armAudio(settings);
      }}
      title={title()}
      aria-label={live ? t('Stop listening', language) : t('Start listening', language)}
      aria-pressed={live}
    />
  );
}
