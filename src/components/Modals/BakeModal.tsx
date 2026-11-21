/**
 * "Bake to texture" (docs/dev/baking.md): what leaves the selection, whether
 * each socket can be baked and why not, one size, and Bake. Loaded through
 * `lazyOr` by BakeLauncher, so nothing of the bake is on the boot wave.
 *
 * Modal like every dialog here: every key but Tab is swallowed in the capture
 * phase (the canvas binds its shortcuts on `window`), Escape is Cancel while
 * nothing runs, and the backdrop is Cancel. Every refusal and every stop is a
 * SENTENCE in the dialog — a limit announces itself — and the over-budget stop
 * offers "Add anyway", which commits the pictures already made.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { useModalKeys } from './useModalKeys';
import { previewBakeContext } from '@/components/Preview/previewBake';
import {
  MAX_BAKE_SOCKETS,
  planBake,
  type BakeRefusal,
  type BakeSocketPlan,
  type BakeWarning,
} from '@/utils/bakePlan';
import { bakeSizesOffered, runBake, type BakeRunError, type BakeRunOutcome } from './bakeRun';
import './CsvImportModal.css';
import './BakeModal.css';

/** One sentence per refusal — i18n KEYS (lv.json carries their Latvian). */
export const BAKE_REFUSAL_TEXT: Record<BakeRefusal, string> = {
  view: 'Depends on the camera or the screen, so no texture can hold it.',
  unknown: 'Contains an expression the bake cannot reproduce.',
  constant: 'Is one value everywhere, so there is nothing to bake.',
  'uv-channels': 'Reads two different UV channels.',
  'uv-channel-wired': 'The Channel of a UV node is wired, so the bake cannot tell which UV map it reads.',
  'needs-mesh': 'Reads the surface of the model, and the UVs of this model overlap. Show the Sphere, Plane, Stanford Bunny or a dropped model in the 3D view.',
  'no-preview': 'Nothing in the 3D view can show it.',
  'sdf-driven': 'An SDF Output or a Gaussian splat drives the 3D view.',
};

export const BAKE_WARNING_TEXT: Record<BakeWarning, string> = {
  time: 'Time is frozen at the moment of the bake.',
  sound: 'Sound is frozen at the moment of the bake.',
  tuned: 'Properties are baked at their current values.',
  derivative: 'Line widths are baked in texels, not in screen pixels.',
  world: 'World-space values are baked at the current turn of the model.',
  displaced: 'The bake reads the surface before displacement.',
};

export const BAKE_ERROR_TEXT: Record<BakeRunError, string> = {
  'no-preview': 'The 3D view is not running, so nothing can be baked.',
  timeout: 'The 3D view did not answer in time.',
  render: 'The 3D view could not render the bake.',
  'bad-reply': 'The 3D view sent back something other than the picture asked for.',
  'non-finite': 'The shader gives NaN or infinite values here, which no picture can hold.',
  empty: 'No surface of the shown model reaches the texture. Does the model have UVs?',
  encode: 'This browser could not encode the picture.',
  'too-large': 'The picture does not fit the size limit for one image. Pick a smaller size.',
  'over-budget': 'The image budget of the project is full. Bake at a smaller size, delete Image nodes you do not use, or add it anyway.',
  changed: 'The graph changed while baking. Bake again.',
};

const LAYOUT_TEXT = {
  uv: 'Across the whole UV square',
  mesh: 'Across the UV layout of the model',
} as const;

/** The size the dialog opens on: 1024, or the largest offered below it. */
function defaultSize(sizes: number[]): number {
  return sizes.includes(1024) ? 1024 : sizes[sizes.length - 1];
}

interface Props {
  selectedIds: string[];
  onClose: () => void;
}

