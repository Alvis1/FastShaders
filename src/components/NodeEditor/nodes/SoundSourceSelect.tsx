import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import {
  subscribeSound,
  getSoundStatus,
  getSoundSource,
  setSoundSource,
  listInputDevices,
  systemAudioSupported,
} from '@/utils/soundSession';
import {
  encodeSoundSource,
  decodeSoundSource,
  selectableInputDevices,
  SYSTEM_SOUND_SOURCE,
  DEFAULT_DEVICE_SOURCE,
} from '@/utils/soundSource';

/**
 * The Sound node's source picker: a microphone, any other input device (a
 * loopback driver like BlackHole / VB-Cable lands in the same list) or the
 * machine's own audio. It lives in the node's right-click settings menu, not
 * on the card, and the palette tile renders none (docs/dev/node-types.md).
 *
 * CHOOSING A SOURCE CAN NEVER START A CAPTURE — `setSoundSource` only
 * redirects one that is already running (see soundSession). Arming stays the
 * arm light's job, because in this app a node's presence in a graph IS its
 * execution, so the click is the whole consent model.
 *
 * Device LABELS are empty strings until the page holds a media permission (the
 * spec's anti-fingerprinting rule, not a bug), so before the first successful
 * arm the list shows the right NUMBER of inputs with positional names. That is
 * why the system entry leads: it is the one entry that is always meaningful.
 */
export function SoundSourceSelect() {
  const language = useAppStore((s) => s.language);
  // Subscribing to the session covers BOTH the status (which re-triggers
  // enumeration once labels materialise) and the source itself, which the
  // settings-free redirect path can change from under this component.
  const status = useSyncExternalStore(subscribeSound, getSoundStatus, getSoundStatus);
  const source = useSyncExternalStore(subscribeSound, getSoundSource, getSoundSource);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void listInputDevices().then((d) => {
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

  const systemOk = systemAudioSupported();
  const value = encodeSoundSource(source);
  // Real, addressable devices only. Before the page holds a media permission
  // enumerateDevices() returns a placeholder with an EMPTY deviceId (and no
  // label) — listing it would put an unnamed twin of "Default input" in the
  // menu, which is what made the device half look broken on first run.
  const realDevices = selectableInputDevices(devices);

  // A source the picker cannot represent (the chosen device was unplugged, or
  // `system` in a build without getDisplayMedia) would otherwise leave the
  // <select> showing option 0 while the session still points elsewhere — the
  // control silently lying about what it is listening to. Render the real state
  // as its own entry instead.
  const known =
    source.kind === 'system'
      ? systemOk
      : source.deviceId === '' || realDevices.some((d) => d.deviceId === source.deviceId);

  const explain = systemOk
    ? t('Where the sound comes from. Share a tab, window or screen to react to what it is playing, or pick an audio input directly. Remembered for this session only — it is never saved into the shader.', language)
    : t('This browser cannot share tab or system audio (only Chromium-based browsers can). To react to music playing on this machine, route it through a loopback input device and pick it here. Remembered for this session only.', language);
  // The control is half the menu's width by design (see SoundNodeSettings: a
  // full-width select let the longest device name decide the panel's width),
  // and a device name can be long — "MacBook Pro Microphone (Built-in)" — so
  // the closed control ellipsises routinely. Naming the current source on the
  // FIRST line of the tooltip is what gives the truncated text somewhere to
  // resolve, and is the reason this tooltip is built rather than left to the
  // browser.
  const selectedLabel = !known
    ? (source.kind === 'system'
      ? t('System audio (unavailable)', language)
      : t('Input unavailable', language))
    : source.kind === 'system'
      ? t('Tab / system audio…', language)
      : source.deviceId === ''
        ? t('Default input', language)
        : (realDevices.find((d) => d.deviceId === source.deviceId)?.label
          || `${t('Input', language)} ${realDevices.findIndex((d) => d.deviceId === source.deviceId) + 1}`);
  const title = `${selectedLabel}\n\n${explain}`;

  return (
    <select
      className="nodrag"
      style={{ width: '50%', minWidth: 0 }}
      value={value}
      title={title}
      aria-label={t('Audio source', language)}
      // The card selects the node on click; this control must not also do it,
      // and React Flow must not read the press as the start of a drag.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        const next = decodeSoundSource(e.target.value);
        // decodeSoundSource returns null rather than guessing; ignoring an
        // unrecognised value is right, because the one wrong answer available
        // here is silently resolving junk to "share my screen".
        if (next) setSoundSource(next);
      }}
    >
      {!known && (
        <option value={value} disabled>
          {source.kind === 'system'
            ? t('System audio (unavailable)', language)
            : t('Input unavailable', language)}
        </option>
      )}
      <option value={encodeSoundSource(SYSTEM_SOUND_SOURCE)} disabled={!systemOk}>
        {systemOk
          ? t('Tab / system audio…', language)
          : t('Tab / system audio (unsupported)', language)}
      </option>
      {/* Always offered, and always usable: it needs no device id, so it is the
          one device entry that works before any permission has been granted —
          which is also how the user GETS the permission that names the rest. */}
      <option value={encodeSoundSource(DEFAULT_DEVICE_SOURCE)}>
        {t('Default input', language)}
      </option>
      {realDevices.map((d, i) => (
        <option key={d.deviceId} value={encodeSoundSource({ kind: 'device', deviceId: d.deviceId })}>
          {d.label || `${t('Input', language)} ${i + 1}`}
        </option>
      ))}
    </select>
  );
}
