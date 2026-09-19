import { useEffect, useRef, useState } from 'react';
import { useAppStore, resolveDeviceTextureDim, resolveDeviceBudget } from '@/store/useAppStore';
import { t } from '@/i18n';
import { getNodeValues } from '@/types';
import { rowStyle, labelStyle, wideFieldStyle } from './menuShared';
import { imageCharsReplacing, MAX_TOTAL_IMAGE_CHARS, displayImageFileName, resolveImageDrop } from '@/utils/imageNode';
import { resolutionLadder } from '@/utils/imageCodec';
import { resizeEncodedImage, encodeImageFile, isSvgFile, type ImageConvertMode } from '@/utils/imageImport';
import { imageDropReport, type ConvertNoteReason } from '@/utils/imageImportNote';
import { pickTextureValues, withImagePayload, type TextureSource } from '@/utils/textureSources';
import { fillTemplate } from '@/utils/fillTemplate';
import { isEvalMode } from '@/eval/evalMode';
import { TexturePicker } from './TexturePicker';
import { ImageMappingSettings } from './ImageMappingSettings';
import { loadImageOrigin, stashImageOrigin, canStashPayload, type ImageOriginPayload } from '@/utils/imageOriginCache';
import { deriveOriginView, type LoadedOrigin } from './imageOriginView';
import { generateId } from '@/utils/idGenerator';

const checkLabelStyle = { ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px' } as const;
const checkStyle = { width: '12px', height: '12px', margin: 0 } as const;
const valueStyle = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-primary)',
  fontVariantNumeric: 'tabular-nums',
} as const;

/**
 * "From file…" (TexturePicker) — the canvas drop's pipeline, aimed at an
 * EXISTING node instead of a new one: the same `encodeImageFile` (EXIF strip,
 * device texture cap, per-image budget, the convert-or-keep choice), the same
 * `resolveImageDrop` (a power-of-two snap ships only with its stashed
 * original), and the same announcements — a per-image refusal, the device
 * downscale notice and the import note's budget lines. What differs is what a
 * drop cannot have: the payload REPLACES this node's, so the project budget is
 * checked per instance through `imageCharsReplacing`, only when the file GROWS
 * the payload, and a refusal raises `image-pick-cap` (a toggle; there is no
 * drop point for "Add anyway" to place a node at).
 *
 * A module function, not a closure over the menu's render: the menu can close
 * or MOVE to another node mid-encode, and a notice's `proceed` can run long
 * after the menu is gone. So it takes the node's id, re-reads that node LIVE
 * after the await, and writes ONE updateNodeData (one undo entry) or nothing.
 * An empty node — added from the palette or stripped on restore — gets its
 * picture this way.
 */
