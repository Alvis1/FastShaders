import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { listInputDevices, subscribeSound, getSoundStatus, soundSupported } from '@/utils/soundSession';
import { SoundSourceSelect } from '../nodes/SoundSourceSelect';
import { rowStyle, labelStyle } from './menuShared';

/**
 * The Sound node's settings: WHICH sound it listens to.
 *
 * The picker offers the machine's own audio (share a tab, window or screen) and
 * every audio input device — a microphone, or a loopback driver like BlackHole
 * or VB-Cable, which is how a browser without tab-audio capture still hears
 * what is playing. It is the ONE source control in the app; the node face
 * carries no second copy, because two controls for one session is how the two
 * end up disagreeing.
 *
 * WHERE IT LIVES, and why it moved: this control sat on the node face when the
 * Audio Input node was folded into the Sound node (2026-09-08), inherited from
 * that node. It moved in here the same day, by owner decision. The trade it
 * makes: the face no longer answers "what is this listening to?" at a glance,
 * and in exchange the node is back to its compact size instead of spending
 * 22px of height and 20px of width on a control most graphs set once and never
 * touch. The question that DOES change minute to minute — is capture live? —
 * is still answered on the face, by the arm light.
 *
 * The choice is SESSION-only (see `setSoundSource`): a `deviceId` is
 * origin-scoped, rotates when site data is cleared, and would be meaningless in
 * a shared `.fastshader`, so it never reaches `node.data.values`. That is why
 * this component owns no undo history and calls no `updateNodeData` — nothing
 * here is part of the document.
 *
 * Choosing a source cannot START a capture, only redirect one that is already
 * running, which is what keeps arming a deliberate click on the arm light. In
 * this app a node's presence in a graph IS its execution, so that click is the
 * whole consent model.
 *
 * Its own component because it needs hooks — the same reason ImageNodeSettings
 * is separate.
 */
export function SoundNodeSettings() {
  const language = useAppStore((s) => s.language);
  const status = useSyncExternalStore(subscribeSound, getSoundStatus, getSoundStatus);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void listInputDevices().then((d) => {
        if (alive) setDevices(d);
      });
    };
    refresh();
    // Plugging in a USB interface mid-session should not require reopening the
    // menu, and device LABELS only materialise once permission is granted — so
    // a re-enumeration after arming is what makes the hint below stop applying.
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    md?.addEventListener?.('devicechange', refresh);
    return () => {
      alive = false;
      md?.removeEventListener?.('devicechange', refresh);
    };
  }, [status]);

  // No capture path at all in this build — outside a secure context there is
  // neither `getUserMedia` nor `getDisplayMedia`, which is the real case for
  // the LAN bench server. A picker that cannot open anything is worse than no
  // picker, so the whole section goes.
  if (!soundSupported()) return null;

  // Labels are empty strings until the page holds a media permission (the
  // spec's anti-fingerprinting rule, not a bug), so the picker falls back to
  // positional names and reads as broken exactly when it is first opened. Say
  // why, and only while it is true.
  const unnamed = devices.length > 0 && devices.every((d) => !d.label);

  return (
    <>
      {/* Label and control on their OWN rows, and the control at half width.
          A `<select>` stretched across the panel is as wide as the longest
          device name a machine happens to report, which made this the widest
          row in the menu and dragged the whole fixed-width box out with it.
          Stacking costs one line and takes the control off the label's
          baseline, so the width is now a choice rather than whatever the OS
          named the audio interface. Truncation is covered: the tooltip names
          the current source on its first line, which is why it does. */}
      <div style={{ ...rowStyle, display: 'block' }}>
        <label style={labelStyle}>{t('Source', language)}</label>
      </div>
      <div style={{ ...rowStyle, display: 'block' }}>
        <SoundSourceSelect />
      </div>
      {unnamed && (
        <div style={{ ...rowStyle, opacity: 0.7, fontSize: '11px', display: 'block' }}>
          {t('Device names appear after you allow microphone access once.', language)}
        </div>
      )}
    </>
  );
}
