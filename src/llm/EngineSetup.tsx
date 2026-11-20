/**
 * The built-in route's setup (desktop only, P5): surveys this computer for the
 * bundled engine when the route is shown, and shows the ONE box for what it
 * found (setupStates.ts). "Check again" runs the survey again; the ways around
 * a computer that cannot run the engine switch the dialog's route.
 *
 * A survey that came back `ok` is kept for the session (module scope), so
 * reopening the dialog does not start the engine twice more; any other answer
 * is asked again on the next open, since the fix happens outside the app.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { t, type Language } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { runEngineSurvey, type EngineSurvey } from './engineSurvey';
import { engineDeleteModel, engineDownload, engineStatus, engineStop, type StatusOutcome } from './engineModel';
import {
  deleteModelBox,
  engineSetupBox,
  modelReady,
  modelSetupBox,
  sizeGb,
  type EngineSetupState,
  type ModelSetupState,
  type SetupAction,
} from './setupStates';
import { SetupBoxView } from './SetupBox';

let sessionSurvey: EngineSurvey | null = null;

const BUSY_WAIT_MS = 60_000;
const BUSY_STEP_MS = 300;
/** How often the model's status is read: while something moves, and at rest. */
const POLL_ACTIVE_MS = 500;
const POLL_IDLE_MS = 2500;

/** The actions this component answers itself; the rest go to the dialog. */
type OwnAction =
  | 'checkAgain' | 'download' | 'pause' | 'resume' | 'cancelDownload'
  | 'downloadAgain' | 'startAgain' | 'deleteModel' | 'keepModel';

export interface EngineSetupProps {
  language: Language;
  busy: boolean;
  claudeOffered: boolean;
  /** "Other ways", "Use LM Studio / Ollama", "Use an API key", "Not now". */
  onAction: (action: Exclude<SetupAction, OwnAction>) => void;
  /** Is the route ready to generate: the engine runs here and its model is downloaded and checked. */
  onReady: (ready: boolean) => void;
}

export function EngineSetup({ language, busy, claudeOffered, onAction, onReady }: EngineSetupProps) {
  const [state, setState] = useState<EngineSetupState>(() =>
    sessionSurvey ? { kind: 'surveyed', survey: sessionSurvey } : { kind: 'surveying' });
  const [model, setModel] = useState<ModelSetupState>({ kind: 'loading' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A survey that lands after a newer one started, or after unmount, is ignored.
  const generation = useRef(0);
  const alive = useRef(true);

  const survey = useCallback(async () => {
    const mine = ++generation.current;
    setState({ kind: 'surveying' });
    let r = await runEngineSurvey();
    // Rust runs one survey at a time; an earlier one (a quick reopen, React's
    // dev double mount) is still finishing. Wait for it, up to BUSY_WAIT_MS.
    for (let waited = 0; !r.ok && r.reason === 'busy' && waited < BUSY_WAIT_MS; waited += BUSY_STEP_MS) {
      await new Promise((done) => setTimeout(done, BUSY_STEP_MS));
      if (generation.current !== mine) return;
      r = await runEngineSurvey();
    }
    if (generation.current !== mine) return;
    if (r.ok) {
      sessionSurvey = r.survey.state === 'ok' ? r.survey : null;
      setState({ kind: 'surveyed', survey: r.survey });
    } else {
      setState({ kind: 'unchecked', detail: r.reason === 'busy' ? '' : r.detail });
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!sessionSurvey) void survey();
    return () => { alive.current = false; generation.current++; };
  }, [survey]);

  const surveyBox = engineSetupBox(state, { claudeOffered });
  // The model's step shows only under a survey that passed (its ✓ line).
  const surveyed = surveyBox.variant === 'done';

  const take = useCallback((r: StatusOutcome) => {
    if (!alive.current) return;
    setModel(r.ok ? { kind: 'status', status: r.status } : { kind: 'unread', detail: r.detail });
  }, []);

  // Read the model's state while the pane is open: often while a download, a
  // check or a start is under way, slowly at rest (an idle stop, a crash).
  const moving = model.kind === 'status'
    && (model.status.model.state === 'downloading' || model.status.model.state === 'checking' || model.status.server.state === 'starting');
  const unread = model.kind === 'unread';
  useEffect(() => {
    if (!surveyed || unread) return;
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      const r = await engineStatus();
      if (stopped) return;
      take(r);
      timer = window.setTimeout(tick, moving || busy ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [surveyed, unread, moving, busy, take]);

  const ready = surveyed && modelReady(model);
  useEffect(() => { onReady(ready); }, [ready, onReady]);
  useEffect(() => () => onReady(false), [onReady]);

  const act = (action: SetupAction) => {
    switch (action) {
      case 'download':
      case 'resume':
      case 'downloadAgain':
        void engineDownload('start').then(take);
        return;
      case 'pause':
        void engineDownload('pause').then(take);
        return;
      case 'cancelDownload':
        void engineDownload('cancel').then(take);
        return;
      case 'startAgain':
        void engineStop().then(take);
        return;
      case 'deleteModel':
        setConfirmDelete(false);
        void engineDeleteModel().then(take);
        return;
      case 'keepModel':
        setConfirmDelete(false);
        return;
      case 'checkAgain':
        // Under a passed survey this is the model's own box: a full disk asks
        // the download again (it re-reads the free space), anything else re-reads.
        if (!surveyed) void survey();
        else if (model.kind === 'status' && model.status.model.state === 'low-disk') void engineDownload('start').then(take);
        else { setModel({ kind: 'loading' }); void engineStatus().then(take); }
        return;
      default:
        onAction(action);
    }
  };

  const downloaded = model.kind === 'status' && model.status.model.state === 'ready';
  return (
    <>
      <SetupBoxView box={surveyBox} language={language} disabled={busy} onAction={act} />
      {surveyed && (
        confirmDelete && downloaded
          ? <SetupBoxView box={deleteModelBox(model.status.model.sizeBytes)} language={language} disabled={busy} onAction={act} />
          : <SetupBoxView box={modelSetupBox(model)} language={language} disabled={busy} onAction={act} />
      )}
      {surveyed && downloaded && !confirmDelete && (
        <button type="button" className="generator-dialog__link" disabled={busy} onClick={() => setConfirmDelete(true)}>
          {fillTemplate(t('Delete model ({size} GB)', language), { size: sizeGb(model.status.model.sizeBytes) })}
        </button>
      )}
    </>
  );
}
