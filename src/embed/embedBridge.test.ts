/**
 * The SuperWXR embed bridge (embed/EmbedBridge.tsx) is a second way to change
 * the graph and a second way out for EXPORT, so the shape that keeps it safe is
 * pinned here, on the source:
 *
 *   - the switch (embed/embedMode.ts) is a LEAF sampled once, and never true
 *     without a window — every node suite runs an un-embedded app;
 *   - App.tsx mounts the bridge only behind that switch AND outside a study,
 *     as a lazy chunk: an ordinary boot never imports it (bootWave.test.ts
 *     walks the static graph; this pins the reason the edge is dynamic);
 *   - the bridge answers the PARENT window at the page's own origin only;
 *   - exportShader.ts hands EXPORT's bytes to the host at that origin instead
 *     of the download folder, and only when embedded;
 *   - every message names its document (embedDocument.ts has the rules and
 *     their own suite), and the id moves only where the document does;
 *   - embedded, the stored document — graph, name, viewport, model — is
 *     neither read nor written: the host's copy is the only one;
 *   - protocol 3: host messages in arrival order, an open waiting for a
 *     code→graph pass on its way and posting an edit still settling first,
 *     the host's look kept (embedLook.ts has its rules and suite), a
 *     host-opened document posted back in its own `ui` and `preview` blocks,
 *     a fresh undo history per host open (driven through the real import in
 *     embedHostOpen.test.ts), the rename, a bare module that is the document
 *     only once its own code→graph pass landed and wrote its graph (the sync
 *     engine's `codeSyncOutcome`) — and nobody's until then — or is refused
 *     for the code its conversion would lose, an import's pass that carries
 *     nothing of the graph it replaces, and `superwxr:open-failed` (with
 *     `retry`) for every host open that is not the document.
 *     embedBridgeMounted.test.ts mounts the bridge with the sync engine and
 *     drives all of it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isEmbedMode, EMBED_PARAM } from './embedMode';
import { MAX_DROPPED_NAME_LENGTH, sanitizeDroppedName } from '@/utils/shaderDropName';

const read =(rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** One of the effect's own functions (`const open = …` up to its `};` at the effect's indent). */
const fn = (src: string, decl: string): string => {
  const at = src.indexOf(`    const ${decl} = `);
  if (at < 0) throw new Error(`EmbedBridge.tsx has no \`const ${decl}\``);
  const end = src.indexOf('\n    };', at);
  return src.slice(at, end + '\n    };'.length);
};

