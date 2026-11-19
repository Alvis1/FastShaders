/**
 * "Generate nodes from text" — the one surface of src/llm/. Loaded through
 * `lazyOr` by components/Layout/GeneratorLauncher, which the toolbar's
 * Settings list opens ("Open the generator…", once the opt-in is ticked);
 * never on the boot wave.
 *
 * The flow: pick a route (a model server on this computer, or Claude with the
 * user's own key), type a request, Generate — up to three rounds of model →
 * gate → repair (orchestrate.ts) — then look at the result (the model's plan,
 * node count, its points on the selected device's fixed 100, the properties)
 * and press Add. The graph changes ONLY on that click, through place.ts;
 * closing the dialog, or the page going, cancels a running generation.
 *
 * Everything a model sends is DATA: the plan, the problem lines, the code and
 * the uniform names are React text nodes, never markup and never through t()
 * (problem lines stay English, like the parser's own diagnostics).
 *
 * Keys: the dialog's window listener runs in the CAPTURE phase and stops every
 * key but Tab, so Cmd+Z in the text box undoes the TEXT (a default action),
 * never the graph behind the dialog; Escape cancels a run, else closes;
 * Cmd/Ctrl+Enter generates, or adds a finished result.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveDeviceBudget, useAppStore } from '@/store/useAppStore';
import { isEvalMode } from '@/eval/evalArm';
import { t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { POINT_BUDGET, toBudgetPoints } from '@/utils/budgetPoints';
import { useDeviceBudget } from '@/hooks/useDeviceBudget';
import { Points } from '@/components/Points/Points';
import { preloadShaderImport } from '@/engine/projectImport';
import { fullscreenElement } from '@/components/inputs/colorPickerModel';
import { useModalKeys } from '@/components/Modals/useModalKeys';
import { buildCatalogue, type Catalogue } from './catalogue';
import { exampleCorpus, type Example } from './examples';
import { liveUniformNames, storedUniformNames } from './names';
import { MAX_ROUNDS, runGeneration, type GateOk, type RunStatus } from './orchestrate';
import { addGeneratedGroup } from './place';
import { loadGeneratorPrefs, saveGeneratorPref, type RouteId } from './prefs';
import { buildEnv, loadClaude, loadLocalTransport, offeredRoutes, requestBase } from './registry';
import { checkLocalServer, LOCAL_MIN_CONTEXT, localProvider, type LocalCheck } from './providers/local';
import { normalizeLocalBase } from './endpoint';
import { CLAUDE_MODELS, CLAUDE_MODEL_LABELS, type ClaudeModel } from './claudeModels';
import { clearCloudKey, hasCloudKey, setCloudKey, subscribeCloudKey } from './cloudKey';
import type { GenerateFailure, GeneratorProvider } from './providerTypes';
import '@/components/Modals/CsvImportModal.css';
import './GeneratorDialog.css';

export interface GeneratorDialogProps {
  /** A request to start from ('' from the Settings list: the session's last
   *  request is offered instead). */
  initialPrompt: string;
  onClose: () => void;
}

/** This session's last request — kept in memory only, never stored. */
let lastPrompt = '';

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; status: RunStatus | null; startedAt: number }
  /** `request` is the text that was generated from — the group's label. */
  | { kind: 'result'; result: GateOk; rounds: number; request: string }
  /** `message` is an English t() key, filled with `params` at render. */
  | { kind: 'failed'; message: string; params?: Record<string, string | number>; detail?: string; problems?: string[]; code?: string | null }
  | { kind: 'adding' };

/** What each failure tells the user, per route. English keys through t(). */
function failureText(f: GenerateFailure, route: RouteId): string {
  switch (f) {
    case 'cancelled': return 'Cancelled.';
    case 'not-running': return 'Nothing answers at that address. Start LM Studio’s server (Developer tab, or `lms server start`), then press Check.';
    case 'wrong-server': return 'No OpenAI-compatible model server answers at that address — check the port (LM Studio uses 1234).';
    case 'bad-address': return 'Use http://127.0.0.1:<port> or http://localhost:<port> — a server on this computer.';
    case 'busy': return 'Another request to the model is still running. Wait a moment, then try again.';
    case 'no-model': return route === 'local'
      ? 'The server runs, but no model is loaded. Load one in LM Studio, or run `lms load <model> --context-length 16384`.'
      : 'That model is not available to this API key.';
    case 'context-too-small': return 'The loaded model’s context is too small for this request. Load it again with a larger one: `lms load <model> --context-length 16384`.';
    case 'auth': return route === 'claude' ? 'The API key was refused, or none was entered.' : 'The server refused the request.';
    case 'rate-limit': return 'Too many requests for now. Wait a moment and try again.';
    case 'refused': return 'The model declined this request.';
    case 'truncated': return 'The reply was cut off before the program ended. Try a simpler request.';
    case 'timeout': return 'The model took too long to answer.';
    case 'network': return 'The model could not be reached.';
    case 'unavailable': return 'This route is not available right now.';
    case 'bad-response': return 'The model sent something unreadable.';
  }
}

