import { useEffect, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { getNodeValues } from '@/types';
import { rowStyle, labelStyle, wideFieldStyle } from './menuShared';
import { totalImageChars, MAX_TOTAL_IMAGE_CHARS } from '@/utils/imageNode';
import { loadImageOrigin, type ImageOriginPayload } from '@/utils/imageOriginCache';
import { generateId } from '@/utils/idGenerator';

const checkLabelStyle = { ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px' } as const;
const checkStyle = { width: '12px', height: '12px', margin: 0 } as const;
const valueStyle = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-primary)',
  fontVariantNumeric: 'tabular-nums',
} as const;

/** Image-node section of the right-click settings menu.
 *
 *  Its own component (rather than an inline block in NodeSettingsMenu)
 *  because it needs hooks: the pre-snap "original" lives in IndexedDB, and it
 *  is read ONCE when the menu opens. That prefetch is what lets both the
 *  Revert button and the Data-map checkbox apply their change synchronously,
 *  as a SINGLE undo entry — `updateNodeData` pushes history the moment it is
 *  called, so a handler that awaited the read mid-click would split one click
 *  into two undo steps, with the intermediate one leaving the node half
 *  changed. */
export function ImageNodeSettings({ nodeId }: { nodeId: string }) {
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);
  const convertMode = useAppStore((s) => s.imageConvertMode);
  const setConvertMode = useAppStore((s) => s.setImageConvertMode);
  const [origin, setOrigin] = useState<ImageOriginPayload | null>(null);
  const [pending, setPending] = useState(false);

  const node = nodes.find((n) => n.id === nodeId);
  const vals = node ? getNodeValues(node) : {};
  const originId = typeof vals.originId === 'string' ? vals.originId : '';

  useEffect(() => {
    if (!originId) {
      setOrigin(null);
      return;
    }
    let alive = true;
    setPending(true);
    void loadImageOrigin(originId).then((payload) => {
      if (!alive) return;
      setOrigin(payload);
      setPending(false);
    });
    return () => {
      alive = false;
    };
  }, [originId]);

  if (!node || node.data.registryType !== 'imageNode') return null;

  const flagOf = (key: string, dflt: boolean) =>
    vals[key] === undefined ? dflt : Number(vals[key]) >= 0.5;
  const setValues = (patch: Record<string, string | number>) =>
    updateNodeData(nodeId, { values: { ...getNodeValues(node), ...patch } });
  const setVal = (key: string, value: string | number) => setValues({ [key]: value });

  const checkboxRow = (label: string, key: string, dflt: boolean, title: string) => (
    <div style={rowStyle}>
      <label style={checkLabelStyle}>
        <input
          type="checkbox"
          checked={flagOf(key, dflt)}
          onChange={() => setVal(key, flagOf(key, dflt) ? 0 : 1)}
          title={title}
          style={checkStyle}
        />
        {label}
      </label>
    </div>
  );

  // Read-only source info: format, encoded (post-downscale) resolution,
  // and payload size (base64 chars → ~3/4 bytes). Reflects what's actually
  // stored/emitted, so it also shows the effect of the device downscale.
  const url = typeof vals.imageB64 === 'string' ? vals.imageB64 : '';
  const mimeMatch = /^data:image\/(png|jpeg|webp);base64,/.exec(url);
  const fmt = (u: string) => {
    const m = /^data:image\/(png|jpeg|webp);base64,/.exec(u);
    return m ? (m[1] === 'jpeg' ? 'JPEG' : m[1].toUpperCase()) : '—';
  };
  const format = fmt(url);
  const w = Number(vals.width) || 0;
  const h = Number(vals.height) || 0;
  const resolution = w && h ? `${w} × ${h}` : '—';
  const bytes = mimeMatch ? Math.round((url.length - url.indexOf(',') - 1) * 0.75) : 0;
  const size =
    bytes <= 0 ? '—'
      : bytes < 1024 ? `${bytes} B`
        : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB`
          : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const infoRow = (label: string, value: string, title?: string) => (
    <div style={rowStyle} title={title}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{value}</span>
    </div>
  );

  // The node was snapped to a power of two at drop time iff it carries the
  // pre-snap dimensions. `origin` is what makes the snap undoable — when the
  // record is gone (another machine, cleared storage, aged out of the cache)
  // the row states that instead of failing on click.
  const wasSnapped = Number(vals.srcWidth) > 0 && Number(vals.srcHeight) > 0;
  const restorable = origin !== null && origin.dataUrl !== url;

  /** Values that put the original payload back. Drops the pre-snap dimension
   *  record with it, so the node reads as un-snapped afterwards. */
  const revertedValues = (o: ImageOriginPayload) => {
    const next: Record<string, string | number> = {
      ...getNodeValues(node),
      imageB64: o.dataUrl,
      width: o.width,
      height: o.height,
    };
    delete next.srcWidth;
    delete next.srcHeight;
    return next;
  };

  /** Reverting can GROW the payload (the snap usually shrinks it), so the
   *  project-wide image budget is re-checked — the same rule the drop path
   *  applies, with its own notice: the drop's `image-total-cap` "Add anyway"
   *  places a new node from a File, which a revert has neither of, so reusing
   *  it would offer an override that silently does nothing. */
  const overBudget = (o: ImageOriginPayload) => {
    const store = useAppStore.getState();
    if (store.ignoreImageLimits) return false;
    const total = totalImageChars(store.nodes) - url.length + o.dataUrl.length;
    return total > MAX_TOTAL_IMAGE_CHARS;
  };

  const noticeOverBudget = () =>
    useAppStore.getState().enqueueLimitNotice({
      id: generateId(),
      kind: 'image-revert-cap',
      fileName: String(vals.fileName ?? ''),
    });

  const revert = () => {
    if (!origin) return;
    const store = useAppStore.getState();
    // The menu can outlive its node (deleted from elsewhere, or an undo
    // landed while it was open) — re-read before writing.
    const live = store.nodes.find((n) => n.id === nodeId);
    if (!live || live.data.registryType !== 'imageNode') return;
    if (overBudget(origin)) {
      noticeOverBudget();
      return;
    }
    updateNodeData(nodeId, { values: revertedValues(origin) });
    // The menu deliberately stays OPEN. A revert is usually invisible on the
    // canvas — 1024×2048 back to 1080×1920 is the same picture — so closing
    // the menu made a successful revert indistinguishable from a dead button.
    // Left open, the Format / Resolution / Size rows update under the cursor
    // and this button drops to "already the original": that IS the receipt.
  };

  /** Data map ⇄ colour. Ticking "Data map" is the ONLY moment the app learns
   *  an image is a normal/height map — the drop had no way to know — so it
   *  also restores the un-snapped original when one exists: a resampled
   *  normal map has wrong normals, and this is the point where that becomes
   *  knowable. Both changes ride ONE updateNodeData → one undo entry. */
  const toggleColorSpace = () => {
    const next = vals.colorSpace === 'data' ? 'color' : 'data';
    const wants = next === 'data' && origin !== null && restorable;
    // Budget refusal must be VISIBLE here too: silently flipping to data mode
    // while leaving the resampled pixels in place is the one outcome this
    // whole path exists to prevent.
    if (wants && overBudget(origin!)) {
      noticeOverBudget();
      setVal('colorSpace', next);
      return;
    }
    if (!wants) {
      setVal('colorSpace', next);
      return;
    }
    // NOT setValues: that spreads the live values UNDER the patch, so the
    // srcWidth/srcHeight that revertedValues DELETES would come straight back
    // and the node would keep claiming a snap it no longer carries. One
    // updateNodeData → one undo entry for the flip and the restore together.
    updateNodeData(nodeId, { values: { ...revertedValues(origin!), colorSpace: next } });
  };

  return (
    <>
      <div className="context-menu__divider" />
      <div className="context-menu__category">{t('Image', language)}</div>
      {infoRow(t('Format', language), format)}
      {infoRow(t('Resolution', language), resolution)}
      {infoRow(t('Size', language), size)}
      {checkboxRow(t('Repeat (tile the image)', language), 'repeat', true,
        t('On: the image wraps/tiles. Off: edge pixels clamp beyond 0–1 UV.', language))}
      {checkboxRow(t('Flip X', language), 'flipX', false, t('Mirror the image left–right', language))}
      {checkboxRow(t('Flip Y', language), 'flipY', false, t('Mirror the image top–bottom', language))}
      {/* colorSpace keeps its string contract ('color' | 'data') — the
          emission branch and makeImageNodeData both read it that way. */}
      <div style={rowStyle}>
        <label style={checkLabelStyle}>
          <input
            type="checkbox"
            checked={vals.colorSpace === 'data'}
            onChange={toggleColorSpace}
            title={t('Sample as linear data (normal/height maps) instead of sRGB color. Also restores the original image, since a resampled normal map has wrong normals.', language)}
            style={checkStyle}
          />
          {t('Data map (linear, no mipmaps)', language)}
        </label>
      </div>

      {/* The drop-time optimization preference, surfaced HERE because it is
          otherwise a one-way door: "Don't ask again" on the import dialog
          silently pins every future drop, and a remembered "No" then looks
          exactly like the feature being broken. Global, not per-node — this
          is the same `fs:imageConvert` the import dialog writes. */}
      <div style={rowStyle}>
        <span style={labelStyle} title={t('Applies to every image you drop from now on, not just this one.', language)}>
          {t('Optimize on import', language)}
        </span>
        <select
          style={wideFieldStyle}
          value={convertMode}
          onChange={(e) => setConvertMode(e.target.value as 'ask' | 'always' | 'never')}
        >
          <option value="ask">{t('Ask each time', language)}</option>
          <option value="always">{t('Always', language)}</option>
          <option value="never">{t('Never', language)}</option>
        </select>
      </div>

      {/* Provenance + the way back from the drop-time power-of-two snap. */}
      {(wasSnapped || originId) && (
        <>
          {infoRow(
            t('Original', language),
            pending
              ? '…'
              : origin
                ? `${origin.width} × ${origin.height} ${fmt(origin.dataUrl)}`
                : t('not on this device', language),
            origin
              ? t('The image as imported before the automatic power-of-two step — same EXIF strip and same device texture cap, not the raw source file.', language)
              : t('The pre-conversion copy is kept on this device only, so it is unavailable after sharing a project, in a different browser, or once it ages out of the cache.', language),
          )}
          <button
            className="context-menu__item"
            onClick={revert}
            disabled={!restorable}
            title={
              restorable
                ? t('Undo the automatic power-of-two conversion for this image', language)
                : pending
                  // The stash read is async; a click in this window would do
                  // nothing, so say what the row is waiting for.
                  ? t('Looking for the stored original…', language)
                  : origin
                    // The record is there and already applied — saying "no
                    // stored original" here would be plainly false.
                    ? t('This image is already the original', language)
                    : t('No stored original for this image', language)
            }
          >
            {t('Revert to original', language)}
            {!restorable && !pending && (
              <span style={{ ...labelStyle, marginLeft: 'var(--space-2)' }}>
                {origin ? t('already original', language) : t('unavailable', language)}
              </span>
            )}
          </button>
        </>
      )}
    </>
  );
}
