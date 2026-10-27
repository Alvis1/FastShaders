import { memo, useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useAppStore, VR_HEADSETS, resolveDeviceBudget } from '@/store/useAppStore';
import { t, type Language } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { downloadBlob } from '@/utils/downloadBlob';
import { POINT_BUDGET, formatPoints } from '@/utils/budgetPoints';
import { useBudgetPoints } from '@/hooks/useDeviceBudget';
import { Points } from '@/components/Points/Points';
import { isEvalMode } from '@/eval/evalMode';
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
import { formatSplatCount } from '@/utils/previewMesh';
import './CostBar.css';

/** The splat figure and its tooltip. Each English sentence IS its lv.json key. */
const SPLAT_FIGURE_KEY = 'Gaussian splats: {count}';
const SPLAT_FIGURE_HINT_KEY =
  'How many Gaussian splats the 3D preview is drawing. Shown for information only — splats are not priced in points: their cost depends on how much of the screen they cover and on depth sorting, not on the node graph.';

/**
 * Action rows in the device dropdown. Sentinels rather than ids so a real
 * device can never collide with one; matched against this Set, never by
 * prefix, so an id that happens to start with `__` stays selectable.
 */
const IMPORT_OPTION = '__import-bench';
const NEW_OPTION = '__new-profile';
const EDIT_OPTION = '__edit-profile';
const EXPORT_OPTION = '__export-profiles';
const COMPARE_OPTION = '__compare-devices';
const ACTION_OPTIONS = new Set([IMPORT_OPTION, NEW_OPTION, EDIT_OPTION, EXPORT_OPTION, COMPARE_OPTION]);

/**
 * The device comparison page — every device's price for every node, side by
 * side (compare/index.html, its own Vite entry). A NEW TAB, so the shader on
 * the canvas stays where it is. Not offered in a study session (what the
 * editor offers is part of the condition every participant must meet alike,
 * the DesktopAppNote rule) nor in the desktop build, whose webview has no
 * browser tab to open it in (Toolbar.tsx's Podest note: `_blank` is inert
 * there). Both are fixed for the page's lifetime: `isEvalMode()` is sampled
 * once at module init, `__FS_DESKTOP__` at build time.
 */
const COMPARE_URL = `${import.meta.env.BASE_URL}compare/`;
const OFFERS_COMPARE = !__FS_DESKTOP__ && !isEvalMode();

/** How long a one-line notice stays up — the image-convert notice's 12 s. */
const NOTICE_TIMEOUT_MS = 12000;

/** Every file this bar writes is pretty-printed JSON. */
function downloadJson(data: unknown, fileName: string): void {
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), fileName);
}

/** A device as its dropdown row reads — `Meta Quest 3`, a measured profile
 *  marked ◆ (⚠ when its run was invalid), a hand-authored one ✎. No budget
 *  beside the name: every device's is 100 (utils/budgetPoints.ts), so the
 *  figure would be the same on every row — devices differ in their node prices
 *  alone (owner, 2026-10-23). Shared with the intro window's stage
 *  (intro/BudgetScene.tsx). */
export function deviceOptionText(device: { label: string; meta?: CostProfile['meta'] }): string {
  const mark = !device.meta ? '' : device.meta.manual ? '✎ ' : device.meta.valid === false ? '⚠ ' : '◆ ';
  return `${mark}${device.label}`;
}

/**
 * The bar's readout: `0 · total / 100 pts · 100` over the gradient track and
 * its marker. `points` is the shader's total in BUDGET points — its share of
 * the selected device's frame, which prints as 100 on every device — so the
 * caller divides the summed table total ONCE (`useBudgetPoints`) and this only
 * prints and places it: the marker at its share of 100, red past it (the same
 * test as "the total passes the device's budget", in the printed currency).
 * The bar wraps the total in its own button or span (`value`) and supplies the
 * two pole pickers; the intro window's stage draws the same readout with inert
 * poles (intro/BudgetScene.tsx).
 */