function fullscreenHost(): HTMLElement {
  return fullscreenElement() ?? document.body;
}

/** The facts line's template split around its `{cost}` placeholder, so the
 *  figure can be the app's one point printer (`<Points>`) in either language. */
function splitAtCost(template: string): [string, string] {
  const at = template.indexOf('{cost}');
  return at < 0 ? [template, ''] : [template.slice(0, at), template.slice(at + '{cost}'.length)];
}

export function GeneratorDialog({ initialPrompt, onClose }: GeneratorDialogProps) {
  const language = useAppStore((s) => s.language);
  // The result's price prints as every surface prints one: divided by the
  // selected device's budget onto the fixed 100 (utils/budgetPoints.ts).
  const deviceBudget = useDeviceBudget();
  const deviceLabel = useAppStore((s) => resolveDeviceBudget(s.selectedHeadsetId, s.costProfiles).label);

  const env = useMemo(buildEnv, []);
  const routes = useMemo(() => offeredRoutes(env, isEvalMode()), [env]);
  const initial = useMemo(() => loadGeneratorPrefs((k) => localStorage.getItem(k)), []);
  const [route, setRoute] = useState<RouteId | null>(() =>
    initial.route && routes.includes(initial.route) ? initial.route : routes[0] ?? null);
  const [prompt, setPrompt] = useState(() => initialPrompt.trim() || lastPrompt);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [prepared, setPrepared] = useState<{ catalogue: Catalogue; corpus: Example[] } | null>(null);
  const [prepFailed, setPrepFailed] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const checkRef = useRef<AbortController | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const downOnBackdrop = useRef(false);

  // Local route state.
  const [baseText, setBaseText] = useState(initial.localBase);
  const [check, setCheck] = useState<LocalCheck | 'checking' | null>(null);
  const [localModel, setLocalModel] = useState(initial.localModel);
  // Cloud route state. The key text is cleared the moment it is taken.
  const [cloudModel, setCloudModel] = useState<ClaudeModel>(initial.cloudModel);
  const [keyText, setKeyText] = useState('');
  const [keyHeld, setKeyHeld] = useState(hasCloudKey);
  const [keyRefused, setKeyRefused] = useState(false);
  useEffect(() => subscribeCloudKey(setKeyHeld), []);

  const running = phase.kind === 'running';
  const busy = running || phase.kind === 'adding';

  // The portal host follows fullscreen, the ShaderImportModal rule.
  useEffect(() => {
    const resolve = () => setHost(fullscreenHost());
    resolve();
    document.addEventListener('fullscreenchange', resolve);
    document.addEventListener('webkitfullscreenchange', resolve);
    return () => {
      document.removeEventListener('fullscreenchange', resolve);
      document.removeEventListener('webkitfullscreenchange', resolve);
    };
  }, []);

  // Prepare on OPEN: the node list for the user's switches, and the worked
  // examples (the built-in libraries load here, off the boot wave).
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [{ getBuiltinPresets }, { getBuiltinTextures }] = await Promise.all([
          import('@/registry/builtinPresets'),
          import('@/registry/builtinTextures'),
        ]);
        const catalogue = buildCatalogue(useAppStore.getState().optionalCategories);
        const corpus = exampleCorpus([...getBuiltinPresets(), ...getBuiltinTextures()], catalogue);
        if (live) setPrepared({ catalogue, corpus });
      } catch {
        if (live) setPrepFailed(true);
      }
    })();
    return () => { live = false; };
  }, []);

  // A running generation — and a running check — dies with the dialog, and
  // with the page, so the desktop bridge's cancel reaches the server instead
  // of streaming into nothing until its timeout.
  useEffect(() => {
    const stop = () => { abortRef.current?.abort(); checkRef.current?.abort(); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); };
  }, []);

  // The elapsed-time clock, only while running.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => { textRef.current?.focus(); }, [host]);

  const base = normalizeLocalBase(baseText);

  // The check in flight. A new check, an address edit and closing the dialog
  // all abort it — which also frees the desktop bridge's ONE request slot —
  // and a result that lands after that is ignored.
  const dropCheck = useCallback(() => {
    checkRef.current?.abort();
    checkRef.current = null;
  }, []);

  const runCheck = useCallback(async () => {
    if (route !== 'local') return;
    const b = normalizeLocalBase(baseText);
    if (!b) return;
    checkRef.current?.abort();
    const ac = new AbortController();
    checkRef.current = ac;
    setCheck('checking');
    let r: LocalCheck;
    try {
      const transport = await loadLocalTransport();
      r = transport ? await checkLocalServer(transport, requestBase(env, b), ac.signal) : { ok: false, failure: 'unavailable' };
    } catch {
      r = { ok: false, failure: 'unavailable' };
    }
    if (checkRef.current !== ac) return;
    checkRef.current = null;
    setCheck(r);
    if (r.ok) {
      saveGeneratorPref('localBase', b);
      setLocalModel((m) => {
        if (r.models.some((x) => x.id === m)) return m;
        return (r.models.find((x) => x.loaded) ?? r.models[0]).id;
      });
    }
  }, [route, baseText, env]);

  // Check the local server once when the route is first shown.
  const checkedOnce = useRef(false);
  useEffect(() => {
    if (route === 'local' && !checkedOnce.current) { checkedOnce.current = true; void runCheck(); }
    // Fetch the provider (and the SDK) while the user types, not on Generate.
    if (route === 'claude') void loadClaude().catch(() => null);
  }, [route, runCheck]);

  const chooseRoute = (r: RouteId) => {
    setRoute(r);
    saveGeneratorPref('route', r);
  };

  const takeKey = () => {
    const ok = setCloudKey(keyText);
    setKeyRefused(!ok);
    if (ok) setKeyText('');
  };

  const routeReady = route === 'local'
    ? !!base && typeof check === 'object' && check !== null && check.ok && !!localModel
    : route === 'claude' && keyHeld;
  const canGenerate = !!prepared && !busy && !!prompt.trim() && routeReady;

  const generate = useCallback(async () => {
    if (!canGenerate || !prepared || !route) return;
    const request = prompt.trim();
    lastPrompt = request;
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase({ kind: 'running', status: null, startedAt: Date.now() });
    let provider: GeneratorProvider;
    try {
      if (route === 'local') {
        saveGeneratorPref('localModel', localModel);
        const transport = await loadLocalTransport();
        if (!transport) throw new Error('no local transport in this build');
        provider = localProvider(transport, requestBase(env, base!), localModel);
      } else {
        saveGeneratorPref('cloudModel', cloudModel);
        const claude = await loadClaude();
        if (!claude) throw new Error('no cloud route in this build');
        provider = claude.claudeProvider(cloudModel);
      }
    } catch {
      setPhase({ kind: 'failed', message: failureText('unavailable', route) });
      return;
    }
    const store = useAppStore.getState();
    const takenNames = new Set([
      ...liveUniformNames(store.nodes),
      ...storedUniformNames((k) => localStorage.getItem(k)),
    ]);
    let r: Awaited<ReturnType<typeof runGeneration>>;
    try {
      r = await runGeneration({
        provider,
        request,
        catalogue: prepared.catalogue,
        corpus: prepared.corpus,
        takenNames,
        signal: ac.signal,
        inStudy: isEvalMode,
        onStatus: (status) => setPhase((p) => (p.kind === 'running' ? { ...p, status } : p)),
      });
    } catch {
      // runGeneration does not throw; if that ever breaks, the dialog must
      // still leave "running" (there is no error boundary).
      r = { ok: false, kind: 'provider', failure: 'bad-response', rounds: 0 };
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
    if (r.ok) {
      setPhase({ kind: 'result', result: r.result, rounds: r.rounds, request });
      // The ADD's converter chunk, fetched now, so the Add's awaits are
      // microtasks and nothing can open a gesture bracket before pushHistory.
      void preloadShaderImport();
    } else if (r.kind === 'provider') {
      setPhase(r.failure === 'cancelled' ? { kind: 'idle' } : { kind: 'failed', message: failureText(r.failure, route), detail: r.detail });
    } else if (r.kind === 'rejected') {
      setPhase({
        kind: 'failed',
        message: 'After {n} tries the program still had problems:',
        params: { n: r.rounds },
        problems: r.problems,
        code: r.lastCode,
      });
    } else {
      onClose();
    }
  }, [canGenerate, prepared, route, prompt, env, base, localModel, cloudModel, onClose]);

  const add = useCallback(async () => {
    if (phase.kind !== 'result') return;
    const { result: { tsl }, request } = phase;
    setPhase({ kind: 'adding' });
    let r: Awaited<ReturnType<typeof addGeneratedGroup>>;
    try {
      r = await addGeneratedGroup(tsl, request, isEvalMode);
    } catch {
      r = { ok: false, reason: 'parse-failed' };
    }
    if (r.ok) { onClose(); return; }
    setPhase({ kind: 'failed', message: r.reason === 'study' ? failureText('unavailable', route ?? 'local') : 'The group could not be added.' });
  }, [phase, onClose, route]);

  const cancel = () => abortRef.current?.abort();
  const close = () => { if (!busy) onClose(); };

  useModalKeys(true, (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      if (running) cancel();
      else if (!busy) onClose();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.stopPropagation();
      e.preventDefault();
      // A held key must not add the group and then generate again.
      if (e.repeat) return;
      if (phase.kind === 'result') void add();
      else void generate();
      return;
    }
    if (e.key !== 'Tab') e.stopPropagation();
  }, true);

  if (!host) return null;

  /** The phase, for the live region: it changes a few times per run, so a
   *  screen reader is not read a counter twice a second. */
  const statusLine = (): string => {
    if (phase.kind !== 'running') return '';
    const s = phase.status;
    const head = fillTemplate(t('Round {round} of {max}', language), { round: s?.round ?? 1, max: MAX_ROUNDS });
    let what: string;
    if (!s || s.phase === 'connecting') what = t('connecting…', language);
    else if (s.phase === 'loading') what = t('waiting for the model (loading it, or reading the request)…', language);
    else if (s.phase === 'thinking') what = t('thinking…', language);
    else if (s.phase === 'writing') what = t('writing…', language);
    else what = t('checking the program…', language);
    return `${head} — ${what}`;
  };
  /** The counters beside it, for the eye only. */
  const statusDetail = (): string => {
    if (phase.kind !== 'running') return '';
    const secs = Math.max(0, Math.round((now - phase.startedAt) / 1000));
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const s = phase.status;
    const chars = s && (s.phase === 'thinking' || s.phase === 'writing') ? `${fillTemplate(t('{n} characters', language), { n: s.chars })} · ` : '';
    return `${chars}${clock}`;
  };

  const localInfo = (): string | null => {
    if (check === 'checking') return t('Checking…', language);
    if (!check) return null;
    if (!check.ok) return null;
    const m = check.models.find((x) => x.id === localModel);
    if (m?.contextLength !== undefined && m.contextLength < LOCAL_MIN_CONTEXT) {
      return fillTemplate(t('Loaded with a {have}-token context; this needs about {need}. Load it again: lms load {model} --context-length 16384', language), {
        have: m.contextLength, need: LOCAL_MIN_CONTEXT, model: m.id,
      });
    }
    if (m?.loaded === false) return t('Not loaded yet — LM Studio loads it on the first request, which takes longer.', language);
    return null;
  };

  return createPortal(
    <div
      className="csv-import-modal__backdrop"
      // Only a click that STARTED on the backdrop closes: selecting text in
      // the result and releasing outside the panel fires `click` here too,
      // and would throw away a result that took minutes (or money) to make.
      onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) close();
        downOnBackdrop.current = false;
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div
        className="csv-import-modal__panel generator-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="generator-dialog-title"
        aria-busy={busy}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="csv-import-modal__title" id="generator-dialog-title">
          {t('Generate nodes from text', language)} <span className="generator-dialog__tag">{t('experimental', language)}</span>
        </div>

        {routes.length > 1 && (
          <div className="generator-dialog__routes" role="radiogroup" aria-label={t('Model', language)}>
            {routes.map((r) => (
              <label key={r} className="generator-dialog__route">
                <input type="radio" name="generator-route" checked={route === r} disabled={busy} onChange={() => chooseRoute(r)} />
                {r === 'local' ? t('This computer (LM Studio)', language) : t('Claude (your API key)', language)}
              </label>
            ))}
          </div>
        )}

        {route === 'local' && (
          <div className="generator-dialog__section">
            {env.desktop ? (
              <div className="csv-import-modal__row">
                <span>{t('Server', language)}</span>
                <span className="generator-dialog__inline">
                  <input
                    className="generator-dialog__field"
                    type="text"
                    value={baseText}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                    onChange={(e) => { setBaseText(e.target.value); dropCheck(); setCheck(null); }}
                    aria-invalid={!base}
                  />
                  <button type="button" className="csv-import-modal__button" disabled={busy || !base} onClick={() => void runCheck()}>
                    {t('Check', language)}
                  </button>
                </span>
              </div>
            ) : (
              <div className="generator-dialog__note">
                {t('Dev server: requests go through its proxy to LM Studio (FS_LLM_DEV_TARGET, 127.0.0.1:1234 by default).', language)}{' '}
                <button type="button" className="csv-import-modal__button" disabled={busy} onClick={() => void runCheck()}>
                  {t('Check', language)}
                </button>
              </div>
            )}
            {!base && <div className="generator-dialog__warn">{t('Use http://127.0.0.1:<port> or http://localhost:<port> — a server on this computer.', language)}</div>}
            {typeof check === 'object' && check !== null && check.ok && (
              <div className="csv-import-modal__row">
                <span>{t('Model', language)}</span>
                <select value={localModel} disabled={busy} onChange={(e) => setLocalModel(e.target.value)}>
                  {check.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}{m.loaded ? ` · ${t('loaded', language)}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {typeof check === 'object' && check !== null && !check.ok && (
              <div className="generator-dialog__warn">
                {t(failureText(check.failure, 'local'), language)}
                {check.detail && <div className="generator-dialog__detail">{check.detail}</div>}
              </div>
            )}
            {localInfo() && <div className="generator-dialog__note">{localInfo()}</div>}
            <div className="generator-dialog__disclosure">{t('Runs on this computer; nothing leaves it.', language)}</div>
          </div>
        )}

        {route === 'claude' && (
          <div className="generator-dialog__section">
            <div className="csv-import-modal__row">
              <span>{t('Model', language)}</span>
              <select
                value={cloudModel}
                disabled={busy}
                onChange={(e) => setCloudModel(e.target.value as ClaudeModel)}
              >
                {CLAUDE_MODELS.map((m) => <option key={m} value={m}>{CLAUDE_MODEL_LABELS[m]}</option>)}
              </select>
            </div>
            {keyHeld ? (
              <div className="csv-import-modal__row">
                <span>{t('API key: held in this tab only', language)}</span>
                <button type="button" className="csv-import-modal__button" disabled={busy} onClick={clearCloudKey}>
                  {t('Forget key', language)}
                </button>
              </div>
            ) : (
              // A plain text field outside any <form>: a password field would
              // invite the browser's password manager to SAVE the key.
              <div className="csv-import-modal__row">
                <input
                  className="generator-dialog__field generator-dialog__field--key"
                  type="text"
                  value={keyText}
                  placeholder={t('Anthropic API key', language)}
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  data-1p-ignore=""
                  data-lpignore="true"
                  disabled={busy}
                  onChange={(e) => { setKeyText(e.target.value); setKeyRefused(false); }}
                  aria-label={t('Anthropic API key', language)}
                />
                <button type="button" className="csv-import-modal__button" disabled={busy || !keyText.trim()} onClick={takeKey}>
                  {t('Use key', language)}
                </button>
              </div>
            )}
            {keyRefused && <div className="generator-dialog__warn">{t('That does not look like an API key.', language)}</div>}
            <div className="generator-dialog__disclosure">
              {t('Sends your request and FastShaders’ node list to Anthropic with your API key, billed to your account. Nothing from your graph or files is sent. The key stays in this tab’s memory and is forgotten on reload; other pages or extensions on this site could read it while the tab is open, so use a dedicated key with a spend limit.', language)}
            </div>
          </div>
        )}

        {routes.length === 0 && <div className="generator-dialog__warn">{t('This route is not available right now.', language)}</div>}

        <label className="generator-dialog__label" htmlFor="generator-dialog-prompt">{t('Describe the shader', language)}</label>
        <textarea
          id="generator-dialog-prompt"
          ref={textRef}
          className="generator-dialog__prompt"
          value={prompt}
          maxLength={1000}
          rows={3}
          disabled={busy}
          // English in both languages: requests are written in English (the
          // prompt, the rules and the examples are English), so the example
          // shows the language to write in.
          placeholder="e.g. glowing lava cracks on dark rock"
          onChange={(e) => setPrompt(e.target.value)}
        />

        {!prepared && !prepFailed && <div className="generator-dialog__note">{t('Preparing…', language)}</div>}
        {prepFailed && <div className="generator-dialog__warn">{t('The node list could not be loaded. Check the connection and open this again.', language)}</div>}

        <div className="generator-dialog__status">
          <span aria-live="polite">{statusLine()}</span>
          {running && <span className="generator-dialog__status-detail" aria-hidden="true">{statusDetail()}</span>}
        </div>

        {phase.kind === 'failed' && (
          <div className="generator-dialog__warn">
            {fillTemplate(t(phase.message, language), phase.params ?? {})}
            {phase.detail && <div className="generator-dialog__detail">{phase.detail}</div>}
            {phase.problems && phase.problems.length > 0 && (
              <ul className="generator-dialog__problems">
                {phase.problems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            )}
            {phase.code && (
              <details className="generator-dialog__code">
                <summary>{t('Show the last program', language)}</summary>
                <pre>{phase.code}</pre>
              </details>
            )}
          </div>
        )}

        {phase.kind === 'result' && (() => {
          const points = toBudgetPoints(phase.result.cost, deviceBudget);
          const facts = { n: phase.result.nodeCount, max: POINT_BUDGET, device: deviceLabel };
          const [beforeCost, afterCost] = splitAtCost(t('{n} nodes · {cost} of {max} points on {device}', language));
          return (
          <div className="generator-dialog__result">
            {phase.result.plan && <div className="generator-dialog__plan">{phase.result.plan}</div>}
            <div className={`generator-dialog__facts${points > POINT_BUDGET ? ' generator-dialog__facts--over' : ''}`}>
              {fillTemplate(beforeCost, facts)}
              <Points value={points} />
              {fillTemplate(afterCost, facts)}
              {phase.rounds > 1 && ` · ${fillTemplate(t('{n} rounds', language), { n: phase.rounds })}`}
            </div>
            {phase.result.uniforms.length > 0 && (
              <ul className="generator-dialog__uniforms" aria-label={t('Properties', language)}>
                {phase.result.uniforms.map((u) => (
                  <li key={u.name} className="generator-dialog__chip">
                    {u.kind === 'color' && <span className="generator-dialog__swatch" style={{ background: String(u.value) }} />}
                    {u.name}{u.kind === 'float' ? ` = ${u.value}` : ''}
                    {u.renamedFrom && <span className="generator-dialog__renamed">{fillTemplate(t('(was {name})', language), { name: u.renamedFrom })}</span>}
                  </li>
                ))}
              </ul>
            )}
            {phase.result.pruned.length > 0 && (
              <div className="generator-dialog__note">
                {fillTemplate(t('Left out {n} unused lines.', language), { n: phase.result.pruned.length })}
              </div>
            )}
            <div className="generator-dialog__note">{t('The group arrives unconnected: wire its last node into an Output to see it.', language)}</div>
            <details className="generator-dialog__code">
              <summary>{t('Show code', language)}</summary>
              <pre>{phase.result.tsl}</pre>
            </details>
          </div>
          );
        })()}

        <div className="csv-import-modal__buttons">
          {running ? (
            <button type="button" className="csv-import-modal__button" onClick={cancel}>{t('Cancel', language)}</button>
          ) : (
            <button type="button" className="csv-import-modal__button" disabled={busy} onClick={close}>{t('Close', language)}</button>
          )}
          {phase.kind === 'result' || phase.kind === 'adding' ? (
            <>
              <button type="button" className="csv-import-modal__button" disabled={busy} onClick={() => void generate()}>
                {t('Generate again', language)}
              </button>
              <button type="button" className="csv-import-modal__button csv-import-modal__button--yes" disabled={busy} onClick={() => void add()}>
                {t('Add to canvas', language)}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="csv-import-modal__button csv-import-modal__button--primary"
              disabled={!canGenerate}
              onClick={() => void generate()}
              title={t('Cmd/Ctrl+Enter', language)}
            >
              {t('Generate', language)}
            </button>
          )}
        </div>
      </div>
    </div>,
    host,
  );
}
