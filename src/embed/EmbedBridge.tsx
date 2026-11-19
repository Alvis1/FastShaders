/**
 * The SuperWXR embed bridge (embed/embedMode.ts decides when it mounts).
 *
 * Messages, all with `type: 'superwxr:*'`, posted to and accepted from the
 * PARENT window at the page's own origin only:
 *
 *   in   { type: 'superwxr:open', module: string, name?: string, id?: string }
 *        — open a shader .js export (a FASTSHADERS_PROJECT_V1 block restores the
 *          graph; a bare module is parsed back), the "Load Script…" path: no
 *          Open/Add dialog. `id` is the host's own name for that document. The
 *          open starts a FRESH undo history (3): an undo never reaches the
 *          document the editor held before, which it would post as this one.
 *          A block is the document as soon as its import returns. A BARE
 *          module only once its own code→graph pass has LANDED and written
 *          its graph (3): until then the canvas holds the previous document's
 *          graph under the new name, it is NO document's (id null: a file
 *          opened inside the editor meanwhile says `replaced: null`), and
 *          nothing is posted under either id. A bare module whose conversion
 *          would LOSE code — code at module scope, which only the default
 *          function's body escapes (scriptToTSL's `dropped`) — is refused
 *          before anything is written: its graph would go back as this file
 *          without the constant or function its code reads. An open that does
 *          not become the document says so (open-failed).
 *   in   { type: 'superwxr:rename', name: string, id?: string }            (3)
 *        — the host renamed the document the editor holds. The name is cleaned
 *          like an opened file's (empty: ignored; at most 120 characters, as an
 *          opened block's own name is); an `id` naming another document than
 *          the one the editor holds is ignored, and a message without one
 *          renames whatever it holds.
 *   in   { type: 'superwxr:appearance', theme?: 'dark' | 'light',
 *          canvasOpacity?: number }                                        (3)
 *        — the host's look. Each field is optional and applied on its own;
 *          anything else is ignored. `theme` is the app-wide theme, and from
 *          then on no document changes it: a host open applies none of the
 *          document's own `ui` block, and a file opened INSIDE the editor gets
 *          the host's theme back. `canvasOpacity` (0–1) is how much of the
 *          canvas backdrop covers the host's view, which the page lets show
 *          through (embed/embedLook.ts); opaque until the host sends it.
 *   out  { type: 'superwxr:ready', protocol: 3 }
 *        — posted once the bridge listens.
 *   out  { type: 'superwxr:module', module: string, name: string, id, replaced? }
 *        — the settled EXPORT module (images inlined, project block appended):
 *          what the EXPORT button would write, whenever the graph, the module
 *          settings or the name changed, trailing-debounced like the preview,
 *          and never while a code→graph pass is on its way (the module would
 *          carry the code with the graph before it). For a document the HOST
 *          opened, the block carries that document's own `ui` and `preview`
 *          blocks exactly as they arrived (no key where it had none, as a bare
 *          module never has): the embed has no preview pane to change one,
 *          and the store's would carry the host's theme and what other
 *          documents (or a full FastShaders tab at this origin) left in the
 *          shared preview settings. So a mere open of a module FastShaders
 *          wrote posts nothing back, whatever the look. (What every open
 *          restores still normalises: a graph an older FastShaders wrote, a
 *          name over 120 characters, a device this browser does not have.)
 *   out  { type: 'superwxr:export', kind, fileName, mime, bytes, id }
 *        — what downloadShader would have downloaded (exportShader.ts).
 *   out  { type: 'superwxr:open-failed', id, reason, retry }              (3)
 *        — a host open that did NOT become the document, posted for every
 *          one: `id` is that OPEN's (null when it sent none), `reason` one
 *          plain line, at most 200 characters, never markup (embedDocument.ts
 *          `openFailedReason`), and `retry` whether the same bytes may open
 *          another time: true when the failure said nothing about the file
 *          (converter chunks not fetched within CHUNK_WAIT_MS, its graph not
 *          ready within PASS_WAIT_MS, another file opened inside the editor
 *          first), false when the file itself cannot be opened (a host keeps
 *          those bytes out until they change). An open with no module text,
 *          an import that threw (a corrupt block, a bare module refused for
 *          the code it would lose) or converter chunks that could not be
 *          fetched leave the document the editor held: its id, graph and name
 *          (a block's import reads the whole block before it writes, and the
 *          name and device one wrote before it threw are put back). A bare
 *          module whose pass wrote no graph — blocking parse errors (the first
 *          one is the reason, without its position, which counts lines of the
 *          CONVERTED module), direct material assignments, a pass that threw,
 *          none landed within PASS_WAIT_MS — leaves the previous graph on the
 *          canvas as NOBODY's: id null from its import on, the boot graph's
 *          rule, so a host files none of it. One whose pass was dropped
 *          because a file was opened inside the editor meanwhile leaves that
 *          file the document, under the id minted for it (`replaced: null`).
 *
 * Protocol 3 adds, over 2: appearance and rename, the transparent page, the
 * fresh history of a host open, the host's theme kept, the document's own
 * `ui` and `preview` blocks sent back, the order below, a bare module that is
 * the document only once its graph landed, and open-failed (with `retry`). 2
 * named the document in every message; 1 named nothing.
 *
 * Host messages are handled in ARRIVAL order, through one promise chain: a
 * bare module's open waits for the converter chunks (CHUNK_WAIT_MS at most; a
 * block needs neither), and a rename sent right after it renames the document
 * that open made (out of order, its id check would drop it). An open also
 * waits, in its turn, for a code→graph pass already on its way to land — a
 * bare module's graph is parsed in by the sync engine AFTER its open's turn,
 * and the previous open's, or one opened inside the editor, would otherwise
 * land on this document (the store's `documentEpoch` drops such a pass
 * anyway, should it outlast PASS_WAIT_MS) — and then posts an edit of the
 * document it replaces that is still settling, under that document's id. A
 * bare module's open keeps its turn until its own pass
 * landed and it was decided whose the graph is (PASS_WAIT_MS at most), so a
 * rename behind it finds the id that decision left. An open's synchronous
 * part runs at arrival: it cancels the mount-time broadcast, and nothing
 * else. A message that throws is logged and the next one still runs.
 * Appearance applies at once: it records the host's look, which an open still
 * waiting in the chain reads when its import runs.
 *
 * Every outgoing message names the document it is about (embedDocument.ts):
 * `id` is the id of the open the graph came from; for a file opened INSIDE the
 * editor it is an id minted here, with `replaced` naming the document it took
 * the place of (null when that was no document); for the graph the editor
 * started with, and for the graph a bare module's open leaves on the canvas
 * until its own landed (and for good when it failed), it is null. A host files
 * a module by that id, never by what is selected when the message arrives.
 * (open-failed names the open, which never became a document.)
 *
 * The host's document is the ONLY copy: embedded, the editor neither reads nor
 * writes its own stored graph, name, viewport or model (store/useAppStore.ts,
 * utils/viewportMemory.ts), so it starts from the built-in graph every time
 * and a full FastShaders tab at the same origin keeps its own work. The theme
 * is a preference and stays shared: appearance writes `fs:codeEditorTheme`.
 *
 * The see-through page needs the host's iframe ELEMENT in the color-scheme of
 * the theme it sends: a browser gives a framed document whose color-scheme
 * differs from its frame's an opaque backdrop (CSS Color Adjust, "used color
 * scheme"), and the host's view stops showing through.
 *
 * Never in a study session: the bridge is a second way to change the graph.
 */
import { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { buildExportModule, buildProjectState, EXPORT_ERROR_PREFIX } from '@/engine/exportShader';
import { embedProjectState, extractProjectState, type FastShadersProject } from '@/engine/fastShadersProject';
import { importShaderText, preloadShaderImport, SHADER_CONVERTER_MISSING } from '@/engine/projectImport';
import { moduleSettingsOutput } from '@/utils/outputMaterials';
import { sanitizeDroppedName } from '@/utils/shaderDropName';
import type { AppNode, OutputNodeData } from '@/types';
import { embedTargetOrigin } from './embedMode';
import {
  EMBED_PROTOCOL,
  embedDocument,
  embedDocumentFields,
  embedDocumentOpened,
  embedDocumentReplaced,
  embedModuleKey,
  hostDocumentId,
  openFailedReason,
} from './embedDocument';
import { EMBED_CANVAS_ALPHA_VAR, embedCanvasAlpha, hostTheme } from './embedLook';

/** The preview's own settle delay (PREVIEW_REBUILD_DEBOUNCE_MS) plus a margin. */
const SETTLE_MS = 300;

/**
 * The longest an open waits for a code→graph pass — one already on its way
 * when its turn comes, and a bare module's own: the first one of a page
 * fetches the parser chunk, which a slow device (a headset, Safari without
 * JIT) can take seconds over. Past it an open goes ahead of a pass still on
 * its way, which then writes nothing (the store's `documentEpoch`); a bare
 * module whose own pass has not landed by then is a failed open.
 */
const PASS_WAIT_MS = 5000;

/**
 * The longest a bare module's open waits for the converter chunks. A fetch
 * that never settles held every later open and rename for good (the chain
 * waits on it) and told the host nothing; past this the open fails, with
 * `retry` — the chunks may still come, and a later open finds them.
 */
const CHUNK_WAIT_MS = 20000;

/**
 * Why a host-opened bare module did not become the document, where the sync
 * engine's outcome (the store's `codeSyncOutcome`) gives none of its own.
 */
const REPLACED_INSIDE = 'another file was opened in the editor before its graph was ready';
const NOT_READY = `its graph was not ready after ${PASS_WAIT_MS / 1000} s`;
const NO_OUTCOME = 'it could not be turned into a graph';
/** An open whose `module` is empty or no string: nothing to open at all. */
const NO_MODULE = 'there was no shader module to open';

/** Every field a host message may carry; each is checked where it is read. */
interface HostMessage {
  type?: unknown;
  module?: unknown;
  name?: unknown;
  id?: unknown;
  theme?: unknown;
  canvasOpacity?: unknown;
}

type EditorTheme = 'vs' | 'vs-dark';
type ParsedProject = NonNullable<ReturnType<typeof extractProjectState>>;

function post(message: Record<string, unknown>): void {
  window.parent.postMessage(message, embedTargetOrigin());
}

/**
 * A name a dropped file would get: the stem, its control characters gone,
 * trimmed, bounded (utils/shaderDropName.ts, 120 characters — what an opened
 * block's own name is bounded to, so the rename a host sends after an open
 * leaves a name that fits as it was). An opened file's name and a rename both
 * pass here.
 */
function nameOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return sanitizeDroppedName(raw.replace(/\.(m?js|zip)$/i, ''));
}