export function CostMeter({
  points, language, colorLow, colorHigh, device, value, lowPole, highPole,
}: {
  points: number;
  language: Language;
  /** The device control, sharing the top row with the total — two rows in
   *  all: device + total, then the ramp. The budget is printed once, after
   *  the slash, so the ramp's ends carry no numbers. */
  device: ReactNode;
  colorLow: string;
  colorHigh: string;
  /** Wraps the total; it gets the value's class and its text. A wrapper that
   *  carries a title should state the exact figure in it (the bar's does): the
   *  figure itself takes no tooltip, since one hover cannot show two. */
  value?: (className: string, label: ReactNode) => ReactNode;
  lowPole: ReactNode;
  highPole: ReactNode;
}) {
  const percentage = Math.min(points / POINT_BUDGET, 1);
  const over = points > POINT_BUDGET;
  const label = (
    <>
      <Points value={points} tip={false} /> / {POINT_BUDGET} {t('pts', language)}
    </>
  );
  const cls = `cost-bar__value ${over ? 'cost-bar__value--over' : ''}`;
  return (
    <>
      <div className="cost-bar__head">
        {device}
        {value ? value(cls, label) : <span className={cls}>{label}</span>}
      </div>
      <div className="cost-bar__track-row">
        {lowPole}
        <div
          className="cost-bar__track"
          style={{
            background: `linear-gradient(to right, ${colorLow} 0%, ${colorHigh} 100%)`,
          }}
        >
          <div
            className="cost-bar__indicator"
            style={{ left: `${percentage * 100}%` }}
          />
        </div>
        {highPole}
      </div>
    </>
  );
}

export interface CostBarProps {
  /**
   * Jump the canvas to the Output node. Supplied by NodeEditor (the only
   * consumer), which owns React Flow's `fitView`; absent means "no Output in
   * the graph", and the total then renders as plain text rather than as a
   * control that would do nothing — the same rule the Output tile follows.
   */
  onFocusOutput?: () => void;
  /**
   * Does a press CYCLE through several Output nodes, or glide to the one?
   * The title has to say which: a second press that lands somewhere new is
   * not discoverable, and with one Output a promise of cycling would be a
   * control describing something it will not do (owner decision D4).
   */
  cyclesOutputs?: boolean;
}

