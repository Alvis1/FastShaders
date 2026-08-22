import { memo, useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react';
import { useAppStore, VR_HEADSETS, resolveDeviceBudget } from '@/store/useAppStore';
import { t } from '@/i18n';
import {
  parseCostFile, parseCostProfileBundle, buildMergedComplexity, mergedComplexityFileName,
  buildProfileFile, buildProfileBundle, profileFileName, profileBundleFileName, editedCostCount,
  type ParsedCostFile, type CostProfile,
} from '@/utils/costOverride';
import { CostProfileModal, type CostProfileModalMode, type ExportScope } from '@/components/Modals/CostProfileModal';
import {
  readPendingBenchResult, clearBenchResult, BENCH_RESULT_KEY, type PendingBenchResult,
} from '@/utils/benchResult';
// Before './CostBar.css' so the bundler emits PaletteColorPicker.css first —
// the pole-picker rule below is written with two classes anyway, so this is
// belt-and-braces rather than the mechanism.
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import './CostBar.css';

/**
 * Action rows in the device dropdown. Sentinels rather than ids so a real
 * device can never collide with one; matched against this Set, never by
 * prefix, so an id that happens to start with `__` stays selectable.
 */
const IMPORT_OPTION = '__import-bench';
const NEW_OPTION = '__new-profile';
const EDIT_OPTION = '__edit-profile';
const EXPORT_OPTION = '__export-profiles';
const ACTION_OPTIONS = new Set([IMPORT_OPTION, NEW_OPTION, EDIT_OPTION, EXPORT_OPTION]);

/** How long a one-line notice stays up — the image-convert notice's 12 s. */
const NOTICE_TIMEOUT_MS = 12000;

/** Blob-and-anchor JSON download, shared by every file this bar writes. */
function downloadJson(data: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// memo(): rendered by NodeEditor, which re-renders every drag frame; this
// panel reads everything it shows from its own store selectors.
export const CostBar = memo(function CostBar() {
  const totalCost = useAppStore((s) => s.totalCost);
  const language = useAppStore((s) => s.language);
  const selectedHeadsetId = useAppStore((s) => s.selectedHeadsetId);
  const setSelectedHeadsetId = useAppStore((s) => s.setSelectedHeadsetId);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const setCostColorLow = useAppStore((s) => s.setCostColorLow);
  const setCostColorHigh = useAppStore((s) => s.setCostColorHigh);
  const costProfiles = useAppStore((s) => s.costProfiles);
  const importCostProfile = useAppStore((s) => s.importCostProfile);
  const importCostProfiles = useAppStore((s) => s.importCostProfiles);
  const createCostProfile = useAppStore((s) => s.createCostProfile);
  const deleteCostProfile = useAppStore((s) => s.deleteCostProfile);
  const [dragOver, setDragOver] = useState(false);
  const [modal, setModal] = useState<CostProfileModalMode | null>(null);
  // Stable: it is the modal's Escape-listener dependency, and an inline arrow
  // would re-subscribe that listener on every render of this panel.
  const closeModal = useCallback(() => setModal(null), []);

  /**
   * One-line confirmation strip (a download landed, profiles were imported).
   * A download is otherwise silent — the file appears in a folder the user
   * isn't looking at — and "nothing happened" is indistinguishable from a
   * broken menu row. Self-clearing, dismissible, and never blocking: it
   * reports what happened, it doesn't ask anything.
   */
  const [notice, setNotice] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const showNotice = useCallback((text: string, action?: { label: string; run: () => void }) => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice({ text, action });
    noticeTimer.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimer.current = null;
    }, NOTICE_TIMEOUT_MS);
  }, []);
  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  const activeProfile = costProfiles.find((p) => p.id === selectedHeadsetId) ?? null;
  const measuredProfiles = costProfiles.filter((p) => !p.meta.manual);
  const manualProfiles = costProfiles.filter((p) => p.meta.manual);
  const { label: deviceLabel, maxPoints: maxBudget } = resolveDeviceBudget(selectedHeadsetId, costProfiles);
  // A dangling id (e.g. a profile id from an imported project the user doesn't
  // have) resolves to base budget but isn't a real option — show the fallback.
  const knownId = activeProfile != null || VR_HEADSETS.some((h) => h.id === selectedHeadsetId);
  const selectValue = knownId ? selectedHeadsetId : VR_HEADSETS[0].id;
  const percentage = Math.min(totalCost / maxBudget, 1);
  const over = totalCost > maxBudget;
  const invalid = activeProfile?.meta.valid === false;

  // ONE commit gate for every entrance (drop, picker, same-browser chip):
  // an invalid run asks before applying, a valid one applies silently.
  const confirmAndImport = useCallback(
    (parsed: ParsedCostFile): boolean => {
      if (parsed.meta.valid === false) {
        const ok = window.confirm(
          `${t('This benchmark run was flagged invalid:', language)}\n\n` +
          `${parsed.meta.reasons.join('\n')}\n\n` +
          t('Add it as a device profile anyway?', language),
        );
        if (!ok) return false;
      }
      // Report what landed. Without this the download → edit → drop-back loop
      // ends in silence, with the "Saved <file>" notice from the download step
      // still on screen — which reads as the re-import having done nothing.
      // Read imperatively AFTER the import: this component's `costProfiles`
      // is the pre-import render's value, and the id is only knowable from the
      // profile the store actually built (a claimed id can be refused).
      const before = new Set(useAppStore.getState().costProfiles.map((p) => p.id));
      importCostProfile(parsed);
      const s = useAppStore.getState();
      const landed = s.costProfiles.find((p) => p.id === s.selectedHeadsetId);
      if (landed) {
        showNotice((before.has(landed.id)
          ? t('Updated “{name}”.', language)
          : t('Added “{name}”.', language)
        ).replace('{name}', landed.label));
      }
      return true;
    },
    [importCostProfile, showNotice, language],
  );

  // File entrances (drop on the bar, the dropdown's "Import benchmark…"
  // picker). Adversarial input — parseCostFile validates keys against the
  // authored table.
  const importBenchFile = useCallback(
    async (file: File) => {
      if (!/\.json$/i.test(file.name)) {
        window.alert(t('Use one of the benchmark’s .json exports (results or complexity suggestion) — the .csv summary is not importable.', language));
        return;
      }
      let text: string;
      try { text = await file.text(); } catch { return; }
      // An exported BUNDLE first — it is the app's own multi-profile file, and
      // its entries are single-profile files, so the single parser would read
      // only… nothing (a bundle has no top-level `costs`). Import them all.
      const bundle = parseCostProfileBundle(text, file.name);
      if (bundle) {
        // A bundle may carry runs the bench flagged unpriceable. The single
        // path asks before adding one; skipping that here would make a bundle
        // the way to smuggle them in silently. One prompt for the set, and
        // declining keeps the good entries rather than losing the whole file.
        const bad = bundle.filter((p) => p.meta.valid === false);
        let list = bundle;
        if (bad.length) {
          const ok = window.confirm(
            `${t('This file contains {n} benchmark runs flagged invalid:', language).replace('{n}', String(bad.length))}\n\n` +
            `${bad.map((p) => `• ${p.self?.label ?? p.meta.device ?? '?'}: ${p.meta.reasons.join('; ')}`).join('\n')}\n\n` +
            t('Add them as device profiles anyway? Cancel imports only the valid ones.', language),
          );
          if (!ok) {
            list = bundle.filter((p) => p.meta.valid !== false);
            if (!list.length) return;
          }
        }
        // `current`: restoring a backup must not silently reprice the open
        // shader against whichever profile the file happened to end with.
        const n = importCostProfiles(list, { select: 'current' });
        // Two whole sentences rather than "{n} profile(s)": Latvian inflects
        // the noun with the number, so a stitched-in plural token can't be
        // translated into a sentence that reads correctly.
        showNotice(n === 1
          ? t('Imported one profile.', language)
          : t('Imported {n} profiles.', language).replace('{n}', String(n)));
        return;
      }
      const parsed = parseCostFile(text, file.name);
      if (!parsed) {
        window.alert(t('That JSON carries no usable node prices. Use a ShaderCarousel export (the results .json or its -complexity-suggestion sibling), or a profile file exported from this menu.', language));
        return;
      }
      confirmAndImport(parsed);
    },
    [confirmAndImport, importCostProfiles, showNotice, language],
  );

  // Same-browser handoff: a finished ShaderCarousel run stores its profile
  // under fs:benchResult (same origin), and this chip offers it with ONE
  // click. The `storage` event fires in OTHER tabs of the origin, so the
  // chip appears live while the bench tab still shows its done popup.
  // Re-checked when costProfiles changes: an import (any path) turns the
  // pending entry into a duplicate, which reads as 'consumed'.
  const [pendingBench, setPendingBench] = useState<PendingBenchResult | null>(null);
  useEffect(() => {
    const check = () => {
      const r = readPendingBenchResult(costProfiles.map((p) => p.id));
      if (r === 'consumed') {
        clearBenchResult();
        setPendingBench(null);
        return;
      }
      setPendingBench(r);
    };
    check();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === BENCH_RESULT_KEY) check();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [costProfiles]);

  const addPendingBench = useCallback(() => {
    if (!pendingBench) return;
    if (confirmAndImport(pendingBench.parsed)) {
      clearBenchResult();
      setPendingBench(null);
    }
  }, [pendingBench, confirmAndImport]);

  const dismissPendingBench = useCallback(() => {
    clearBenchResult();
    setPendingBench(null);
  }, []);

  // The dropdown's "Import benchmark…" row — a visible, clickable way into the
  // same import the drag-drop offers (a drop-only target is invisible until
  // you already know it exists, and unusable on touch).
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * True while the latest select interaction was bare arrow/Home/End
   * navigation. On Windows/Linux a CLOSED select commits each ArrowDown step
   * and fires change per step, so without this guard merely keyboard-browsing
   * the device list popped the OS file dialog the moment the Import row was
   * reached. Enter (committing from an OPEN dropdown) and mouse clicks clear
   * it, so both still open the picker.
   */
  const arrowNavRef = useRef(false);
  const handleDeviceKeyDown = useCallback((e: KeyboardEvent<HTMLSelectElement>) => {
    arrowNavRef.current =
      e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
      e.key === 'Home' || e.key === 'End' ||
      e.key === 'PageDown' || e.key === 'PageUp';
  }, []);
  /**
   * A pointer interaction is definitionally not arrow navigation, so it
   * clears the flag. Consuming it per `change` is not enough on its own:
   * MEASURED on macOS, ArrowDown on a closed select opens the popup WITHOUT
   * committing, so no change event follows to consume it and the stale `true`
   * survives until the next keydown — after which clicking any action row
   * with the mouse did nothing at all.
   */
  const handleDevicePointerDown = useCallback(() => { arrowNavRef.current = false; }, []);
  /** Download one profile as its editable JSON, and say where it went. */
  const downloadProfile = useCallback(
    (p: CostProfile) => {
      const name = profileFileName(p);
      downloadJson(buildProfileFile(p), name);
      // A MEASURED profile's download does NOT come back as an update: its id
      // is refused so the run's numbers survive, and the edit lands as a
      // separate "(edited)" row. Promising an update there would be a lie the
      // user only discovers as an unexplained second row.
      showNotice((p.meta.manual
        ? t('Saved {file} — edit the numbers and drop the file back here to update this profile.', language)
        : t('Saved {file} — edit the numbers and drop the file back here; it returns as an editable copy, leaving this measured run untouched.', language)
      ).replace('{file}', name));
    },
    [language, showNotice],
  );

  const handleCreateProfile = useCallback(
    (label: string) => {
      const p = createCostProfile(label);
      showNotice(
        t('Created “{name}” from the shipped prices. Download it to fill in your own numbers.', language)
          .replace('{name}', p.label),
        { label: t('⭳ Download', language), run: () => downloadProfile(p) },
      );
    },
    [createCostProfile, downloadProfile, language, showNotice],
  );

  const handleExport = useCallback(
    (scope: ExportScope) => {
      if (scope === 'current') {
        if (activeProfile) downloadProfile(activeProfile);
        return;
      }
      const name = profileBundleFileName();
      downloadJson(buildProfileBundle(costProfiles), name);
      showNotice(costProfiles.length === 1
        ? t('Saved one profile to {file}.', language).replace('{file}', name)
        : t('Saved {n} profiles to {file}.', language)
          .replace('{n}', String(costProfiles.length))
          .replace('{file}', name));
    },
    [activeProfile, costProfiles, downloadProfile, language, showNotice],
  );

  const handleDeviceChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      // CONSUME the arrow-nav flag: it describes the interaction that produced
      // THIS change and nothing later. It is only ever set by a keydown, so a
      // stale `true` (any earlier arrow press on this select) survived until
      // the next keydown — and a mouse click fires no keydown, so clicking an
      // action row after having arrowed the list at any point silently did
      // nothing. Harmless while the only action was Import (retry with the
      // mouse and it works, because the retry's own change cleared it); with
      // four action rows it is the difference between a working menu and a
      // dead one. Each Windows arrow step re-sets it on its own keydown, so
      // consuming here cannot re-open the closed-select trap it guards.
      const viaArrowNav = arrowNavRef.current;
      arrowNavRef.current = false;
      if (ACTION_OPTIONS.has(value)) {
        // Controlled select + unchanged state = React skips the DOM write, so
        // put the visible value back by hand before running the action.
        e.target.value = selectValue;
        if (viaArrowNav) return;
        if (value === IMPORT_OPTION) fileInputRef.current?.click();
        else if (value === NEW_OPTION) setModal('new');
        else if (value === EXPORT_OPTION) setModal('export');
        else if (value === EDIT_OPTION && activeProfile) downloadProfile(activeProfile);
        return;
      }
      setSelectedHeadsetId(value);
    },
    [setSelectedHeadsetId, selectValue, activeProfile, downloadProfile],
  );
  const handlePickedFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // re-picking the same file must fire change again
      if (file) void importBenchFile(file);
    },
    [importBenchFile],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void importBenchFile(file);
    },
    [importBenchFile],
  );

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    }
  }, []);

  const onDragLeave = useCallback(() => setDragOver(false), []);

  const removeActiveProfile = useCallback(() => {
    if (!activeProfile) return;
    // A measured profile is silent to remove: its numbers live in the bench
    // export it came from, so re-importing is a drag away. Hand-typed numbers
    // have no such source — deleting them is the one unrecoverable action on
    // this panel, and there is no undo here.
    if (activeProfile.meta.manual && !window.confirm(
      t('Delete the hand-authored profile “{name}”? Its prices are not saved anywhere else.', language)
        .replace('{name}', activeProfile.label),
    )) return;
    deleteCostProfile(activeProfile.id);
  }, [activeProfile, deleteCostProfile, language]);

  const downloadMerged = useCallback(() => {
    if (!activeProfile) return;
    downloadJson(
      buildMergedComplexity(activeProfile.costs, activeProfile.meta),
      mergedComplexityFileName(activeProfile.meta),
    );
  }, [activeProfile]);

  return (
    <div
      className={`cost-bar${dragOver ? ' cost-bar--drop' : ''}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      title={t('Drop a benchmark result or an exported profile (.json) here to add it as a device profile.', language)}
    >
      <div className="cost-bar__device-row">
        <select
          className="cost-bar__headset-select"
          value={selectValue}
          onChange={handleDeviceChange}
          onKeyDown={handleDeviceKeyDown}
          onPointerDown={handleDevicePointerDown}
          title={t('Performance device — sets the points budget and, for a measured profile, the per-node prices this bar uses', language)}
          aria-label={t('Performance device', language)}
        >
          <optgroup label={t('Headsets', language)}>
            {VR_HEADSETS.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label} ({h.maxPoints} {t('pts', language)})
              </option>
            ))}
          </optgroup>
          {measuredProfiles.length > 0 && (
            <optgroup label={t('Measured (dropped benchmark)', language)}>
              {measuredProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.meta.valid === false ? '⚠ ' : '◆ '}{p.label} ({p.maxPoints} {t('pts', language)})
                </option>
              ))}
            </optgroup>
          )}
          {/* Hand-authored profiles are their own group with their own mark:
              a typed table must never sit under a heading that says the
              numbers were measured. */}
          {manualProfiles.length > 0 && (
            <optgroup label={t('Custom (hand-authored)', language)}>
              {manualProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  ✎ {p.label} ({p.maxPoints} {t('pts', language)})
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={t('Profiles', language)}>
            <option value={IMPORT_OPTION}>{t('Import result JSON…', language)}</option>
            <option value={NEW_OPTION}>{t('New profile…', language)}</option>
            {/* Only with a profile active: there is nothing to download for a
                built-in headset, and New is the way to fork one. */}
            {activeProfile && <option value={EDIT_OPTION}>{t('Edit profile…', language)}</option>}
            {costProfiles.length > 0 && (
              <option value={EXPORT_OPTION}>{t('Export profiles…', language)}</option>
            )}
          </optgroup>
        </select>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={handlePickedFile}
          aria-hidden="true"
          tabIndex={-1}
        />
        {activeProfile && (
          <button
            className="cost-bar__device-remove"
            onClick={removeActiveProfile}
            title={t('Remove this profile', language)}
            aria-label={t('Remove this profile', language)}
          >
            ✕
          </button>
        )}
      </div>
      {notice && (
        <div className="cost-bar__notice" role="status" aria-live="polite">
          <span className="cost-bar__notice-text">{notice.text}</span>
          {notice.action && (
            <button className="cost-bar__bench-add" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          )}
          <button
            className="cost-bar__bench-dismiss"
            onClick={() => setNotice(null)}
            title={t('Dismiss', language)}
            aria-label={t('Dismiss', language)}
          >
            ✕
          </button>
        </div>
      )}
      {pendingBench && (
        <div
          className="cost-bar__bench-offer"
          title={t('A ShaderCarousel benchmark finished on this browser. Add adds it as a measured device profile — same as dragging the profile file here.', language)}
        >
          <span className="cost-bar__bench-offer-label">
            {pendingBench.parsed.meta.valid === false ? '⚠ ' : '◆ '}
            {pendingBench.label} · {pendingBench.parsed.meta.count} {t('nodes', language)} {t('measured', language)}
          </span>
          <button className="cost-bar__bench-add" onClick={addPendingBench}>
            {t('Add', language)}
          </button>
          <button
            className="cost-bar__bench-dismiss"
            onClick={dismissPendingBench}
            title={t('Dismiss', language)}
            aria-label={t('Dismiss', language)}
          >
            ✕
          </button>
        </div>
      )}
      <div className="cost-bar__labels">
        <span className="cost-bar__label-end">0</span>
        <span
          className={`cost-bar__value ${over ? 'cost-bar__value--over' : ''}`}
          title={`${t('Estimated GPU cost: {total} of {max} points for {headset}. A point is a rough measure of per-pixel shader work — staying under the budget keeps the frame rate smooth in VR.', language).replace('{total}', String(totalCost)).replace('{max}', String(maxBudget)).replace('{headset}', deviceLabel)}${over ? t(' You are over budget.', language) : ''}`}
        >
          {totalCost} / {maxBudget} {t('pts', language)}
        </span>
        <span className="cost-bar__label-end">{maxBudget}</span>
      </div>
      {/* Both gradient poles take `history="none"`: `setCostColorLow`/`High`
          write `fs:costColorLow`/`High` and the store, with no pushHistory —
          the gradient is a display PREFERENCE over the whole app (it recolors
          every cost badge), not a property of the graph. Bracketing would push
          an undo entry that restores nothing and clear the redo stack. */}
      <div className="cost-bar__track-row">
        <PaletteColorPicker
          className="cost-bar__pole-picker"
          history="none"
          value={costColorLow}
          onPick={setCostColorLow}
          title={t('Low impact color', language)}
        />
        <div
          className="cost-bar__track"
          style={{
            background: `linear-gradient(to right, ${costColorLow} 0%, ${costColorHigh} 100%)`,
          }}
        >
          <div
            className="cost-bar__indicator"
            style={{ left: `${percentage * 100}%` }}
          />
        </div>
        <PaletteColorPicker
          className="cost-bar__pole-picker"
          history="none"
          value={costColorHigh}
          onPick={setCostColorHigh}
          title={t('High impact color', language)}
        />
      </div>
      {activeProfile && (
        <div className={`cost-bar__override${invalid ? ' cost-bar__override--warn' : ''}`}>
          <span
            className="cost-bar__override-tag"
            title={[
              activeProfile.meta.manual
                // Deliberately does NOT claim all {n} were typed: a new
                // profile is seeded from the shipped table, so most of them
                // usually are exactly that until the user edits the file.
                ? t('Hand-authored profile — this table carries {n} node prices. Anything you have not edited still matches the shipped table.', language).replace('{n}', String(activeProfile.meta.count))
                : t('Measured prices active — {n} node types repriced from a benchmark run.', language).replace('{n}', String(activeProfile.meta.count)),
              activeProfile.meta.device ? `device: ${activeProfile.meta.device}` : null,
              activeProfile.meta.bench ? `bench: ${activeProfile.meta.bench}` : null,
              activeProfile.meta.timingMethod ? `timing: ${activeProfile.meta.timingMethod}` : null,
              invalid ? `⚠ ${activeProfile.meta.reasons.join('; ')}` : null,
            ].filter(Boolean).join('\n')}
          >
            {invalid ? '⚠ ' : activeProfile.meta.manual ? '✎ ' : '● '}
            {activeProfile.meta.manual ? t('custom', language) : t('measured', language)}
            {activeProfile.meta.manual
              // The count that means something for a hand-authored table is
              // how many prices were CHANGED — its size is every node, which
              // would read as far better-specified than a measured run.
              ? ` · ${editedCostCount(activeProfile.costs)} ${t('edited', language)}`
              : ` · ${activeProfile.meta.count} ${t('nodes', language)}`}
          </span>
          <button className="cost-bar__override-btn" onClick={downloadMerged} title={t('Download the merged complexity.json to commit into the repo', language)}>
            ⭳ complexity.json
          </button>
        </div>
      )}
      {modal && (
        <CostProfileModal
          mode={modal}
          language={language}
          profiles={costProfiles}
          activeProfile={activeProfile}
          onClose={closeModal}
          onCreate={handleCreateProfile}
          onExport={handleExport}
        />
      )}
    </div>
  );
});
