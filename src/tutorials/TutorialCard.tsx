/**
 * The Tutorials tab's tile: a numbered lesson with a picture of what it builds,
 * pressed to start. NOT a drag tile — a lesson is not an asset you drop — so
 * this is a plain button rather than `AssetTile`, whose whole body is drag
 * plumbing. It is deliberately UNLIKE every other tile in the strip (owner,
 * 2026-10-23): no coloured header bar (that is a group or a preset), no node
 * shadow — a plain white card, the lesson's number, title and length filling
 * its top half and the result's picture filling the bottom half.
 */

import { useEffect, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { useAssetTooltip } from '@/components/NodeEditor/AssetTooltip';
import { PREVIEW_SIZE, renderPixels } from '@/components/NodeEditor/tilePreview';
import { tutorialShade } from './tutorialShades';
import type { TutorialDef } from './tutorialTypes';
import './TutorialCard.css';

export function TutorialCard({ def, index }: { def: TutorialDef; index: number }) {
  const language = useAppStore((s) => s.language);
  const done = useAppStore((s) => s.tutorialsDone.includes(def.id));
  const running = useAppStore((s) => s.tutorial?.id === def.id);
  const startTutorial = useAppStore((s) => s.startTutorial);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Painted once per tile: the shade is a pure function of the lesson id.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) renderPixels(ctx, tutorialShade(def));
  }, [def]);

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
      <span className="tutorial-card__text">
        <span className="tutorial-card__index" aria-hidden="true">{index}</span>
        <span className="tutorial-card__title">{title}</span>
        <span className="tutorial-card__count">
          {count}
          {done && <span className="tutorial-card__done" title={t('Done', language)}> ✓</span>}
        </span>
      </span>
      <canvas
        ref={canvasRef}
        className="tutorial-card__picture"
        width={PREVIEW_SIZE}
        height={PREVIEW_SIZE}
        aria-hidden="true"
      />
    </button>
  );
}
