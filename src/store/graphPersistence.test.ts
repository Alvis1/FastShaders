import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { useAppStore, setGraphPersistence, cancelPendingGraphSave } from './useAppStore';
import { makeNode } from '@/test-utils';

// Proves the guard node-editor.html relies on: with persistence off, NO store
// mutation may ever reach localStorage['fs:graph'].
describe('setGraphPersistence', () => {
  beforeEach(() => {
    // A previous file in this worker (isolate: false) may have left a real
    // 300ms autosave timer armed — kill it before it can write into the
    // fresh stub mid-test.
    cancelPendingGraphSave();
    vi.useFakeTimers();
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      __store: store,
    });
  });

  // isolate: false shares this worker's globals with later files — leave no
  // fake clock, stubbed storage, or armed save timer behind.
  afterAll(() => {
    cancelPendingGraphSave();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setGraphPersistence(true);
  });

  it('blocks the autosave subscribe when off', () => {
    setGraphPersistence(false);
    useAppStore.getState().setNodes([makeNode('n1', 'sin')], 'graph');
    vi.advanceTimersByTime(1000);
    expect(localStorage.getItem('fs:graph')).toBeNull();
  });

  it('still persists when on (guard is not a one-way kill switch)', () => {
    setGraphPersistence(true);
    useAppStore.getState().setNodes([makeNode('n2', 'cos')], 'graph');
    vi.advanceTimersByTime(1000);
    expect(localStorage.getItem('fs:graph')).not.toBeNull();
    setGraphPersistence(true);
  });
});