/** The parsed project with an EMPTY `ui` block: its theme, canvas and cost colours are not applied. */
function withoutLook(parsed: ParsedProject): ParsedProject {
  return { ...parsed, project: { ...parsed.project, ui: {} } };
}

/**
 * One block of the project put back as the opened document carried it: the
 * key assigned in place (buildProjectState's order kept), or deleted when the
 * document carried none.
 */
function carry<K extends 'ui' | 'preview'>(project: FastShadersProject, key: K, value: FastShadersProject[K] | undefined): void {
  if (value === undefined) delete (project as Partial<FastShadersProject>)[key];
  else project[key] = value;
}

/**
 * Whether both chunks a bare module's conversion takes are here: the
 * converter (the import's, scriptToTSL) and the code→graph parser (the sync
 * engine's pass). False when either cannot be fetched, or both are not here
 * within CHUNK_WAIT_MS. A block needs neither, and does not wait for them.
 */
async function convertersLoaded(): Promise<boolean> {
  const both = Promise.all([
    preloadShaderImport(),
    import('@/engine/codeToGraph').then(() => true, () => false),
  ]).then(([converter, parser]) => converter !== null && parser);
  let cap: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    cap = setTimeout(() => resolve(false), CHUNK_WAIT_MS);
  });
  try {
    return await Promise.race([both, late]);
  } finally {
    clearTimeout(cap);
  }
}

