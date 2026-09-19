/**
 * The 3M project image budget, counted on every path that ADDS a payload — the
 * two that live in the store (saved-group instantiate, and saved-group SAVE
 * against the library's own total), the right-click Duplicate Node (a plain
 * function over the store, so it runs here for real), plus the "Add anyway"
 * report path. Paste and Ctrl+D live in NodeEditor and are source-pinned in
 * components/NodeEditor/imageBudgetPins.test.ts.
 *
 * `isolate: false` shares this store with later files, so every test starts
 * from a reset and the file leaves one behind. In the node env `localStorage`
 * does not exist, so `persistSavedGroups` may queue a `storage-quota` notice
 * (guarded by a module-level flag that outlives this file): notices are
 * therefore always filtered by kind, never counted whole.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { useAppStore, cancelPendingGraphSave, type LimitNotice } from '@/store/useAppStore';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import { MAX_TOTAL_IMAGE_CHARS, MAX_LIBRARY_IMAGE_CHARS, MAX_IMAGE_ENCODED_CHARS } from '@/utils/imageNode';
import { duplicateNodeWithinBudget } from '@/components/NodeEditor/menus/menuShared';

const PREFIX = 'data:image/png;base64,';
/** An Image node whose payload is exactly `chars` long. */
const img = (id: string, chars: number, parentId?: string): AppNode =>
  ({
    ...makeNode(id, 'imageNode', { imageB64: PREFIX + 'A'.repeat(chars - PREFIX.length), fileName: `${id}.png` }),
    ...(parentId ? { parentId } : {}),
  }) as AppNode;
const member = (node: AppNode, parentId: string): AppNode => ({ ...node, parentId }) as AppNode;
const groupNode = (id: string): AppNode =>
  ({
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    width: 200,
    height: 120,
    data: { label: id, color: '#dde', collapsed: false, width: 200, height: 120 },
  }) as unknown as AppNode;

function reset() {
  useAppStore.setState({
    nodes: [],
    edges: [],
    past: [],
    future: [],
    savedGroups: [],
    pendingLimitNotices: [],
    ignoreImageLimits: false,
    importNote: null,
  });
}
beforeEach(reset);
afterAll(() => {
  cancelPendingGraphSave();
  reset();
});

const notices = (kind: LimitNotice['kind']) =>
  useAppStore.getState().pendingLimitNotices.filter((n) => n.kind === kind);
const s = () => useAppStore.getState();

describe('instantiateSavedGroup counts the project image budget', () => {
  function seed(liveChars: number, memberNodes: AppNode[]) {
    useAppStore.setState({
      nodes: liveChars > 0 ? [img('live', liveChars)] : [],
      savedGroups: [
        { id: 'sg', name: 'Textures', color: '#abc', nodes: [groupNode('g'), ...memberNodes], edges: [] },
      ] as never,
    });
  }

  it('refuses a group whose images cross the budget: nothing placed, no undo entry', () => {
    seed(MAX_TOTAL_IMAGE_CHARS - 100, [img('m', 1000, 'g')]);
    s().instantiateSavedGroup('sg', { x: 10, y: 10 });
    expect(s().nodes).toHaveLength(1);
    expect(s().past).toHaveLength(0);
    const n = notices('image-total-cap');
    expect(n).toHaveLength(1);
    expect(n[0].fileName).toBe('Textures');
    expect(typeof n[0].proceed).toBe('function');
  });

  it('"Add anyway" places it', () => {
    seed(MAX_TOTAL_IMAGE_CHARS - 100, [img('m', 1000, 'g')]);
    s().instantiateSavedGroup('sg', { x: 10, y: 10 });
    s().resolveLimitNotice('proceed', null);
    expect(s().nodes).toHaveLength(3);
    expect(s().past).toHaveLength(1);
  });

  it('Cancel places nothing', () => {
    seed(MAX_TOTAL_IMAGE_CHARS - 100, [img('m', 1000, 'g')]);
    s().instantiateSavedGroup('sg', { x: 10, y: 10 });
    s().resolveLimitNotice('dismiss', null);
    expect(s().nodes).toHaveLength(1);
    expect(s().past).toHaveLength(0);
  });

  it('the override re-reads the group, so one deleted meanwhile places nothing', () => {
    seed(MAX_TOTAL_IMAGE_CHARS - 100, [img('m', 1000, 'g')]);
    s().instantiateSavedGroup('sg', { x: 10, y: 10 });
    useAppStore.setState({ savedGroups: [] });
    s().resolveLimitNotice('proceed', null);
    expect(s().nodes).toHaveLength(1);
  });

  it('places directly under ignore-limits', () => {
    seed(MAX_TOTAL_IMAGE_CHARS - 100, [img('m', 1000, 'g')]);
    useAppStore.setState({ ignoreImageLimits: true });
    s().instantiateSavedGroup('sg', { x: 10, y: 10 });
    expect(s().nodes).toHaveLength(3);
    expect(notices('image-total-cap')).toHaveLength(0);
  });

  it('never refuses a group without images, even in a project already over budget', () => {
    seed(MAX_TOTAL_IMAGE_CHARS + 500, [member(makeNode('f', 'float'), 'g')]);
    s().instantiateSavedGroup('sg', { x: 10, y: 10 });
    expect(s().nodes).toHaveLength(3);
    expect(notices('image-total-cap')).toHaveLength(0);
  });
});

