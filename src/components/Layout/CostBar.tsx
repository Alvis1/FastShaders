import { memo, useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react';
import { useAppStore, VR_HEADSETS, resolveDeviceBudget } from '@/store/useAppStore';
import { t } from '@/i18n';
import { parseCostFile, buildMergedComplexity, mergedComplexityFileName, type ParsedCostFile } from '@/utils/costOverride';
import {
  readPendingBenchResult, clearBenchResult, BENCH_RESULT_KEY, type PendingBenchResult,
} from '@/utils/benchResult';
// Before './CostBar.css' so the bundler emits PaletteColorPicker.css first —
// the pole-picker rule below is written with two classes anyway, so this is
// belt-and-braces rather than the mechanism.
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import './CostBar.css';

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
  const deleteCostProfile = useAppStore((s) => s.deleteCostProfile);
  const [dragOver, setDragOver] = useState(false);

  const activeProfile = costProfiles.find((p) => p.id === selectedHeadsetId) ?? null;
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
      importCostProfile(parsed);
      return true;
    },
    [importCostProfile, language],
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
      const parsed = parseCostFile(text, file.name);
      if (!parsed) {
        window.alert(t('That JSON carries no usable node prices. Use a ShaderCarousel export: the results .json or its -complexity-suggestion sibling.', language));
        return;
      }
      confirmAndImport(parsed);
    },
    [confirmAndImport, language],
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
  const IMPORT_OPTION = '__import-bench';
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
  const handleDeviceChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      if (e.target.value === IMPORT_OPTION) {
        // Controlled select + unchanged state = React skips the DOM write, so
        // put the visible value back by hand before opening the picker.
        e.target.value = selectValue;
        if (!arrowNavRef.current) fileInputRef.current?.click();
        return;
      }
      setSelectedHeadsetId(e.target.value);
    },
    [setSelectedHeadsetId, selectValue],
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
    if (activeProfile) deleteCostProfile(activeProfile.id);
  }, [activeProfile, deleteCostProfile]);

  const downloadMerged = useCallback(() => {
    if (!activeProfile) return;
    const merged = buildMergedComplexity(activeProfile.costs, activeProfile.meta);
    const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = mergedComplexityFileName(activeProfile.meta);
    a.click();
    URL.revokeObjectURL(url);
  }, [activeProfile]);

  return (
    <div
      className={`cost-bar${dragOver ? ' cost-bar--drop' : ''}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      title={t('Drop a benchmark complexity patch (.json) here to add it as a measured device profile.', language)}
    >
      <div className="cost-bar__device-row">
        <select
          className="cost-bar__headset-select"
          value={selectValue}
          onChange={handleDeviceChange}
          onKeyDown={handleDeviceKeyDown}
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
          {costProfiles.length > 0 && (
            <optgroup label={t('Measured (dropped benchmark)', language)}>
              {costProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.meta.valid === false ? '⚠ ' : '◆ '}{p.label} ({p.maxPoints} {t('pts', language)})
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={t('Benchmark', language)}>
            <option value={IMPORT_OPTION}>{t('Import result JSON…', language)}</option>
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
            title={t('Remove this measured profile', language)}
            aria-label={t('Remove this measured profile', language)}
          >
            ✕
          </button>
        )}
      </div>
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
              t('Measured prices active — {n} node types repriced from a benchmark run.', language).replace('{n}', String(activeProfile.meta.count)),
              activeProfile.meta.device ? `device: ${activeProfile.meta.device}` : null,
              activeProfile.meta.bench ? `bench: ${activeProfile.meta.bench}` : null,
              activeProfile.meta.timingMethod ? `timing: ${activeProfile.meta.timingMethod}` : null,
              invalid ? `⚠ ${activeProfile.meta.reasons.join('; ')}` : null,
            ].filter(Boolean).join('\n')}
          >
            {invalid ? '⚠ ' : '● '}
            {t('measured', language)}
            {` · ${activeProfile.meta.count} ${t('nodes', language)}`}
          </span>
          <button className="cost-bar__override-btn" onClick={downloadMerged} title={t('Download the merged complexity.json to commit into the repo', language)}>
            ⭳ complexity.json
          </button>
        </div>
      )}
    </div>
  );
});