export function BakeModal({ selectedIds, onClose }: Props) {
  const language = useAppStore((s) => s.language);
  const bakeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Planned ONCE, on open: the dialog is modal, and the run re-checks the
  // graph against what it baked before it commits.
  const plans = useMemo<BakeSocketPlan[]>(() => {
    const s = useAppStore.getState();
    return planBake(s.nodes, s.edges, selectedIds, previewBakeContext());
  }, [selectedIds]);
  const sizes = useMemo(() => bakeSizesOffered(), []);
  const [size, setSize] = useState(() => defaultSize(sizes));
  const [running, setRunning] = useState<number | null>(null);
  const [stop, setStop] = useState<Extract<BakeRunOutcome, { ok: false }> | null>(null);

  const tooMany = plans.length > MAX_BAKE_SOCKETS;
  const blocked = plans.length === 0 || tooMany || plans.some((p) => p.refusal !== null);
  const why = plans.length === 0
    ? t('Nothing leaves the selection. Wire it into another node first.', language)
    : tooMany
      ? t('More than {n} outputs leave the selection. Bake fewer nodes at a time.', language).replace('{n}', String(MAX_BAKE_SOCKETS))
      : null;

  const close = () => {
    if (running === null) onClose();
  };

  useModalKeys(true, (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') e.stopPropagation();
  }, true);

  useEffect(() => {
    if (bakeRef.current) bakeRef.current.focus();
    else panelRef.current?.focus();
  }, []);

  const finish = (out: BakeRunOutcome) => {
    setRunning(null);
    if (out.ok) onClose();
    else setStop(out);
  };

  const start = async () => {
    if (blocked || running !== null) return;
    setStop(null);
    setRunning(0);
    try {
      finish(await runBake(selectedIds, plans, size, { onProgress: (i) => setRunning(i) }));
    } catch (err) {
      finish({ ok: false, error: 'render', detail: String((err as Error)?.message ?? err).slice(0, 200) });
    }
  };

  const proceed = () => {
    if (!stop?.proceed) return;
    finish(stop.proceed());
  };

  return createPortal(
    <div
      className="csv-import-modal__backdrop"
      onClick={close}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div
        ref={panelRef}
        className="csv-import-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bake-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="bake-modal-title">
          {t('Bake to texture', language)}
        </div>
        <div className="csv-import-modal__message">
          {t('Renders what leaves the selection into a picture on an Image node, which takes over its wires. The baked nodes stay in a collapsed group, unwired.', language)}
        </div>

        {why && <div className="csv-import-modal__message">{why}</div>}
        {!tooMany && plans.map((p) => (
          <div key={`${p.nodeId}\0${p.handleId}`} className="csv-import-modal__message">
            {/* The node's own label is DATA — never through t(). */}
            <div className="bake-modal__label">{p.label}</div>
            {p.refusal ? (
              <div className="bake-modal__refusal">{t(BAKE_REFUSAL_TEXT[p.refusal], language)}</div>
            ) : (
              <>
                <div>{t(LAYOUT_TEXT[p.layout], language)}</div>
                {p.warnings.map((w) => <div key={w}>{t(BAKE_WARNING_TEXT[w], language)}</div>)}
              </>
            )}
          </div>
        ))}

        <label className="csv-import-modal__row">
          <span>{t('Size', language)}</span>
          <select
            value={size}
            disabled={running !== null}
            onChange={(e) => setSize(Number(e.target.value))}
            title={t('Width and height of the baked picture, in pixels. The selected device caps it.', language)}
          >
            {sizes.map((s) => <option key={s} value={s}>{`${s} × ${s}`}</option>)}
          </select>
        </label>

        {running !== null && (
          <div className="csv-import-modal__message" role="status">
            {t('Baking {i} of {n}…', language).replace('{i}', String(running + 1)).replace('{n}', String(plans.length))}
          </div>
        )}
        {stop && running === null && (
          <div className="csv-import-modal__message bake-modal__stop" role="alert">
            {t(BAKE_ERROR_TEXT[stop.error], language)}
          </div>
        )}

        <div className="csv-import-modal__buttons">
          {stop?.proceed && running === null && (
            <button type="button" className="csv-import-modal__button" onClick={proceed}>
              {t('Add anyway', language)}
            </button>
          )}
          <button
            type="button"
            className="csv-import-modal__button"
            onClick={close}
            aria-disabled={running !== null}
          >
            {t('Cancel', language)}
          </button>
          <button
            ref={bakeRef}
            type="button"
            className="csv-import-modal__button csv-import-modal__button--yes"
            aria-disabled={blocked || running !== null}
            title={blocked ? why ?? t('A socket above cannot be baked.', language) : undefined}
            onClick={() => { void start(); }}
          >
            {t('Bake', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
