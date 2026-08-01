import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';

/**
 * Notes are group members like any other node.
 *
 * A note is usually the LABEL for the very cluster being grouped, so excluding
 * it stranded the annotation outside the frame that explains it. Notes stay
 * exempt from the placement rules that would fight their purpose (anti-overlap
 * nudging, drop-on-edge splicing — both live in NodeEditor's drag handlers),
 * but membership itself is type-agnostic.
 */

function note(id: string, x: number, y: number): AppNode {
  return {
    id,
    type: 'note',
    position: { x, y },
    width: 240,
    height: 150,
    dragHandle: '.note-node__header',
    data: { registryType: 'note', heading: 'Note', text: '', color: '#fff7cc', headerColor: '#ffd24a', scale: 1 },
  } as unknown as AppNode;
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  useAppStore.setState({
    nodes: [note('n', 400, 400), makeNode('a', 'mul'), makeNode('b', 'mul')],
    edges: [],
    past: [],
    future: [],
    isUndoRedo: false,
    coalescingHistory: false,
  });
});

describe('groupSelection with notes', () => {
  it('takes a note in as a member', () => {
    const groupId = useAppStore.getState().groupSelection(['a', 'b', 'n']);
    expect(groupId).toBeTruthy();
    const noteNode = useAppStore.getState().nodes.find((n) => n.id === 'n');
    expect(noteNode?.parentId).toBe(groupId);
  });

  it('groups a note together with a single node (2 members incl. the note)', () => {
    // The <2 members guard counts the note, so node+note is a valid group —
    // before, this silently produced nothing.
    const groupId = useAppStore.getState().groupSelection(['a', 'n']);
    expect(groupId).toBeTruthy();
    expect(useAppStore.getState().nodes.find((n) => n.id === 'n')?.parentId).toBe(groupId);
  });

  it('still refuses to nest a group inside a new group', () => {
    useAppStore.setState({
      nodes: [
        { id: 'g', type: 'group', position: { x: 0, y: 0 }, width: 200, height: 100,
          data: { registryType: 'group', label: 'G', color: '#dde', collapsed: false } } as unknown as AppNode,
        note('n', 400, 400),
      ],
    });
    // Only the note qualifies → below the 2-member floor.
    expect(useAppStore.getState().groupSelection(['g', 'n'])).toBeNull();
  });

  it('keeps the group ahead of the note in the array (React Flow parent-before-child)', () => {
    // Notes are PREPENDED by addNote, so a member note starts ahead of any
    // group; groupSelection front-inserts the container to fix that ordering.
    const groupId = useAppStore.getState().groupSelection(['a', 'b', 'n']);
    const ids = useAppStore.getState().nodes.map((n) => n.id);
    expect(ids.indexOf(groupId!)).toBeLessThan(ids.indexOf('n'));
  });

  it('hides a member note when the group collapses, and restores it', () => {
    const groupId = useAppStore.getState().groupSelection(['a', 'b', 'n'])!;
    useAppStore.getState().toggleGroupCollapsed(groupId);
    const collapsed = useAppStore.getState().nodes.find((n) => n.id === 'n');
    expect(collapsed?.className ?? '').toContain('fs-collapsed-member');
    useAppStore.getState().toggleGroupCollapsed(groupId);
    const expanded = useAppStore.getState().nodes.find((n) => n.id === 'n');
    expect(expanded?.className ?? '').not.toContain('fs-collapsed-member');
  });

  it('releases a member note on ungroup', () => {
    const groupId = useAppStore.getState().groupSelection(['a', 'b', 'n'])!;
    useAppStore.getState().ungroup(groupId);
    const noteNode = useAppStore.getState().nodes.find((n) => n.id === 'n');
    expect(noteNode).toBeDefined();
    expect(noteNode?.parentId).toBeUndefined();
  });
});
