import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import {
  listMicDevices,
  getMicDeviceId,
  setMicDeviceId,
  subscribeMic,
  getMicStatus,
  micSupported,
} from '@/utils/micSession';
import { rowStyle, labelStyle } from './menuShared';

/**
 * Mic node settings that the generic `defaultValues` loop cannot express: which
 * input device to capture from.
 *
 * The choice is SESSION-only (see `setMicDeviceId`) — a `deviceId` is
 * origin-scoped, rotates when site data is cleared, and would be meaningless in
 * a shared `.fastshader`, so it deliberately never reaches `node.data.values`.
 * That also means this component owns no undo history and needs no
 * `updateNodeData`.
 *
 * Its own component because it needs hooks — the same reason ImageNodeSettings
 * is separate.
 */
export function MicNodeSettings() {
  const language = useAppStore((s) => s.language);
  const status = useSyncExternalStore(subscribeMic, getMicStatus, getMicStatus);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const selected = getMicDeviceId() ?? '';

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void listMicDevices().then((d) => {
        if (alive) setDevices(d);
      });
    };
    refresh();
    // Plugging in a USB mic mid-session should not require reopening the menu,
    // and device LABELS only materialise once permission is granted — so a
    // re-enumeration after arming is what turns "Microphone 2" into its name.
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    md?.addEventListener?.('devicechange', refresh);
    return () => {
      alive = false;
      md?.removeEventListener?.('devicechange', refresh);
    };
  }, [status]);

  if (!micSupported()) return null;

  // Labels are empty until the page holds a mic permission (the spec's
  // anti-fingerprinting rule). Say so rather than rendering blank rows, or the
  // picker looks broken exactly when the user first opens it.
  const unnamed = devices.length > 0 && devices.every((d) => !d.label);

  return (
    <>
      <div style={rowStyle}>
        <label style={labelStyle}>{t('Input device', language)}</label>
        <select
          className="nodrag"
          value={selected}
          onChange={(e) => setMicDeviceId(e.target.value || null)}
          style={{ flex: 1, minWidth: 0 }}
          title={t(
            'Which microphone to capture from. Remembered for this session only — it is never saved into the shader.',
            language,
          )}
        >
          <option value="">{t('Default', language)}</option>
          {devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `${t('Microphone', language)} ${i + 1}`}
            </option>
          ))}
        </select>
      </div>
      {unnamed && (
        <div style={{ ...rowStyle, opacity: 0.7, fontSize: '11px', display: 'block' }}>
          {t('Device names appear after you allow microphone access once.', language)}
        </div>
      )}
    </>
  );
}
