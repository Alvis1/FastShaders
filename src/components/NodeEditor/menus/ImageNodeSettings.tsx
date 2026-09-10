import { useEffect, useRef, useState } from 'react';
import { useAppStore, resolveDeviceTextureDim } from '@/store/useAppStore';
import { t } from '@/i18n';
import { getNodeValues } from '@/types';
import { rowStyle, labelStyle, wideFieldStyle } from './menuShared';
import { totalImageChars, MAX_TOTAL_IMAGE_CHARS } from '@/utils/imageNode';
import { resolutionLadder } from '@/utils/imageCodec';
import { resizeEncodedImage } from '@/utils/imageImport';
import { loadImageOrigin, stashImageOrigin, canStashPayload, type ImageOriginPayload } from '@/utils/imageOriginCache';
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
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);
  const convertMode = useAppStore((s) => s.imageConvertMode);
  const setConvertMode = useAppStore((s) => s.setImageConvertMode);
  const [origin, setOrigin] = useState<ImageOriginPayload | null>(null);
  const [pending, setPending] = useState(false);
  /** A resolution change is a decode + resample + encode; the row says so. */
  const [resizing, setResizing] = useState(false);
  const selectedHeadsetId = useAppStore((s) => s.selectedHeadsetId);
  const costProfiles = useAppStore((s) => s.costProfiles);

  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
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

  // The stored payload is NOT the original iff the node carries the original's
  // dimensions — written by the drop-time power-of-two snap, or by a
  // Resolution pick below (both set the pair; a revert deletes it). `origin` is
  // the stored original itself, which is what makes either undoable — when the
  // record is gone (another machine, cleared storage, aged out of the cache)
  // the rows state that instead of failing on click.
  const resized = Number(vals.srcWidth) > 0 && Number(vals.srcHeight) > 0;
  const restorable = origin !== null && origin.dataUrl !== url;

  /**
   * The source the Resolution ladder re-encodes from: the stashed original
   * when there is one, else — while the payload has never been resized — the
   * payload ITSELF, which then IS the original. That second branch is what
   * puts the control on every image node: the cache is written only by a snap
   * or a resize, so for the ordinary unsnapped drop there is no record and
   * nothing needs one until the first pick, which stashes this exact payload
   * before replacing it (`applyResolution`). Reading the source off the node
   * also means the ladder needs no IndexedDB round trip to appear.
   *
   * `canKeepOriginal` is the gate on that first pick: a payload the cache
   * would REFUSE (over the 600 K per-image cap, i.e. placed under
   * ignore-limits) must not be resized, or the resize ships with no way back —
   * the rule the whole revert design rests on. The read-only row then says
   * exactly why.
   */
  const ladderSource: ImageOriginPayload | null =
    origin ??
    (!resized && url && w > 0 && h > 0
      ? { dataUrl: url, width: w, height: h, fileName: String(vals.fileName ?? '') }
      : null);
  const canKeepOriginal = origin !== null || (ladderSource !== null && canStashPayload(ladderSource.dataUrl));

  /**
   * The resolution ladder — halvings of the ORIGINAL, so the choice is
   * reversible (see `resolutionLadder`): the re-encode always reads from the
   * original, never from a smaller payload, or 2048 → 1024 → 512 would stack
   * three lossy passes and could never go back up.
   *
   * Capped by the SELECTED DEVICE's texture size, the same number the drop
   * path caps at — offering a rung the pipeline would immediately shrink
   * would be a control that lies.
   */
  const deviceMaxDim = resolveDeviceTextureDim(selectedHeadsetId, costProfiles);
  const ladder =
    ladderSource && canKeepOriginal
      ? resolutionLadder(ladderSource.width, ladderSource.height, deviceMaxDim)
      : [];
  /** Which rung the stored payload is on — none, after a power-of-two snap,
   *  whose aspect ratio no halving of the original reproduces. */
  const currentStep = ladder.find((step) => step.width === w && step.height === h) ?? null;

  /**
   * Once the Original row + Revert button have shown for THIS node, they stay
   * for the rest of the menu session. Their gate is "the payload differs from
   * the original", and a successful revert makes that false on the very frame
   * it lands — so without the latch the block unmounted under the cursor, and
   * the documented receipt (the button dropping to "already the original")
   * could never render. Keyed on the node id, since a second right-click MOVES
   * this menu to another node without remounting it.
   */
  const receiptRef = useRef<string | null>(null);
  if (resized || restorable) receiptRef.current = nodeId;
  const showOriginal = resized || restorable || receiptRef.current === nodeId;

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

  /**
   * Re-encode the ORIGINAL at one rung of the ladder.
   *
   * Divisor 1 is routed through `revert` rather than re-encoded: the original
   * payload IS that rung, so re-encoding it would spend a second lossy pass to
   * arrive at a worse copy of a file we already hold — and it keeps the button
   * and the dropdown from being able to disagree about what "original" means.
   *
   * Unlike Revert and the Data-map flip this genuinely awaits, and that is
   * fine: those two await a READ and then write TWO things, which is what
   * would split them into two undo entries. Here the whole await happens
   * before the single `updateNodeData`, so a resolution change is still one
   * undo step. The node is re-read after the await for the reason `revert`
   * documents — the menu can outlive its node.
   */
  const applyResolution = async (divisor: number) => {
    if (!ladderSource || !canKeepOriginal || resizing) return;
    const step = ladder.find((x) => x.divisor === divisor);
    if (!step) return;
    if (divisor === 1) {
      // The original IS this rung. With a stored one, put it back; without
      // one the payload already is it and there is nothing to do.
      if (origin) revert();
      return;
    }
    setResizing(true);
    try {
      const encoded = await resizeEncodedImage(
        ladderSource.dataUrl,
        step.width,
        step.height,
        useAppStore.getState().ignoreImageLimits,
      );
      // A failed decode/draw/encode leaves the node exactly as it was — a
      // resolution the user picked and did not get is better than a payload
      // silently replaced by something else.
      if (!encoded) return;
      const store = useAppStore.getState();
      const live = store.nodes.find((n) => n.id === nodeId);
      if (!live || live.data.registryType !== 'imageNode') return;
      const liveVals = getNodeValues(live);
      const currentUrl = typeof liveVals.imageB64 === 'string' ? liveVals.imageB64 : '';
      // Going back UP a rung can grow the payload, so the project-wide budget
      // is re-checked exactly as the revert path checks it.
      if (!store.ignoreImageLimits) {
        const total = totalImageChars(store.nodes) - currentUrl.length + encoded.dataUrl.length;
        if (total > MAX_TOTAL_IMAGE_CHARS) {
          noticeOverBudget();
          return;
        }
      }
      // The FIRST resize of an unsnapped image is the moment its payload stops
      // being the original — so this is where it is stashed, from the exact
      // payload about to be replaced. `canKeepOriginal` already vouched that
      // the cache will take it; a refusal here anyway means the resize ships
      // with no way back, and the destructive step does not ship.
      const originId =
        (typeof liveVals.originId === 'string' && liveVals.originId) ||
        stashImageOrigin(ladderSource, Date.now());
      if (!originId) return;
      store.updateNodeData(nodeId, {
        values: {
          ...liveVals,
          imageB64: encoded.dataUrl,
          width: encoded.width,
          height: encoded.height,
          originId,
          // The ORIGINAL's dimensions, which is what these two have always
          // meant ("what the source was, before the app resized it"). They
          // keep the Original row and the Revert button live, and the card's
          // thumbnail aspect right — a halving preserves it, so this is a
          // no-op there rather than a correction.
          srcWidth: ladderSource.width,
          srcHeight: ladderSource.height,
        },
      });
    } finally {
      setResizing(false);
    }
  };

  return (
    <>
      <div className="context-menu__divider" />
      <div className="context-menu__category">{t('Image', language)}</div>
      {infoRow(t('Format', language), format)}
      {/* Resolution is a CHOICE when the original is still on this device —
          the one lever that turns "this shader is too expensive" into
          something actionable, since a 4 K photo on a blurred backdrop costs
          the same bandwidth as one that matters. It falls back to the
          read-only reading otherwise, with the row's title saying why. */}
      {ladder.length > 1 ? (
        <div style={rowStyle}>
          <span
            style={labelStyle}
            title={t('Re-encode this image from the stored original at a smaller size. Lower resolution costs less GPU bandwidth.', language)}
          >
            {t('Resolution', language)}
          </span>
          <select
            style={wideFieldStyle}
            value={resizing ? 'busy' : (currentStep?.divisor ?? 'current')}
            disabled={resizing || pending}
            onChange={(e) => void applyResolution(Number(e.target.value))}
          >
            {resizing && <option value="busy">{t('Re-encoding…', language)}</option>}
            {/* A power-of-two-snapped payload is on no rung of a ladder built
                by halving the original, so its size is shown as its own entry
                rather than leaving the box reading someone else's number. */}
            {!resizing && !currentStep && <option value="current">{resolution}</option>}
            {!resizing && ladder.map((step) => (
              <option key={step.divisor} value={step.divisor}>
                {`${step.width} × ${step.height}`}
                {step.divisor === 1 ? ` (${t('original', language)})` : ''}
              </option>
            ))}
          </select>
        </div>
      ) : (
        infoRow(
          t('Resolution', language),
          resolution,
          // Three different reasons the ladder is absent, each named: the
          // resized image whose original has left this device; the untouched
          // payload the cache would refuse to keep a copy of (placed under
          // ignore-limits); and, rarely, a source too small to halve at all.
          ladder.length === 1
            ? undefined
            : resized && !origin
              ? t('Choosing a resolution needs the stored original, which lives on this device only.', language)
              : !canKeepOriginal
                ? t('This image is too large for a copy of the original to be kept on this device, so its resolution cannot be changed without losing the way back.', language)
                : undefined,
        )
      )}
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

      {/* Provenance + the way back. Gated on the payload actually DIFFERING
          from the original (`resized`, `restorable`) plus the per-session
          receipt latch — never on `originId` alone, or an untouched image
          would show an Original row repeating its own size beside a
          permanently disabled "already original" button. */}
      {showOriginal && (
        <>
          {infoRow(
            t('Original', language),
            pending
              ? '…'
              : origin
                ? `${origin.width} × ${origin.height} ${fmt(origin.dataUrl)}`
                : t('not on this device', language),
            origin
              ? t('The image as imported, before the automatic power-of-two step or any resolution you have chosen — same EXIF strip and same device texture cap, not the raw source file.', language)
              : t('The pre-conversion copy is kept on this device only, so it is unavailable after sharing a project, in a different browser, or once it ages out of the cache.', language),
          )}
          <button
            className="context-menu__item"
            onClick={revert}
            disabled={!restorable}
            title={
              restorable
                ? t('Put this image back to its original resolution', language)
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
