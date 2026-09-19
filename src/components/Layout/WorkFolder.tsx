import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useDismiss } from '@/hooks/useDismiss';
import { announceExportDelivered, buildShaderExportChecked, shaderBaseName } from '@/engine/exportShader';
import { useExportPreflight } from '@/components/Modals/ExportPreflightModal';
import {
  importShaderGlb,
  importShaderText,
  importShaderZip,
  reportZipImportError,
} from '@/engine/projectImport';
import { effectiveExportFormat } from '@/utils/glbExportAvailability';
import { GLB_EXPORT_KEYS } from '@/utils/glbExportCopy';
import { fsRefusalNotice } from '@/utils/glbImportCopy';
import { meshRefusalMessage } from '@/utils/previewMeshMessage';
import { sanitizeMeshFileName } from '@/utils/previewMesh';
import { isEvalMode } from '@/eval/evalMode';
import {
  adoptShaderName,
  isShaderRenamed,
  sameShaderFile,
  workFolderSaveName,
} from '@/utils/workFolderFile';
import { invokeDesktop, errorText } from '@/utils/tauriBridge';
import {
  ARCHIVE_SLACK_BYTES,
  FILE_NAME_HEADER,
  WORK_FOLDER_WRITE_BYTES,
  desktopBytes,
  encodeHeaderName,
  parseDesktopError,
} from '@/utils/desktopIpc';
import { fillTemplate } from '@/utils/fillTemplate';
import { formatMiB } from '@/utils/formatSize';
import { generateId } from '@/utils/idGenerator';
import { t } from '@/i18n';

/**
 * Work-folder control (desktop builds only): pick a local folder once, then
 * the control becomes Save + a dropdown of the folder's shaders. All file
 * access happens on the Rust side (src-tauri/src/work_folder.rs) — the
 * webview only ever exchanges bare file names and bytes, and the picked
 * path persists across launches in the app's config dir.
 *
 * The folder is an open/save surface, not just an export target: loading an
 * entry adopts that FILE's identity as the shader name, and Save writes back to
 * the file it came from for as long as the name still resolves there. Rename the
 * shader and Save forks a new file instead — which is the only way to make a
 * copy, so the rules live in one pure, tested place (utils/workFolderFile.ts).
 */

/**
 * Where the document on screen came from, as far as this folder is concerned.
 * Three states, because Save has to treat them differently and two of them look
 * identical if you only track a file name:
 *
 *  - `file`   — it was loaded from (or last written to) this work-folder file
 *               under this name. Saving back to it is the point, and silent.
 *  - `new`    — NEW made a blank document that never had a file. It usually
 *               resolves to `my-shader.js` (DEFAULT_SHADER_NAME), so it lands on
 *               a real file often enough that Save must check before replacing.
 *  - null     — unknown: a session restored from the autosave, or an import from
 *               another surface. Save writes the derived name silently, exactly
 *               as it did before any of this existed — the alternative is
 *               prompting to "replace" the user's own shader on the first save
 *               of every launch, which is noise, not safety.
 *
 * Component state on purpose — one reader, one writer, and the control never
 * unmounts on desktop, so there is nothing to gain by putting desktop
 * vocabulary in the shared store. Session-only by construction.
 */
type DocOrigin =
  | { kind: 'file'; fileName: string; shaderName: string }
  | { kind: 'new' }
  | null;