export function EmbedBridge() {
  useEffect(() => {
    // What the host holds: the document and text last posted OR last opened
    // (embedModuleKey). One slot, so an edit away from an opened module and
    // back to it is posted again.
    let lastPosted = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Whether `timer` is the mount-time broadcast (below), which an open
    // supersedes. Any other is an edit's, of the document the editor holds,
    // which an open posts before it replaces that document (`flush`).
    let timerIsMount = false;
    // True only inside this bridge's own import: its `fs:graph-imported` is the
    // host's document arriving, not one replacing it.
    let opening = false;
    // True while a host open waits for its bare module's graph and decides
    // whose the graph on the canvas is (`bareLanded`): nothing is posted then,
    // under the document's id it replaces or its own.
    let deciding = false;
    // The theme the host gave (`superwxr:appearance`), kept from then on. Null
    // until it gives one; until then a document's own look applies, as it
    // does in a full FastShaders.
    let hostLook: EditorTheme | null = null;
    // While the graph is a document the HOST opened: that document's own `ui`
    // and `preview` blocks, exactly as they arrived (undefined where it
    // carried none, as a bare module never does). Null for the boot graph and
    // for a document replaced inside the editor, whose module carries the
    // store's look and the stored preview settings as EXPORT writes them.
    let opened: { ui: FastShadersProject['ui'] | undefined; preview: FastShadersProject['preview'] | undefined } | null = null;
    // Host messages in arrival order (the header): each waits for the one
    // before it, and one that throws does not stop the next.
    let turn: Promise<void> = Promise.resolve();
    const inTurn = (task: () => void | Promise<void>) => {
      turn = turn.then(task).catch((err: unknown) => {
        console.error('[FastShaders embed] message failed', err);
      });
    };

    // A code→graph pass asked for or on its way (a bare module's conversion):
    // the graph is not yet what the code says. Read from a timer or a turn,
    // never inside a store notification (passesLanded says why).
    const passPending = () => {
      const s = useAppStore.getState();
      return s.codeSyncRequested || s.syncInProgress;
    };
    /**
     * Resolves once no code→graph pass is pending, or after PASS_WAIT_MS.
     * Checked a microtask after each store write, never inside it: the sync
     * engine takes a request and arms `syncInProgress` in one synchronous run,
     * and between those two writes it reads as idle.
     */
    const passesLanded = (): Promise<void> => {
      if (!passPending()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(cap);
          stop();
          resolve();
        };
        const stop = useAppStore.subscribe(() => {
          queueMicrotask(() => {
            if (!passPending()) finish();
          });
        });
        const cap = setTimeout(finish, PASS_WAIT_MS);
      });
    };

    const broadcast = () => {
      timer = null;
      // Not while a pass is on its way: the module would carry the code with
      // the graph BEFORE it — for a bare module just opened, the previous
      // document's graph under this one's id. Nor while an open decides whose
      // the graph is, from the moment its pass lands to the id it then takes
      // (`deciding`). Asked again once it landed.
      if (passPending() || deciding) {
        timer = setTimeout(broadcast, SETTLE_MS);
        return;
      }
      const module = buildExportModule({ inlineImages: true });
      if (module.startsWith(EXPORT_ERROR_PREFIX)) return;
      const project = buildProjectState();
      // A host-opened document goes back in its OWN look and preview settings,
      // never the store's (the host's theme, once it sent one) or what another
      // document left in the shared preview keys: a mere open then posts
      // exactly the text it opened, which the dedupe below swallows.
      if (opened) {
        carry(project, 'ui', opened.ui);
        carry(project, 'preview', opened.preview);
      }
      const text = embedProjectState(module, project);
      const key = embedModuleKey(text);
      if (key === lastPosted) return;
      lastPosted = key;
      post({ type: 'superwxr:module', module: text, name: useAppStore.getState().shaderName, ...embedDocumentFields() });
    };
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(broadcast, SETTLE_MS);
      timerIsMount = false;
    };
    /** An edit still settling, posted NOW: before an open replaces the document it is of. */
    const flush = () => {
      if (timer === null) return;
      clearTimeout(timer);
      broadcast();
    };

    // The store notifies once per drag frame, so the question "did anything the
    // module depends on change?" must cost nothing on the frames where nothing
    // did: three references, and the Output node's settings OBJECT by reference
    // when the nodes array moved (a drag replaces the array and the moved
    // cards, never a card's data). No string is built here; `broadcast` dedupes
    // the module text itself.
    const settingsOf = (nodes: AppNode[]) => (moduleSettingsOutput(nodes)?.data as OutputNodeData | undefined)?.materialSettings;
    const initial = useAppStore.getState();
    let last = { previewCode: initial.previewCode, shaderName: initial.shaderName, nodes: initial.nodes, settings: settingsOf(initial.nodes) };
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.previewCode === last.previewCode && state.shaderName === last.shaderName && state.nodes === last.nodes) return;
      const settings = state.nodes === last.nodes ? last.settings : settingsOf(state.nodes);
      const changed = state.previewCode !== last.previewCode || state.shaderName !== last.shaderName || settings !== last.settings;
      last = { previewCode: state.previewCode, shaderName: state.shaderName, nodes: state.nodes, settings };
      if (!changed) return;
      schedule();
    });

    /** The store's theme, written only when it differs (a switch is a preference write and a recolour). */
    const keepTheme = (theme: EditorTheme) => {
      const store = useAppStore.getState();
      if (store.codeEditorTheme !== theme) store.setCodeEditorTheme(theme);
    };

    // A file opened inside the editor (a dropped shader's Open, IMPORT, a
    // shader stored in a dropped model) or NEW: another document, no longer
    // the one the host opened. Both events are dispatched synchronously by the
    // path that replaces the graph. The boot seed's own `fs:graph-imported`
    // (App.tsx) never reaches this listener: it fires in the first commit's
    // mount effect, and this chunk is lazy, so it mounts in a later one.
    const onReplaced = () => {
      if (opening) return;
      embedDocumentReplaced();
      opened = null;
      // Such a file applied its OWN look (applyProjectToStore does, before it
      // announces): the host's theme goes back, here, in the same dispatch.
      if (hostLook !== null) keepTheme(hostLook);
      schedule();
    };
    window.addEventListener('fs:graph-imported', onReplaced);
    window.addEventListener('fs:graph-new', onReplaced);

    /**
     * A host open that did not become the document: the host is told, and why
     * (the header) — and whether those bytes may open another time (`retry`).
     * An expected outcome, so a warning (with the cause as it came: a parse
     * error's position, a throw's stack), never an error.
     */
    const openFailed = (id: string | null, cause: unknown, retry: boolean) => {
      console.warn('[FastShaders embed] open failed:', cause);
      post({ type: 'superwxr:open-failed', id, reason: openFailedReason(cause), retry });
    };

    /**
     * A host-opened BARE module, its import just returned: whether it becomes
     * the document. Its graph is the sync engine's code→graph pass, asked for
     * by the import and landing after it; until then the canvas holds the
     * previous document's graph under this file's name and settings, which is
     * NO document's (id null). So it is waited for (PASS_WAIT_MS at most) with
     * nothing posted (`deciding`), and only a pass asked for under this
     * import's `documentEpoch` that WROTE its graph (the store's
     * `codeSyncOutcome`: blocking parse errors write none) makes the file the
     * document. Anything else is a failed open, told to the host here.
     */
    const bareLanded = async (id: string | null): Promise<boolean> => {
      // The count this open's import wrote, read before the first await: its
      // pass was asked for under it.
      const epoch = useAppStore.getState().documentEpoch;
      // From the import on, the graph is neither the document it replaced nor
      // this file yet: nobody's — the boot graph's rule (id null, the store's
      // look and preview settings). A file opened inside the editor before
      // the decision replaced no document of the host's (`replaced: null`,
      // measured: naming the previous one, its module was dropped by a host
      // that had just been told this open failed).
      embedDocumentOpened(null);
      opened = null;
      deciding = true;
      try {
        await passesLanded();
        const { documentEpoch, codeSyncOutcome: outcome } = useAppStore.getState();
        // Replaced inside the editor meanwhile (a dropped file's Open, IMPORT,
        // NEW): that file is the document, under the id `onReplaced` minted
        // for it, and the replacement dropped this one's pass.
        if (documentEpoch !== epoch) {
          openFailed(id, REPLACED_INSIDE, true);
          return false;
        }
        if (outcome?.epoch === epoch && outcome.ok) return true;
        // No graph of this file was written: the canvas shows the previous
        // document's, this file's name and settings over it, and it stays
        // nobody's, so no host document is posted that graph. A parse that
        // failed is the file's; one not ready yet says nothing about it.
        const failed = outcome?.epoch === epoch && !outcome.ok ? outcome : null;
        openFailed(id, failed ? failed.error : passPending() ? NOT_READY : NO_OUTCOME, failed ? failed.retry : true);
        return false;
      } finally {
        deciding = false;
      }
    };

    /**
     * `superwxr:open`, its turn come: `parsed` its project block (null: a bare
     * module), and for a bare module whether both converter chunks are here
     * (`converts`). The import is synchronous; a block is the document once it
     * returns, a bare module once its graph landed (`bareLanded`). An open
     * that does not become the document tells the host (`openFailed`).
     */
    const open = async (text: string, parsed: ParsedProject | null, nameFallback: string, id: string | null, converts: boolean): Promise<void> => {
      // A bare module without its converters would leave the previous
      // document's graph under this one's name and id — which the next post
      // would then send the host AS this document. A failed open instead,
      // before anything is written; the chunks may come another time.
      if (!parsed && !converts) {
        openFailed(id, SHADER_CONVERTER_MISSING, true);
        return;
      }
      // The state before the import: what it writes ahead of the graph — the
      // name (a block's, a bare module's fallback) and a block's device — is
      // put back should it throw. The graph is still the document it was,
      // and its next post would carry them (renaming it after this file).
      const before = useAppStore.getState();
      opening = true;
      try {
        importShaderText(text, {
          nameFallback,
          // Once the host has a theme, a document applies none of its own look.
          parsed: hostLook !== null && parsed ? withoutLook(parsed) : parsed,
          // Past and future emptied on success, a bare module's later
          // code→graph pass included (projectImport.ts).
          freshHistory: true,
          // A bare module whose conversion would lose code is refused, before
          // anything is written: its graph would go back to the host as this
          // file (measured: without the `const` its function read).
          refuseDroppedCode: true,
        });
      } catch (err) {
        // The host first: whatever the putting back below does, it knows. A
        // throw is the file's (a corrupt block, code a graph cannot hold): the
        // same bytes fail the same way.
        openFailed(id, err, false);
        const store = useAppStore.getState();
        if (store.shaderName !== before.shaderName) store.setShaderName(before.shaderName);
        if (store.selectedHeadsetId !== before.selectedHeadsetId) store.setSelectedHeadsetId(before.selectedHeadsetId);
        return;
      } finally {
        opening = false;
      }
      // A bare module: not before its own graph landed.
      if (!parsed && !(await bareLanded(id))) return;
      // Only now, and only on success: an open that failed leaves the graph
      // the document it was (or nobody's), and its edits must keep saying so.
      embedDocumentOpened(id);
      lastPosted = embedModuleKey(text);
      opened = { ui: parsed?.project.ui, preview: parsed?.project.preview };
    };

    /** `superwxr:rename`, its turn come: after every open the host sent before it. */
    const rename = (name: string, id: string | null) => {
      // An id the editor no longer holds (the host's, or one minted here)
      // names a document this rename cannot reach.
      if (id !== null && id !== embedDocument().id) return;
      const store = useAppStore.getState();
      // Embedded, setShaderName writes no storage (DOCUMENT_STORED); the
      // subscription above posts the module, the new name in its block too.
      if (store.shaderName !== name) store.setShaderName(name);
    };

    /** `superwxr:appearance`, at once: each field on its own, anything else ignored. */
    const appearance = (data: HostMessage) => {
      const theme = hostTheme(data.theme);
      if (theme !== null) {
        hostLook = theme;
        keepTheme(theme);
      }
      const alpha = embedCanvasAlpha(data.canvasOpacity);
      if (alpha !== null) document.documentElement.style.setProperty(EMBED_CANVAS_ALPHA_VAR, alpha);
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== embedTargetOrigin()) return;
      const data = e.data as HostMessage | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'superwxr:open') {
        const id = hostDocumentId(data.id);
        // Nothing to open: the editor keeps what it holds — the mount-time
        // broadcast included — and the host is told, in its turn.
        if (typeof data.module !== 'string' || data.module.length === 0) {
          inTurn(() => openFailed(id, NO_MODULE, false));
          return;
        }
        const text = data.module;
        const nameFallback = nameOf(data.name);
        // An open supersedes the mount-time broadcast below: the import's own
        // settle broadcasts. At arrival, never in its turn — and only that
        // one: an edit's is the document's the editor holds, posted below.
        if (timer !== null && timerIsMount) {
          clearTimeout(timer);
          timer = null;
        }
        inTurn(async () => {
          let parsed: ParsedProject | null;
          try {
            parsed = extractProjectState(text);
          } catch (err) {
            openFailed(id, err, false);
            return;
          }
          // A block is restored from its own JSON and needs no converter; a
          // bare module waits for both chunks, CHUNK_WAIT_MS at most.
          const converts = parsed !== null || (await convertersLoaded());
          // A pass already on its way (the previous open's bare module, one
          // opened inside the editor) lands on the document it was asked for…
          await passesLanded();
          // …and an edit of that document still settling goes to the host
          // under ITS id, before this open replaces it. A bare module's open
          // keeps the turn until its own graph landed (`bareLanded`).
          flush();
          await open(text, parsed, nameFallback, id, converts);
        });
      } else if (data.type === 'superwxr:rename') {
        const name = nameOf(data.name);
        if (!name) return;
        const id = hostDocumentId(data.id);
        inTurn(() => rename(name, id));
      } else if (data.type === 'superwxr:appearance') {
        appearance(data);
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'superwxr:ready', protocol: EMBED_PROTOCOL });
    // A lazy chunk comes up AFTER the first settle, so nothing would change the
    // store again on a host that just shows what the editor holds: tell it, at
    // the same trailing delay — unless an open arrives first (above).
    timer = setTimeout(broadcast, SETTLE_MS);
    timerIsMount = true;
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('fs:graph-imported', onReplaced);
      window.removeEventListener('fs:graph-new', onReplaced);
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return null;
}
