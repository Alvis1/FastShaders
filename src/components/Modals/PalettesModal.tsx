import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { BUILTIN_PALETTES } from '@/registry/builtinPalettes';
import { swatchTitle } from '@/components/inputs/colorPickerModel';
import {
  MAX_COLORS_PER_PALETTE,
  MAX_COLOR_NAME,
  MAX_PALETTES_PER_SHADER,
  MAX_PALETTE_FILE_BYTES,
  MAX_PASTE_CHARS,
  collectGraphColors,
  emitGpl,
  emitPaletteJson,
  parseHexList,
  parsePaletteFile,
  type Palette,
  type PaletteParseResult,
} from '@/utils/palettes';
import {
  canAddColor,
  canAddPalette,
  importOutcome,
  nextPaletteColor,
  paletteExportFileName,
  planPaletteImport,
  refusePaletteFile,
  withColorAt,
  withColorInserted,
  withColorMoved,
  withColorNameAt,
  withColorRemoved,
  type ColorList,
  type ImportOutcome,
  type PaletteExportKind,
} from '@/utils/paletteUi';
import './CsvImportModal.css';
import './PalettesModal.css';

/**
 * Palette names that this dialog MINTS are canonical English, never `t()`-ed.
 * A palette name is DATA: it rides the shader, the `fs:graph` autosave and every
 * exported file, so translating it at creation time would bake the UI language
 * of whoever happened to create it into a shared file — the same rule that
 * keeps `data.label` and generated identifiers English.
 */
const PASTED_NAME = 'Pasted';
const GRAPH_NAME = 'Shader colours';
const EMPTY_NAME = 'New palette';
/** What a "New" with nothing to seed from starts on — see `handleNew`. */
const EMPTY_SEED = '#ffffff';

interface ImportReport {
  outcome: ImportOutcome;
  added: number;
  overflow: number;
  /** Parser notes (English, from utils/palettes) plus our own refusal message. */
  notes: string[];
}

/**
 * Browser download of a text file. Deliberately the SAME blob → anchor → revoke
 * shape as `engine/exportShader.ts`'s `downloadShader`, rather than a second
 * mechanism (no `showSaveFilePicker`, no data: URL): one download path in the
 * app means one set of behaviours to reason about across Safari, the Tauri
 * WKWebView and the desktop build.
 */
