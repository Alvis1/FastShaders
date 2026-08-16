import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useDismiss } from '@/hooks/useDismiss';
import { buildShaderBundle } from '@/engine/exportShader';
import { importShaderText, importShaderZip } from '@/engine/projectImport';
import { bytesToBase64 } from '@/utils/binaryCodec';
import { t } from '@/i18n';

/**
 * Work-folder control (desktop builds only): pick a local folder once, then
 * the control becomes Save + a dropdown of the folder's shaders. All file
 * access happens on the Rust side (src-tauri/src/work_folder.rs) — the
 * webview only ever exchanges bare file names and bytes, and the picked
 * path persists across launches in the app's config dir.
 */

/** Result shapes of the work-folder commands (src-tauri/src/work_folder.rs). */
interface WorkFolderInfo {
  path: string;
  name: string;
}
interface WorkFolderEntry {
  fileName: string;
  /**
   * The shader's authored name, recovered Rust-side from the embedded
   * FASTSHADERS_PROJECT_V1 block. Still sent, no longer DISPLAYED — the list
   * shows file names only. Kept on the type because the command really does
   * return it; if it stays unused, the scan in `work_folder.rs` (which reads
   * up to MAX_SCAN_BYTES of every `.js` on each listing) is what to delete.
   */
  displayName: string | null;
  sizeBytes: number;
  modifiedMs: number | null;
}

/** Invoke a work-folder Tauri command (same bridge rules as Toolbar's benchInvoke). */
function wfInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = window.__TAURI__;
  if (!bridge) return Promise.reject(new Error('Desktop bridge unavailable'));
  return bridge.core.invoke<T>(cmd, args);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * work_folder_read returns raw bytes via tauri::ipc::Response, which the
 * invoke bridge surfaces as an ArrayBuffer — but normalize defensively, since
 * this path can only be verified on a real desktop run.
 */
function toBytes(data: unknown): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    // Copy so the result is plain-ArrayBuffer-backed (BlobPart rejects
    // ArrayBufferLike views under TS's typed-array generics).
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy;
  }
  if (Array.isArray(data)) return new Uint8Array(data);
  throw new Error('Unexpected binary payload from the desktop bridge');
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function WorkFolder() {
  const language = useAppStore((s) => s.language);

  // null = no folder linked; the Rust side re-validates the persisted path.
  const [info, setInfo] = useState<WorkFolderInfo | null>(null);
  const [open, setOpen] = useState(false);
  // null = list being read.
  const [entries, setEntries] = useState<WorkFolderEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  useDismiss(open, setOpen, [wrapRef]);

  useEffect(() => {
    let cancelled = false;
    wfInvoke<WorkFolderInfo | null>('work_folder_status')
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
    wfInvoke<WorkFolderInfo | null>('work_folder_status')
      .then(setInfo)
      .catch(() => {
        /* keep current state */
      });
  }, []);

  const refreshList = useCallback(() => {
    setEntries(null);
    wfInvoke<WorkFolderEntry[]>('work_folder_list')
      .then((list) => {
        list.sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0));
        setEntries(list);
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
    wfInvoke<WorkFolderInfo | null>('work_folder_pick', {
      title: t('Choose a work folder for shaders', language),
    })
      .then((picked) => {
        // null = the user cancelled the native dialog; keep whatever we had.
        if (picked) {
          setInfo(picked);
          setOpen(false);
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
    wfInvoke<void>('work_folder_forget').catch(() => {
      /* worst case the stale path re-validates away next launch */
    });
  }, []);

  const save = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const bundle = buildShaderBundle();
      wfInvoke<void>('work_folder_write', {
        fileName: bundle.fileName,
        dataB64: bytesToBase64(bundle.bytes),
      })
        .then(() => {
          setSavedFlash(true);
          window.clearTimeout(flashTimer.current);
          flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1600);
          if (open) refreshList();
        })
        .catch((e) => {
          // Surface the failure — a silent failed save is worse. The list is
          // refreshed too, so the popover can't open onto a stale "Reading
          // folder…" placeholder with no fetch in flight.
          setError(errorText(e));
          setOpen(true);
          refreshList();
          resyncStatus();
        })
        .finally(() => setBusy(false));
    } catch (e) {
      setError(errorText(e));
      setOpen(true);
      refreshList();
      setBusy(false);
    }
  }, [busy, open, refreshList, resyncStatus]);

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
      setBusy(true);
      setError(null);
      wfInvoke<unknown>('work_folder_read', { fileName: entry.fileName })
        .then(async (data) => {
          const bytes = toBytes(data);
          if (/\.zip$/i.test(entry.fileName)) {
            const result = await importShaderZip(new File([bytes], entry.fileName));
            if (result === null) {
              throw new Error(t('No shader found inside the zip.', language));
            }
          } else {
            // Throws on an unparseable script; the catch shows the message.
            importShaderText(new TextDecoder().decode(bytes));
          }
          setOpen(false);
        })
        .catch((e) => {
          setError(errorText(e));
          resyncStatus();
        })
        .finally(() => setBusy(false));
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
        title={`${t('Save the current shader into the work folder', language)} (${info.name})`}
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
            entries.map((entry) => (
              <button
                key={entry.fileName}
                type="button"
                className="toolbar__local-row toolbar__wf-row"
                onClick={() => loadEntry(entry)}
                disabled={busy}
                title={t('Load this shader into the editor', language)}
              >
                {/* The FILE NAME is the label — this is a folder listing, and
                    the name on disk is the one the user can find again outside
                    the app. It used to lead with the shader's authored name
                    (recovered from the embedded project block) and repeat the
                    file name underneath, which put two different names on one
                    row: a file saved as `waves.js` whose graph was still called
                    "Untitled" read as an unrelated shader. The size keeps the
                    second line; the file name no longer needs repeating. */}
                <span className="toolbar__local-os toolbar__wf-row-name">
                  {entry.fileName}
                </span>
                <span className="toolbar__local-detail">
                  {formatSize(entry.sizeBytes)}
                </span>
              </button>
            ))
          )}
          <button type="button" className="toolbar__wf-forget" onClick={forgetFolder}>
            {t('Forget this folder', language)}
          </button>
        </div>
      )}
    </div>
  );
}
