/**
 * The GLB import FLOW (GLB Phase 5 Step 9): what `loadMeshFile` hands an
 * offerable `.glb`/`.gltf` to — read the model on the trusted side
 * (`readGltfModel`), derive the facts and the plan, show the dialog, run the
 * builder on "Mesh with Materials", commit through `commitGlbImport`,
 * post ONE report note.
 *
 * The reader's report is TRANSIENT (it holds views into the dropped bytes):
 * it lives in this hook's state for exactly as long as the dialog is open,
 * and is dropped — with the bytes — on commit, cancel, a refused build or
 * unmount. Nothing here writes the store except through `commitGlbImport`
 * and `showImportNote`; "Only Mesh" is the caller's own model drop over the
 * bytes already read (`applyModelBytes`), and fires nothing.
 *
 * A second drop while the dialog is open is REFUSED with a notice rather
 * than swapping the file under the user's cursor: the sandboxed preview can
 * forge a drop and so open a dialog, but it can never answer one.
 *
 * GLB Phase 7 adds RESTORE: a FastShaders single-GLB export carrying its
 * shader (the trusted reader `readGlbFsExtras`) is offered "Restore the
 * stored shader", committed through `importShaderGlb`. An iframe-forwarded
 * drop needs the forwarded-shader `window.confirm` on top of the click, since
 * the sandbox can forge the drop that opened the dialog. A stored shader the
 * reader refuses is announced whether or not the dialog opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppStore, resolveDeviceTextureDim } from '@/store/useAppStore';
import { t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { readGltfModel, type GltfModelReport } from '@/utils/gltfReader';
import { glbImportFactsOf, planGlbImportDialog, type GlbDialogPlan, type GlbImportFacts } from '@/utils/glbImportGate';
import { GLB_IMPORT_KEYS, fsRefusalNotice } from '@/utils/glbImportCopy';
import { readGlbFsExtras, type FsExtrasRead } from '@/utils/glbShaderExtras';
import { restoreFactOf } from '@/utils/glbImportGate';
import { sanitizeMeshFileName } from '@/utils/previewMesh';
import { glbImportReportLines } from '@/utils/glbImportReport';
import { gltfBuildRefusalMessage, meshRefusalMessage } from '@/utils/previewMeshMessage';
import { pickPortalHost } from '@/components/inputs/colorPickerModel';
import { buildGlbImport } from '@/engine/gltfImport';
import { commitGlbImport, importShaderGlb } from '@/engine/projectImport';
import { GlbImportModal, type GlbImportChoice } from '@/components/Modals/GlbImportModal';

export interface GlbImportFlow {
  /**
   * Offer the dropped model. 'opened' = the dialog is up and owns the bytes;
   * 'busy' = a dialog is already open (a notice was shown); 'declined' = not
   * offerable (no built material with an extractable texture, or the reader
   * refused it — then an INFO notice says why), so the caller loads it
   * model-only. `source` is where the drop landed: an 'iframe' one is only as
   * trustworthy as the sandbox that forwarded it, so its Restore also asks.
   */
  offer(
    fileName: string,
    bytes: Uint8Array<ArrayBuffer>,
    kind: 'glb' | 'gltf',
    source?: 'dom' | 'iframe',
  ): 'opened' | 'busy' | 'declined';
  busy(): boolean;
  modal: ReactNode;
}

interface Request {
  fileName: string;
  bytes: Uint8Array<ArrayBuffer>;
  /** Null when only a restore is offered for a model the reader refused. */
  report: GltfModelReport | null;
  facts: GlbImportFacts | null;
  plan: GlbDialogPlan;
  source: 'dom' | 'iframe';
}

function fullscreenEl(): HTMLElement | null {
  const d = document as Document & { webkitFullscreenElement?: Element | null };
  const el = document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
  return el instanceof HTMLElement ? el : null;
}