// memo(): rendered by NodeEditor, which re-renders every drag frame; this
// panel reads everything it shows from its own store selectors.
export const CostBar = memo(function CostBar({ onFocusOutput, cyclesOutputs = false }: CostBarProps) {
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
  // The loaded Gaussian splat's count, as the preview's sandbox reported it —
  // a FIGURE beside the points, never points: the report is forgeable and a
  // splat's cost is screen coverage and sorting, which no node price models.
  // Only while the preview SHOWS the model (a parked splat draws nothing).
  const splatFacts = useAppStore((s) => (s.previewShowsModel ? s.previewSplatFacts : null));
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
  // A built-in row that carries its own measured prices (the Steam Frame) gets
  // the same "measured" tag a dropped profile does: the bar is not using the
  // shipped table, and nothing else on the panel would say so.
  const pricedHeadset = activeProfile ? null : VR_HEADSETS.find((h) => h.id === selectedHeadsetId && h.costs) ?? null;
  const measuredProfiles = costProfiles.filter((p) => !p.meta.manual);
  const manualProfiles = costProfiles.filter((p) => p.meta.manual);
  const { label: deviceLabel } = resolveDeviceBudget(selectedHeadsetId, costProfiles);
  // A dangling id (e.g. a profile id from an imported project the user doesn't
  // have) resolves to the first headset but isn't a real option — show that one.
  const knownId = activeProfile != null || VR_HEADSETS.some((h) => h.id === selectedHeadsetId);
  const selectValue = knownId ? selectedHeadsetId : VR_HEADSETS[0].id;
  // The total as printed: its share of the selected device's budget, which is
  // 100 on every device (utils/budgetPoints.ts). The store sums in table
  // points; this divides ONCE, after the sum, so rounding never compounds.
  // There is no cap to type any more (2026-10-23): with every budget printed
  // as 100, a device differs only in its node prices, and the right-click
  // editor that layered a user's own cap over a device's measured one went
  // with `fs:costBudgets`.
  const points = useBudgetPoints(totalCost);
  const over = points > POINT_BUDGET;
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
        : fillTemplate(t('Saved {n} profiles to {file}.', language), { n: costProfiles.length, file: name }));
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
      // five action rows it is the difference between a working menu and a
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
        // Inside the change, like the Import row's picker: a new tab needs the
        // user's press, and the guard above has already refused arrowing.
        else if (value === COMPARE_OPTION && OFFERS_COMPARE) window.open(COMPARE_URL, '_blank', 'noopener');
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
      {/* The total is the shader's price, and the Output node is where that
          price is spent — so the number doubles as the way to GET there, the
          same "take me to it" affordance the Output's palette tile and its
          Add-node row carry (outputFocus.ts). A real <button>, not a span
          with a click handler: it is keyboard-reachable and announces itself.
          It renders as an inert <span> when there is no Output to jump to.
          Both gradient poles take `history="none"`: `setCostColorLow`/`High`
          write `fs:costColorLow`/`High` and the store, with no pushHistory —
          the gradient is a display PREFERENCE over the whole app (it recolors
          every cost badge), not a property of the graph. Bracketing would push
          an undo entry that restores nothing and clear the redo stack. */}
      <CostMeter
        points={points}
        language={language}
        colorLow={costColorLow}
        colorHigh={costColorHigh}
        device={
          <div className="cost-bar__device-row">
            <select
              className="cost-bar__headset-select"
              value={selectValue}
              onChange={handleDeviceChange}
              onKeyDown={handleDeviceKeyDown}
              onPointerDown={handleDevicePointerDown}
              // A device sets the node PRICES, never the printed budget: every
              // device's reads 100 (utils/budgetPoints.ts) — its measured one is
              // only the divisor — which is why no row prints one.
              title={fillTemplate(t('Performance device — sets the per-node prices this bar adds up. Every device’s budget is {max} points.', language), { max: POINT_BUDGET })}
              aria-label={t('Performance device', language)}
            >
              <optgroup label={t('Headsets', language)}>
                {VR_HEADSETS.map((h) => (
                  <option key={h.id} value={h.id}>
                    {deviceOptionText(h)}
                  </option>
                ))}
              </optgroup>
              {measuredProfiles.length > 0 && (
                <optgroup label={t('Measured (dropped benchmark)', language)}>
                  {measuredProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {deviceOptionText(p)}
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
                      {deviceOptionText(p)}
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
                {/* Last, below the rows that manage profiles: it opens a page
                    rather than acting on this list. */}
                {OFFERS_COMPARE && <option value={COMPARE_OPTION}>{t('Compare devices…', language)}</option>}
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
        }
        value={(cls, label) => {
          // deviceLabel can be an imported profile's label, so every sentence
          // it goes into is filled in ONE pass (utils/fillTemplate.ts). The
          // total is the EXACT figure (`formatPoints().exact`), so hovering the
          // number shows what its rounded print and dot stand for.
          const explain = `${fillTemplate(t('Estimated GPU cost: {total} of {max} points for {headset}. Every device’s budget is {max} points — the per-pixel shader work it can do each frame while keeping the frame rate smooth in VR.', language), { total: formatPoints(points).exact, max: POINT_BUDGET, headset: deviceLabel })}${over ? t(' You are over budget.', language) : ''}`;
          return onFocusOutput ? (
            <button
              type="button"
              className={`${cls} cost-bar__value--link`}
              onClick={onFocusOutput}
              title={`${explain}\n${t(cyclesOutputs
                ? 'Click to cycle through the Output nodes.'
                : 'Click to jump to the Output node.', language)}`}
            >
              {label}
            </button>
          ) : (
            <span className={cls} title={explain}>{label}</span>
          );
        }}
        lowPole={
          <PaletteColorPicker
            className="cost-bar__pole-picker"
            history="none"
            value={costColorLow}
            onPick={setCostColorLow}
            title={t('Low impact color', language)}
          />
        }
        highPole={
          <PaletteColorPicker
            className="cost-bar__pole-picker"
            history="none"
            value={costColorHigh}
            onPick={setCostColorHigh}
            title={t('High impact color', language)}
          />
        }
      />
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
      {splatFacts && (
        <div className="cost-bar__override">
          <span className="cost-bar__override-tag" title={t(SPLAT_FIGURE_HINT_KEY, language)}>
            {'◇ '}
            {fillTemplate(t(SPLAT_FIGURE_KEY, language), { count: formatSplatCount(splatFacts.count, language) })}
          </span>
        </div>
      )}
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
      {pricedHeadset?.costs && (
        <div className="cost-bar__override">
          <span
            className="cost-bar__override-tag"
            title={[
              t('Measured prices active — {n} node types repriced from a benchmark run.', language)
                .replace('{n}', String(Object.keys(pricedHeadset.costs).length)),
              `run: ShaderCarousel/benchData/${pricedHeadset.costsBasis ?? pricedHeadset.id}`,
            ].join('\n')}
          >
            {'● '}{t('measured', language)}{` · ${Object.keys(pricedHeadset.costs).length} ${t('nodes', language)}`}
          </span>
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