describe('saveGroupToLibrary counts the LIBRARY’s own image budget', () => {
  function seed(libraryChars: number, liveMembers: AppNode[]) {
    useAppStore.setState({
      nodes: [groupNode('g'), ...liveMembers],
      savedGroups: [
        {
          id: 'old',
          name: 'Old',
          color: '#abc',
          nodes: [groupNode('og'), img('om', libraryChars, 'og')],
          edges: [],
        },
      ] as never,
    });
  }

  it('refuses a save that would cross it: the library is left untouched', () => {
    seed(MAX_LIBRARY_IMAGE_CHARS - 100, [img('m', 1000, 'g')]);
    const before = s().savedGroups;
    s().saveGroupToLibrary('g');
    expect(s().savedGroups).toBe(before);
    const n = notices('image-library-cap');
    expect(n).toHaveLength(1);
    expect(n[0].fileName).toBe('g');
    expect(typeof n[0].proceed).toBe('function');
  });

  it('"Save anyway" saves it', () => {
    seed(MAX_LIBRARY_IMAGE_CHARS - 100, [img('m', 1000, 'g')]);
    s().saveGroupToLibrary('g');
    s().resolveLimitNotice('proceed', null);
    expect(s().savedGroups).toHaveLength(2);
    expect(s().savedGroups[1].nodes.map((n) => n.id)).toEqual(['g', 'm']);
  });

  it('Cancel saves nothing', () => {
    seed(MAX_LIBRARY_IMAGE_CHARS - 100, [img('m', 1000, 'g')]);
    s().saveGroupToLibrary('g');
    s().resolveLimitNotice('dismiss', null);
    expect(s().savedGroups).toHaveLength(1);
  });

  it('saves directly under ignore-limits', () => {
    seed(MAX_LIBRARY_IMAGE_CHARS - 100, [img('m', 1000, 'g')]);
    useAppStore.setState({ ignoreImageLimits: true });
    s().saveGroupToLibrary('g');
    expect(s().savedGroups).toHaveLength(2);
    expect(notices('image-library-cap')).toHaveLength(0);
  });

  it('never refuses a group without images', () => {
    seed(MAX_LIBRARY_IMAGE_CHARS + 500, [member(makeNode('f', 'float'), 'g')]);
    s().saveGroupToLibrary('g');
    expect(s().savedGroups).toHaveLength(2);
    expect(notices('image-library-cap')).toHaveLength(0);
  });

  it('checks against the library, not the project: a big live graph does not refuse a save', () => {
    useAppStore.setState({
      nodes: [img('big', MAX_TOTAL_IMAGE_CHARS + 500), groupNode('g'), img('m', 1000, 'g')],
      savedGroups: [],
    });
    s().saveGroupToLibrary('g');
    expect(s().savedGroups).toHaveLength(1);
    expect(notices('image-library-cap')).toHaveLength(0);
  });
});

