/**
 * Intro scene — an image dropped on the canvas: the app asks to convert it,
 * stores it as WebP at the size the target device needs, and says so.
 *
 * Nothing it shows is written into the slide. A phone-sized photo is painted
 * (introPhoto.ts) and run through the REAL drop encode — `encodeImageFile` at
 * the user's device texture cap, in 'convert' mode — then `resolveImageDrop`
 * and `makeImageNodeFromEncode` build the node exactly as a drop does, so the
 * picture, its format, its resolution and both sizes are measured. The two
 * dialogs are the app's own panels (`ImageImportPanel`, `LimitNoticePanel` with
 * `limitNoticeCopy`'s words) and the card is the canvas's own picture block.
 *
 * Two differences from a drop, both so the intro writes nothing: the original
 * is not stashed in IndexedDB (the stash is answered "kept", which is what a
 * drop on a working machine gets, so the node is the snapped one a drop
 * places), and no store state changes. The encode runs once per device cap per
 * session, when this slide is first shown.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore, resolveDeviceBudget, resolveDeviceTextureDim, type LimitNotice } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getCost, imageNodeCost } from '@/utils/nodeCost';
import { makeImageNodeFromEncode, resolveImageDrop } from '@/utils/imageNode';
import { filePictureOrientation } from '@/utils/pictureOrientation';
import { formatKbMb } from '@/utils/formatSize';
import { ShaderCardContent, useCardChrome } from '@/components/NodeEditor/NodePreviewCard';
import { useCostChrome } from '@/components/NodeEditor/nodes/useCostChrome';
import { ImageImportPanel } from '@/components/Modals/ImageImportModal';
import { LimitNoticePanel } from '@/components/Modals/LimitModal';
import { limitNoticeCopy } from '@/components/Modals/limitNoticeCopy';
import { INTRO_PHOTO, makeIntroPhoto } from './introPhoto';
import { buildImageTour, imageFrame, type ImageState, type ImageTour } from './imageTour';
import { IntroStage, centre, paintCursor, stageMeasurer, useIntroStage } from './IntroStage';
import type { Point } from './timeline';

/** The drop point — the node's top-left, as a drop places it. */
const DROP: Point = { x: 196, y: 64 };
/** Where the drag comes in from: beyond the stage's left edge. */
const ENTER: Point = { x: -40, y: 230 };
/** The pointer holds the dragged file near its top-left corner. */
const GRIP: Point = { x: 18, y: 14 };
const noop = () => {};

const imageDef = NODE_REGISTRY.get('imageNode')!;

interface IntroImage {
  /** The dropped file, as its chip shows it. */
  bytes: number;
  /** The node's values, built the way a drop builds them. */
  values: Record<string, string | number>;
  /** The device-downscale notice's numbers, when the photo was over the cap. */
  downscale: { cap: number; sourceW: number; sourceH: number; finalW: number; finalH: number } | null;
}

const cache = new Map<number, Promise<IntroImage | null>>();

async function buildIntroImage(cap: number): Promise<IntroImage | null> {
  const [{ encodeImageFile }, file] = await Promise.all([import('@/utils/imageImport'), makeIntroPhoto()]);
  if (!file) return null;
  const res = await encodeImageFile(file, false, cap, 'convert');
  if (!res.ok) return null;
  // "Kept" — see the module comment: the intro stashes nothing.
  const { payload, origin } = resolveImageDrop(res, file.name, () => 'intro');
  const cost = imageNodeCost(getCost('imageNode'), payload.width, payload.height);
  const data = makeImageNodeFromEncode(payload, cost, file.name, origin, filePictureOrientation(useAppStore.getState()));
  return {
    bytes: file.size,
    values: data.values as Record<string, string | number>,
    downscale:
      Math.max(res.sourceWidth, res.sourceHeight) > cap
        ? {
            cap,
            sourceW: res.sourceWidth,
            sourceH: res.sourceHeight,
            finalW: res.original?.width ?? payload.width,
            finalH: res.original?.height ?? payload.height,
          }
        : null,
  };
}

function loadIntroImage(cap: number): Promise<IntroImage | null> {
  let p = cache.get(cap);
  if (!p) {
    p = buildIntroImage(cap).catch(() => null);
    cache.set(cap, p);
  }
  return p;
}

const IDLE: ImageState = { dragging: false, ask: false, node: false, notice: false, pressed: false };

