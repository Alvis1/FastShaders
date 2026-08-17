import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import {
  subscribeAudio,
  getAudioStatus,
  getAudioSource,
  setAudioSource,
  listAudioInputDevices,
  systemAudioAvailable,
} from '@/utils/audioSession';
import {
  encodeAudioSource,
  decodeAudioSource,
  selectableAudioDevices,
  SYSTEM_AUDIO_SOURCE,
  DEFAULT_DEVICE_SOURCE,
} from '@/utils/audioSource';

/**
 * The source picker that lives ON the Audio Input node card.
 *
 * This is the node's whole reason for existing as its own type: the Mic node
 * already has a device dropdown, but it is buried in the right-click settings
 * menu, so "what is this node listening to?" is invisible until you go looking.
 * Here the answer is the control.
 *
 * Putting a real `<select>` inside the React Flow viewport is a first for this
 * codebase — every other on-node non-numeric element is inert display (the
 * colormap strip, the image thumbnail). Three things make it safe:
 *
 *   - `nodrag`, so a pointerdown on it never starts a node drag. (NodeEditor's
 *     own `isInteractive()` / `isChrome()` guards already list `select`, so the
 *     custom pan/draw capture was never a problem — React Flow's drag is.)
 *   - `stopPropagation` on pointerdown/click, so opening the menu does not also
 *     change the canvas selection.
 *   - Choosing a source can never START a capture — `setAudioSource` only
 *     redirects one that is already running (see audioSession). That is what
 *     makes a one-click control on the card acceptable at all; arming stays the
 *     button's job, because the click is the consent model.
 *
 * Device LABELS are empty strings until the page holds a media permission (the
 * spec's anti-fingerprinting rule, not a bug), so before the first successful
 * arm the list shows the right NUMBER of inputs with positional names. That is
 * why the system entry leads: it is the one entry that is always meaningful.
 */
export function AudioSourceSelect({ style, disabled = false }: {
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const language = useAppStore((s) => s.language);
  // Subscribing to the session covers BOTH the status (which re-triggers
  // enumeration once labels materialise) and the source itself, which the
  // settings-free redirect path can change from under this component.
  const status = useSyncExternalStore(subscribeAudio, getAudioStatus, getAudioStatus);
  const source = useSyncExternalStore(subscribeAudio, getAudioSource, getAudioSource);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void listAudioInputDevices().then((d) => {
        if (alive) setDevices(d);
      });
    };
    refresh();
    // Plugging in a USB interface mid-session should not require re-adding the
    // node, and device LABELS only materialise once a permission is granted —
    // so a re-enumeration after arming is what turns "Input 2" into its name.
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    md?.addEventListener?.('devicechange', refresh);
    return () => {
      alive = false;
      md?.removeEventListener?.('devicechange', refresh);
    };
  }, [status]);

  const systemOk = systemAudioAvailable();
  const value = encodeAudioSource(source);
  // Real, addressable devices only. Before the page holds a media permission
  // enumerateDevices() returns a placeholder with an EMPTY deviceId (and no
  // label) — listing it would put an unnamed twin of "Default input" in the
  // menu, which is what made the device half look broken on first run.
  const realDevices = selectableAudioDevices(devices);

  // A source the picker cannot represent (the chosen device was unplugged, or
  // `system` in a build without getDisplayMedia) would otherwise leave the
  // <select> showing option 0 while the session still points elsewhere — the
  // control silently lying about what it is listening to. Render the real state
  // as its own entry instead.
  const known =
    source.kind === 'system'
      ? systemOk
      : source.deviceId === '' || realDevices.some((d) => d.deviceId === source.deviceId);

  const title = systemOk
    ? t('Where the sound comes from. Share a tab, window or screen to react to what it is playing, or pick an audio input directly. Remembered for this session only — it is never saved into the shader.', language)
    : t('This browser cannot share tab or system audio (only Chromium-based browsers can). To react to music playing on this machine, route it through a loopback input device and pick it here. Remembered for this session only.', language);

  return (
    <select
      className="audio-node__source nodrag"
      style={style}
      disabled={disabled}
      value={value}
      title={title}
      aria-label={t('Audio source', language)}
      // The card selects the node on click; this control must not also do it,
      // and React Flow must not read the press as the start of a drag.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = decodeAudioSource(e.target.value);
        // decodeAudioSource returns null rather than guessing; ignoring an
        // unrecognised value is right, because the one wrong answer available
        // here is silently resolving junk to "share my screen".
        if (next) setAudioSource(next);
      }}
    >
      {!known && (
        <option value={value} disabled>
          {source.kind === 'system'
            ? t('System audio (unavailable)', language)
            : t('Input unavailable', language)}
        </option>
      )}
      <option value={encodeAudioSource(SYSTEM_AUDIO_SOURCE)} disabled={!systemOk}>
        {systemOk
          ? t('Tab / system audio…', language)
          : t('Tab / system audio (unsupported)', language)}
      </option>
      {/* Always offered, and always usable: it needs no device id, so it is the
          one device entry that works before any permission has been granted —
          which is also how the user GETS the permission that names the rest. */}
      <option value={encodeAudioSource(DEFAULT_DEVICE_SOURCE)}>
        {t('Default input', language)}
      </option>
      {realDevices.map((d, i) => (
        <option key={d.deviceId} value={encodeAudioSource({ kind: 'device', deviceId: d.deviceId })}>
          {d.label || `${t('Input', language)} ${i + 1}`}
        </option>
      ))}
    </select>
  );
}