describe('the right-click "Duplicate Node" counts the project image budget', () => {
  it('refuses a duplicate that would cross it: nothing added, no undo entry, the file named', () => {
    useAppStore.setState({ nodes: [img('a', 2_000_000)] });
    expect(duplicateNodeWithinBudget(s().nodes[0])).toBe(false);
    expect(s().nodes).toHaveLength(1);
    expect(s().past).toHaveLength(0);
    const n = notices('image-total-cap');
    expect(n).toHaveLength(1);
    expect(n[0].fileName).toBe('a.png');
    expect(typeof n[0].proceed).toBe('function');
  });

  it('"Add anyway" adds the duplicate beside the original', () => {
    useAppStore.setState({ nodes: [img('a', 2_000_000)] });
    duplicateNodeWithinBudget(s().nodes[0]);
    s().resolveLimitNotice('proceed', null);
    expect(s().nodes).toHaveLength(2);
    const [orig, dup] = s().nodes;
    expect(dup.id).not.toBe(orig.id);
    expect(dup.position).toEqual({ x: orig.position.x + 30, y: orig.position.y + 30 });
  });

  it('Cancel adds nothing', () => {
    useAppStore.setState({ nodes: [img('a', 2_000_000)] });
    duplicateNodeWithinBudget(s().nodes[0]);
    s().resolveLimitNotice('dismiss', null);
    expect(s().nodes).toHaveLength(1);
  });

  it('adds directly when it fits, and under ignore-limits', () => {
    useAppStore.setState({ nodes: [img('a', 1000)] });
    expect(duplicateNodeWithinBudget(s().nodes[0])).toBe(true);
    expect(s().nodes).toHaveLength(2);
    useAppStore.setState({ nodes: [img('b', 2_000_000)], ignoreImageLimits: true });
    expect(duplicateNodeWithinBudget(s().nodes[0])).toBe(true);
    expect(s().nodes).toHaveLength(2);
    expect(notices('image-total-cap')).toHaveLength(0);
  });
});

describe('"Add anyway" on one image of a batch joins that drop\'s note', () => {
  const scaled = (w: number) => ({
    storedAs: 'PNG',
    convertNote: null,
    budgetScaled: { width: w, height: w },
    losslessDropped: false,
    budgetChars: MAX_IMAGE_ENCODED_CHARS,
  });
  function enqueueRefused(dropId: string) {
    s().enqueueLimitNotice({
      id: 'b2',
      kind: 'image-total-cap',
      fileName: 'b.png',
      file: { name: 'b.png' } as unknown as File,
      position: { x: 0, y: 0 },
      encoded: { dataUrl: PREFIX + 'AAAA', width: 512, height: 512, report: scaled(512) },
      dropId,
    });
  }
  const threeReduced = [{ kind: 'budget-scaled-many', count: 3, budgetChars: MAX_IMAGE_ENCODED_CHARS }];

  it('clicked after the batch posted: one count for all three', () => {
    enqueueRefused('drop-A');
    s().showImageDropReports('drop-A', [scaled(256), scaled(128)]);
    s().resolveLimitNotice('proceed', null);
    expect(s().importNote?.lines).toEqual(threeReduced);
  });

  it('clicked while the batch was still encoding: the batch joins it, same count', () => {
    enqueueRefused('drop-A');
    s().resolveLimitNotice('proceed', null);
    s().showImageDropReports('drop-A', [scaled(256), scaled(128)]);
    expect(s().importNote?.lines).toEqual(threeReduced);
  });

  it('a note from a DIFFERENT drop is replaced, as any later import replaces', () => {
    s().showImageDropReports('drop-other', [scaled(256)]);
    enqueueRefused('drop-A');
    s().resolveLimitNotice('proceed', null);
    expect(s().importNote?.lines).toEqual([
      { kind: 'budget-scaled', width: 512, height: 512, budgetChars: MAX_IMAGE_ENCODED_CHARS },
    ]);
  });

  it('a note that was dismissed is not resurrected', () => {
    s().showImageDropReports('drop-A', [scaled(256), scaled(128)]);
    s().dismissImportNote();
    enqueueRefused('drop-A');
    s().resolveLimitNotice('proceed', null);
    expect(s().importNote?.lines).toEqual([
      { kind: 'budget-scaled', width: 512, height: 512, budgetChars: MAX_IMAGE_ENCODED_CHARS },
    ]);
  });
});

