/**
 * The lesson panel over the canvas (src/tutorials): the current step's caption,
 * a hint on request, Previous / Do it for me / Next, the confirm screen before a
 * takeover and the Keep / New finish screen.
 *
 * Mounted inside NodeEditor's canvas div (it needs `useReactFlow().fitView`) at
 * the canvas's bottom-right — the one corner nothing else owns: NEW and Import
 * sit top-left, the cost pill top-right, the import note top-centre, the
 * drawing bar bottom-left, the preview rail on the right edge at the Output's
 * height. NOT a dialog: no `role="dialog"`, no `aria-modal`, no `useModalKeys`
 * — the canvas must stay fully usable while the lesson runs (the graph keys
 * stand down behind an aria-modal, keysBehindDialogs.test.ts), Escape stays
 * the canvas's own cancel key, and ←/→ would collide with keyboardNav's node
 * moves, so every control is a button. Plain keys pressed on those buttons are
 * stopped from reaching NodeEditor's window handlers, which would otherwise
 * read a Space on "Next" as "open the Add-node menu" (the panel is inside the
 * canvas div, so it counts as on-canvas); modifier combos pass, so ⌘Z still
 * undoes.
 *
 * Evaluation is live: `nodes`/`edges` selectors feed the pure `evaluateStep`,
 * and an effect commits the binding a satisfied `add` discovered and drops the
 * bindings of nodes that left. Lose the Output itself (the takeover undone)
 * and the lesson ends as Keep — there is nothing left to teach on.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { assetText, formatNodeLabel, t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { LangSwitch } from '@/eval/LangSwitch';
import { focusNodes } from '@/components/NodeEditor/outputFocus';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { findTutorial } from './tutorialDefs';
import { evaluateStep, reconcileBindings, stepTargets } from './tutorialRun';
import { tutorialAutoStep } from './tutorialAutoStep';
import { markStepTargets } from './tutorialHighlights';
import { OUT_ROLE } from './tutorialTypes';
import type { TutorialDef, TutorialRun } from './tutorialTypes';
import './TutorialPanel.css';

export function TutorialPanel() {
  const run = useAppStore((s) => s.tutorial);
  const def = run ? findTutorial(run.id) : undefined;
  const endTutorial = useAppStore((s) => s.endTutorial);
  // An id no lesson has (a stale store from a removed lesson) closes itself.
  useEffect(() => {
    if (run && !def) endTutorial('keep');
  }, [run, def, endTutorial]);
  if (!run || !def) return null;
  return <TutorialPanelBody run={run} def={def} />;
}

/** The node type label a role was introduced as — for the "{role} node is gone" line. */
function roleLabel(def: TutorialDef, role: string, language: 'en' | 'lv'): string {
  if (role === OUT_ROLE) return formatNodeLabel('Output', 'output', language, false);
  const added = def.steps.find((s) => s.kind === 'add' && s.role === role);
  if (!added || added.kind !== 'add') return role;
  const nodeDef = NODE_REGISTRY.get(added.type);
  return nodeDef ? formatNodeLabel(nodeDef.label, nodeDef.type, language, false) : added.type;
}

function typeLabel(type: string, language: 'en' | 'lv'): string {
  const nodeDef = NODE_REGISTRY.get(type);
  return nodeDef ? formatNodeLabel(nodeDef.label, nodeDef.type, language, false) : type;
}