async function fillImageNodeFromFile(
  targetId: string,
  file: File,
  mode: ImageConvertMode,
  forceIgnoreLimits = false,
): Promise<void> {
  const language = useAppStore.getState().language;
  if (isSvgFile(file)) {
    window.alert(
      fillTemplate(t('Could not load {name}:\nSVG images can\'t be imported — export it as PNG or WebP first.', language), {
        name: `“${file.name}”`,
      }),
    );
    return;
  }
  const before = useAppStore.getState();
  // "Add anyway" on a per-image refusal re-runs this with the soft limits off,
  // exactly as the drop's own override re-encodes (hard ceilings still apply).
  const ignore = forceIgnoreLimits || before.ignoreImageLimits;
  const deviceCap = resolveDeviceTextureDim(before.selectedHeadsetId, before.costProfiles);
  const res = await encodeImageFile(file, ignore, deviceCap, mode);
  const store = useAppStore.getState();
  if (!res.ok) {
    if (res.reason === 'too-large' || res.reason === 'pixels') {
      store.enqueueLimitNotice({
        id: generateId(),
        kind: res.reason === 'pixels' ? 'image-too-many-pixels' : 'image-too-large',
        fileName: file.name,
        detail: res.width && res.height ? `${res.width}×${res.height}` : undefined,
        // No `file` + `position`: those make "Add anyway" place a NEW node at
        // a drop point. The override refills THIS node instead.
        proceed: () => void fillImageNodeFromFile(targetId, file, mode, true),
      });
    } else {
      window.alert(fillTemplate(t('Could not load {name} as an image.', language), { name: `“${file.name}”` }));
    }
    return;
  }
  const { payload, origin } = resolveImageDrop(res, file.name, (p) => stashImageOrigin(p, Date.now()));
  const live = store.nodes.find((n) => n.id === targetId);
  if (!live || live.data.registryType !== 'imageNode') return;
  const liveVals = getNodeValues(live);
  const currentUrl = typeof liveVals.imageB64 === 'string' ? liveVals.imageB64 : '';
  if (currentUrl === payload.dataUrl && liveVals.fileName === file.name) return;
  if (
    !ignore &&
    payload.dataUrl.length > currentUrl.length &&
    imageCharsReplacing(store.nodes, targetId, payload.dataUrl) > MAX_TOTAL_IMAGE_CHARS
  ) {
    store.enqueueLimitNotice({
      id: generateId(),
      kind: 'image-pick-cap',
      fileName: displayImageFileName(file.name, payload.dataUrl),
    });
    return;
  }
  store.updateNodeData(targetId, {
    values: withImagePayload(liveVals, {
      dataUrl: payload.dataUrl,
      width: payload.width,
      height: payload.height,
      fileName: file.name,
      ...(origin ? { originId: origin.originId, srcWidth: origin.srcWidth, srcHeight: origin.srcHeight } : {}),
    }),
  });
  // The drop's own announcements, in the drop's order (NodeEditor
  // placeImageFile): the import note's budget/lossy/WebP lines, then the
  // device-downscale notice. The WebP line is withheld on an override, as the
  // drop's "Add anyway" withholds it.
  const convertNote: ConvertNoteReason | null =
    forceIgnoreLimits || store.hideImageConvertNotice
      ? null
      : mode === 'convert' && !res.webpAvailable
        ? 'no-webp'
        : mode === 'keep' && store.imageConvertMode === 'never'
          ? 'preference'
          : null;
  store.showImageDropReports(undefined, [imageDropReport(res, payload, convertNote)]);
  if (!ignore && !store.hideImageDownscaleWarning && Math.max(res.sourceWidth, res.sourceHeight) > deviceCap) {
    store.enqueueLimitNotice({
      id: generateId(),
      kind: 'image-device-downscaled',
      fileName: file.name,
      downscale: {
        deviceLabel: resolveDeviceBudget(store.selectedHeadsetId, store.costProfiles).label,
        cap: deviceCap,
        sourceW: res.sourceWidth,
        sourceH: res.sourceHeight,
        finalW: res.original?.width ?? payload.width,
        finalH: res.original?.height ?? payload.height,
      },
    });
  }
}

/** Image-node section of the right-click settings menu.
 *
 *  Its own component (rather than an inline block in NodeSettingsMenu)
 *  because it needs hooks: the pre-snap "original" lives in IndexedDB, and it
 *  is read when the menu opens — and again whenever the node's `originId`
 *  changes, which includes a second right-click MOVING the menu to another
 *  node without remounting it (imageOriginView.ts says what the read means
 *  for the node on screen, and why it is keyed by id). That prefetch is what
 *  lets both the Revert button and the Data-map checkbox apply their change
 *  synchronously, as a SINGLE undo entry — `updateNodeData` pushes history
 *  the moment it is called, so a handler that awaited the read mid-click
 *  would split one click into two undo steps, with the intermediate one
 *  leaving the node half changed. */