function downloadText(text: string, fileName: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Up/down chevrons as inline SVG, not "↑"/"↓": the app self-hosts a woff2
 *  SUBSET of Inter (offline constraint), so arrow code points are not
 *  guaranteed to be in the font — the same reason the toolbar's reload button
 *  draws its own glyph. */
function Chevron({ up }: { up: boolean }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d={up ? 'M6 3 11 9H1z' : 'M6 9 1 3h10z'} />
    </svg>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Manage the shader's colour palettes.
 *
 * WHY A DIALOG rather than growing the colour-picker popover: that popover only
 * renders on an Output channel that is both EXPOSED and UNWIRED, so on a
 * finished shader it is frequently not on screen at all — there would be no
 * reliable way to reach "import a palette" or "save the colours I am using".
 *
 * LAYOUT. Title, then ONE toolbar row of exactly three verbs — New / Import /
 * Export — then the lists. Everything that used to be explanatory prose is a
 * `title`, picked up by the app-wide TooltipLayer: a dialog you open to press
 * one button should not make you read three paragraphs first, and the
 * explanations are still there for whoever wants them.
 *
 * EVERY PALETTE IS ONE LINE. The swatch strip does not wrap — it scrolls
 * horizontally inside its own row — so a list of palettes stays a list you can
 * scan rather than a stack of blocks whose height depends on how many colours
 * each happens to hold. Detail (per-colour hexes, names, reordering, per-palette
 * export) lives in the row's expandable editor, which is the one place height is
 * allowed to vary.
 *
 * Open/closed is LOCAL state in the Toolbar (the `FeedbackModal` precedent),
 * not a store field: it is transient UI opened from exactly one place, and the
 * dialog portals itself to `document.body` so nothing about where the Toolbar
 * paints constrains it. The queue-in-the-store pattern (`CsvImportModal`,
 * `LimitModal`) exists because those dialogs are raised by non-UI code — a
 * drop handler, an import — and can stack; neither applies here.
 *
 * HISTORY. Every palette action is its own undo entry (the store snapshots
 * inline — see the slice), so a per-keystroke `updatePalette` would make one
 * undo entry PER CHARACTER TYPED. The editable fields therefore hold the
 * in-progress value in LOCAL state and commit exactly once, on blur/Enter:
 * `nameDraft` for palette renames, `labelDraft` for a colour's label, and
 * `colorDraft` for the colour inputs (whose `change` event fires continuously
 * while the OS picker is dragged). `flushDrafts` commits whatever is open when
 * the dialog closes by a route that skips blur.
 */
export function PalettesModal({ open, onClose }: Props) {
  const language = useAppStore((s) => s.language);
  const palettes = useAppStore((s) => s.shaderPalettes);
  const shaderName = useAppStore((s) => s.shaderName);
  const addPalette = useAppStore((s) => s.addPalette);
  const updatePalette = useAppStore((s) => s.updatePalette);
  const deletePalette = useAppStore((s) => s.deletePalette);
  const reorderPalette = useAppStore((s) => s.reorderPalette);

  const [nameDraft, setNameDraft] = useState<{ id: string; value: string } | null>(null);
  const [colorDraft, setColorDraft] = useState<{ id: string; index: number; hex: string } | null>(
    null,
  );
  const [labelDraft, setLabelDraft] = useState<{ id: string; index: number; value: string } | null>(
    null,
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  /** Colours currently used by the graph, sampled once per opening. */
  const [graphColors, setGraphColors] = useState<string[]>([]);

  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Mirrors so the Escape/close paths can commit an open draft without
  // re-binding their listeners on every keystroke.
  const nameDraftRef = useRef(nameDraft);
  nameDraftRef.current = nameDraft;
  const colorDraftRef = useRef(colorDraft);
  colorDraftRef.current = colorDraft;
  const labelDraftRef = useRef(labelDraft);
  labelDraftRef.current = labelDraft;

  const full = !canAddPalette(palettes.length);
  const fullTitle = t(
    'This shader already holds the maximum of {max} palettes — delete one first.',
    language,
  ).replace('{max}', () => String(MAX_PALETTES_PER_SHADER));

  /* ---- committing drafts ------------------------------------------------- */

  const commitName = useCallback(
    (draft: { id: string; value: string }) => {
      // One `updatePalette` for the whole rename — see the class comment.
      updatePalette(draft.id, { name: draft.value });
    },
    [updatePalette],
  );

  /**
   * Apply one colour-list edit. The edit is a FUNCTION of the palette's current
   * list, read imperatively — clicking a move/remove button first BLURS an open
   * colour input, whose commit has already rewritten the list by the time the
   * click lands, so an edit computed from the render's array would apply on top
   * of a stale copy and silently undo that colour pick.
   *
   * `names ?? []` is LOAD-BEARING, not defensive noise. An edit that leaves no
   * colour labelled returns a list with NO `names` key (see `makeList`), and
   * `updatePalette` reads an absent `names` as "keep the ones you have" — so
   * passing it through would re-apply the OLD, now-longer labels to the SHORTER
   * colour list and slide every tooltip onto the wrong swatch. An empty array
   * says "no labels" explicitly.
   */
  const editColors = useCallback(
    (id: string, edit: (list: ColorList) => ColorList) => {
      const current = useAppStore.getState().shaderPalettes.find((p) => p.id === id);
      if (!current) return;
      const next = edit(current);
      if (next === current) return; // identity return = no-op edit
      updatePalette(id, { colors: next.colors, names: next.names ?? [] });
    },
    [updatePalette],
  );

  const commitColor = useCallback(
    (draft: { id: string; index: number; hex: string }) => {
      editColors(draft.id, (list) => withColorAt(list, draft.index, draft.hex));
    },
    [editColors],
  );

  const commitLabel = useCallback(
    (draft: { id: string; index: number; value: string }) => {
      editColors(draft.id, (list) => withColorNameAt(list, draft.index, draft.value.trim()));
    },
    [editColors],
  );

  const flushDrafts = useCallback(() => {
    const nd = nameDraftRef.current;
    if (nd) commitName(nd);
    const cd = colorDraftRef.current;
    if (cd) commitColor(cd);
    const ld = labelDraftRef.current;
    if (ld) commitLabel(ld);
    setNameDraft(null);
    setColorDraft(null);
    setLabelDraft(null);
  }, [commitName, commitColor, commitLabel]);

  const requestClose = useCallback(() => {
    flushDrafts();
    onClose();
  }, [flushDrafts, onClose]);

  /* ---- open / close ------------------------------------------------------ */

  useEffect(() => {
    if (!open) return;
    // Fresh each opening: a stale import report from last time would read as a
    // confirmation of something that has not happened yet.
    setReport(null);
    setPasteText('');
    setNameDraft(null);
    setColorDraft(null);
    setLabelDraft(null);
    setExpandedId(null);
    // Read the graph imperatively, once. Subscribing to `nodes` would re-render
    // (and re-scan every node) on each graph edit behind the dialog; the graph
    // cannot change while it is up anyway.
    setGraphColors(collectGraphColors(useAppStore.getState().nodes));
    panelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const editable =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === 'Escape') {
        // Escape must not leak: `ContextMenu` listens for it on the BUBBLE
        // phase and `useDismiss` closes the toolbar popovers on it, so a
        // capture-phase stop here is what keeps one Escape from dismissing
        // three things at once.
        e.preventDefault();
        e.stopPropagation();
        // Inside an open rename, Escape means "abandon this rename", not
        // "close the dialog" — the smaller scope always wins.
        if (nameDraftRef.current || labelDraftRef.current) {
          setNameDraft(null);
          setLabelDraft(null);
          (el as HTMLInputElement | null)?.blur();
          return;
        }
        requestClose();
        return;
      }
      // Everything else is swallowed while the dialog is up, EXCEPT inside a
      // text field. The canvas binds its shortcuts on `window` (Delete, Ctrl+G,
      // Shift+A, Cmd+Z…) and skips only INPUT/TEXTAREA targets — so with focus
      // on the panel div, a keypress meant for this dialog would edit the graph
      // behind it. Capture phase, so it runs before the canvas's bubble
      // listener; Tab is left alone so focus can still move.
      if (!editable && e.key !== 'Tab') e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, requestClose]);

  /* ---- import ------------------------------------------------------------ */

  const applyParsed = useCallback(
    (parsed: PaletteParseResult, extraNotes: string[] = []) => {
      const plan = planPaletteImport(useAppStore.getState().shaderPalettes.length, parsed);
      // One `addPalette` per palette, so an import is undone one palette at a
      // time. `setShaderPalettes` would land it in a single step but bypasses
      // history entirely (it is the load/undo path), and an unrecordable import
      // is the worse trade.
      let added = 0;
      for (const p of plan.accept) {
        if (addPalette({ name: p.name, colors: p.colors, names: p.names })) added += 1;
      }
      const notes = [...extraNotes, ...plan.notes];
      setReport({
        outcome: importOutcome(added, plan.overflow, notes.length > 0),
        added,
        overflow: plan.overflow,
        notes,
      });
    },
    [addPalette],
  );

  const refuse = useCallback((note: string) => {
    setReport({ outcome: 'nothing', added: 0, overflow: 0, notes: [note] });
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      // THE GATE, and it runs before `file.text()` on purpose: decoding a
      // 500 MB file has already allocated a ~1 GB JS string, so a cap measured
      // on the decoded text is not a cap at all.
      const refusal = refusePaletteFile(file);
      if (refusal) {
        refuse(
          refusal === 'too-large'
            ? t('That file is too big for a palette (limit {kb} KB).', language).replace(
                '{kb}',
                () => String(Math.round(MAX_PALETTE_FILE_BYTES / 1024)),
              )
            : t('That file is empty.', language),
        );
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        refuse(t('That file could not be read.', language));
        return;
      }
      applyParsed(parsePaletteFile(text));
    },
    [applyParsed, language, refuse],
  );

  /**
   * The second import path, kept as a REAL FIELD rather than a document-level
   * `paste` listener.
   *
   * A listener would be the compact answer on desktop and would remove the only
   * import route that works on a tablet: there is no Ctrl/Cmd+V on a coarse
   * pointer, and `navigator.clipboard.readText()` is not available in Firefox.
   * The app supports iPad, so paste has to be somewhere a finger can reach it.
   * One line, so it costs the dialog ~28px instead of the three-row textarea,
   * a hint and a separate button it replaces — and one path means no guard
   * against hijacking a paste meant for the rename field.
   */
  const handlePaste = useCallback(() => {
    const parsed = parseHexList(pasteText, PASTED_NAME);
    if (!parsed) {
      refuse(t('No colours found in the pasted text.', language));
      return;
    }
    applyParsed({ palettes: [parsed], notes: [] });
    setPasteText('');
  }, [applyParsed, language, pasteText, refuse]);

  /* ---- new / export ------------------------------------------------------ */

  /**
   * "New" is ALWAYS available. It seeds from the colours the shader already
   * uses, and from a single white swatch when there are none — an empty graph
   * must still be able to start a palette, and a disabled button with a
   * tooltip explaining why is a worse answer than one that just works.
   */
  const handleNew = useCallback(() => {
    const seeded = graphColors.length > 0;
    addPalette({
      name: seeded ? GRAPH_NAME : EMPTY_NAME,
      colors: seeded ? graphColors : [EMPTY_SEED],
    });
  }, [addPalette, graphColors]);

  const exportOne = useCallback(
    (palette: Palette, kind: PaletteExportKind) => {
      const name = paletteExportFileName(shaderName, palette, kind);
      if (kind === 'gpl') {
        downloadText(emitGpl(palette), name, 'text/plain;charset=utf-8');
      } else {
        downloadText(emitPaletteJson([palette]), name, 'application/json');
      }
    },
    [shaderName],
  );

  const exportAll = useCallback(() => {
    // JSON only: a `.gpl` carries exactly ONE palette by construction, so
    // "export all" as GPL would have to be a zip or a silent pick of the first.
    downloadText(
      emitPaletteJson(palettes),
      paletteExportFileName(shaderName, null, 'json'),
      'application/json',
    );
  }, [palettes, shaderName]);

  if (!open) return null;

  /** One palette's swatches: ONE non-wrapping row that scrolls if it must. */
  const strip = (p: Palette) => (
    <div className="palettes-modal__strip">
      {p.colors.map((hex, i) => (
        // The key carries the index because a palette may legitimately repeat a
        // colour (a ramp that returns to its start).
        <span
          key={`${hex}-${i}`}
          className="palettes-modal__chip"
          // Only ever a value that came out of the sanitizer — every colour in
          // the store passed `normalizeHex`, so nothing user-typed reaches CSS.
          style={{ background: hex }}
          title={swatchTitle(hex, p.names?.[i])}
        />
      ))}
    </div>
  );

  return createPortal(
    <div className="csv-import-modal__backdrop" onClick={requestClose}>
      <div
        ref={panelRef}
        className="csv-import-modal__panel palettes-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="palettes-modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="csv-import-modal__title"
          id="palettes-modal-title"
          // The dialog's whole explanation, as a tooltip rather than a
          // paragraph — see the layout note in the class comment.
          title={t('Palettes belong to this shader: they are saved with it and travel inside the exported file. Duplicate a built-in one to get an editable copy, or import a palette file to share one between shaders.', language)}
        >
          {t('Palettes', language)}
        </div>

        {/* ── The three verbs ────────────────────────────────────────────── */}
        <div className="palettes-modal__toolbar">
          <button
            type="button"
            className="csv-import-modal__button"
            disabled={full}
            title={
              full
                ? fullTitle
                : graphColors.length > 0
                  ? t('New palette from the {n} colours this shader uses.', language).replace(
                      '{n}',
                      () => String(graphColors.length),
                    )
                  : t('New palette. This shader uses no colours yet, so it starts with one white swatch.', language)
            }
            onClick={handleNew}
          >
            {t('New', language)}
          </button>
          <button
            type="button"
            className="csv-import-modal__button"
            disabled={full}
            title={
              full
                ? fullTitle
                : t('Open a FastShaders palette .json or a GIMP .gpl file. To bring colours in as text instead, use the paste field below.', language)
            }
            onClick={() => fileRef.current?.click()}
          >
            {t('Import', language)}
          </button>
          <button
            type="button"
            className="csv-import-modal__button"
            disabled={palettes.length === 0}
            title={
              palettes.length === 0
                ? t('This shader has no palettes to export yet.', language)
                : t('Export every palette in this shader as one .json. Open a palette to export it on its own.', language)
            }
            onClick={exportAll}
          >
            {t('Export', language)}
          </button>
          <span className="palettes-modal__spacer" />
          <span className="palettes-modal__count" title={full ? fullTitle : undefined}>
            {palettes.length} / {MAX_PALETTES_PER_SHADER}
          </span>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".json,.gpl,application/json,text/plain"
          className="palettes-modal__file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Clear before the async work so picking the SAME file again
            // still fires a change event.
            e.target.value = '';
            if (file) void handleFile(file);
          }}
        />

        {/* One line, and the only paste route that works on a tablet. */}
        <div className="palettes-modal__paste">
          <input
            className="palettes-modal__paste-input"
            type="text"
            value={pasteText}
            maxLength={MAX_PASTE_CHARS}
            spellCheck={false}
            aria-label={t('Paste colours', language)}
            placeholder={t('…or paste colours: #264653 #2a9d8f, a CSS block, a coolors.co link', language)}
            onChange={(e) => setPasteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pasteText.trim() && !full) handlePaste();
            }}
          />
          <button
            type="button"
            className="palettes-modal__btn"
            disabled={full || pasteText.trim().length === 0}
            title={full ? fullTitle : t('Add the pasted colours as a new palette', language)}
            onClick={handlePaste}
          >
            {t('Add', language)}
          </button>
        </div>

        {report && (
          <div
            className={`palettes-modal__report${
              report.outcome === 'ok' ? '' : ' palettes-modal__report--warn'
            }`}
            role="status"
          >
            <div>
              {report.added > 0
                ? t('{n} palette(s) added.', language).replace('{n}', () => String(report.added))
                : t('Nothing was imported.', language)}
            </div>
            {report.overflow > 0 && (
              <div>
                {t('{n} more did not fit — this shader holds at most {max} palettes.', language)
                  .replace('{n}', () => String(report.overflow))
                  .replace('{max}', () => String(MAX_PALETTES_PER_SHADER))}
              </div>
            )}
            {report.notes.map((note, i) => (
              <div key={i}>{note}</div>
            ))}
          </div>
        )}

        {/* ── This shader's palettes ─────────────────────────────────────── */}
        {palettes.length === 0 ? (
          <div className="palettes-modal__empty">
            {t('No palettes in this shader yet. Press New, or duplicate a built-in one below.', language)}
          </div>
        ) : (
          <ul className="palettes-modal__list">
            {palettes.map((p, index) => {
              const editing = expandedId === p.id;
              return (
                <li key={p.id} className="palettes-modal__row">
                  <div className="palettes-modal__line">
                    <input
                      className="palettes-modal__name"
                      type="text"
                      // Rendered as TEXT through React's own escaping — a
                      // palette name is user/file data and must never be
                      // injected as markup.
                      value={nameDraft?.id === p.id ? nameDraft.value : p.name}
                      spellCheck={false}
                      aria-label={t('Palette name', language)}
                      title={t('Rename — press Enter or click away to save', language)}
                      onFocus={() => setNameDraft({ id: p.id, value: p.name })}
                      onChange={(e) => setNameDraft({ id: p.id, value: e.target.value })}
                      onBlur={() => {
                        // ONE store write for the whole rename. Committing per
                        // keystroke would push one undo entry per character.
                        if (nameDraft?.id === p.id) commitName(nameDraft);
                        setNameDraft(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                      }}
                    />
                    {strip(p)}
                    <div className="palettes-modal__actions">
                      <button
                        type="button"
                        className="palettes-modal__btn palettes-modal__btn--icon"
                        disabled={index === 0}
                        title={t('Move up', language)}
                        aria-label={t('Move up', language)}
                        onClick={() => reorderPalette(p.id, index - 1)}
                      >
                        <Chevron up />
                      </button>
                      <button
                        type="button"
                        className="palettes-modal__btn palettes-modal__btn--icon"
                        disabled={index === palettes.length - 1}
                        title={t('Move down', language)}
                        aria-label={t('Move down', language)}
                        onClick={() => reorderPalette(p.id, index + 1)}
                      >
                        <Chevron up={false} />
                      </button>
                      <button
                        type="button"
                        className="palettes-modal__btn"
                        aria-expanded={editing}
                        title={t('Edit the colours, rename them, and export this palette on its own', language)}
                        onClick={() => setExpandedId(editing ? null : p.id)}
                      >
                        {editing ? t('Done', language) : t('Edit', language)}
                      </button>
                      <button
                        type="button"
                        className="palettes-modal__btn palettes-modal__btn--icon palettes-modal__btn--danger"
                        // The qualifier is load-bearing: this modal's
                        // capture-phase key handler deliberately swallows
                        // non-Escape keys so canvas shortcuts cannot edit the
                        // graph behind the dialog, which includes Cmd+Z. The
                        // undo entry IS recorded (verified in a browser) -- it
                        // is simply not reachable until the dialog closes.
                        title={t('Delete this palette — undoable with Ctrl+Z / ⌘Z once this dialog is closed', language)}
                        aria-label={t('Delete', language)}
                        onClick={() => {
                          if (expandedId === p.id) setExpandedId(null);
                          deletePalette(p.id);
                        }}
                      >
                        {'×'}
                      </button>
                    </div>
                  </div>

                  {editing && (
                    <div className="palettes-modal__editor">
                      {p.colors.map((hex, i) => (
                        <div key={`${p.id}-${i}`} className="palettes-modal__color-row">
                          <input
                            className="palettes-modal__color"
                            type="color"
                            // The native picker fires `change` continuously
                            // while it is dragged — hold it locally and write
                            // once, on blur, or a single pick becomes dozens of
                            // undo entries.
                            value={
                              colorDraft?.id === p.id && colorDraft.index === i
                                ? colorDraft.hex
                                : hex
                            }
                            aria-label={t('Colour {n}', language).replace('{n}', () =>
                              String(i + 1),
                            )}
                            onChange={(e) =>
                              setColorDraft({ id: p.id, index: i, hex: e.target.value })
                            }
                            onBlur={() => {
                              if (colorDraft?.id === p.id && colorDraft.index === i) {
                                commitColor(colorDraft);
                              }
                              setColorDraft(null);
                            }}
                          />
                          <code className="palettes-modal__hex">
                            {colorDraft?.id === p.id && colorDraft.index === i
                              ? colorDraft.hex
                              : hex}
                          </code>
                          <input
                            className="palettes-modal__label"
                            type="text"
                            maxLength={MAX_COLOR_NAME}
                            spellCheck={false}
                            placeholder={t('name', language)}
                            value={
                              labelDraft?.id === p.id && labelDraft.index === i
                                ? labelDraft.value
                                : (p.names?.[i] ?? '')
                            }
                            aria-label={t('Colour name', language)}
                            title={t('Name this colour — it shows in the tooltip everywhere the swatch appears', language)}
                            onFocus={() =>
                              setLabelDraft({ id: p.id, index: i, value: p.names?.[i] ?? '' })
                            }
                            onChange={(e) =>
                              setLabelDraft({ id: p.id, index: i, value: e.target.value })
                            }
                            onBlur={() => {
                              if (labelDraft?.id === p.id && labelDraft.index === i) {
                                commitLabel(labelDraft);
                              }
                              setLabelDraft(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur();
                            }}
                          />
                          <button
                            type="button"
                            className="palettes-modal__btn palettes-modal__btn--icon"
                            disabled={i === 0}
                            title={t('Move up', language)}
                            aria-label={t('Move up', language)}
                            onClick={() => editColors(p.id, (c) => withColorMoved(c, i, i - 1))}
                          >
                            <Chevron up />
                          </button>
                          <button
                            type="button"
                            className="palettes-modal__btn palettes-modal__btn--icon"
                            disabled={i === p.colors.length - 1}
                            title={t('Move down', language)}
                            aria-label={t('Move down', language)}
                            onClick={() => editColors(p.id, (c) => withColorMoved(c, i, i + 1))}
                          >
                            <Chevron up={false} />
                          </button>
                          <button
                            type="button"
                            className="palettes-modal__btn palettes-modal__btn--icon palettes-modal__btn--danger"
                            // A palette with no colours is not a palette — the
                            // store refuses the write, so the control has to
                            // say so instead of doing nothing.
                            disabled={p.colors.length <= 1}
                            title={
                              p.colors.length <= 1
                                ? t('A palette needs at least one colour — delete the palette instead.', language)
                                : t('Remove this colour', language)
                            }
                            aria-label={t('Remove this colour', language)}
                            onClick={() => editColors(p.id, (c) => withColorRemoved(c, i))}
                          >
                            {'×'}
                          </button>
                        </div>
                      ))}
                      <div className="palettes-modal__editor-foot">
                        <button
                          type="button"
                          className="palettes-modal__btn"
                          disabled={!canAddColor(p.colors.length)}
                          title={
                            canAddColor(p.colors.length)
                              ? undefined
                              : t('A palette holds at most {max} colours.', language).replace(
                                  '{max}',
                                  () => String(MAX_COLORS_PER_PALETTE),
                                )
                          }
                          onClick={() =>
                            editColors(p.id, (c) =>
                              withColorInserted(c, c.colors.length, nextPaletteColor(c.colors)),
                            )
                          }
                        >
                          {t('Add colour', language)}
                        </button>
                        <span className="palettes-modal__spacer" />
                        <button
                          type="button"
                          className="palettes-modal__btn"
                          title={t('Export this palette as a FastShaders .json', language)}
                          onClick={() => exportOne(p, 'json')}
                        >
                          .json
                        </button>
                        <button
                          type="button"
                          className="palettes-modal__btn"
                          title={t('Export this palette as a GIMP .gpl — readable by GIMP, Krita, Inkscape, Aseprite and Blender', language)}
                          onClick={() => exportOne(p, 'gpl')}
                        >
                          .gpl
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* ── Built-in ───────────────────────────────────────────────────── */}
        <div className="palettes-modal__section">
          <div className="palettes-modal__section-head">
            <h3 className="palettes-modal__section-title">{t('Built-in', language)}</h3>
            <span
              className="palettes-modal__hint"
              title={t('These ship with the app and cannot be changed. Metals are F0 reflectances (use metalness 1), the surface and organic sets are albedos (metalness 0), and the emissive names carry the HDR multiplier to scale by. Hover any swatch for its name.', language)}
            >
              {t('Read-only — duplicate one to edit it.', language)}
            </span>
          </div>
          <ul className="palettes-modal__list palettes-modal__list--builtin">
            {BUILTIN_PALETTES.map((p) => (
              <li key={p.id} className="palettes-modal__row palettes-modal__row--builtin">
                <div className="palettes-modal__line">
                  <span className="palettes-modal__builtin-name" title={p.name}>
                    {p.name}
                  </span>
                  {strip(p)}
                  <div className="palettes-modal__actions">
                    <button
                      type="button"
                      className="palettes-modal__btn"
                      disabled={full}
                      title={
                        full
                          ? fullTitle
                          : t('Copy this palette into the shader, where you can edit it.', language)
                      }
                      onClick={() =>
                        addPalette({ name: p.name, colors: p.colors, names: p.names })
                      }
                    >
                      {t('Duplicate', language)}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="csv-import-modal__buttons">
          <button type="button" className="csv-import-modal__button" onClick={requestClose}>
            {t('Close', language)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