/** Result shapes of the work-folder commands (src-tauri/src/work_folder.rs). */
interface WorkFolderInfo {
  path: string;
  name: string;
}
interface WorkFolderEntry {
  fileName: string;
  /**
   * The shader's authored name, recovered Rust-side from the embedded
   * FASTSHADERS_PROJECT_V1 block (null for zips, foreign scripts, and `.js`
   * files past MAX_NAME_SCAN_BYTES). Deliberately NOT displayed — the list
   * shows file names only — but load-bearing: it is what `adoptShaderName`
   * compares the file name against, and the only source that answers "did
   * THIS file supply a name?" exactly. The store cannot: `applyProjectToStore`
   * skips an empty `shaderName`, so a post-import read cannot tell "the file
   * said nothing" from "the previous shader was called this" — which would
   * degrade "My Shader" to "my-shader" on the most ordinary flow there is,
   * reopening the shader you just saved.
   */
  displayName: string | null;
  sizeBytes: number;
  modifiedMs: number | null;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function WorkFolder() {
  const language = useAppStore((s) => s.language);
  const shaderName = useAppStore((s) => s.shaderName);
  // Which extension the export will take, mirroring buildExportBundle's own
  // "images or a mesh → zip" test. Predicted from cheap store reads rather than
  // by building a bundle, because this only feeds the Save tooltip and building
  // one generates the whole module. It can over-predict `zip` for an image node
  // whose payload fails to decode (collectImageFiles drops those); the write
  // itself always uses the real bundle's kind — and so can a pre-flight answer
  // ("Export without the 3D model" turns a .zip into a .js) at write time.
  const bundleKind = useAppStore((s) =>
    effectiveExportFormat(s.exportAsGlb, s.previewMesh, isEvalMode()) === 'glb'
      ? 'glb'
      : s.nodes.some((n) => n.data.registryType === 'imageNode') ||
          (s.exportIncludeMesh && s.previewMesh !== null)
        ? 'zip'
        : 'js',
  );

  // null = no folder linked; the Rust side re-validates the persisted path.
  const [info, setInfo] = useState<WorkFolderInfo | null>(null);
  const [open, setOpen] = useState(false);
  // null = list being read.
  const [entries, setEntries] = useState<WorkFolderEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  // The export pre-flight's dialog (N1) for Save.
  const { ask: askExportPreflight, glb: glbExportUi, modal: exportPreflightModal } = useExportPreflight();
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [origin, setOrigin] = useState<DocOrigin>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  // True while THIS control is importing, so the graph-replaced listener below
  // ignores the event its own load dispatches.
  const loadingRef = useRef(false);
  // Bumped whenever an outside event moves the origin. A save reads it before
  // its write and refuses to re-track if it changed meanwhile — the write is
  // awaited, and a canvas drop landing inside that window would otherwise be
  // followed by the continuation resurrecting tracking for a document the
  // editor no longer holds.
  const originEpoch = useRef(0);

  useDismiss(open, setOpen, [wrapRef]);

  // Two ways the document stops being the file we opened, and they need
  // different answers (see DocOrigin):
  //  - another surface replaced the graph (canvas drop, Load Script, the code
  //    panel's drop zone, a preview drop) → unknown provenance;
  //  - NEW built a blank one → known to have no file, and its default name
  //    resolves onto a real one often enough that Save must look first.
  //
  // The loadingRef guard is deliberate rather than defensive: announceGraphImport
  // runs SYNCHRONOUSLY inside importShaderText, so without it a work-folder load
  // would clear the very origin it is about to set. Relying on the set landing
  // afterwards would make the feature depend on that dispatch never moving to a
  // microtask. `fs:graph-imported` also fires once at boot, which is harmless.
  useEffect(() => {
    const forget = (next: DocOrigin) => () => {
      if (loadingRef.current) return;
      originEpoch.current++;
      setOrigin(next);
    };
    const onImport = forget(null);
    const onNew = forget({ kind: 'new' });
    window.addEventListener('fs:graph-imported', onImport);
    window.addEventListener('fs:graph-new', onNew);
    return () => {
      window.removeEventListener('fs:graph-imported', onImport);
      window.removeEventListener('fs:graph-new', onNew);
    };
  }, []);

  // The file Save would write right now: the tracked one while the name still
  // resolves to it, otherwise the ordinary export name (a save-as).
  const openedFile = origin?.kind === 'file' ? origin : null;
  const trackedFile =
    openedFile && !isShaderRenamed(openedFile.shaderName, shaderName) ? openedFile.fileName : null;
  const saveTarget = workFolderSaveName(
    trackedFile,
    `${shaderBaseName(shaderName)}.${bundleKind}`,
    bundleKind,
  );

  useEffect(() => {
    let cancelled = false;
    invokeDesktop<WorkFolderInfo | null>('work_folder_status')
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch(() => {
        /* bridge unavailable (plain-browser run of a desktop bundle) */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  // Any command failure may mean the Rust side silently unlinked a vanished
  // folder (resolve_root re-validates the path) — re-fetch status so the
  // control falls back to the unlinked pick button instead of a dead Save
  // titled with a folder that no longer exists.
  const resyncStatus = useCallback(() => {
    invokeDesktop<WorkFolderInfo | null>('work_folder_status')
      .then(setInfo)
      .catch(() => {
        /* keep current state */
      });
  }, []);

  const refreshList = useCallback(() => {
    setEntries(null);
    invokeDesktop<WorkFolderEntry[]>('work_folder_list')
      .then((list) => {
        list.sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0));
        // The .glb entries are the single-GLB export's, which a study session
        // never offers — so it never lists them either.
        setEntries(isEvalMode() ? list.filter((e) => !/\.glb$/i.test(e.fileName)) : list);
      })
      .catch((e) => {
        setEntries([]);
        setError(errorText(e));
        resyncStatus();
      });
  }, [resyncStatus]);

  const pickFolder = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    invokeDesktop<WorkFolderInfo | null>('work_folder_pick', {
      title: t('Choose a work folder for shaders', language),
    })
      .then((picked) => {
        // null = the user cancelled the native dialog; keep whatever we had.
        if (picked) {
          setInfo(picked);
          setOpen(false);
          // The tracked file belonged to the OLD folder — a same-named file in
          // the new one is a different shader.
          originEpoch.current++;
          setOrigin(null);
        }
      })
      .catch((e) => {
        setError(errorText(e));
        // In the unlinked branch the error popover is gated on `open`, so
        // useDismiss (outside click / Escape) can clear it away again.
        setOpen(true);
      })
      .finally(() => setBusy(false));
  }, [busy, language]);

  const forgetFolder = useCallback(() => {
    setOpen(false);
    setInfo(null);
    originEpoch.current++;
    setOrigin(null);
    invokeDesktop<void>('work_folder_forget').catch(() => {
      /* worst case the stale path re-validates away next launch */
    });
  }, []);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // The pre-flight (N1) runs BEFORE the target is derived: answering
      // "Export without the 3D model" can turn a .zip into a .js, and so the
      // file name. Cancelling reports itself like a declined replace does.
      const bundle = await buildShaderExportChecked({
        preflight: askExportPreflight,
        glb: glbExportUi,
        // An IPC write, so the fresh-click ("ready") step never applies.
        delivery: 'write',
      });
      if (!bundle) {
        setError(t('Save cancelled — nothing was written.', language));
        setOpen(true);
        return;
      }
      // Read the name imperatively: `saveTarget` above is a render-time
      // prediction, this is the one the bytes are actually written under.
      const liveName = useAppStore.getState().shaderName;
      const from = origin?.kind === 'file' ? origin : null;
      const tracked =
        from && !isShaderRenamed(from.shaderName, liveName) ? from.fileName : null;
      const target = workFolderSaveName(tracked, bundle.fileName, bundle.kind);

      // Writing back to the file this document came from is the point, and stays
      // silent. Everything else that would land on an EXISTING file has to ask —
      // `work_folder_write_bytes` replaces unconditionally and the folder has no undo:
      // a rename (the file names collapse through toKebabCase, so "Zīle" and
      // "Zāle" are one file), a kind flip, and a save after NEW. An origin of
      // null asks nothing: that is a restored session or a foreign import, where
      // the app cannot tell the user's own file from a stranger's and prompting
      // would fire on the first save of every launch. The listing is fetched only
      // on these branches, so ordinary re-saves pay nothing for it.
      const mustCheck = origin !== null && !(from !== null && sameShaderFile(target, from.fileName));
      let writeName = target;
      if (mustCheck) {
        const list = await invokeDesktop<WorkFolderEntry[]>('work_folder_list');
        const clash = list.find((e) => sameShaderFile(e.fileName, target));
        if (clash) {
          const ok = window.confirm(
            // Replacer FUNCTION, not a string: a file name is disk-supplied and
            // `$&` / `$'` in one would expand against the pattern.
            t('{file} already exists in the work folder. Replace it?', language).replace(
              '{file}',
              () => clash.fileName,
            ),
          );
          if (!ok) {
            // Say so — a cancelled save otherwise looks identical to a save that
            // silently did nothing.
            setError(t('Save cancelled — nothing was written.', language));
            setOpen(true);
            return;
          }
          // Write under the spelling already on disk, so confirming "replace
          // Waves.js" cannot leave a differently-cased twin behind.
          writeName = clash.fileName;
        }
      }

      const epoch = originEpoch.current;
      // The RAW bytes are the body and the name rides a header: base64 inside
      // a JSON string inflated a 256 MiB zip by a third before Rust saw it.
      await invokeDesktop<void>(WORK_FOLDER_WRITE_BYTES, bundle.bytes, {
        headers: { [FILE_NAME_HEADER]: encodeHeaderName(writeName) },
      });
      // Track ONLY after a write that succeeded, and only if the document is
      // still the one that was written: claiming a file that was never written —
      // or that belongs to a shader some other surface imported during the await
      // — would aim the next Save at whatever really is at that name.
      if (originEpoch.current === epoch) {
        setOrigin({ kind: 'file', fileName: writeName, shaderName: liveName });
      }
      // N1's desktop variant, only once the write resolved: a bundle between
      // the web reader's cap and this build's reopens only in the desktop editor.
      announceExportDelivered(bundle);
      setSavedFlash(true);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1600);
      if (open) refreshList();
    } catch (e) {
      // Surface the failure — a silent failed save is worse. The list is
      // refreshed too, so the popover can't open onto a stale "Reading
      // folder…" placeholder with no fetch in flight. Rust's two structured
      // refusals of the request itself (`E_BAD_BODY`: the raw body did not
      // arrive as bytes — Tauri's postMessage fallback re-serialises it as JSON
      // for the rest of the session once its custom-protocol fetch fails;
      // `E_BAD_NAME`: the header did not decode to a safe name) get a sentence,
      // not the literal code; every other command error is plain English.
      const de = parseDesktopError(e);
      setError(
        de?.code === 'BAD_BODY' || de?.code === 'BAD_NAME'
          ? t('The desktop app could not receive the file. Nothing was written.', language)
          : errorText(e),
      );
      setOpen(true);
      refreshList();
      resyncStatus();
    } finally {
      setBusy(false);
    }
  }, [busy, language, open, origin, refreshList, resyncStatus, askExportPreflight, glbExportUi]);

  const toggleList = useCallback(() => {
    setOpen((o) => {
      const next = !o;
      if (next) {
        setError(null);
        refreshList();
      }
      return next;
    });
  }, [refreshList]);

  const loadEntry = useCallback(
    (entry: WorkFolderEntry) => {
      if (busy) return;
      // The single-GLB restore is never offered in a study session (the format
      // itself is not), so its entries are not listed there either — this is
      // the guard behind that listing, not a second decision.
      if (isEvalMode() && /\.glb$/i.test(entry.fileName)) return;
      setBusy(true);
      setError(null);
      // Fallback source for the authored name, used only where the listing has
      // none (a zip, or a `.js` too big to scan): did the import MOVE the store's
      // name? A move means the file supplied one. It cannot see a file whose
      // name equals the previous shader's — hence `entry.displayName` first.
      const nameBefore = useAppStore.getState().shaderName;
      loadingRef.current = true;
      invokeDesktop<unknown>('work_folder_read', { fileName: entry.fileName })
        .then(async (data) => {
          const bytes = desktopBytes(data);
          let result: 'project' | 'script' | 'model' | null;
          if (/\.glb$/i.test(entry.fileName)) {
            // A FastShaders single-GLB export: its shader is RESTORED, the
            // model becomes the preview mesh. The folder is the user's own, so
            // this needs no confirm (a forwarded drop does — see the
            // GLB-restore convention). A .glb that carries no shader changes
            // nothing and says so.
            const r = await importShaderGlb(entry.fileName, bytes);
            if (!r.ok) {
              const shown = sanitizeMeshFileName(entry.fileName, 'glb');
              setError(
                r.reason === 'no-shader'
                  ? fillTemplate(t(GLB_EXPORT_KEYS.workFolderNoShader, language), { file: `“${shown}”` })
                  : r.reason === 'mesh-refused'
                    ? meshRefusalMessage(r.refusal, language)
                    : fsRefusalNotice(shown, 'damaged', language),
              );
              setOpen(true);
              return;
            }
            useAppStore.getState().showImportNote(r.notes);
            // The opened file's FORMAT is adopted with its name: Save writes
            // back to the file it was opened from, and without this the
            // session flag is still the bundle, so `waves.glb` would fork a
            // `waves.js`/`.zip` sibling and keep the pre-edit shader.
            // `effectiveExportFormat` still falls back to the bundle if the
            // restored mesh cannot be packed.
            useAppStore.getState().setExportAsGlb(true);
            result = r.imported;
          } else if (/\.zip$/i.test(entry.fileName)) {
            result = await importShaderZip(new File([bytes], entry.fileName));
            if (result === null) {
              throw new Error(t('No shader found inside the zip.', language));
            }
          } else {
            // Throws on an unparseable script; the catch shows the message.
            result = importShaderText(new TextDecoder().decode(bytes));
          }
          // A model-only zip carries no shader: the graph was never replaced, so
          // neither the name nor the tracked file may move.
          if (result !== 'model') {
            const nameAfter = useAppStore.getState().shaderName;
            const authored =
              entry.displayName ?? (nameAfter !== nameBefore ? nameAfter : null);
            const adopted = adoptShaderName(entry.fileName, authored);
            useAppStore.getState().setShaderName(adopted);
            originEpoch.current++;
            setOrigin({ kind: 'file', fileName: entry.fileName, shaderName: adopted });
          }
          setOpen(false);
        })
        .catch((e) => {
          // Rust refused the file before reading it (`E_TOO_LARGE <size> <limit>`,
          // work_folder.rs MAX_READ_BYTES). A zip gets the same N2 notice every
          // other import surface shows — its printed limit is the UNPACKED cap,
          // so the archive slack comes off; anything else gets the Work-folder
          // sentence rather than the raw code.
          const de = parseDesktopError(e);
          if (de?.code === 'TOO_LARGE' && de.limit !== undefined) {
            if (/\.zip$/i.test(entry.fileName)) {
              useAppStore.getState().enqueueLimitNotice({
                id: generateId(),
                kind: 'zip-limit',
                fileName: entry.fileName,
                zipLimit: {
                  kind: 'total-size',
                  limit: Math.max(0, de.limit - ARCHIVE_SLACK_BYTES),
                  value: de.value ?? 0,
                },
              });
            } else {
              setError(
                fillTemplate(
                  t('{name} is larger than {limit} MB, the most the Work folder opens. Nothing was changed.', language),
                  { name: `“${entry.fileName}”`, limit: formatMiB(de.limit, language) },
                ),
              );
            }
            resyncStatus();
            return;
          }
          // A zip the reader refused says why (shared mapping, all surfaces);
          // it throws before the success path, so name and origin are untouched.
          if (!reportZipImportError(e, entry.fileName)) setError(errorText(e));
          resyncStatus();
        })
        .finally(() => {
          loadingRef.current = false;
          setBusy(false);
        });
    },
    [busy, language, resyncStatus]
  );

  if (!info) {
    return (
      <div className="toolbar__workfolder" ref={wrapRef}>
        <button
          type="button"
          className="toolbar__sc-link toolbar__wf-link"
          onClick={pickFolder}
          disabled={busy}
          title={t('Pick a local work folder — Save writes the current shader there, and its shaders appear in the list', language)}
        >
          {t('Work folder', language)}
        </button>
        {open && error && (
          <div className="toolbar__local-popover toolbar__wf-popover" role="alert">
            <div className="toolbar__vr-error">{error}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="toolbar__workfolder" ref={wrapRef}>
      <button
        type="button"
        className={`toolbar__sc-link toolbar__wf-save${savedFlash ? ' toolbar__wf-save--saved' : ''}`}
        onClick={save}
        disabled={busy}
        // Naming the exact target is the only place the open/save-as split is
        // visible before it happens: rename the shader and this changes, which
        // is the signal that Save is about to create a second file. It also
        // shows the two cases the rules cannot distinguish — a rename whose
        // kebab collides with the tracked file still reads as the same name.
        title={`${t('Save the current shader into the work folder', language)} (${info.name}) → ${saveTarget}`}
      >
        {t('Save', language)}
      </button>
      <button
        type="button"
        className="toolbar__sc-link toolbar__wf-caret"
        onClick={toggleList}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('Shaders in the work folder', language)}
        aria-label={t('Shaders in the work folder', language)}
      >
        {/* Inline SVG, not a glyph — the self-hosted woff2 subset may lack ▾. */}
        <svg viewBox="0 0 10 6" aria-hidden="true" focusable="false">
          <path d="M0 0h10L5 6z" />
        </svg>
      </button>
      {open && (
        <div
          className="toolbar__local-popover toolbar__wf-popover"
          role="dialog"
          aria-label={t('Work folder', language)}
        >
          <div className="toolbar__local-header">
            <span className="toolbar__contact-label" title={info.path}>
              {info.name}
            </span>
            <button
              type="button"
              className="toolbar__contact-copy"
              onClick={pickFolder}
              disabled={busy}
            >
              {t('Change…', language)}
            </button>
          </div>
          {/* Error ABOVE the list — the popover scrolls, and an error after a
              long entry list would sit below the fold and read as success. */}
          {error && <div className="toolbar__vr-error">{error}</div>}
          {entries === null ? (
            <div className="toolbar__local-note">{t('Reading folder…', language)}</div>
          ) : entries.length === 0 && !error ? (
            <div className="toolbar__local-note">
              {t('No shaders here yet — Save adds the current one.', language)}
            </div>
          ) : (
            entries.map((entry) => {
              // The row the document came from. Without it the popover cannot
              // say which of several similarly-named files is the one on screen
              // — exactly the question the open/save-as split creates. The
              // WRITE-BACK promise is narrower than the mark: after a rename the
              // row is still where this shader came from, but Save now forks.
              const isCurrent =
                openedFile !== null && sameShaderFile(openedFile.fileName, entry.fileName);
              const writesBack = isCurrent && trackedFile !== null;
              return (
              <button
                key={entry.fileName}
                type="button"
                className={`toolbar__local-row toolbar__wf-row${isCurrent ? ' toolbar__wf-row--current' : ''}`}
                onClick={() => loadEntry(entry)}
                disabled={busy}
                aria-current={isCurrent ? 'true' : undefined}
                title={
                  writesBack
                    ? t('Open in the editor — Save writes back to this file', language)
                    : isCurrent
                      ? t('Loaded from this file — the shader was renamed, so Save creates a new one', language)
                      : t('Load this shader into the editor', language)
                }
              >
                {/* The FILE NAME is the label — this is a folder listing, and
                    the name on disk is the one the user can find again outside
                    the app. It used to lead with the shader's authored name
                    (recovered from the embedded project block) and repeat the
                    file name underneath, which put two different names on one
                    row: a file saved as `waves.js` whose graph was still called
                    "Untitled" read as an unrelated shader. Loading now closes
                    that divergence at the source (the file's name becomes the
                    shader's), so the example survives only for foreign files.
                    The size keeps the second line. */}
                <span className="toolbar__local-os toolbar__wf-row-name">
                  {entry.fileName}
                </span>
                <span className="toolbar__local-detail">
                  {formatSize(entry.sizeBytes)}
                </span>
              </button>
              );
            })
          )}
          <button type="button" className="toolbar__wf-forget" onClick={forgetFolder}>
            {t('Forget this folder', language)}
          </button>
        </div>
      )}
      {exportPreflightModal}
    </div>
  );
}
