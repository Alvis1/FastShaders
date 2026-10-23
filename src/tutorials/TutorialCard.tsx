/**
 * The Tutorials tab's tile: a numbered lesson, pressed to start. NOT a drag
 * tile — a lesson is not an asset you drop — so this is a plain button rather
 * than `AssetTile`, whose whole body is drag plumbing. Sized at 1× and scaled
 * by the same `zoom` the strip's other tiles carry (NodePreviewCard.css), so it
 * grows and shrinks with them as the bar is dragged.
 */

import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { useAssetTooltip } from '@/components/NodeEditor/AssetTooltip';
import type { TutorialDef } from './tutorialTypes';
import './TutorialCard.css';

export function TutorialCard({ def, index }: { def: TutorialDef; index: number }) {
  const language = useAppStore((s) => s.language);
  const done = useAppStore((s) => s.tutorialsDone.includes(def.id));
  const running = useAppStore((s) => s.tutorial?.id === def.id);
  const startTutorial = useAppStore((s) => s.startTutorial);
  const steps = def.steps.length;
  // The NUMBER stays outside the key: Latvian inflects the noun with it
  // (SavedGroupCard's rule), so singular and plural are two entries.
  const count = `${steps} ${t(steps === 1 ? 'step' : 'steps', language)}`;
  const title = t(def.title, language);
  const { tooltip, tooltipHandlers } = useAssetTooltip(t(def.summary, language));
  return (
    <button
      type="button"
      className={`tutorial-card${done ? ' tutorial-card--done' : ''}${running ? ' tutorial-card--running' : ''}`}
      onClick={() => startTutorial(def.id)}
      aria-label={fillTemplate(t('Start lesson {name}', language), { name: title })}
      {...tooltipHandlers}
    >
      {tooltip}
      <span className="tutorial-card__index" aria-hidden="true">{index}</span>
      <span className="tutorial-card__title">{title}</span>
      <span className="tutorial-card__count">
        {count}
        {done && <span className="tutorial-card__done" title={t('Done', language)}> ✓</span>}
      </span>
    </button>
  );
}
