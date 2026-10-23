import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ChangeEvent, type DragEvent, type ReactNode,
} from 'react';
import { Points } from '@/components/Points/Points';
import { TooltipLayer } from '@/components/Tooltip/TooltipLayer';
import { formatPoints } from '@/utils/budgetPoints';
import { fillTemplate } from '@/utils/fillTemplate';
import { CATEGORIES } from '@/registry/nodeCategories';
import { t, formatCategoryLabel, formatNodeLabel, type Language } from '@/i18n';
import type { CostProfile } from '@/utils/costOverride';
import {
  builtinDevices, storedDevices, devicesFromFile, mergeFileDevices, displayLabel,
  readLinkIds, writeLinkIds, selectionFromLink, linkIdsOf, toggleDevice, makeReference, pruneSelection,
  compareGroups, compareTable, filterSections, languageOf,
  MAX_COLUMNS, MAX_PROFILE_FILE_BYTES,
  type CompareDevice, type DeviceKind, type PriceNote,
} from './compareModel';
import './compare.css';

/**
 * The device-comparison page: pick devices, each one a column, and read what
 * every node costs on each — in points of a budget that is 100 on every
 * device, so the columns differ in node prices alone. The first column is the
 * reference; every other cell carries its signed difference from it, red for
 * more, green for less (the sign says it too). Logic in compareModel.ts.
 *
 * Reads this browser's `fs:costProfiles`, `fs:lang` and (in the pre-paint
 * guard) `fs:codeEditorTheme`, and WRITES NO KEY: a dropped file lives in
 * React state until the page is reloaded, and the selection lives in the
 * link (`?d=…`, replaceState), so a copied address reproduces the view.
 */

const PROFILES_KEY = 'fs:costProfiles';

/** One read of the editor's localStorage — blocked storage (a private window,
 *  site data off) is an empty browser, never a blank page. */
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

const LANGUAGE: Language = languageOf(readStorage('fs:lang'));
const BUILTINS = builtinDevices();
const GROUPS = compareGroups();

/** Files read per drop or pick; the rest of a larger drop is ignored. */
const MAX_FILES_PER_DROP = 20;

const NOTE_TEXT: Record<PriceNote, string> = {
  operands: 'Price of a new node with two operands. Every operand you add is one more operation.',
  resolution: 'Price of a new node: a full-size image. A smaller image costs less, down to half.',
  curves: 'Price of a new node: straight curves, which bake nothing. Bending a curve bakes a lookup table and costs more.',
  march: 'Its own fixed cost. The fields it marches are charged again on every ray step.',
};

const KIND_TEXT: Record<DeviceKind, string> = {
  builtin: 'Built-in',
  stored: 'This browser',
  file: 'File',
};

/** A device's provenance, for its chip and column header title. */
function provenance(d: CompareDevice, lang: Language): string {
  if (d.kind === 'builtin') return d.basis ? `${t('measured', lang)} · ${d.basis}` : '';
  if (d.mark === '⚠') {
    return fillTemplate(t('Benchmark run flagged invalid: {reasons}', lang), { reasons: d.reasons.join('; ') });
  }
  return d.mark === '✎' ? t('Hand-authored profile', lang) : t('Measured profile', lang);
}

/** `+1.5` red / `−2` green beside a cell: the column against the reference,
 *  rounded the way every point figure is (a centred dot + the exact value as
 *  the title when the 0.01 print dropped precision). The drawn figure is
 *  hidden from assistive tech, which hears a sentence instead ("5 less than
 *  the reference" — a bare "12.5 −5" names no reference), and its slot is
 *  left out of a copy (compare.css), so a copied row is the values alone. */
function Delta({ value, lang }: { value: number; lang: Language }) {
  const up = value > 0;
  // U+2212, the true minus: a plus sign's width, where a hyphen is narrower.
  const sign = up ? '+' : '\u2212';
  const abs = Math.abs(value);
  const { text, rounded, exact } = formatPoints(abs);
  return (
    <>
      <span className={`cmp-delta cmp-delta--${up ? 'up' : 'down'}`} title={rounded ? `${sign}${exact}` : undefined} aria-hidden="true">
        {sign}
        <Points value={abs} tip={false} />
      </span>
      <span className="cmp-sr">
        {', '}
        {fillTemplate(t(up ? '{n} more than the reference' : '{n} less than the reference', lang), { n: text })}
      </span>
    </>
  );
}