export function useGlbImport(deps: {
  applyModelBytes(fileName: string, bytes: Uint8Array<ArrayBuffer>): void;
  showDropNotice(msg: string, tone?: 'error' | 'info'): void;
  anchorRef: React.RefObject<HTMLElement | null>;
}): GlbImportFlow {
  const [request, setRequest] = useState<Request | null>(null);
  const [phase, setPhase] = useState<'ask' | 'building'>('ask');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const requestRef = useRef<Request | null>(null);
  const depsRef = useRef(deps);
  useEffect(() => { depsRef.current = deps; }, [deps]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    seqRef.current++;
    requestRef.current = null;
    setRequest(null);
    setPhase('ask');
    setProgress(null);
  }, []);

  // The portal host follows fullscreen: the preview fullscreens its own
  // root, and the top layer shows only that subtree, so a body portal would
  // be invisible there (the colour picker's rule).
  useEffect(() => {
    if (!request) return;
    const resolve = () => setPortalHost(pickPortalHost(fullscreenEl(), depsRef.current.anchorRef.current, document.body));
    resolve();
    document.addEventListener('fullscreenchange', resolve);
    document.addEventListener('webkitfullscreenchange', resolve);
    return () => {
      document.removeEventListener('fullscreenchange', resolve);
      document.removeEventListener('webkitfullscreenchange', resolve);
    };
  }, [request]);

  // Unmount aborts a build in flight and drops the report.
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const offer = useCallback<GlbImportFlow['offer']>((fileName, bytes, kind, source = 'dom') => {
    const lang = useAppStore.getState().language;
    if (requestRef.current) {
      depsRef.current.showDropNotice(t(GLB_IMPORT_KEYS.busy, lang));
      return 'busy';
    }
    // The stored shader (Phase 7): GLBs only — a single-GLB export is never
    // a .gltf. The reader slices bytes and runs nothing.
    const fsRead: FsExtrasRead = kind === 'glb' ? readGlbFsExtras(bytes) : { state: 'none' };
    const embedded = {
      fact: restoreFactOf(fsRead),
      refusal: fsRead.state === 'refused' ? fsRead.reason : null,
      fileBytes: bytes.length,
    };
    // After the caller's model-only load, so its own notices cannot hide this one.
    const announceRefusal = () => {
      const reason = embedded.refusal;
      if (!reason) return;
      queueMicrotask(() =>
        depsRef.current.showDropNotice(fsRefusalNotice(sanitizeMeshFileName(fileName, 'glb'), reason, lang), 'info'),
      );
    };
    const read = readGltfModel(bytes, kind);
    if (!read.ok && !embedded.fact) {
      // The reader is strict, and a refusal only withdraws the BUILD: the
      // model still loads model-only (the caller's path), with an info line.
      // A too-large refusal is not announced here — the model gate says so.
      // The SANITIZED name, like every other model notice: the raw one is
      // attacker-chosen (a forged iframe drop needs no click to get here).
      if (embedded.refusal) announceRefusal();
      else if (read.refusal.reason !== 'too-large') {
        depsRef.current.showDropNotice(
          gltfBuildRefusalMessage(read.refusal, sanitizeMeshFileName(fileName, kind), bytes.length, lang),
          'info',
        );
      }
      return 'declined';
    }
    const facts = read.ok ? glbImportFactsOf(read.model, fileName, bytes.length) : null;
    const s = useAppStore.getState();
    const plan = planGlbImportDialog(
      facts,
      {
        allowManyMaterials: s.allowManyMaterials,
        ignoreImageLimits: s.ignoreImageLimits,
        deviceMaxDim: resolveDeviceTextureDim(s.selectedHeadsetId, s.costProfiles),
      },
      embedded,
    );
    if (!plan.offer) {
      if (plan.embeddedRefusal) announceRefusal();
      return 'declined';
    }
    const req: Request = {
      fileName,
      bytes,
      report: read.ok ? read.model : null,
      facts,
      plan,
      source: source === 'iframe' ? 'iframe' : 'dom',
    };
    requestRef.current = req;
    setRequest(req);
    setPhase('ask');
    setProgress(null);
    return 'opened';
  }, []);

  const choose = useCallback((c: GlbImportChoice) => {
    const req = requestRef.current;
    if (!req) return;
    const lang = useAppStore.getState().language;
    if (c === 'cancel') {
      clear();
      return;
    }
    if (c === 'model') {
      if (req.plan.modelOnlyRefusal) return;
      clear();
      depsRef.current.applyModelBytes(req.fileName, req.bytes);
      return;
    }
    const shownName = sanitizeMeshFileName(req.fileName, 'glb');
    if (c === 'restore') {
      if (!req.plan.embeddedShader || abortRef.current) return;
      // SECURITY: a forwarded drop is only as trustworthy as the sandbox that
      // forwarded it, and a restore REPLACES the project: the same confirm a
      // forwarded .js/.zip needs. Declining is Cancel.
      if (
        req.source === 'iframe' &&
        !window.confirm(`${t('Load the dropped shader file? It replaces the current project.', lang)}\n(${shownName})`)
      ) {
        clear();
        return;
      }
      const ac = new AbortController();
      abortRef.current = ac;
      const seq = ++seqRef.current;
      setPhase('building');
      setProgress(null);
      void (async () => {
        try {
          const r = await importShaderGlb(req.fileName, req.bytes, { signal: ac.signal });
          if (seq !== seqRef.current || ac.signal.aborted) return;
          abortRef.current = null;
          clear();
          if (r.ok) useAppStore.getState().showImportNote(r.notes);
          else if (r.reason === 'mesh-refused') depsRef.current.showDropNotice(meshRefusalMessage(r.refusal, lang));
          else if (r.reason === 'damaged' || r.reason === 'no-shader') {
            depsRef.current.showDropNotice(fsRefusalNotice(shownName, 'damaged', lang));
          }
        } catch (e) {
          if (seq !== seqRef.current) return;
          abortRef.current = null;
          clear();
          depsRef.current.showDropNotice(
            fillTemplate(t('Could not import {name}: {reason}', lang), {
              name: '\u201c' + shownName + '\u201d',
              reason: e instanceof Error ? e.message : String(e),
            }),
          );
        }
      })();
      return;
    }
    if (req.plan.primary === null || !req.report || !req.facts || abortRef.current) return;
    const report = req.report;
    const facts = req.facts;
    const ac = new AbortController();
    abortRef.current = ac;
    const seq = ++seqRef.current;
    setPhase('building');
    // No line until the encoder's first report (0 of N, before its loop) —
    // a seeded {0, 0} read "0 of 0" for the whole first encode.
    setProgress(null);
    const s = useAppStore.getState();
    void (async () => {
      try {
        const r = await buildGlbImport(report, req.fileName, {
          bytes: req.bytes,
          materialIndices: req.plan.buildMaterialIndices,
          maxDim: req.plan.maxDim,
          deviceMaxDim: resolveDeviceTextureDim(s.selectedHeadsetId, s.costProfiles),
          ignoreImageLimits: s.ignoreImageLimits,
          signal: ac.signal,
          onProgress: (done, total) => { if (seq === seqRef.current) setProgress({ done, total }); },
        });
        if (seq !== seqRef.current || ac.signal.aborted) return;
        abortRef.current = null;
        clear();
        if (r.ok) {
          // Replaces the GRAPH and keeps the DOCUMENT — see the commit.
          // The note waits for the commit: a budget refusal defers it to the
          // limit notice, and a dismissed notice imports nothing at all.
          commitGlbImport(r.project, r.mesh, {
            onCommitted: () => useAppStore.getState().showImportNote(glbImportReportLines(r.report)),
          });
        } else if (r.reason === 'mesh-refused') {
          depsRef.current.showDropNotice(meshRefusalMessage(r.refusal, lang));
        } else if (r.reason === 'failed') {
          depsRef.current.showDropNotice(
            fillTemplate(t(GLB_IMPORT_KEYS.buildFailed, lang), { name: '“' + facts.fileName + '”', reason: r.message }),
          );
        }
      } catch (e) {
        if (seq !== seqRef.current) return;
        abortRef.current = null;
        clear();
        depsRef.current.showDropNotice(
          fillTemplate(t(GLB_IMPORT_KEYS.buildFailed, lang), {
            name: '“' + facts.fileName + '”',
            reason: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    })();
  }, [clear]);

  const busy = useCallback(() => requestRef.current !== null, []);

  const modal = useMemo(
    () => (
      <GlbImportModal
        request={
          request
            ? { facts: request.facts, plan: request.plan, fileName: sanitizeMeshFileName(request.fileName, 'glb') }
            : null
        }
        phase={phase}
        progress={progress}
        portalHost={portalHost}
        onChoose={choose}
      />
    ),
    [request, phase, progress, portalHost, choose],
  );

  return useMemo(() => ({ offer, busy, modal }), [offer, busy, modal]);
}
