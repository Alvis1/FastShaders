import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore, loadGraph, setGraphPersistence } from './useAppStore';
import type { DrawStroke } from '@/utils/drawings';
import { MAX_STROKES } from '@/utils/drawings';

function stroke(over: Partial<DrawStroke> = {}): DrawStroke {
  return { id: `s${Math.round(over.opacity ?? 0)}`, color: '#ff8800', opacity: 0.5, width: 3, points: [0, 0, 10, 10], ...over };
}

describe('store drawings slice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const mem: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => { mem[k] = v; },
      removeItem: (k: string) => { delete mem[k]; },
    });
    setGraphPersistence(true);
    // Full history reset between scenarios — a prior undo() leaves isUndoRedo
    // true, which (correctly) suppresses the next pushHistory.
    useAppStore.setState({
      drawings: [], nodes: [], edges: [], past: [], future: [],
      isUndoRedo: false, coalescingHistory: false,
    });
  });

  it('addStroke appends and records one undo entry that undo reverses', () => {
    const s = useAppStore.getState();
    s.addStroke(stroke({ id: 'a' }));
    expect(useAppStore.getState().drawings.map((d) => d.id)).toEqual(['a']);
    s.addStroke(stroke({ id: 'b' }));
    expect(useAppStore.getState().drawings.map((d) => d.id)).toEqual(['a', 'b']);

    useAppStore.getState().undo();
    expect(useAppStore.getState().drawings.map((d) => d.id)).toEqual(['a']);
    useAppStore.getState().undo();
    expect(useAppStore.getState().drawings).toEqual([]);
    useAppStore.getState().redo();
    expect(useAppStore.getState().drawings.map((d) => d.id)).toEqual(['a']);
  });

  it('addStroke drops the OLDEST ink past the stroke cap', () => {
    const s = useAppStore.getState();
    for (let i = 0; i < MAX_STROKES + 3; i++) s.addStroke(stroke({ id: `k${i}` }));
    const ids = useAppStore.getState().drawings.map((d) => d.id);
    expect(ids.length).toBe(MAX_STROKES);
    expect(ids[0]).toBe('k3');                       // k0..k2 dropped (oldest)
    expect(ids[ids.length - 1]).toBe(`k${MAX_STROKES + 2}`);
  });

  it('eraseStrokeIds removes only the named strokes, one undo entry', () => {
    const s = useAppStore.getState();
    s.setDrawings([stroke({ id: 'a' }), stroke({ id: 'b' }), stroke({ id: 'c' })]);
    s.eraseStrokeIds(['b']);
    expect(useAppStore.getState().drawings.map((d) => d.id)).toEqual(['a', 'c']);
    useAppStore.getState().undo();
    expect(useAppStore.getState().drawings.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('clearDrawings empties and undoes back', () => {
    const s = useAppStore.getState();
    s.setDrawings([stroke({ id: 'a' }), stroke({ id: 'b' })]);
    s.clearDrawings();
    expect(useAppStore.getState().drawings).toEqual([]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().drawings.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('a graph-only edit does not disturb drawings but its undo preserves them', () => {
    const s = useAppStore.getState();
    s.setDrawings([stroke({ id: 'ink' })]);
    // simulate a graph mutation with its own history push
    useAppStore.getState().pushHistory();
    useAppStore.setState({ nodes: [], edges: [] });
    expect(useAppStore.getState().drawings.map((d) => d.id)).toEqual(['ink']);
    useAppStore.getState().undo();
    expect(useAppStore.getState().drawings.map((d) => d.id)).toEqual(['ink']);
  });

  it('drawings round-trip through the fs:graph autosave', () => {
    const s = useAppStore.getState();
    s.addStroke(stroke({ id: 'persisted', opacity: 0.35, color: '#00aaff' }));
    vi.advanceTimersByTime(1000); // debounced saveGraph fires
    const reloaded = loadGraph();
    expect(reloaded?.drawings.map((d) => d.id)).toEqual(['persisted']);
    expect(reloaded?.drawings[0].opacity).toBe(0.35);
    expect(reloaded?.drawings[0].color).toBe('#00aaff');
  });

  it('setDrawColor rejects non-hex, setDrawOpacity clamps', () => {
    const s = useAppStore.getState();
    s.setDrawColor('#abcdef');
    expect(useAppStore.getState().drawColor).toBe('#abcdef');
    s.setDrawColor('red');                            // rejected → unchanged
    expect(useAppStore.getState().drawColor).toBe('#abcdef');
    s.setDrawOpacity(5);
    expect(useAppStore.getState().drawOpacity).toBe(1);
    s.setDrawOpacity(-1);
    expect(useAppStore.getState().drawOpacity).toBe(0.05);
  });

  it('leaving draw mode clears the eraser sub-mode', () => {
    const s = useAppStore.getState();
    s.setDrawToolActive(true);
    s.setDrawEraser(true);
    s.setDrawToolActive(false);
    expect(useAppStore.getState().drawEraser).toBe(false);
    expect(useAppStore.getState().drawToolActive).toBe(false);
  });
});