function DeviceChip({
  device, selected, full, lang, onToggle,
}: {
  device: CompareDevice;
  selected: boolean;
  full: boolean;
  lang: Language;
  onToggle: (key: string) => void;
}) {
  // aria-disabled, never `disabled`: a disabled button takes no pointer, so
  // the title saying WHY could never show.
  const blocked = full && !selected;
  const title = [
    provenance(device, lang),
    blocked ? fillTemplate(t('At most {n} columns.', lang), { n: MAX_COLUMNS }) : '',
  ].filter(Boolean).join(' — ');
  return (
    <button
      type="button"
      className="cmp-chip"
      aria-pressed={selected}
      aria-disabled={blocked || undefined}
      title={title || undefined}
      onClick={() => { if (!blocked) onToggle(device.key); }}
    >
      {device.mark && <span className="cmp-mark" aria-hidden="true">{device.mark}</span>}
      {device.label}
    </button>
  );
}

export function ComparePage() {
  const lang = LANGUAGE;

  const [initial] = useState(() => {
    const stored = storedDevices(readStorage(PROFILES_KEY));
    return { stored, selection: selectionFromLink(readLinkIds(window.location.search), [...BUILTINS, ...stored]) };
  });
  const [stored, setStored] = useState<CompareDevice[]>(initial.stored);
  const [files, setFiles] = useState<CompareDevice[]>([]);
  const [selection, setSelection] = useState<string[]>(initial.selection);
  const [query, setQuery] = useState('');
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const [notice, setNotice] = useState('');
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const devices = useMemo(() => [...BUILTINS, ...stored, ...files], [stored, files]);
  const columns = useMemo(
    () => selection.map((k) => devices.find((d) => d.key === k)).filter((d): d is CompareDevice => !!d),
    [selection, devices],
  );

  // The latest state for the async file path, which commits after its reads.
  const latest = useRef({ stored, files, selection });
  useLayoutEffect(() => {
    latest.current = { stored, files, selection };
  });

  useEffect(() => {
    document.title = `FastShaders · ${t('Device comparison', lang)}`;
  }, [lang]);

  // A profile added or deleted in an editor tab shows here at once (the
  // `storage` event fires in every OTHER tab of the origin).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== PROFILES_KEY) return;
      setStored(storedDevices(readStorage(PROFILES_KEY)));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => {
    setSelection((sel) => pruneSelection(sel, devices));
  }, [devices]);

  /** Every selection change the viewer makes, mirrored into the link. Only
   *  theirs: arriving on a link never rewrites it, so ids this browser does
   *  not know stay in the address for whoever it is passed on to. */
  const commitSelection = useCallback((next: string[], known: readonly CompareDevice[]) => {
    setSelection(next);
    const { pathname, search, hash } = window.location;
    try {
      window.history.replaceState(window.history.state, '', `${pathname}${writeLinkIds(search, linkIdsOf(next, known))}${hash}`);
    } catch { /* a sandboxed frame refuses history writes — the view still changes */ }
  }, []);

  const toggle = useCallback(
    (key: string) => commitSelection(toggleDevice(selection, key), devices),
    [commitSelection, selection, devices],
  );
  const toReference = useCallback(
    (key: string) => commitSelection(makeReference(selection, key), devices),
    [commitSelection, selection, devices],
  );

  const addFiles = useCallback(async (list: readonly File[]) => {
    // Read everything first, then commit against the state as it is THEN:
    // a chip pressed while a file was loading is not overwritten.
    const reads: { name: string; text: string | null; problem: string | null }[] = [];
    for (const file of list.slice(0, MAX_FILES_PER_DROP)) {
      const name = displayLabel(file.name, '?');
      if (/\.csv$/i.test(file.name)) {
        reads.push({ name, text: null, problem: t('Use one of the benchmark’s .json exports (results or complexity suggestion) — the .csv summary is not importable.', lang) });
      } else if (file.size > MAX_PROFILE_FILE_BYTES) {
        reads.push({ name, text: null, problem: fillTemplate(t('{file} is too large for a profile.', lang), { file: name }) });
      } else {
        try {
          reads.push({ name, text: await file.text(), problem: null });
        } catch {
          reads.push({ name, text: null, problem: t('Could not read that file.', lang) });
        }
      }
    }
    const now = latest.current;
    let nextFiles = now.files;
    let nextSelection = now.selection;
    const messages: string[] = [];
    for (const r of reads) {
      if (r.text === null) {
        if (r.problem) messages.push(r.problem);
        continue;
      }
      const existing = [...now.stored, ...nextFiles]
        .map((d) => d.profile)
        .filter((p): p is CostProfile => !!p);
      // One file at a time: a parser throw on a crafted file (none known
      // today — costOverride reads every number without coercing) must not
      // discard the other files of the drop, or the notice saying why.
      let read: ReturnType<typeof devicesFromFile> = null;
      try { read = devicesFromFile(r.text, r.name, existing); } catch { read = null; }
      if (!read) {
        messages.push(fillTemplate(
          t('{file} holds no node prices. Use a ShaderCarousel result (.json) or a profile exported from the editor.', lang),
          { file: r.name },
        ));
        continue;
      }
      nextFiles = mergeFileDevices(nextFiles, read.devices);
      // One profile is what the viewer came to compare: it becomes a column.
      // A bundle's join the list (a backup of thirty would bury the table).
      if (!read.bundle) {
        for (const d of read.devices) {
          if (nextFiles.some((f) => f.key === d.key) && !nextSelection.includes(d.key)) {
            nextSelection = toggleDevice(nextSelection, d.key);
          }
        }
      }
      messages.push(read.devices.length === 1
        ? fillTemplate(t('Added “{name}”.', lang), { name: read.devices[0].label })
        : fillTemplate(t('Added {n} devices from {file}.', lang), { n: read.devices.length, file: r.name }));
    }
    setFiles(nextFiles);
    if (nextSelection !== now.selection) commitSelection(nextSelection, [...BUILTINS, ...now.stored, ...nextFiles]);
    setNotice(messages.join(' '));
  }, [commitSelection, lang]);

  const onPick = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = ''; // the same file again is a new pick
    if (list.length) void addFiles(list);
  }, [addFiles]);

  const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  }, []);
  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    const to = e.relatedTarget as Node | null;
    if (!to || !e.currentTarget.contains(to)) setDropping(false);
  }, []);
  const onDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    setDropping(false);
    const list = Array.from(e.dataTransfer.files);
    if (list.length) void addFiles(list);
  }, [addFiles]);

  const sections = useMemo(() => compareTable(GROUPS, columns), [columns]);
  const shown = useMemo(
    () => filterSections(sections, query, onlyDifferences, lang),
    [sections, query, onlyDifferences, lang],
  );
  const full = selection.length >= MAX_COLUMNS;

  const chipGroup = (title: string, list: readonly CompareDevice[], extra?: ReactNode) => (
    <div className="cmp-devgroup" role="group" aria-label={title}>
      <span className="cmp-devgroup__title">{title}</span>
      {list.map((d) => (
        <DeviceChip
          key={d.key}
          device={d}
          selected={selection.includes(d.key)}
          full={full}
          lang={lang}
          onToggle={toggle}
        />
      ))}
      {extra}
    </div>
  );

  return (
    <div
      className={`cmp${dropping ? ' cmp--dropping' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="cmp-head">
        <div className="cmp-title">
          <a className="cmp-brand" href={import.meta.env.BASE_URL}>FastShaders</a>
          <h1>{t('Device comparison', lang)}</h1>
        </div>
        <p className="cmp-intro">
          {t('Every device’s budget is 100 points: a node’s points are its share of that device’s frame. Each column is compared with the first one, the reference.', lang)}
        </p>
      </header>

      <section className="cmp-devices" aria-label={t('Devices', lang)}>
        {chipGroup(t('Built-in', lang), BUILTINS)}
        {stored.length > 0 && chipGroup(t('This browser', lang), stored)}
        {chipGroup(t('Files', lang), files, (
          <>
            <button
              type="button"
              className="cmp-btn"
              title={t('A ShaderCarousel result or a profile exported from the editor (.json) — or drop one on this page. It stays only until the page is reloaded; nothing is saved.', lang)}
              onClick={() => fileInput.current?.click()}
            >
              {t('Add a profile file…', lang)}
            </button>
            <input ref={fileInput} type="file" accept=".json,application/json" multiple hidden onChange={onPick} />
          </>
        ))}
      </section>

      <div className="cmp-tools">
        <input
          type="search"
          className="cmp-search"
          value={query}
          placeholder={t('Search nodes...', lang)}
          aria-label={t('Search nodes...', lang)}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="cmp-check">
          <input type="checkbox" checked={onlyDifferences} onChange={(e) => setOnlyDifferences(e.target.checked)} />
          {t('Only differences', lang)}
        </label>
        <span className="cmp-legend">{t('* Price of a new node — on the canvas, its settings or wiring change it.', lang)}</span>
        {/* Always mounted, so the FIRST message is announced too: a live
            region that appears together with its text is not. */}
        <span className="cmp-notice" role="status">{notice}</span>
      </div>

      {/* Focusable: a region that scrolls must be reachable by keyboard. */}
      <div className="cmp-table-wrap" role="region" aria-label={t('Device comparison', lang)} tabIndex={0}>
        {columns.length === 0 ? (
          <p className="cmp-empty">{t('Pick a device to compare.', lang)}</p>
        ) : (
          <table className="cmp-table">
            <thead>
              <tr>
                <th scope="col" className="cmp-corner">{t('Node', lang)}</th>
                {columns.map((d, i) => {
                  const removeLabel = fillTemplate(t('Remove {name}', lang), { name: d.label });
                  return (
                    <th scope="col" key={d.key} className={`cmp-col${i === 0 ? ' cmp-col--ref' : ''}`}>
                      <span className="cmp-col__name" title={provenance(d, lang) || undefined}>
                        {d.mark && <span className="cmp-mark" aria-hidden="true">{d.mark}</span>}
                        {d.label}
                      </span>
                      <span className="cmp-col__kind">{t(KIND_TEXT[d.kind], lang)}</span>
                      <span className="cmp-col__actions">
                        {i === 0 ? (
                          <span className="cmp-ref">{t('reference', lang)}</span>
                        ) : (
                          <button
                            type="button"
                            className="cmp-mini"
                            title={t('Compare every other column with this one', lang)}
                            onClick={() => toReference(d.key)}
                          >
                            {t('Make reference', lang)}
                          </button>
                        )}
                        <button
                          type="button"
                          className="cmp-mini"
                          aria-label={removeLabel}
                          title={removeLabel}
                          onClick={() => toggle(d.key)}
                        >
                          ✕
                        </button>
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            {shown.map((s) => {
              const cat = CATEGORIES.find((c) => c.id === s.category);
              return (
                <tbody key={s.category}>
                  <tr className="cmp-group">
                    <th scope="rowgroup" colSpan={columns.length + 1}>
                      <span>{cat ? formatCategoryLabel(cat.label, cat.id, lang, true) : s.category}</span>
                    </th>
                  </tr>
                  {s.lines.map((line) => {
                    const note = line.row.note ? t(NOTE_TEXT[line.row.note], lang) : null;
                    return (
                      <tr key={line.row.type}>
                        <th scope="row" className="cmp-node" title={note ?? undefined}>
                          {formatNodeLabel(line.row.def.label, line.row.type, lang)}
                          {note && <span className="cmp-note-mark" aria-hidden="true">*</span>}
                          {note && <span className="cmp-sr">{note}</span>}
                        </th>
                        {line.values.map((v, i) => (
                          <td
                            key={columns[i].key}
                            className={`cmp-cell${i === 0 ? ' cmp-cell--ref' : ''}${v === 0 ? ' cmp-cell--zero' : ''}`}
                          >
                            <span className="cmp-val">{v === null ? '—' : <Points value={v} />}</span>
                            {i > 0 && (
                              <span className="cmp-delta-slot">
                                {line.deltas[i] !== 0 && <Delta value={line.deltas[i]} lang={lang} />}
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
        )}
        {columns.length > 0 && shown.length === 0 && (
          <p className="cmp-empty">
            {onlyDifferences && !query.trim()
              ? t('No node differs from the reference.', lang)
              : t('No node matches.', lang)}
          </p>
        )}
      </div>
      <TooltipLayer />
    </div>
  );
}
