/**
 * Source pins for the image-budget paths that cannot run in the node env:
 * NodeEditor's paste/duplicate and drop loop (React + DOM), the DOM-only
 * encoder, and the ORDER of the store's budget checks (behaviour is driven
 * for real in store/imageBudgetPaths.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const EDITOR = readFileSync(new URL('./NodeEditor.tsx', import.meta.url), 'utf8');
const IMPORT = readFileSync(new URL('../../utils/imageImport.ts', import.meta.url), 'utf8');
const STORE = readFileSync(new URL('../../store/useAppStore.ts', import.meta.url), 'utf8');
const MENU_SHARED = readFileSync(new URL('./menus/menuShared.tsx', import.meta.url), 'utf8');

/** `src` from `start` up to (not including) `end`; both must exist. */
function slice(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  expect(a, `missing ${start}`).toBeGreaterThan(-1);
  const b = src.indexOf(end, a);
  expect(b, `missing ${end}`).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('paste and Ctrl+D count the project image budget', () => {
  const paste = slice(EDITOR, 'function pasteNodes(', 'const handler = (e: KeyboardEvent)');

  it('checks the budget BEFORE anything is committed, and overrides through proceed', () => {
    const check = paste.indexOf('exceedsImageBudget(store.nodes, clones, store.ignoreImageLimits)');
    expect(check).toBeGreaterThan(-1);
    expect(paste.indexOf('proceed: commit')).toBeGreaterThan(check);
  });

  it('commits from LIVE state, since proceed may run later', () => {
    expect(paste).toMatch(/const commit = \(\) => \{\s*const live = useAppStore\.getState\(\);\s*live\.pushHistory\(\);/);
  });

  it('shifts the clipboard only once a paste lands', () => {
    expect(EDITOR).toMatch(/pasteNodes\(clipboardRef\.current, \(clones\) => \{\s*clipboardRef\.current = clones\.map/);
    expect(EDITOR).not.toContain('const clones = pasteNodes(');
  });
});

describe('the right-click "Duplicate Node" counts the project image budget too', () => {
  it('goes through the budget-checked helper, never a bare addNode', () => {
    const dup = slice(MENU_SHARED, 'const handleDuplicate = () => {', 'const handleDelete');
    expect(dup).toContain('duplicateNodeWithinBudget(node as AppNode);');
    expect(dup).not.toContain('addNode(');
  });

  it('the helper checks before it adds, and its override adds through LIVE state', () => {
    const helper = slice(MENU_SHARED, 'export function duplicateNodeWithinBudget(', 'export function NodeActions(');
    const check = helper.indexOf('exceedsImageBudget(s.nodes, [clone], s.ignoreImageLimits)');
    expect(check).toBeGreaterThan(-1);
    expect(helper.indexOf('s.addNode(clone)')).toBeGreaterThan(check);
    expect(helper).toContain('proceed: () => useAppStore.getState().addNode(clone)');
  });
});

describe('an image drop reports ONCE', () => {
  it('the drop loop collects reports and posts them under ONE drop id after it', () => {
    expect(EDITOR).toMatch(
      /const dropId = generateId\(\);\s*const reports: ImageDropReport\[\] = \[\];/,
    );
    expect(EDITOR).toContain('placeImageFile(q.img, q.x, q.y, q.ghostId, choice, dropId)');
    expect(EDITOR).toMatch(
      /reports\.push\(r\);\s*\}\s*useAppStore\.getState\(\)\.showImageDropReports\(dropId, reports\);/,
    );
  });

  it('every notice a drop raises carries that drop id, so "Add anyway" merges into its note', () => {
    const place = slice(EDITOR, 'const placeImageFile', 'const onDrop');
    // The per-image refusal (too large / too many pixels) and the project cap.
    expect((place.match(/\n\s*dropId,\n/g) ?? []).length).toBe(2);
    const resolve = slice(STORE, 'resolveLimitNotice: (action, ignoreFuture) => {', 'setIgnoreImageLimits: (v) =>');
    expect((resolve.match(/showImageDropReports\(head\.dropId, \[/g) ?? []).length).toBe(2);
    expect(resolve).not.toContain('showImportNote(');
  });

  it('placeImageFile posts nothing itself, and a refused drop carries its report', () => {
    const place = slice(EDITOR, 'const placeImageFile', 'const onDrop');
    expect(place).not.toContain('showImportNote(');
    expect(place).not.toContain('setImportNote');
    expect(place).toContain('encoded: { ...payload, origin, report }');
    expect(place).toContain('return report;');
  });

  it('the "?" renders only beside a conversion line', () => {
    expect(EDITOR).toContain('importNoteHasConvertLine(importNote) && (');
  });
});

describe('the encoder reports what the budget cost', () => {
  it('flags the halving retry', () => {
    expect(IMPORT).toMatch(/scale \/= 2;\s*budgetScaled = true;/);
  });

  it('never trades a lossless base for a lossy power-of-two round-up', () => {
    expect(IMPORT).toContain('base.lossless ? candidates.filter((c) => c.lossless) : candidates');
    expect(IMPORT).toMatch(/encodeWithinBudget\(potCanvas, potCandidates, budget\)/);
  });
});

describe('the store checks the budget before it changes anything', () => {
  it('"Add anyway" runs a notice\'s proceed before the File path', () => {
    const resolve = slice(STORE, 'resolveLimitNotice: (action, ignoreFuture) => {', 'setIgnoreImageLimits: (v) =>');
    const proceed = resolve.indexOf("if (action === 'proceed' && head.proceed) {");
    expect(proceed).toBeGreaterThan(-1);
    expect(resolve.indexOf("if (action !== 'proceed' || !head.file")).toBeGreaterThan(proceed);
    // The checkbox is committed first: `proceed` sits below the queue shift.
    expect(resolve.indexOf('pendingLimitNotices.slice(1)')).toBeLessThan(proceed);
  });

  it('instantiateSavedGroup refuses before it pushes history', () => {
    const inst = slice(STORE, 'instantiateSavedGroup: (savedId, position, opts) => {', 'unfoldOutputMaterials(');
    const check = inst.indexOf('exceedsImageBudget(state.nodes, saved.nodes, state.ignoreImageLimits)');
    expect(check).toBeGreaterThan(-1);
    expect(inst.indexOf('get().pushHistory()')).toBeGreaterThan(check);
  });

  it('saveGroupToLibrary refuses before it snapshots, against the LIBRARY cap', () => {
    const save = slice(STORE, 'saveGroupToLibrary: (groupId, opts) => {', 'deleteSavedGroup:');
    const check = save.indexOf('exceedsImageBudget(');
    expect(check).toBeGreaterThan(-1);
    expect(save.indexOf('structuredClone(')).toBeGreaterThan(check);
    expect(save).toContain('MAX_LIBRARY_IMAGE_CHARS');
  });

  it('documents that a proceed closure makes a notice non-serialisable', () => {
    const decl = slice(STORE, 'export interface LimitNotice {', 'export type ContextMenuType');
    expect(decl).toMatch(/proceed\?: \(\) => void;/);
    expect(decl).toMatch(/never persisted/);
  });
});

describe('storage de-duplication: every project add still counts instances, and clones share payloads', () => {
  const IMAGE_MENU = readFileSync(new URL('./menus/ImageNodeSettings.tsx', import.meta.url), 'utf8');

  it('the drop asks exceedsImageBudgetAdding with the default (project) count', () => {
    const place = slice(EDITOR, 'const placeImageFile', 'const onDrop');
    expect(place).toContain('exceedsImageBudgetAdding(useAppStore.getState().nodes, [payload.dataUrl], ignore)');
    expect(EDITOR).not.toContain('totalImageChars(');
  });

  it('Revert and Resolution replace the LIVE node\'s payload', () => {
    expect(IMAGE_MENU).toContain('imageCharsReplacing(store.nodes, nodeId, o.dataUrl)');
    expect(IMAGE_MENU).toContain('imageCharsReplacing(store.nodes, nodeId, encoded.dataUrl)');
    expect(IMAGE_MENU).not.toContain('totalImageChars(');
  });

  it('the library save counts distinct payloads and shares the strings it saves', () => {
    const save = slice(STORE, 'saveGroupToLibrary: (groupId, opts) => {', 'deleteSavedGroup:');
    expect(save).toContain('LIBRARY_IMAGE_BUDGET_COUNT');
    expect(save).toContain('nodes: cloneNodesSharingPayloads(snapshot)');
  });

  it('paste, the clipboard, Ctrl+D and the menu Duplicate never deep-copy a node', () => {
    expect(EDITOR).not.toContain('structuredClone(node)');
    expect(EDITOR).not.toContain('structuredClone(selected)');
    expect(EDITOR).toContain('const cloned = cloneNodeSharingPayloads(node);');
    expect(EDITOR).toContain('clones.map((n) => cloneNodeSharingPayloads(n))');
    expect(MENU_SHARED).not.toContain('structuredClone(node)');
    expect(MENU_SHARED).toContain('...cloneNodeSharingPayloads(node),');
    expect(MENU_SHARED).toContain('exceedsImageBudget(');
  });

  it('a saved group is instantiated through the sharing clone', () => {
    const clone = slice(STORE, 'function cloneGroupSnapshot(', 'function placeLibraryGroup(');
    expect(clone).toContain('...cloneNodeSharingPayloads(originalGroup)');
    expect(clone).toContain('...cloneNodeSharingPayloads(m)');
    expect(clone).not.toMatch(/structuredClone\((originalGroup|m)\)/);
  });
});
