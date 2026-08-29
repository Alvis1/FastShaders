import { useEffect, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { countProject } from '@/utils/feedbackReport';
import {
  CONSENT_TEXT_VERSION,
  clearEvalMode,
  mintEvalSessionId,
  readEvalSession,
  writeEvalSession,
  type EvalSessionRecord,
} from './evalMode';
import { initEvalBridge, startEvalSession, type EvalBridge } from './telemetry';
import { ConsentModal } from './ConsentModal';
import { VIEWPORT_KEY } from '@/utils/viewportMemory';

/**
 * Orchestrates eval-mode boot. Mounted by App.tsx ONLY when `isEvalMode()` —
 * outside eval mode none of this module's code runs.
 *
 * Two paths:
 *  - fresh entry (the /eval redirector dropped any previous session record):
 *    show the consent screen; Agree mints the session, starts telemetry and
 *    clears the canvas; Decline drops the flag and reloads into the normal app.
 *  - mid-session reload (the record survived in sessionStorage): resume
 *    silently — consent was already given in this tab, the journal restores
 *    the event log, and the participant's graph comes back through the normal
 *    fs:graph autosave restore.
 *
 * The bridge is how telemetry (which the store imports — no cycle allowed)
 * reaches graph totals: this component imports BOTH sides and wires them.
 */

function makeBridge(): EvalBridge {
  return {
    getSnapshot: () => {
      const s = useAppStore.getState();
      return { ...countProject(s.nodes, s.edges), costPoints: s.totalCost };
    },
    // `previewCode` advances per scrub FRAME (the sync engine regenerates code
    // on every node-value change), while the actual iframe rebuild is behind
    // ShaderPreview's 200 ms debounce — so the metric ("edit→preview cycles",
    // Alaboudi & LaToza) debounces here too, or a slider drag would log tens
    // of phantom rebuilds per second and drown the journal.
    subscribePreviewRebuild: (cb) => {
      let timer: number | null = null;
      const unsub = useAppStore.subscribe((state, prev) => {
        if (state.previewCode === prev.previewCode) return;
        if (timer != null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          cb();
        }, 250);
      });
      return () => {
        if (timer != null) window.clearTimeout(timer);
        unsub();
      };
    },
  };
}

/**
 * The clean slate between participants. `newGraph()` alone is not enough:
 * three other persisted surfaces would leak the PREVIOUS user's material into
 * the next participant's session — and two of them straight into the study
 * package via buildShaderBundle()/buildProjectState():
 *  - the custom preview mesh (store + IndexedDB mirror) rides the export zip;
 *  - fs:previewUniformValues / fs:previewUniformBounds are embedded in the
 *    project block AND, because they persist BY NAME and auto-generated names
 *    (color1, property1) collide by design, would silently override the new
 *    participant's property values;
 *  - newGraph's own undo entry snapshots the pre-clear graph, so one Cmd+Z
 *    would resurrect the previous document — history is cleared outright.
 * fs:savedGroups (the machine's saved-group library) is deliberately NOT
 * wiped — it is the machine owner's persistent data; study-machine hygiene
 * (an empty library) is the researcher's setup step, noted in the plan.
 */
function cleanSlateForStudy(): void {
  const store = useAppStore.getState();
  store.newGraph();
  store.setPreviewMesh(null);
  try {
    localStorage.removeItem('fs:previewUniformValues');
    localStorage.removeItem('fs:previewUniformBounds');
    // The remembered canvas pan/zoom (utils/viewportMemory.ts) — measured
    // against the PREVIOUS user's graph, so a reload mid-session would restore
    // this participant's blank document to wherever the last one was looking.
    localStorage.removeItem(VIEWPORT_KEY);
  } catch {
    /* storage blocked — nothing persisted to leak either */
  }
  useAppStore.setState({ past: [], future: [] });
}

export function EvalGate() {
  const [consented, setConsented] = useState(() => readEvalSession() != null);

  // Resume path — runs once. A fresh entry has no record (the redirector
  // cleared it), so this is a no-op there and Agree does the starting.
  useEffect(() => {
    const rec = readEvalSession();
    if (!rec) return;
    initEvalBridge(makeBridge());
    startEvalSession(rec);
  }, []);

  const handleAgree = (participant: string) => {
    const nowIso = new Date().toISOString();
    const rec: EvalSessionRecord = {
      id: mintEvalSessionId(),
      participant,
      startedIso: nowIso,
      consentIso: nowIso,
      consentVersion: CONSENT_TEXT_VERSION,
    };
    writeEvalSession(rec);
    initEvalBridge(makeBridge());
    startEvalSession(rec);
    // Clean slate: the session starts from an empty document, not whatever
    // the machine's autosave, mesh cache, or uniform tunings held — see
    // cleanSlateForStudy for why newGraph() alone would leak the previous
    // user's material into this participant's package.
    cleanSlateForStudy();
    setConsented(true);
  };

  const handleDecline = () => {
    clearEvalMode();
    window.location.reload();
  };

  if (consented) return null;
  return <ConsentModal onAgree={handleAgree} onDecline={handleDecline} />;
}