describe('embed mode', () => {
  it('is never on without a window, and the switch module is a leaf', () => {
    expect(isEmbedMode()).toBe(false);
    expect(EMBED_PARAM).toBe('embed');
    const src = read('./embedMode.ts');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).toMatch(/window\.parent !== window/);
  });

  it('App.tsx mounts the bridge lazily, behind the switch and outside a study', () => {
    const app = read('../App.tsx');
    expect(app).not.toMatch(/from '\.\/embed\/EmbedBridge'/);
    expect(app).toMatch(/import\('\.\/embed\/EmbedBridge'\)/);
    expect(app).toMatch(/isEmbedMode\(\) && !isEvalMode\(\) && \(/);
  });

  it('embedded, only the canvas pane mounts: no toolbar, no preview, no code pane, no intro', () => {
    const layout = read('../components/Layout/AppLayout.tsx');
    expect(layout).toMatch(/isEmbedMode\(\) \? <EmbeddedLayout \/> : <FullLayout \/>/);
    const embedded = layout.match(/function EmbeddedLayout\(\) \{[\s\S]*?\n\}/)![0];
    expect(embedded).toMatch(/CANVAS_PANE/);
    expect(embedded).not.toMatch(/TOOLBAR|PREVIEW_PANE|CODE_PANE/);
    expect(read('../App.tsx')).toMatch(/introVia && !desktopBooting && !isEmbedMode\(\) && \(/);
  });

  it('the bridge accepts messages from the parent at its own origin only', () => {
    const bridge = read('./EmbedBridge.tsx');
    expect(bridge).toMatch(/e\.source !== window\.parent \|\| e\.origin !== embedTargetOrigin\(\)/);
    expect(bridge).toMatch(/typeof data\.module !== 'string'/);
    expect(bridge).toMatch(/window\.parent\.postMessage\(message, embedTargetOrigin\(\)\)/);
  });

  it('dedupes on ONE slot, the text the host holds, so editing back to an opened module still posts it', () => {
    const bridge = read('./EmbedBridge.tsx');
    // A second "last opened" slot suppressed X after open X → edit to Y → undo
    // to X, leaving the host on Y.
    expect(bridge).not.toMatch(/lastOpened/);
    expect(bridge).toMatch(/const key = embedModuleKey\(text\);\s*if \(key === lastPosted\) return;\s*lastPosted = key;/);
    // The open (in its turn, below) takes the slot for the text it opened.
    expect(fn(bridge, 'open')).toMatch(/lastPosted = embedModuleKey\(text\);/);
  });

  it('every message names its document, and says which protocol it speaks', () => {
    const bridge = read('./EmbedBridge.tsx');
    expect(bridge).toMatch(/post\(\{ type: 'superwxr:ready', protocol: EMBED_PROTOCOL \}\)/);
    expect(bridge).toMatch(/type: 'superwxr:module', module: text, name: [^}]*\.\.\.embedDocumentFields\(\) \}/);
    expect(read('../engine/exportShader.ts')).toMatch(/type: 'superwxr:export',[^}]*id: embedDocument\(\)\.id \}/);
  });

  it('the graph becomes the host\'s document only once its open succeeded', () => {
    const bridge = read('./EmbedBridge.tsx');
    const open = fn(bridge, 'open');
    // A throwing open (a corrupt project block) leaves the OLD document in the
    // editor: taking the new id first would send that document's edits to the
    // shader the host asked for. Nothing the open adopts — the id, the text
    // the host holds, the document's own look — is inside the `try`: all of
    // it comes after the import returned, and for a bare module after its
    // graph landed (`bareLanded`, the next suite).
    const tryBody = open.slice(open.indexOf('try {'), open.indexOf('} catch (err) {'));
    const at = (needle: string) => tryBody.indexOf(needle);
    expect(at('importShaderText(')).toBeGreaterThan(-1);
    expect(tryBody).not.toMatch(/embedDocumentOpened|lastPosted =|opened =/);
    expect(open).toMatch(
      /\} finally \{\s*opening = false;\s*\}(\s*\/\/[^\n]*)*\s*if \(!parsed && !\(await bareLanded\(id\)\)\) return;(\s*\/\/[^\n]*)*\s*embedDocumentOpened\(id\);\s*lastPosted = embedModuleKey\(text\);\s*opened = \{ ui: parsed\?\.project\.ui, preview: parsed\?\.project\.preview \};\s*\};$/,
    );
    // A bare module whose converter chunks could not be fetched is such a
    // failed open, told BEFORE the import: left to it, the import renamed the
    // editor and deferred the conversion, the id moved, and the previous
    // document's graph was posted under the new id. Not the file's doing, so
    // with `retry`.
    expect(open).toMatch(/if \(!parsed && !converts\) \{\s*openFailed\(id, SHADER_CONVERTER_MISSING, true\);\s*return;\s*\}/);
    expect(open.indexOf('if (!parsed && !converts)')).toBeLessThan(open.indexOf('importShaderText('));
    expect(open).not.toMatch(/embedDocumentOpened\(id\)[\s\S]*importShaderText\(/);
    // A bare module whose conversion would lose code is refused by the import
    // itself, before it writes anything (projectImport.ts, embedHostOpen.test.ts).
    expect(tryBody).toMatch(/importShaderText\(text, \{[\s\S]*?refuseDroppedCode: true,[\s\S]*?\}\);/);
    // A throw is reported, what the import wrote before its graph (the name, a
    // block's device) is put back — the graph is still the document it was,
    // and its next post would carry them — and the host is told.
    expect(open).toMatch(/const before = useAppStore\.getState\(\);\s*opening = true;/);
    // The host is told FIRST, so nothing the putting back does can keep it
    // from knowing — and it is the file's doing (a corrupt block, code a graph
    // cannot hold), so never with `retry`.
    expect(open).toMatch(
      /\} catch \(err\) \{(\s*\/\/[^\n]*)*\s*openFailed\(id, err, false\);\s*const store = useAppStore\.getState\(\);\s*if \(store\.shaderName !== before\.shaderName\) store\.setShaderName\(before\.shaderName\);\s*if \(store\.selectedHeadsetId !== before\.selectedHeadsetId\) store\.setSelectedHeadsetId\(before\.selectedHeadsetId\);\s*return;\s*\}/,
    );
    expect(fn(bridge, 'onMessage')).toMatch(/const id = hostDocumentId\(data\.id\);/);
  });

  it('a document replaced inside the editor stops being the host\'s, but the bridge\'s own open does not count', () => {
    const bridge = read('./EmbedBridge.tsx');
    // It is no longer the document the host opened (its module carries the
    // store's look again), and the host's theme goes back — below.
    expect(bridge).toMatch(/const onReplaced = \(\) => \{\s*if \(opening\) return;\s*embedDocumentReplaced\(\);\s*opened = null;[\s\S]*?if \(hostLook !== null\) keepTheme\(hostLook\);\s*schedule\(\);\s*\};/);
    for (const event of ['fs:graph-imported', 'fs:graph-new']) {
      expect(bridge).toContain(`window.addEventListener('${event}', onReplaced);`);
      expect(bridge).toContain(`window.removeEventListener('${event}', onReplaced);`);
    }
    // The flag brackets the import and is dropped even when it throws.
    expect(bridge).toMatch(/opening = true;\s*try \{[\s\S]*?\} finally \{\s*opening = false;\s*\}/);
    // Both events are still what the paths that REPLACE a document dispatch.
    expect(read('../engine/projectImport.ts')).toMatch(/new CustomEvent\('fs:graph-imported'\)/);
    expect(read('../store/useAppStore.ts')).toMatch(/new CustomEvent\('fs:graph-new'\)/);
  });

  it('embedded, the stored document is neither read nor written', () => {
    const store = read('../store/useAppStore.ts');
    // The graph autosave starts OFF, with no call for an entry to forget.
    expect(store).toMatch(/const DOCUMENT_STORED = !isEmbedMode\(\);\s*let graphPersistence = DOCUMENT_STORED;/);
    // Its name: read once at init, written by NEW and by a rename.
    expect(store).toMatch(/shaderName: DOCUMENT_STORED \? loadString\('fs:shaderName', DEFAULT_SHADER_NAME\) : DEFAULT_SHADER_NAME,/);
    expect(store.match(/saveString\('fs:shaderName'/g)).toHaveLength(2);
    expect(store.match(/if \(DOCUMENT_STORED\) saveString\('fs:shaderName'/g)).toHaveLength(2);
    // Its model: every `superwxr:open` clears the session mesh, and that clear
    // must not reach the mirror a full FastShaders tab restores from.
    expect(store).toMatch(/if \(opts\?\.persist !== false && DOCUMENT_STORED\) \{\s*void savePreviewMeshToCache\(/);
    expect(store.match(/savePreviewMeshToCache\(/g)).toHaveLength(1);
    // The boot graph, and the viewport that belongs to the stored one.
    expect(read('../App.tsx')).toMatch(/const saved = isEmbedMode\(\) \? null : loadGraph\(\);/);
    const viewport = read('../utils/viewportMemory.ts');
    expect(viewport).toMatch(/export function readStoredViewport\(\)[^{]*\{[^}]*?if \(isEmbedMode\(\)\) return null;/);
    expect(viewport).toMatch(/export function writeStoredViewport\([^{]*\{[^}]*?if \(isEmbedMode\(\)\) return;\s*try \{\s*localStorage\.setItem\(VIEWPORT_KEY/);
  });

  it('EXPORT posts its bytes to the host instead of downloading, only when embedded', () => {
    const exp = read('../engine/exportShader.ts');
    expect(exp).toMatch(/if \(isEmbedMode\(\)\) \{[\s\S]*?type: 'superwxr:export'[\s\S]*?embedTargetOrigin\(\),?\s*\);[\s\S]*?\} else \{[\s\S]*?downloadBlob\(/);
  });
});

describe('protocol 3', () => {
  const bridge = read('./EmbedBridge.tsx');
  const header = bridge.slice(0, bridge.indexOf('\nimport '));

  it('the header lists every message 3 speaks and says what 3 adds over 2', () => {
    for (const line of [
      "{ type: 'superwxr:open', module: string, name?: string, id?: string }",
      "{ type: 'superwxr:rename', name: string, id?: string }",
      "{ type: 'superwxr:appearance', theme?: 'dark' | 'light',",
      'canvasOpacity?: number }',
      "{ type: 'superwxr:ready', protocol: 3 }",
      "{ type: 'superwxr:module', module: string, name: string, id, replaced? }",
      "{ type: 'superwxr:export', kind, fileName, mime, bytes, id }",
      "{ type: 'superwxr:open-failed', id, reason, retry }",
      'Protocol 3 adds, over 2',
      'ARRIVAL order',
    ]) {
      expect(header.includes(line), line).toBe(true);
    }
    // The rule open-failed comes with, where a host reads the protocol.
    const flat = header.replace(/\n \*\s*/g, ' ');
    for (const claim of [
      'A BARE module only once its own code→graph pass has LANDED and written its graph',
      'it is NO document\'s (id null: a file opened inside the editor meanwhile says `replaced: null`)',
      'nothing is posted under either id',
      'is refused before anything is written',
      'posted for every one: `id` is that OPEN\'s (null when it sent none)',
      'at most 200 characters, never markup',
      '`retry` whether the same bytes may open another time',
      'false when the file itself cannot be opened (a host keeps those bytes out until they change)',
      'leaves the previous graph on the canvas as NOBODY\'s: id null from its import on',
      'a bare module that is the document only once its graph landed, and open-failed (with `retry`)',
    ]) {
      expect(flat, claim).toContain(claim);
    }
  });

  it('host messages run in arrival order through ONE chain, which a throw does not stall', () => {
    expect(bridge.match(/let turn: Promise<void> = Promise\.resolve\(\);/g)).toHaveLength(1);
    // The rejection is caught ON the chain, so the next message still runs.
    expect(fn(bridge, 'inTurn')).toMatch(/turn = turn\.then\(task\)\.catch\(\(err: unknown\) => \{\s*console\.error\('\[FastShaders embed\] message failed', err\);\s*\}\);/);
    const onMessage = fn(bridge, 'onMessage');
    const openBranch = onMessage.slice(onMessage.indexOf("data.type === 'superwxr:open'"), onMessage.indexOf("data.type === 'superwxr:rename'"));
    // The open's synchronous part stays at arrival: the mount-time broadcast
    // is cancelled before the open waits for anything — and only that one
    // (an edit's is posted in the turn, below).
    expect(openBranch).toMatch(/if \(timer !== null && timerIsMount\) \{\s*clearTimeout\(timer\);\s*timer = null;\s*\}/);
    expect(openBranch.indexOf('clearTimeout(timer);')).toBeLessThan(openBranch.indexOf('inTurn(async'));
    // Its block is read IN its turn — a parse that throws is a failed open the
    // host is told of — and a bare module's import waits for the converter
    // chunks there too (a block needs neither, and does not wait), so a rename
    // after it waits too; then for a pass already on its way, then the edit
    // still settling is posted, and only then the document is replaced.
    // The open itself is awaited: a bare module's keeps the turn until its
    // graph landed, so a rename behind it finds the id that decision left.
    expect(openBranch).toMatch(
      /inTurn\(async \(\) => \{\s*let parsed: ParsedProject \| null;\s*try \{\s*parsed = extractProjectState\(text\);\s*\} catch \(err\) \{\s*openFailed\(id, err, false\);\s*return;\s*\}(\s*\/\/[^\n]*)*\s*const converts = parsed !== null \|\| \(await convertersLoaded\(\)\);(\s*\/\/[^\n]*)*\s*await passesLanded\(\);(\s*\/\/[^\n]*)*\s*flush\(\);\s*await open\(text, parsed, nameFallback, id, converts\);\s*\}\);/,
    );
    expect(bridge.match(/\bextractProjectState\(/g)).toHaveLength(1);
    expect(onMessage).toMatch(/inTurn\(\(\) => rename\(name, id\)\);/);
    // Appearance applies at once.
    expect(onMessage).toMatch(/\} else if \(data\.type === 'superwxr:appearance'\) \{\s*appearance\(data\);\s*\}/);
    expect(onMessage).not.toMatch(/inTurn\(\(\) => appearance/);
    // No way around the chain: the import and the rename run only from their turns.
    expect(bridge).not.toMatch(/preloadShaderImport\(\)\.then\(/);
    expect(bridge.match(/\bimportShaderText\(/g)).toHaveLength(1);
    expect(bridge.match(/\bopen\(text, parsed, nameFallback, id, converts\)/g)).toHaveLength(1);
    expect(bridge.match(/\brename\(name, id\)/g)).toHaveLength(1);
  });

  it('an open cancels the mount-time broadcast alone: an edit still settling is posted under its own document first', () => {
    // The flag says which broadcast is pending: set by the mount alone, and
    // cleared by every other schedule (an edit, a rename, a file opened inside
    // the editor). Cancelling whatever was pending lost the last edit before
    // an open (measured: a node deleted 100 ms before the host opened another
    // shader never reached the host) and the first post of a document made by
    // IMPORT, whose asset the host then never made.
    expect(bridge).toMatch(/timer = setTimeout\(broadcast, SETTLE_MS\);\s*timerIsMount = true;\s*return \(\) => \{/);
    expect(fn(bridge, 'schedule')).toMatch(/timer = setTimeout\(broadcast, SETTLE_MS\);\s*timerIsMount = false;/);
    expect(bridge.match(/\btimerIsMount = true;/g)).toHaveLength(1);
    // Posted at once, in the open's turn: the graph and embedDocument() are
    // still the document the edit was made to.
    expect(fn(bridge, 'flush')).toMatch(/if \(timer === null\) return;\s*clearTimeout\(timer\);\s*broadcast\(\);/);
    expect(bridge.match(/\bflush\(\);/g)).toHaveLength(1);
  });

  it('nothing is posted while a code→graph pass is on its way, and an open waits for one to land', () => {
    // A bare module's graph is the sync engine's pass, AFTER the open's turn:
    // until it lands the store holds the new code over the previous graph, and
    // a post then filed the previous document's graph under the new id.
    expect(fn(bridge, 'passPending')).toMatch(/return s\.codeSyncRequested \|\| s\.syncInProgress;/);
    // Nor while an open decides whose the graph is (`deciding`, below): from
    // its pass landing to the id it then takes, whatever order the event loop
    // runs a settle in.
    expect(fn(bridge, 'broadcast')).toMatch(/timer = null;(\s*\/\/[^\n]*)*\s*if \(passPending\(\) \|\| deciding\) \{\s*timer = setTimeout\(broadcast, SETTLE_MS\);\s*return;\s*\}/);
    // The wait: checked a microtask after each store write (the sync engine
    // reads as idle between taking a request and arming `syncInProgress`),
    // and given up after PASS_WAIT_MS, when the store's documentEpoch keeps
    // the late pass from writing anything.
    const waiter = fn(bridge, 'passesLanded');
    expect(waiter).toMatch(/if \(!passPending\(\)\) return Promise\.resolve\(\);/);
    expect(waiter).toMatch(/useAppStore\.subscribe\(\(\) => \{\s*queueMicrotask\(\(\) => \{\s*if \(!passPending\(\)\) finish\(\);\s*\}\);\s*\}\);/);
    expect(waiter).toContain('const cap = setTimeout(finish, PASS_WAIT_MS);');
    expect(waiter).toMatch(/clearTimeout\(cap\);\s*stop\(\);\s*resolve\(\);/);
    expect(bridge).toMatch(/const PASS_WAIT_MS = 5000;/);
    // That invariant, on the engine's side: the request effect clears the
    // request and calls the pass synchronously, and the pass arms the flag
    // before its first await.
    const engine = read('../hooks/useSyncEngine.ts');
    const pass = engine.slice(engine.indexOf('const doCodeSync = useCallback('), engine.indexOf('// Code → Graph (manual Save trigger)'));
    const code = pass.replace(/\/\/[^\n]*/g, '');
    expect(code.indexOf('setSyncInProgress(true);')).toBeGreaterThan(-1);
    expect(code.match(/\bawait\b/g)).toHaveLength(1);
    expect(code.indexOf('setSyncInProgress(true);')).toBeLessThan(code.indexOf('await import('));
    expect(engine).toMatch(
      /useAppStore\.setState\(\{ codeSyncRequested: false, codeSyncHistory: true, codeSyncImported: false \}\);[^]*?void doCodeSync\(code, recordHistory, epoch, imported\);\s*\}, \[codeSyncRequested/,
    );
  });

  it('a bare module\'s open fetches BOTH converter chunks first, for CHUNK_WAIT_MS at most, and fails without them', () => {
    // The parser too: after it loaded here, the sync engine's own import of it
    // cannot fail, so the graph either lands or the open never happened.
    const loaded = bridge.slice(bridge.indexOf('async function convertersLoaded('), bridge.indexOf('export function EmbedBridge('));
    expect(loaded).toMatch(
      /const both = Promise\.all\(\[\s*preloadShaderImport\(\),\s*import\('@\/engine\/codeToGraph'\)\.then\(\(\) => true, \(\) => false\),\s*\]\)\.then\(\(\[converter, parser\]\) => converter !== null && parser\);/,
    );
    // A fetch that never settles held every later open and rename for good
    // (the chain waits on it), and told the host nothing: past the cap the
    // open fails, with `retry`, and the timer is gone either way.
    expect(loaded).toMatch(/cap = setTimeout\(\(\) => resolve\(false\), CHUNK_WAIT_MS\);/);
    expect(loaded).toMatch(/try \{\s*return await Promise\.race\(\[both, late\]\);\s*\} finally \{\s*clearTimeout\(cap\);\s*\}/);
    expect(bridge).toMatch(/const CHUNK_WAIT_MS = 20000;/);
    // Only a bare module waits (the turn's `parsed !== null ||`, pinned above).
    expect(bridge.match(/await convertersLoaded\(\)/g)).toHaveLength(1);
  });

  it('appearance: each field on its own — the theme recorded and switched only when it differs, the opacity onto <html>', () => {
    const appearance = fn(bridge, 'appearance');
    expect(appearance).toMatch(/const theme = hostTheme\(data\.theme\);\s*if \(theme !== null\) \{\s*hostLook = theme;\s*keepTheme\(theme\);\s*\}/);
    expect(appearance).toMatch(/const alpha = embedCanvasAlpha\(data\.canvasOpacity\);\s*if \(alpha !== null\) document\.documentElement\.style\.setProperty\(EMBED_CANVAS_ALPHA_VAR, alpha\);/);
    // A switch is a preference write (fs:codeEditorTheme) and a recolour: only when it changes anything.
    expect(fn(bridge, 'keepTheme')).toMatch(/if \(store\.codeEditorTheme !== theme\) store\.setCodeEditorTheme\(theme\);/);
    // The host theme is the host's alone to set.
    expect(bridge.match(/\bhostLook = /g)).toHaveLength(1);
  });

  it('once the host has a theme, no document changes it', () => {
    // (a) A host open applies none of the document's own look: an EMPTY `ui`
    // block, passed through the import's `parsed` option (what an empty block
    // applies — nothing — is driven through the real import in embedHostOpen.test.ts).
    expect(fn(bridge, 'open')).toMatch(/parsed: hostLook !== null && parsed \? withoutLook\(parsed\) : parsed,/);
    expect(bridge).toMatch(/function withoutLook\(parsed: ParsedProject\): ParsedProject \{\s*return \{ \.\.\.parsed, project: \{ \.\.\.parsed\.project, ui: \{\} \} \};\s*\}/);
    // (b) A file opened INSIDE the editor applied its own look before it
    // announced itself, so the listener, in the same dispatch, puts the host's
    // theme back.
    expect(fn(bridge, 'onReplaced')).toContain('if (hostLook !== null) keepTheme(hostLook);');
    const imp = read('../engine/projectImport.ts');
    const apply = imp.slice(imp.indexOf('function applyProjectToStore('), imp.indexOf('function announceGraphImport('));
    expect(apply.indexOf('store.setCodeEditorTheme(')).toBeGreaterThan(-1);
    expect(apply.indexOf('store.setCodeEditorTheme(')).toBeLessThan(apply.lastIndexOf('announceGraphImport();'));
  });

  it('a host-opened document goes back in its OWN ui and preview blocks, exactly as they arrived; any other in the store\'s', () => {
    const broadcast = fn(bridge, 'broadcast');
    // Adjusted on buildProjectState's object, before the block is written:
    // assigned (the key keeps its place) or, for a document that had none,
    // deleted. The preview block too: every import writes only the keys its
    // block has, so one a document lacked read back what the PREVIOUS document
    // (or a full FastShaders tab at this origin) left — measured: a block
    // without a camera opened after one with `geometry: 'torus'` posted the
    // torus and that camera back as its own. The embed has no preview pane,
    // so nothing here changes those settings.
    expect(broadcast).toMatch(
      /const project = buildProjectState\(\);(\s*\/\/[^\n]*)*\s*if \(opened\) \{\s*carry\(project, 'ui', opened\.ui\);\s*carry\(project, 'preview', opened\.preview\);\s*\}\s*const text = embedProjectState\(module, project\);/,
    );
    expect(bridge).toMatch(
      /function carry<K extends 'ui' \| 'preview'>\(project: FastShadersProject, key: K, value: FastShadersProject\[K\] \| undefined\): void \{\s*if \(value === undefined\) delete \(project as Partial<FastShadersProject>\)\[key\];\s*else project\[key\] = value;\s*\}/,
    );
    // Taken from the parse as it ARRIVED, never the look-less copy imported.
    expect(fn(bridge, 'open')).toContain('opened = { ui: parsed?.project.ui, preview: parsed?.project.preview };');
    // A document replaced inside the editor (and the boot graph, `= null` at
    // the start, and the graph a bare module's failed open leaves) carries the
    // store's, as EXPORT writes it.
    expect(bridge).toContain("let opened: { ui: FastShadersProject['ui'] | undefined; preview: FastShadersProject['preview'] | undefined } | null = null;");
    expect(fn(bridge, 'onReplaced')).toContain('opened = null;');
    expect(fn(bridge, 'bareLanded')).toContain('opened = null;');
    expect(bridge.match(/\bopened = /g)).toHaveLength(3);
  });

  it('a host open starts a fresh undo history; nothing else asks for one', () => {
    expect(fn(bridge, 'open')).toMatch(/importShaderText\(text, \{[\s\S]*?freshHistory: true,[\s\S]*?\}\);/);
    // Only the bridge passes it, and only as `true`: a dropped file's Open,
    // IMPORT and NEW keep FastShaders' own history. Swept as ANY use of the
    // option in code outside the import that defines it — `freshHistory:
    // isEmbedMode()` or a shorthand `{ freshHistory }` would ask for it too.
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const using: string[] = [];
    const walk = (rel: string) => {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${rel}${entry.name}/`);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
          if (/\bfreshHistory\b/.test(code(readFileSync(`${dir}${entry.name}`, 'utf8')))) using.push(`${rel}${entry.name}`);
        }
      }
    };
    walk('../');
    expect(using.sort()).toEqual(['../embed/EmbedBridge.tsx', '../engine/projectImport.ts']);
    expect(code(bridge).match(/\bfreshHistory\b[^,\n]*/g)).toEqual(['freshHistory: true']);
  });

  it('the fresh history holds for a bare module too, whose code→graph pass lands after the open', () => {
    const imp = read('../engine/projectImport.ts');
    // A block: nothing recorded, and the write that replaces the graph empties
    // the history — so an apply that throws half way leaves it alone.
    expect(imp).toContain('if (!freshHistory) store.pushHistory();');
    const emptied = /\.\.\.\(freshHistory \? \{ past: \[\], future: \[\] \} : \{\}\),/g;
    expect(imp.match(emptied)).toHaveLength(2);
    // Both branches get it, the bare script's deferred continuation included.
    const body = imp.slice(imp.indexOf('export function importShaderText('), imp.indexOf('\n}\n', imp.indexOf('export function importShaderText(')));
    expect(body).toContain("applyProjectToStore(projectResult.project, projectResult.stripped, opts?.nameFallback ?? '', freshHistory, opts?.keepPreviewMesh === true);");
    expect(body.match(/applyConvertedScript\([^;]*, freshHistory\);/g)).toHaveLength(2);
    // The bare script's one undo entry is the sync engine's doCodeSync
    // pushHistory, AFTER the clear: the request says not to record it (and,
    // every bare script's, that it is an import's — the next suite but one)…
    expect(imp).toContain('store.requestCodeSync({ history: !freshHistory, imported: true });');
    // …the store keeps that answer with the request, every request writing it…
    const store = read('../store/useAppStore.ts');
    expect(store).toMatch(
      /requestCodeSync: \(opts\) =>\s*set\(\{\s*codeSyncRequested: true,\s*codeSyncHistory: opts\?\.history !== false,\s*codeSyncImported: opts\?\.imported === true,\s*codeSyncEpoch: get\(\)\.documentEpoch,\s*previewCode: get\(\)\.code,\s*\}\),/,
    );
    // …and the sync engine takes it WITH the request and hands it to the pass,
    // which then leaves NO history: it records nothing, and empties past and
    // future as it lands — an edit of the graph still on screen while it was
    // on its way (the previous document's) recorded an entry that undid back
    // to that document.
    const engine = read('../hooks/useSyncEngine.ts');
    expect(engine).toMatch(
      /const \{ codeSyncHistory: recordHistory, codeSyncEpoch: epoch, codeSyncImported: imported \} = useAppStore\.getState\(\);\s*useAppStore\.setState\(\{ codeSyncRequested: false, codeSyncHistory: true, codeSyncImported: false \}\);/,
    );
    expect(engine).toContain('void doCodeSync(code, recordHistory, epoch, imported);');
    expect(engine).toMatch(/async \(codeStr: string, recordHistory: boolean, epoch: number, imported: boolean\) => \{/);
    expect(engine).toMatch(
      /if \(recordHistory\) \{\s*useAppStore\.getState\(\)\.pushHistory\(\);\s*\} else \{(\s*\/\/[^\n]*)*\s*useAppStore\.setState\(\{ past: \[\], future: \[\] \}\);\s*\}/,
    );
    expect(engine.match(/\.pushHistory\(\)/g)).toHaveLength(1);
  });

  it('a code→graph pass asked for under a document that has since been replaced writes nothing', () => {
    // Measured on the built embed: a bare module opened and a block opened
    // right behind it (0–10 ms apart, chunk loaded or not) — the bare
    // module's pass landed on the block and the block's asset was posted the
    // bare module's graph. The count, bumped in the very write that replaces
    // the graph with another document: an import's (a block, a bare script's
    // conversion) and NEW's. Nothing else writes it.
    const imp = read('../engine/projectImport.ts');
    expect(imp).toContain('documentEpoch: useAppStore.getState().documentEpoch + 1,');
    expect(imp).toContain('documentEpoch: s.documentEpoch + 1,');
    const store = read('../store/useAppStore.ts');
    expect(store).toContain('documentEpoch: state.documentEpoch + 1,');
    const newGraph = store.slice(store.indexOf('  newGraph: () => {'), store.indexOf('// ── Drawing actions'));
    expect(newGraph).toContain('documentEpoch: state.documentEpoch + 1,');
    const writers: string[] = [];
    const walk = (rel: string) => {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${rel}${entry.name}/`);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
          const n = readFileSync(`${dir}${entry.name}`, 'utf8').match(/\bdocumentEpoch: (?!number)/g)?.length ?? 0;
          if (n > 0) writers.push(`${rel}${entry.name} ${n}`);
        }
      }
    };
    walk('../');
    // The store's own: its initial value and NEW.
    expect(writers.sort()).toEqual(['../engine/projectImport.ts 2', '../store/useAppStore.ts 2']);
    // A request is made under the count it was asked in; the pass drops a
    // stale one when the effect takes it, and again after its parser chunk
    // arrived (which is where the measured race lost), leaving the next
    // request free to parse the same text (the `finally`, below).
    const engine = read('../hooks/useSyncEngine.ts');
    expect(engine).toMatch(
      /if \(epoch !== useAppStore\.getState\(\)\.documentEpoch\) \{\s*requestEnded\(epoch, REPLACED_FIRST, true\);\s*return;\s*\}\s*(\/\/[^\n]*\s*)*if \(!imported && code === lastSyncedCodeRef\.current\) \{/,
    );
    const pass = engine.slice(engine.indexOf('const doCodeSync = useCallback('), engine.indexOf('// Code → Graph (manual Save trigger)'));
    expect(pass).toMatch(/if \(useAppStore\.getState\(\)\.documentEpoch !== epoch\) \{\s*outcome = \{ epoch, ok: false, error: REPLACED_FIRST, retry: true \};\s*return;\s*\}\s*const result = codeToGraph\(codeStr\);/);
    expect(pass.indexOf('documentEpoch !== epoch')).toBeGreaterThan(pass.indexOf("await import('@/engine/codeToGraph')"));
  });

  it('an import\'s code→graph pass is never skipped, and carries nothing of the graph still on the canvas but the stamped settings', () => {
    // MEASURED on the mounted bridge: a bare module opened over a block whose
    // colour node sat in a group frame, with ink on the board, posted both as
    // its own — every parsed node had paired with one of the block's, which
    // let the carries through (embedBridgeMounted.test.ts drives it).
    const engine = read('../hooks/useSyncEngine.ts');
    const pass = engine.slice(engine.indexOf('const doCodeSync = useCallback('), engine.indexOf('// Code → Graph (manual Save trigger)'));
    // No old graph at all: nothing pairs, so every carry is shut (each is
    // gated on pairing, or reads these two).
    expect(pass).toContain('const canvasNodes = useAppStore.getState().nodes;');
    expect(pass).toContain('const oldNodes = imported ? [] : canvasNodes;');
    expect(pass).toContain('const oldEdges = imported ? [] : useAppStore.getState().edges;');
    expect(pass.match(/useAppStore\.getState\(\)\.nodes/g)).toHaveLength(1);
    // The one thing that rides across: the file's material settings, which
    // the import stamped on the canvas graph's Output, per key.
    expect(pass).toMatch(
      /if \(imported\) \{(\s*\/\/[^\n]*)*\s*const stamped = moduleSettingsOutput\(canvasNodes\);\s*if \(stamped && parsedOwnerId !== null\) \{[\s\S]*?carryMaterialSettings\(owner, stamped, true\);[\s\S]*?\}(\s*\/\/[^\n]*)*\s*useAppStore\.setState\(\{ drawings: \[\] \}\);\s*\}\s*setNodes\(finalNodes, 'code'\);/,
    );
    // The board's drawings go in the write the pass's undo entry precedes, so
    // an undo of a file opened inside the editor brings them back.
    expect(pass.indexOf('useAppStore.setState({ drawings: [] });')).toBeGreaterThan(pass.indexOf('useAppStore.getState().pushHistory();'));
    // Never an import's request skipped as done (the same bytes under another
    // name, ink drawn on them since).
    expect(engine).toContain('if (!imported && code === lastSyncedCodeRef.current) {');
    // Every bare script's conversion asks for it, and nothing else does.
    expect(read('../engine/projectImport.ts').match(/imported: true/g)).toHaveLength(1);
    expect(read('../components/CodeEditor/CodeEditor.tsx')).not.toMatch(/requestCodeSync\([^)]/);
  });

  it('every code→graph request ends with how it ended; one that wrote no graph forgets its text', () => {
    // The embed bridge decides on it whether a host-opened bare module became
    // the document (next test): MEASURED, a syntax error's pass wrote no graph
    // and the bridge posted the previous document's under the new id.
    const engine = read('../hooks/useSyncEngine.ts');
    const pass = engine.slice(engine.indexOf('const doCodeSync = useCallback('), engine.indexOf('// Code → Graph (manual Save trigger)'));
    // A pass: one outcome, written in the very `set` that clears the flag, so
    // whoever sees the pass land reads how it ended; a throw is a failure.
    expect(pass).toContain('let outcome: CodeSyncOutcome = { epoch, ok: false, error: PASS_THREW, retry: false };');
    expect(pass.indexOf('let outcome:')).toBeLessThan(pass.indexOf('setSyncInProgress(true);'));
    expect(pass).toMatch(
      /\} finally \{(\s*\/\/[^\n]*)*\s*if \(!outcome\.ok\) lastSyncedCodeRef\.current = '';\s*useAppStore\.setState\(\{ syncInProgress: false, codeSyncOutcome: outcome \}\);\s*\}\s*\},\s*\[setNodes/,
    );
    expect(pass).not.toMatch(/setSyncInProgress\(false\)/);
    // Blocking parse errors write no graph: the first is the outcome's error,
    // and the text's own doing (`retry` false: those bytes fail again).
    expect(pass).toContain("const blocking = result.errors.find((e) => e.severity !== 'warning');");
    expect(pass).toMatch(/if \(!blocking\) \{\s*if \(recordHistory\) \{/);
    expect(pass).toContain('outcome = blocking ? { epoch, ok: false, error: blocking.message, retry: false } : { epoch, ok: true };');
    // The parser chunk that could not be fetched (not the text's: `retry`),
    // and direct assignments (no graph has them): failures too, the text
    // forgotten with them.
    expect(pass).toMatch(/setCodeErrors\(\[\{ message, severity: 'error' \}\]\);\s*outcome = \{ epoch, ok: false, error: message, retry: true \};\s*return;/);
    expect(pass).toMatch(
      /if \(isDirectAssignmentCode\(codeStr\)\) \{\s*setCodeErrors\(\[\]\);(\s*\/\/[^\n]*)*\s*lastSyncedCodeRef\.current = '';\s*requestEnded\(epoch, DIRECT_ASSIGNMENT\);\s*return;\s*\}/,
    );
    // The effect's own two ends: dropped as stale, and SKIPPED because the
    // graph already is that text's — which it is, since the ref names no text
    // a pass failed on: a broken module opened twice parsed the second time,
    // never "landed" over the graph of the document before it.
    expect(engine).toMatch(/if \(!imported && code === lastSyncedCodeRef\.current\) \{\s*requestEnded\(epoch\);\s*return;\s*\}\s*lastSyncedCodeRef\.current = code;/);
    expect(engine).toMatch(
      /function requestEnded\(epoch: number, error\?: string, retry = false\): void \{\s*useAppStore\.setState\(\{ codeSyncOutcome: error === undefined \? \{ epoch, ok: true \} : \{ epoch, ok: false, error, retry \} \}\);\s*\}/,
    );
    expect(engine.match(/\brequestEnded\(epoch[,)]/g)).toHaveLength(3);
    // The store holds it, null until a request ends.
    const store = read('../store/useAppStore.ts');
    expect(store).toContain('export type CodeSyncOutcome = { epoch: number; ok: true } | { epoch: number; ok: false; error: string; retry: boolean };');
    expect(store).toMatch(/codeSyncEpoch: 0,\s*codeSyncOutcome: null,/);
  });

  it('a host-opened bare module is the document only once its own pass LANDED and wrote its graph; otherwise nobody\'s', () => {
    const landed = fn(bridge, 'bareLanded');
    // The count its import wrote, read before the wait: its pass was asked for
    // under it. From the import on, the graph is nobody's (id null) — neither
    // the document it replaced nor this file yet: a file opened inside the
    // editor before the decision replaced no document of the host's, which
    // `replaced: null` says (measured: naming the previous one, its module
    // was dropped by a host just told this open failed).
    expect(landed).toMatch(
      /const epoch = useAppStore\.getState\(\)\.documentEpoch;(\s*\/\/[^\n]*)*\s*embedDocumentOpened\(null\);\s*opened = null;\s*deciding = true;\s*try \{\s*await passesLanded\(\);/,
    );
    expect(landed.replace(/\/\/[^\n]*/g, '').match(/\bawait\b/g)).toHaveLength(1);
    // Replaced inside the editor meanwhile: that file keeps the id minted for
    // it (`onReplaced`), so nothing here touches the document — the host is
    // told, and it is not the file's doing (`retry`).
    expect(landed).toMatch(/if \(documentEpoch !== epoch\) \{\s*openFailed\(id, REPLACED_INSIDE, true\);\s*return false;\s*\}/);
    // Success is the outcome of THIS import's pass, and one that wrote its graph.
    expect(landed).toContain('if (outcome?.epoch === epoch && outcome.ok) return true;');
    // Anything else — blocking parse errors (their first message), direct
    // assignments, a pass that threw, none landed within PASS_WAIT_MS —
    // leaves the previous graph on the canvas as nobody's (the boot graph's
    // rule) and tells the host, with the pass's own `retry` (none landed: true).
    // (A pass dropped as stale is the replaced case above: only a file opened
    // inside the editor moves the count meanwhile.)
    expect(landed).toMatch(
      /const failed = outcome\?\.epoch === epoch && !outcome\.ok \? outcome : null;\s*openFailed\(id, failed \? failed\.error : passPending\(\) \? NOT_READY : NO_OUTCOME, failed \? failed\.retry : true\);\s*return false;/,
    );
    expect(landed.match(/embedDocumentOpened\(/g)).toHaveLength(1);
    // Nothing is posted from the import to that decision, whatever the order
    // of the event loop (`broadcast` waits on the flag, pinned above).
    expect(landed).toMatch(/\} finally \{\s*deciding = false;\s*\}\s*\};$/);
    expect(bridge.match(/\bdeciding = true;/g)).toHaveLength(1);
    expect(bridge.match(/\bdeciding = false;/g)).toHaveLength(2);
    // Called for a bare module only, and the open's adoption waits on it.
    expect(bridge.match(/\bbareLanded\(/g)).toHaveLength(1);
    expect(bridge).toMatch(/const NOT_READY = `its graph was not ready after \$\{PASS_WAIT_MS \/ 1000\} s`;/);
  });

  it('open-failed: the open\'s own id, one cleaned reason and whether to retry, for every open that does not become the document', () => {
    // Exactly four keys: never the document fields (the open never became
    // one), the reason through the leaf's cleaner (embedDocument.test.ts),
    // and `retry` as each caller decides it. An expected outcome: a warning
    // (a host's test runner fails on an error), with the cause as it came.
    expect(fn(bridge, 'openFailed')).toMatch(
      /const openFailed = \(id: string \| null, cause: unknown, retry: boolean\) => \{\s*console\.warn\('\[FastShaders embed\] open failed:', cause\);\s*post\(\{ type: 'superwxr:open-failed', id, reason: openFailedReason\(cause\), retry \}\);\s*\};/,
    );
    expect(bridge.match(/post\(\{ type: 'superwxr:open-failed'/g)).toHaveLength(1);
    // The one error the bridge still logs is a message that THREW — a bug,
    // never an outcome a host is told of.
    expect(bridge.match(/console\.error\(/g)).toHaveLength(1);
    expect(fn(bridge, 'inTurn')).toContain("console.error('[FastShaders embed] message failed', err);");
    // Its callers, `id` always the open's (hostDocumentId(data.id)): an open
    // with no module text and a block that would not parse (the file's), the
    // converter chunks not here (not the file's), an import that threw (the
    // file's), and a bare module whose graph did not land (twice in
    // `bareLanded`).
    expect(bridge.match(/\bopenFailed\(id, /g)).toHaveLength(6);
    expect(bridge.match(/\bopenFailed\(id, [^;]*?, true\)/g)!.sort()).toEqual([
      'openFailed(id, REPLACED_INSIDE, true)',
      'openFailed(id, SHADER_CONVERTER_MISSING, true)',
    ]);
    expect(bridge.match(/\bopenFailed\(id, [^;]*?, false\)/g)!.sort()).toEqual([
      'openFailed(id, NO_MODULE, false)',
      'openFailed(id, err, false)',
      'openFailed(id, err, false)',
    ]);
    expect(fn(bridge, 'open')).toContain('openFailed(id, err, false);');
    // An open with no module text is one too: reported in its turn, the
    // mount-time broadcast left alone (nothing replaced the boot graph).
    const onMessage = fn(bridge, 'onMessage');
    expect(onMessage).toMatch(
      /if \(data\.type === 'superwxr:open'\) \{\s*const id = hostDocumentId\(data\.id\);(\s*\/\/[^\n]*)*\s*if \(typeof data\.module !== 'string' \|\| data\.module\.length === 0\) \{\s*inTurn\(\(\) => openFailed\(id, NO_MODULE, false\)\);\s*return;\s*\}/,
    );
    expect(onMessage.indexOf('openFailed(id, NO_MODULE, false)')).toBeLessThan(onMessage.indexOf('clearTimeout(timer);'));
  });

  it('rename: cleaned like an opened file\'s name, in its turn, for the document the editor holds', () => {
    const nameOf = bridge.match(/function nameOf\(raw: unknown\): string \{[\s\S]*?\n\}/)![0];
    expect(nameOf).toContain("if (typeof raw !== 'string') return '';");
    // Bounded as an opened block's own name is (sanitizeDroppedName: 120,
    // trimmed): SuperWXR renames after every open, and a cap of 80 cut a
    // longer stored name short, so a mere open of it posted a changed text.
    expect(nameOf).toContain("return sanitizeDroppedName(raw.replace(/\\.(m?js|zip)$/i, ''));");
    expect(nameOf).not.toMatch(/\.slice\(/);
    expect(sanitizeDroppedName(`  ${'n'.repeat(119)} x\n`)).toBe(`${'n'.repeat(119)} x`.slice(0, MAX_DROPPED_NAME_LENGTH).trim());
    expect(MAX_DROPPED_NAME_LENGTH).toBe(120);
    expect(read('../engine/projectImport.ts')).toContain('const adopted = sanitizeDroppedName(authored) || nameFallback;');
    const onMessage = fn(bridge, 'onMessage');
    // The open's fallback name goes through the same cleaning.
    expect(onMessage).toContain('const nameFallback = nameOf(data.name);');
    expect(onMessage).toMatch(/const name = nameOf\(data\.name\);\s*if \(!name\) return;\s*const id = hostDocumentId\(data\.id\);\s*inTurn\(\(\) => rename\(name, id\)\);/);
    const rename = fn(bridge, 'rename');
    // An id the editor no longer holds (the host's or a minted one) is
    // ignored; none at all renames whatever it holds.
    expect(rename).toMatch(/if \(id !== null && id !== embedDocument\(\)\.id\) return;/);
    expect(rename).toMatch(/if \(store\.shaderName !== name\) store\.setShaderName\(name\);/);
    // The subscription that posts the module watches the name, so the rename
    // reaches the host through the usual settle, in the message and the block.
    expect(bridge).toMatch(/state\.shaderName !== last\.shaderName/);
    // And embedded, setShaderName writes no storage (pinned above, on the store).
    expect(read('../store/useAppStore.ts')).toMatch(/setShaderName: \(name\) => \{\s*if \(DOCUMENT_STORED\) saveString\('fs:shaderName', name\);/);
  });
});
