import { useEffect, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { useModalKeys } from '@/components/Modals/useModalKeys';
import { ConnectScene } from './ConnectScene';
import { InsertScene } from './InsertScene';
import { BudgetScene } from './BudgetScene';
import { ImageScene } from './ImageScene';
import { FolderScene } from './FolderScene';
import { CodeScene } from './CodeScene';
import { ExposeScene } from './ExposeScene';
import { DrawScene } from './DrawScene';
import { OrganizeScene } from './OrganizeScene';
import { PreviewScene } from './PreviewScene';
import { UniformScene } from './UniformScene';
import { ModelScene } from './ModelScene';
import { introHidden, setIntroHidden, type IntroVia } from './introGate';
import { LangSwitch } from '@/eval/LangSwitch';
import { evalLog } from '@/eval/telemetry';
import { evalTask, introShowsBudget } from '@/eval/evalTask';
import '@/components/Modals/CsvImportModal.css';
import './IntroWindow.css';

/** The slides, in order: a live scene and the line under it. `id` names the
 *  slide in a study session's log (`intro-slide`), stable across reorders. */
const SLIDES: ReadonlyArray<{ id: string; Scene: ComponentType; caption: string }> = [
  {
    id: 'connect',
    Scene: ConnectScene,
    caption: 'Drag a node onto another node to connect them. Move it up or down to pick the socket.',
  },
  {
    id: 'insert',
    Scene: InsertScene,
    caption: 'Right-click a wire to insert a node into it. Delete the node and the wire joins up again.',
  },
  {
    id: 'budget',
    Scene: BudgetScene,
    caption: 'FastShaders uses points to estimate how hard a shader works your target device. Only nodes wired to the Output count; when the total goes over the device’s budget, the numbers turn red.',
  },
  {
    id: 'image',
    Scene: ImageScene,
    caption: 'Drop an image on the canvas. Say Yes and FastShaders stores it as WebP, scaled to the size your target device needs.',
  },
  {
    id: 'folder',
    Scene: FolderScene,
    caption: 'In the desktop app, pick a Work folder once. Its shaders are listed under the arrow: open one, change it, and Save writes it back to its file.',
  },
  {
    id: 'code',
    Scene: CodeScene,
    caption: 'Type TSL in the code panel and press Apply: the graph is built from it.',
  },
  {
    id: 'expose',
    Scene: ExposeScene,
    caption: 'Right-click a node and tick a setting to make it an input socket. The Output’s menu adds channels such as Emissive the same way.',
  },
  {
    id: 'draw',
    Scene: DrawScene,
    caption: 'Turn on Draw to mark up the canvas, and right-click to add a note.',
  },
  {
    id: 'organize',
    Scene: OrganizeScene,
    caption: 'Drag a box around nodes to select them, then right-click and pick Organize: they are laid out in the order the wires run.',
  },
  {
    id: 'preview',
    Scene: PreviewScene,
    caption: 'Alt/⌥-click a node to see it in the 3D view in place of Color; click anywhere else to stop. Ctrl/⌘-click it to attach it to the Output for good.',
  },
  {
    id: 'uniform',
    Scene: UniformScene,
    caption: 'A Property node is a uniform: the 3D view gives it a slider that changes the shader as you drag. Set as default writes the value into the node.',
  },
  {
    id: 'model',
    Scene: ModelScene,
    caption: 'Drop your own model on the 3D view, animated ones too. The same graph shades each one: here Vertex Wave moves the surface and Checker colours it.',
  },
];

/**
 * The window FastShaders opens with (`introGate.ts` decides; App.tsx mounts it
 * lazily; in a study session only after Agree): slides of live scenes drawn with the real
 * node cards, stepped with the arrows beside the stage, the boxes under it, or
 * ← / →. Only the shown slide is mounted, so only its animation runs.
 *
 * The shared dialog chrome (CsvImportModal.css), laid out on one centre line:
 * the title with the language switch beside it (the study dialogs' own
 * `LangSwitch` — the toolbar's is behind the backdrop), the stage, Start and
 * "Don't show this again" under it. There is no ✕: Escape, the backdrop and
 * Start close it, and closing writes "Don't show this again" whichever way it
 * went. `aria-modal` is what stands the canvas's shortcuts down behind it. The
 * backdrop swallows a dropped file, so it never navigates away.
 */
/**
 * The slides a STUDY session shows (every entry — `introInStudy`): all of
 * them but the Work folder (a desktop-app feature the study's web build does
 * not have) and, where the cost bar is hidden, the point budget — teaching the
 * budget would hand that condition the feedback it removes.
 */
function studySlides(): typeof SLIDES {
  const budget = introShowsBudget(evalTask());
  return SLIDES.filter((s) => s.id !== 'folder' && (budget || s.id !== 'budget'));
}

/**
 * In a study session (`study`) the window is part of what is measured: its
 * opening (`via`: Agree or the toolbar's "i"), every slide shown and its close
 * are logged, and it writes nothing — "Don't show this again" is not offered,
 * as no study session ever opens it at boot.
 */
export function IntroWindow({ onClose, via = 'boot', study = false }: { onClose: () => void; via?: IntroVia; study?: boolean }) {
  const language = useAppStore((s) => s.language);
  const startRef = useRef<HTMLButtonElement>(null);
  const [slides] = useState(() => (study ? studySlides() : SLIDES));
  const [index, setIndex] = useState(0);
  const [dontShow, setDontShow] = useState(introHidden);
  const last = slides.length - 1;
  const seen = useRef(new Set<number>([0]));
  const go = (i: number) => {
    const to = Math.max(0, Math.min(last, i));
    if (to === index) return;
    seen.current.add(to);
    if (study) evalLog('intro-slide', { slide: slides[to].id, n: to + 1 });
    setIndex(to);
  };

  const close = () => {
    if (study) {
      evalLog('intro-close', { slide: slides[index].id, seen: seen.current.size, of: slides.length });
    } else {
      setIntroHidden(dontShow);
    }
    onClose();
  };

  // Mount = opened. `slide` is the first one shown, so a session that never
  // pages still records which slide it saw. Once per mount (the window is
  // unmounted on close): the ref keeps StrictMode's dev re-run of the effect
  // from logging a second open.
  const openLogged = useRef(false);
  useEffect(() => {
    if (!study || openLogged.current) return;
    openLogged.current = true;
    evalLog('intro-open', { via, slide: slides[0].id, of: slides.length });
  }, [study, via, slides]);

  useModalKeys(true, (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.stopPropagation();
      e.preventDefault();
      go(index + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  }, true);

  useEffect(() => startRef.current?.focus(), []);

  const { Scene, caption } = slides[index];
  const slideName = (i: number) =>
    fillTemplate(t('Hint {n} of {total}', language), { n: String(i + 1), total: String(slides.length) });

  return createPortal(
    <div
      className="csv-import-modal__backdrop"
      onClick={close}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div
        className="csv-import-modal__panel fs-intro__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fs-intro-title"
        aria-describedby="fs-intro-caption"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fs-intro__head">
          <div className="csv-import-modal__title fs-intro__title" id="fs-intro-title">
            {t('Intro', language)}
          </div>
          <LangSwitch />
        </div>

        <div className="fs-intro__body">
          {/* Each arrow keeps its column when it has nowhere to go, so the
              stage never shifts between slides. */}
          <button
            className="fs-intro__arrow"
            style={{ visibility: index > 0 ? 'visible' : 'hidden' }}
            title={t('Previous hint', language)}
            aria-label={t('Previous hint', language)}
            onClick={() => go(index - 1)}
          >
            ‹
          </button>
          <div className="fs-intro__slide">
            <Scene key={index} />
          </div>
          <button
            className="fs-intro__arrow"
            style={{ visibility: index < last ? 'visible' : 'hidden' }}
            title={t('Next hint', language)}
            aria-label={t('Next hint', language)}
            onClick={() => go(index + 1)}
          >
            ›
          </button>
        </div>

        <div className="fs-intro__dots" role="group" aria-label={slideName(index)}>
          {slides.map((_, i) => (
            <button
              key={i}
              className={`fs-intro__dot${i === index ? ' fs-intro__dot--on' : ''}`}
              title={slideName(i)}
              aria-label={slideName(i)}
              aria-current={i === index ? 'step' : undefined}
              onClick={() => go(i)}
            />
          ))}
        </div>

        <div className="csv-import-modal__message fs-intro__caption" id="fs-intro-caption">
          {t(caption, language)}
        </div>

        <div className="fs-intro__actions">
          <button ref={startRef} className="csv-import-modal__button csv-import-modal__button--yes" onClick={close}>
            {t('Start', language)}
          </button>
          {!study && (
            <label className="fs-intro__again">
              <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
              {t('Don’t show this again', language)}
            </label>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
