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
import { introHidden, setIntroHidden } from './introGate';
import { LangSwitch } from '@/eval/LangSwitch';
import '@/components/Modals/CsvImportModal.css';
import './IntroWindow.css';

/** The slides, in order: a live scene and the line under it. */
const SLIDES: ReadonlyArray<{ Scene: ComponentType; caption: string }> = [
  {
    Scene: ConnectScene,
    caption: 'Drag a node onto another node to connect them. Move it up or down to pick the socket.',
  },
  {
    Scene: InsertScene,
    caption: 'Right-click a wire to insert a node into it. Delete the node and the wire joins up again.',
  },
  {
    Scene: BudgetScene,
    caption: 'FastShaders uses points to estimate how hard a shader works your target device. Only nodes wired to the Output count; when the total goes over the device’s budget, the numbers turn red.',
  },
  {
    Scene: ImageScene,
    caption: 'Drop an image on the canvas. Say Yes and FastShaders stores it as WebP, scaled to the size your target device needs.',
  },
  {
    Scene: FolderScene,
    caption: 'In the desktop app, pick a Work folder once. Its shaders are listed under the arrow: open one, change it, and Save writes it back to its file.',
  },
  {
    Scene: CodeScene,
    caption: 'Type TSL in the code panel and press Apply: the graph is built from it.',
  },
  {
    Scene: ExposeScene,
    caption: 'Right-click a node and tick a setting to make it an input socket. The Output’s menu adds channels such as Emissive the same way.',
  },
  {
    Scene: DrawScene,
    caption: 'Turn on Draw to mark up the canvas, and right-click to add a note.',
  },
  {
    Scene: OrganizeScene,
    caption: 'Drag a box around nodes to select them, then right-click and pick Organize: they are laid out in the order the wires run.',
  },
  {
    Scene: PreviewScene,
    caption: 'Alt/⌥-click a node to see it in the 3D view in place of Color; click anywhere else to stop. Ctrl/⌘-click it to attach it to the Output for good.',
  },
  {
    Scene: UniformScene,
    caption: 'A Property node is a uniform: the 3D view gives it a slider that changes the shader as you drag. Set as default writes the value into the node.',
  },
  {
    Scene: ModelScene,
    caption: 'Drop your own model on the 3D view, animated ones too. The same graph shades each one: here Vertex Wave moves the surface and Checker colours it.',
  },
];

/**
 * The window FastShaders opens with (`introGate.ts` decides; App.tsx mounts it
 * lazily, never in a study session): slides of live scenes drawn with the real
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
export function IntroWindow({ onClose }: { onClose: () => void }) {
  const language = useAppStore((s) => s.language);
  const startRef = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState(0);
  const [dontShow, setDontShow] = useState(introHidden);
  const last = SLIDES.length - 1;
  const go = (i: number) => setIndex(Math.max(0, Math.min(last, i)));

  const close = () => {
    setIntroHidden(dontShow);
    onClose();
  };

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

  const { Scene, caption } = SLIDES[index];
  const slideName = (i: number) =>
    fillTemplate(t('Hint {n} of {total}', language), { n: String(i + 1), total: String(SLIDES.length) });

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
          {SLIDES.map((_, i) => (
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
          <label className="fs-intro__again">
            <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
            {t('Don’t show this again', language)}
          </label>
        </div>
      </div>
    </div>,
    document.body,
  );
}