export function ImageNodeSettings({ nodeId }: { nodeId: string }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);
  const convertMode = useAppStore((s) => s.imageConvertMode);
  const setConvertMode = useAppStore((s) => s.setImageConvertMode);
  /** The last completed read of the original cache, KEYED by the originId
   *  it was for — never "the original" on its own, since this state outlives
   *  the node it was read for when the menu moves (imageOriginView.ts). */
  const [loaded, setLoaded] = useState<LoadedOrigin>(null);
  /** The Original row's receipt latch (see where it is read, below). Declared
   *  up here with the other hooks, above the early return. */
  const receiptRef = useRef<string | null>(null);
  /** A resolution change is a decode + resample + encode; the row says so. */
  const [resizing, setResizing] = useState(false);
  /** Which node a "From file…" import is running for. Keyed by id rather than
   *  a flag, because a menu MOVED to another node mid-import must not show that
   *  node as busy (the imageOriginView lesson). */
  const [importingFor, setImportingFor] = useState<string | null>(null);
  const selectedHeadsetId = useAppStore((s) => s.selectedHeadsetId);
  const costProfiles = useAppStore((s) => s.costProfiles);

  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
  const vals = node ? getNodeValues(node) : {};
  const originId = typeof vals.originId === 'string' ? vals.originId : '';

  useEffect(() => {
    if (!originId) {
      setLoaded(null);
      return;
    }
    let alive = true;
    // Recorded under the id it was read FOR. `pending` and `origin` are
    // derived from that pair, so there is no flag to forget to reset: an id
    // that goes to '' mid-read simply stops being pending.
    void loadImageOrigin(originId).then((payload) => {
      if (alive) setLoaded({ id: originId, payload });
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
  /** Study session (eval): sampled once per page, so every render agrees. */
  const study = isEvalMode();
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

  /**
   * `origin` is the original read for the originId the node carries NOW —
   * null while that read is outstanding (`pending`), never the previous
   * node's. `showOriginal` is the Original row's gate plus its receipt latch:
   * once the row and Revert have shown for this node AND this payload lineage
   * (`nodeId|originId`) they stay for the rest of the menu session, because
   * "the payload differs from the original" is false on the very frame a
   * revert lands — without the latch the block unmounted under the cursor and
   * the documented receipt (the button dropping to "already the original")
   * could never render. A revert keeps `originId`, so the receipt survives it;
   * a change of lineage drops it. The latch is a ref written during render —
   * idempotent, so a StrictMode double render lands on the same value.
   */
  const view = deriveOriginView({ nodeId, originId, loaded, url, resized, receipt: receiptRef.current });
  receiptRef.current = view.receipt;
  const { origin, pending, restorable, showOriginal } = view;

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
   * The resolution ladder — POWER-OF-TWO rungs derived from the ORIGINAL (see
   * `resolutionLadder`): the top rung is the original snapped by the drop's
   * own 80 % rule, each further rung halves it. The re-encode always reads
   * from the original, never from a smaller payload, or 2048 → 1024 → 512
   * would stack three lossy passes and could never go back up.
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
  /** Which rung the stored payload is on — none for a payload stored before
   *  the snap became unconditional, or one declined at drop ("No" in the
   *  import dialog), whose NPOT size is on no power-of-two rung. */
  const currentStep = ladder.find((step) => step.width === w && step.height === h) ?? null;

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
    // The LIVE node's payload is the one replaced (the project budget counts
    // per instance — PROJECT_IMAGE_BUDGET_COUNT).
    return imageCharsReplacing(store.nodes, nodeId, o.dataUrl) > MAX_TOTAL_IMAGE_CHARS;
  };

  // Both notices name the image by its STORED extension, as the card does
  // (displayImageFileName): a converted "photo.png" is "photo.webp" here too.
  const noticeOverBudget = () =>
    useAppStore.getState().enqueueLimitNotice({
      id: generateId(),
      kind: 'image-revert-cap',
      fileName: displayImageFileName(vals.fileName, vals.imageB64),
    });

  /** N6: a Resolution pick that would GROW the payload past the project
   *  budget has its own notice — the revert wording ("restoring … to its
   *  pre-conversion version") is not what the user just did. `raising` only
   *  picks its wording: "Raising" when the pick adds pixels, "Resizing" when
   *  a step down grew the bytes anyway. */
  const noticeResolutionOverBudget = (width: number, height: number, raising: boolean) =>
    useAppStore.getState().enqueueLimitNotice({
      id: generateId(),
      kind: 'image-resolution-cap',
      fileName: displayImageFileName(vals.fileName, vals.imageB64),
      resize: { width, height, raising },
    });

  /** A resize or a file import is running on THIS node. */
  const importing = importingFor === nodeId;
  const busy = resizing || importing;

  /** Point this node at an image the project already holds — ONE
   *  updateNodeData, no await: one click, one undo entry. It is a COPY
   *  (pickTextureValues): the payload and its provenance, never a link.
   *  Counted like every other payload change, per INSTANCE
   *  (PROJECT_IMAGE_BUDGET_COUNT), and only when the pick GROWS this node's
   *  payload — a pick that shrinks it moves toward the budget and is never
   *  refused. An empty node (palette-added, or stripped on restore) can be
   *  given a picture this way. */
  const pickTexture = (src: TextureSource) => {
    if (busy) return;
    // The ONE place a source becomes node values. Phase 5's 'model' kind is
    // not a value to copy — it needs materialising through the import
    // pipeline, its own budget check and a display URL — so a new kind fails
    // to compile here until it is handled.
    switch (src.kind) {
      case 'project':
        break;
      default: {
        // `src.kind`, not `src`: a one-member "union" is a plain interface
        // and does not narrow to never, while its discriminant does.
        const unhandled: never = src.kind;
        void unhandled;
        return;
      }
    }
    const store = useAppStore.getState();
    const live = store.nodes.find((n) => n.id === nodeId);
    if (!live || live.data.registryType !== 'imageNode') return;
    const liveVals = getNodeValues(live);
    const next = pickTextureValues(liveVals, src);
    if (!next) return;
    const currentUrl = typeof liveVals.imageB64 === 'string' ? liveVals.imageB64 : '';
    if (
      !store.ignoreImageLimits &&
      src.dataUrl.length > currentUrl.length &&
      imageCharsReplacing(store.nodes, nodeId, src.dataUrl) > MAX_TOTAL_IMAGE_CHARS
    ) {
      store.enqueueLimitNotice({
        id: generateId(),
        kind: 'image-pick-cap',
        fileName: displayImageFileName(src.fileName, src.dataUrl),
      });
      return;
    }
    updateNodeData(nodeId, { values: next });
  };

  /** "From file…": the encode runs off the render (fillImageNodeFromFile);
   *  this only marks which node it is running for. */
  const pickFile = (file: File, mode: ImageConvertMode) => {
    if (busy) return;
    const targetId = nodeId;
    setImportingFor(targetId);
    void fillImageNodeFromFile(targetId, file, mode).finally(() =>
      setImportingFor((cur) => (cur === targetId ? null : cur)),
    );
  };

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
   *
   * It is gated on `busy`, not only on `resizing`: a "From file…" import is
   * the other async writer to this node, and the two landing out of order
   * would leave one picture's pixels beside the other's provenance.
   */
  const applyResolution = async (key: string) => {
    if (!ladderSource || !canKeepOriginal || busy) return;
    const step = ladder.find((x) => x.key === key);
    if (!step) return;
    if (step.original) {
      // The original IS this rung (a source that was already a power of
      // two). With a stored one, put it back; without one the payload already
      // is it and there is nothing to do.
      if (origin) revert();
      return;
    }
    /** The payload this resize starts from. The result is written only if the
     *  node still holds it after the await (see below). */
    const startUrl = url;
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
      // The node's picture moved while this encode ran — a texture pick, a
      // "From file…" import, an undo, or a pick made after the menu was
      // closed and reopened (which resets `busy`). The result was resized
      // from a picture the node no longer holds, and the stash below would
      // pair it with the new picture's provenance, so it is dropped.
      if (currentUrl !== startUrl) return;
      // Going back UP a rung can grow the payload, so the project-wide budget
      // is re-checked — but only when the new encode really GROWS it. A pick
      // that shrinks the payload moves toward the budget and is never refused,
      // even in a project already over it (placed or imported under
      // ignore-limits, then the box cleared).
      //
      // The test is on BYTES, not pixels, and a step DOWN can grow the bytes:
      // a lossless source that fits a lower rung only lossy comes back longer
      // (measured: a dithered 1700² PNG, 288 K, is 557 K at 1024²). Against a
      // byte budget that must be refused too, so only the WORDING follows the
      // pixels — "Raising" is said only when the pick adds some.
      if (!store.ignoreImageLimits && encoded.dataUrl.length > currentUrl.length) {
        const total = imageCharsReplacing(store.nodes, nodeId, encoded.dataUrl);
        if (total > MAX_TOTAL_IMAGE_CHARS) {
          const raising = encoded.width * encoded.height > Number(liveVals.width) * Number(liveVals.height);
          noticeResolutionOverBudget(encoded.width, encoded.height, raising);
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
      {/* The texture picker: every image the project already holds, plus
          "From file…". Study sessions keep today's Image node (research §7),
          so it is hidden there — the gate is UI-only. Keyed by the node so a
          menu MOVED to another node starts with the grid closed and no
          half-answered file question carried over. */}
      {!study && (
        <TexturePicker
          key={nodeId}
          currentUrl={url}
          currentName={vals.fileName}
          disabled={busy}
          loading={importing}
          onPick={pickTexture}
          onFile={pickFile}
        />
      )}
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
            value={resizing ? 'busy' : (currentStep?.key ?? 'current')}
            disabled={busy || pending}
            onChange={(e) => void applyResolution(e.target.value)}
          >
            {resizing && <option value="busy">{t('Re-encoding…', language)}</option>}
            {/* An NPOT payload (stored before the snap became unconditional,
                or declined at drop) is on no power-of-two rung, so its size is
                shown as its own entry rather than leaving the box reading
                someone else's number. */}
            {!resizing && !currentStep && <option value="current">{resolution}</option>}
            {!resizing && ladder.map((step) => (
              <option key={step.key} value={step.key}>
                {`${step.width} × ${step.height}`}
                {step.original ? ` (${t('original', language)})` : ''}
              </option>
            ))}
          </select>
        </div>
      ) : (
        infoRow(
          t('Resolution', language),
          resolution,
          // Four different reasons the ladder is absent, each named: a node
          // holding no image at all (added empty from the palette, or its
          // payload stripped on restore), which must never be told its image
          // is too large; the resized image whose original has left this
          // device; the untouched payload the cache would refuse to keep a
          // copy of (placed under ignore-limits); and, rarely, a source too
          // small to halve at all.
          !url
            ? t('This node holds no image yet, so there is no resolution to change.', language)
            : ladder.length === 1
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
      {/* Filtering: how the texture fills in between its pixels. Nearest (the
          API's own term — three's NearestFilter, WebGL GL_NEAREST, WebGPU
          'nearest') keeps hard pixel edges; Linear is the default. Stored as
          the string graphToCode compares against, and an absent key reads as
          linear, so a node never ticked here emits what it always did. */}
      <div style={rowStyle}>
        <span
          style={labelStyle}
          title={t('How the image fills in between its pixels. Linear blends neighbouring pixels for a smooth look; Nearest takes the closest pixel and keeps hard edges, for pixel art or a deliberately blocky look.', language)}
        >
          {t('Filtering', language)}
        </span>
        <select
          style={wideFieldStyle}
          value={vals.filter === 'nearest' ? 'nearest' : 'linear'}
          onChange={(e) => setVal('filter', e.target.value === 'nearest' ? 'nearest' : 'linear')}
        >
          <option value="linear">{t('Linear (smooth)', language)}</option>
          <option value="nearest">{t('Nearest (sharp pixels)', language)}</option>
        </select>
      </div>

      {/* The glTF mapping (orientation, UV set, green flip, texture
          transform), collapsed. Study sessions keep today's Image node
          (research §7), so it is hidden there too; stored mapping keys still
          emit, because the gate is UI-only. */}
      {!study && <ImageMappingSettings nodeId={nodeId} />}

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
            // `restorable` is already false while the read is outstanding;
            // `pending` is spelled out so the rule reads where it applies.
            disabled={!restorable || pending}
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