function TutorialPanelBody({ run, def }: { run: TutorialRun; def: TutorialDef }) {
  const language = useAppStore((s) => s.language);
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const confirmTutorial = useAppStore((s) => s.confirmTutorial);
  const tutorialGo = useAppStore((s) => s.tutorialGo);
  const tutorialBind = useAppStore((s) => s.tutorialBind);
  const endTutorial = useAppStore((s) => s.endTutorial);
  const { fitView } = useReactFlow();

  const total = def.steps.length;
  const step = run.phase === 'run' ? def.steps[run.step] : undefined;
  const finished = run.phase === 'run' && run.step >= total;

  const result = useMemo(
    () => (step ? evaluateStep(step, run.bindings, nodes, edges) : null),
    [step, run.bindings, nodes, edges],
  );

  // Bindings follow the canvas: a node the user added takes its role, a node
  // that left gives it up. `tutorialBind` is identity-return when nothing
  // changes, so this cannot loop.
  useEffect(() => {
    if (run.phase !== 'run') return;
    const { dropped } = reconcileBindings(run.bindings, nodes);
    if (dropped.includes(OUT_ROLE)) { endTutorial('keep'); return; }
    for (const role of dropped) tutorialBind(role, null);
    if (result?.bind) tutorialBind(result.bind[0], result.bind[1]);
  }, [run.phase, run.bindings, nodes, result, tutorialBind, endTutorial]);

  // Canvas marks for the step's sockets / node; re-marked on every graph
  // change because handles remount when a node's exposure changes.
  useEffect(() => {
    if (!step) return;
    return markStepTargets(stepTargets(step, run.bindings));
  }, [step, run.bindings, nodes, edges]);

  const [hintShown, setHintShown] = useState(false);
  useEffect(() => setHintShown(false), [run.step]);

  const passed = run.step < run.reached;
  const satisfied = result?.status === 'satisfied';
  const canNext = satisfied || passed;
  const canAuto = !!step && step.kind !== 'look' && !satisfied;

  const next = useCallback(() => tutorialGo(Math.min(total, run.step + 1)), [tutorialGo, total, run.step]);
  const back = useCallback(() => tutorialGo(Math.max(0, run.step - 1)), [tutorialGo, run.step]);
  const auto = useCallback(() => {
    const r = tutorialAutoStep(run);
    if (!r.addedId) return;
    // One frame later: the node is measured by then, so the glide frames it.
    requestAnimationFrame(() => {
      const s = useAppStore.getState();
      const ids = [r.addedId!, r.feedsId ?? s.tutorial?.bindings[OUT_ROLE] ?? ''].filter(Boolean);
      focusNodes(fitView, s.nodes, ids);
    });
  }, [run, fitView]);

  // Plain keys on the panel's controls stay here (see the header). Tab keeps
  // its native focus move: stopPropagation does not touch default actions.
  const keepKeys = useCallback((e: React.KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
  }, []);

  const title = t(def.title, language);

  let body: React.ReactNode;
  if (run.phase === 'ask') {
    body = (
      <>
        <p className="tutorial-panel__caption">{t('This lesson takes over the canvas.', language)}</p>
        <p className="tutorial-panel__hint">
          {t('Your current graph is replaced by a single Output. Undo (Ctrl+Z / Cmd+Z) brings it back until you reload.', language)}
        </p>
        <div className="tutorial-panel__actions">
          <button type="button" className="tutorial-panel__btn" onClick={() => endTutorial('keep')}>
            {t('Cancel', language)}
          </button>
          <button type="button" className="tutorial-panel__btn tutorial-panel__btn--primary" onClick={confirmTutorial}>
            {t('Start lesson', language)}
          </button>
        </div>
      </>
    );
  } else if (finished) {
    body = (
      <>
        <p className="tutorial-panel__caption">{t('Lesson complete!', language)}</p>
        {def.recipeName && (
          <p className="tutorial-panel__hint">
            {fillTemplate(t('The finished version is the "{recipe}" recipe on the Presets tab.', language), {
              recipe: assetText(def.recipeName, language),
            })}
          </p>
        )}
        <div className="tutorial-panel__actions">
          <button type="button" className="tutorial-panel__btn" onClick={() => endTutorial('new', true)}>
            {t('Start new shader', language)}
          </button>
          <button type="button" className="tutorial-panel__btn tutorial-panel__btn--primary" onClick={() => endTutorial('keep', true)}>
            {t('Keep the structure', language)}
          </button>
        </div>
      </>
    );
  } else if (step) {
    let status: React.ReactNode = null;
    if (satisfied && step.kind !== 'look') {
      status = <p className="tutorial-panel__status tutorial-panel__status--ok">✓ {t('Done. Press Next.', language)}</p>;
    } else if (result?.status === 'broken' && result.missingRole) {
      status = (
        <p className="tutorial-panel__status tutorial-panel__status--warn">
          {fillTemplate(t('The {role} node is gone. Add it again, or press Do it for me.', language), {
            role: roleLabel(def, result.missingRole, language),
          })}
        </p>
      );
    } else if (result?.wrongType && step.kind === 'add') {
      status = (
        <p className="tutorial-panel__status tutorial-panel__status--warn">
          {fillTemplate(t('That is a {have} node; this step needs a {want} node.', language), {
            have: typeLabel(result.wrongType, language),
            want: typeLabel(step.type, language),
          })}
        </p>
      );
    }
    body = (
      <>
        <ol className="tutorial-panel__dots" aria-label={t('Steps', language)}>
          {def.steps.map((s, i) => (
            <li
              key={s.id}
              className={`tutorial-panel__dot${i === run.step ? ' tutorial-panel__dot--on' : ''}${i < run.reached ? ' tutorial-panel__dot--done' : ''}`}
              aria-current={i === run.step ? 'step' : undefined}
            />
          ))}
        </ol>
        <p className="tutorial-panel__caption">{t(step.caption, language)}</p>
        {step.hint && (
          hintShown
            ? <p className="tutorial-panel__hint">{t(step.hint, language)}</p>
            : (
              <button type="button" className="tutorial-panel__link" onClick={() => setHintShown(true)}>
                {t('Show hint', language)}
              </button>
            )
        )}
        {status}
        <div className="tutorial-panel__actions">
          <button type="button" className="tutorial-panel__btn" onClick={back} disabled={run.step === 0}>
            {t('Previous step', language)}
          </button>
          <button type="button" className="tutorial-panel__btn" onClick={auto} disabled={!canAuto}>
            {t('Do it for me', language)}
          </button>
          <button type="button" className="tutorial-panel__btn tutorial-panel__btn--primary" onClick={next} disabled={!canNext}>
            {t('Next step', language)}
          </button>
        </div>
      </>
    );
  }

  return (
    <aside className="tutorial-panel" aria-label={t('Lesson', language)} onKeyDown={keepKeys}>
      <div className="tutorial-panel__head">
        <span className="tutorial-panel__title">{title}</span>
        {run.phase === 'run' && !finished && (
          <span className="tutorial-panel__count">{run.step + 1} / {total}</span>
        )}
        <LangSwitch />
        <button
          type="button"
          className="tutorial-panel__close"
          onClick={() => endTutorial('keep')}
          aria-label={t('Close lesson', language)}
          title={t('Close lesson', language)}
        >
          ×
        </button>
      </div>
      {body}
    </aside>
  );
}