export function ImageScene() {
  const stage = useIntroStage();
  const language = useAppStore((s) => s.language);
  const headsetId = useAppStore((s) => s.selectedHeadsetId);
  const costProfiles = useAppStore((s) => s.costProfiles);
  const cap = resolveDeviceTextureDim(headsetId, costProfiles);
  const deviceLabel = resolveDeviceBudget(headsetId, costProfiles).label;

  const [image, setImage] = useState<IntroImage | null>(null);
  useEffect(() => {
    let live = true;
    void loadIntroImage(cap).then((img) => {
      if (live) setImage(img);
    });
    return () => {
      live = false;
    };
  }, [cap]);

  const chrome = useCardChrome(imageDef);
  // Priced LIVE from its resolution, as a canvas Image node is (nodeCostPoints):
  // the image is built once per session and cap, under whichever device was
  // selected then, and useCostChrome re-renders this on a device change.
  const cost = image ? imageNodeCost(getCost('imageNode'), image.values.width, image.values.height) : 0;
  const costChrome = useCostChrome(cost);

  const nodeRef = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<number | null>(null);
  const [tour, setTour] = useState<ImageTour | null>(null);
  const [state, setState] = useState<ImageState>(IDLE);

  const notice: LimitNotice | null = image?.downscale
    ? {
        id: 'intro',
        kind: 'image-device-downscaled',
        fileName: INTRO_PHOTO.name,
        downscale: { deviceLabel, ...image.downscale },
      }
    : null;
  const noticeCopy = notice ? limitNoticeCopy(notice, language) : null;

  useLayoutEffect(() => {
    const stageEl = stage.stageRef.current;
    const ask = askRef.current;
    if (!image || !stageEl || !ask) return;
    const measure = () => {
      const box = stageMeasurer(stageEl);
      if (!box) return;
      const base = stageEl.getBoundingClientRect();
      const origin = { x: 0, y: 0 };
      const yes = box(ask.querySelector('.csv-import-modal__button--yes'), base, origin);
      const ok = noticeRef.current ? box(noticeRef.current.querySelector('.csv-import-modal__button'), base, origin) : null;
      if (!yes) return;
      setTour(
        buildImageTour(
          { enter: ENTER, drop: DROP, yes: centre(yes), ok: ok ? centre(ok) : centre(yes) },
          { notice: !!ok },
        ),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ask);
    if (noticeRef.current) ro.observe(noticeRef.current);
    return () => ro.disconnect();
  }, [image, stage.scale, stage.stageRef, language, !!noticeCopy]);

  useEffect(() => {
    const scene = stage.sceneRef.current;
    const cursor = stage.cursorRef.current;
    const chip = chipRef.current;
    if (!tour || !scene || !cursor || !chip) return;
    let shown: ImageState | null = null;
    const paint = (time: number) => {
      const f = imageFrame(tour, time);
      scene.style.opacity = String(f.opacity);
      paintCursor(cursor, f.cursor, { pressed: f.state.pressed });
      chip.style.transform = `translate(${f.cursor.x - GRIP.x}px, ${f.cursor.y - GRIP.y}px)`;
      chip.style.visibility = f.state.dragging ? 'visible' : 'hidden';
      if (f.state !== shown) {
        shown = f.state;
        setState(f.state);
      }
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      paint(tour.placed);
      return;
    }
    let raf = 0;
    clockRef.current ??= performance.now();
    const t0 = clockRef.current;
    const loop = (now: number) => {
      paint(now - t0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tour, stage.sceneRef, stage.cursorRef]);

  const source = `${INTRO_PHOTO.width} × ${INTRO_PHOTO.height}`;

  return (
    <IntroStage stage={stage}>
      {image && (
        <>
          <div
            ref={nodeRef}
            className="react-flow__node fs-intro__node"
            style={{ left: DROP.x, top: DROP.y, visibility: state.node ? 'visible' : 'hidden' }}
          >
            <ShaderCardContent {...chrome} {...costChrome} cost={cost} values={image.values} />
          </div>

          {/* The file as the operating system drags it in — no app chrome
              exists for this, so it is the stage's own. */}
          <div ref={chipRef} className="fs-intro__file" style={{ visibility: 'hidden' }}>
            <img className="fs-intro__file-thumb" src={String(image.values.imageB64)} alt="" />
            <div>
              <div className="fs-intro__file-name">{INTRO_PHOTO.name}</div>
              <div className="fs-intro__file-meta">
                {source} · {formatKbMb(image.bytes)}
              </div>
            </div>
          </div>

          <div ref={askRef} className="csv-import-modal__backdrop fs-intro__backdrop" style={{ visibility: state.ask ? 'visible' : 'hidden' }}>
            <ImageImportPanel count={1} language={language} remember={false} onRemember={noop} onNo={noop} onYes={noop} inert />
          </div>
          {noticeCopy && (
            <div
              ref={noticeRef}
              className="csv-import-modal__backdrop fs-intro__backdrop"
              style={{ visibility: state.notice ? 'visible' : 'hidden' }}
            >
              <LimitNoticePanel
                copy={noticeCopy}
                language={language}
                desktopNote={false}
                checkboxOn={false}
                onCheck={noop}
                onDismiss={noop}
                onProceed={noop}
                inert
              />
            </div>
          )}
        </>
      )}
    </IntroStage>
  );
}
