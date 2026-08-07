import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from './useAppStore';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';

/**
 * `updateNodeData` is the authoring CHOKEPOINT: it is the only path a node
 * widget or a settings menu takes, and the only one allowed to outrank a value
 * the user tuned in the preview's Uniforms overlay. Everything else (import,
 * undo/redo, the code→graph sync, "Set as default") goes through `setNodes` and
 * must stay silent — otherwise the tuning the overlay exists to hold would be
 * destroyed by ordinary graph churn.
 */
describe('updateNodeData → fs:uniform-authored', () => {
  let dispatched: { type: string; detail: unknown }[];

  beforeEach(() => {
    cancelPendingGraphSave();
    dispatched = [];
    vi.stubGlobal('window', {
      dispatchEvent: (e: CustomEvent) => {
        dispatched.push({ type: e.type, detail: e.detail });
        return true;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    useAppStore.setState({
      nodes: [
        makeNode('p1', 'property_float', { name: 'cutoff', value: 0.2 }),
        makeNode('c1', 'property_color', { name: 'tint', hex: '#ff0000' }),
        makeNode('f1', 'float', { value: 3 }),
      ] as AppNode[],
      edges: [],
      nodeVarNames: { p1: 'cutoff', c1: 'tint' },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cancelPendingGraphSave();
  });

  const events = () => dispatched.filter((d) => d.type === 'fs:uniform-authored');

  it('announces a float property value edit under its emitted name', () => {
    useAppStore.getState().updateNodeData('p1', { values: { name: 'cutoff', value: 0.9 } });
    expect(events()).toEqual([{ type: 'fs:uniform-authored', detail: { name: 'cutoff', value: 0.9 } }]);
  });

  it('announces a colour property edit as a hex string', () => {
    useAppStore.getState().updateNodeData('c1', { values: { name: 'tint', hex: '#00ff00' } });
    expect(events()).toEqual([{ type: 'fs:uniform-authored', detail: { name: 'tint', value: '#00ff00' } }]);
  });

  it('stays silent when the patch carries no `values` at all', () => {
    // The gate that keeps the common case (label / exposedPorts / settings
    // patches) from paying for a node lookup on every call.
    useAppStore.getState().updateNodeData('p1', { label: 'renamed' });
    expect(events()).toEqual([]);
  });

  it('stays silent for a non-property node', () => {
    useAppStore.getState().updateNodeData('f1', { values: { value: 7 } });
    expect(events()).toEqual([]);
  });

  it('stays silent for a rename that leaves the value alone', () => {
    useAppStore.getState().updateNodeData('p1', { values: { name: 'threshold', value: 0.2 } });
    expect(events()).toEqual([]);
  });

  it('stays silent for setNodes — import, undo/redo, code sync, Set-as-default', () => {
    const edited = useAppStore.getState().nodes.map((n) =>
      n.id === 'p1' ? { ...n, data: { ...n.data, values: { name: 'cutoff', value: 0.5 } } } : n
    ) as AppNode[];
    useAppStore.getState().setNodes(edited, 'graph');
    expect(events()).toEqual([]);
  });
});