describe('an image drop refused by the project budget reports its N5 lines only once placed', () => {
  const report = {
    storedAs: 'PNG',
    convertNote: null,
    budgetScaled: { width: 512, height: 256 },
    losslessDropped: false,
    budgetChars: MAX_IMAGE_ENCODED_CHARS,
  };
  function enqueueRefusedDrop() {
    s().enqueueLimitNotice({
      id: 'drop1',
      kind: 'image-total-cap',
      fileName: 'a.png',
      file: { name: 'a.png' } as unknown as File,
      position: { x: 0, y: 0 },
      encoded: { dataUrl: PREFIX + 'AAAA', width: 512, height: 256, report },
    });
  }

  it('"Add anyway" places the image and posts its lines', () => {
    enqueueRefusedDrop();
    s().resolveLimitNotice('proceed', null);
    expect(s().nodes).toHaveLength(1);
    expect(s().importNote?.lines).toEqual([
      { kind: 'budget-scaled', width: 512, height: 256, budgetChars: MAX_IMAGE_ENCODED_CHARS },
    ]);
  });

  it('a cancelled image never shows a "Reduced to…" line', () => {
    enqueueRefusedDrop();
    s().resolveLimitNotice('dismiss', null);
    expect(s().nodes).toHaveLength(0);
    expect(s().importNote).toBeNull();
  });
});

describe('the import note stays quiet without lines', () => {
  it('an empty list posts nothing, and a stale id cannot clear a newer note', () => {
    s().showImportNote([]);
    expect(s().importNote).toBeNull();
    s().showImportNote([{ kind: 'budget-scaled-many', count: 2, budgetChars: MAX_IMAGE_ENCODED_CHARS }]);
    const note = s().importNote!;
    s().dismissImportNote('other-id');
    expect(s().importNote).toBe(note);
    s().dismissImportNote(note.id);
    expect(s().importNote).toBeNull();
  });
});

describe('the two budgets count a shared image differently (the compatibility default)', () => {
  /** A 2M-char payload built on purpose: two nodes holding it hold the SAME image. */
  const X = PREFIX + 'Q'.repeat(2_000_000 - PREFIX.length);
  const withX = (id: string, parentId?: string): AppNode =>
    ({
      ...makeNode(id, 'imageNode', { imageB64: X, fileName: `${id}.png` }),
      ...(parentId ? { parentId } : {}),
    }) as AppNode;

  it('saving a group whose image the library ALREADY holds is not refused, even at the cap', () => {
    useAppStore.setState({
      nodes: [groupNode('g'), withX('m', 'g')],
      savedGroups: [
        {
          id: 'old',
          name: 'Old',
          color: '#abc',
          // The library at exactly its cap: X (2M) plus a different 1M image.
          nodes: [groupNode('og'), withX('om', 'og'), img('fill', MAX_LIBRARY_IMAGE_CHARS - 2_000_000, 'og')],
          edges: [],
        },
      ] as never,
    });
    s().saveGroupToLibrary('g');
    expect(s().savedGroups).toHaveLength(2);
    expect(notices('image-library-cap')).toHaveLength(0);
  });

  it('instantiating a group whose image is already on the canvas is STILL refused (per instance)', () => {
    useAppStore.setState({
      nodes: [withX('live')],
      savedGroups: [
        { id: 'sg', name: 'Textures', color: '#abc', nodes: [groupNode('g'), withX('m', 'g')], edges: [] },
      ] as never,
    });
    s().instantiateSavedGroup('sg', { x: 10, y: 10 });
    expect(s().nodes).toHaveLength(1);
    expect(s().past).toHaveLength(0);
    expect(notices('image-total-cap')).toHaveLength(1);
  });

  it('the menu duplicate carries the same payload and is refused per instance', () => {
    useAppStore.setState({ nodes: [withX('a')] });
    expect(duplicateNodeWithinBudget(s().nodes[0])).toBe(false);
    expect(notices('image-total-cap')).toHaveLength(1);
    s().resolveLimitNotice('proceed', null);
    const [orig, dup] = s().nodes;
    expect(dup.id).not.toBe(orig.id);
    expect((dup.data as { values: Record<string, unknown> }).values.imageB64).toBe(X);
  });
});
