/**
 * The shader-scoped palette slice: CRUD + history + the `fs:graph` payload.
 *
 * The load-bearing test here is `records even while a colour-pick bracket is
 * open`. Every palette action snapshots INLINE instead of calling
 * `pushHistory`, because `pushHistory` hard-bails while `coalescingHistory` is
 * set and `useHistoryBracket` (the colour picker) holds that bracket open for a
 * 600 ms idle window AFTER a pick. Delegating would make "pick a colour, then
 * save it as a palette" — the single most likely real sequence — silently
 * unrecordable, with the next Cmd+Z jumping back past the pick.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { useAppStore, loadGraph, setGraphPersistence, cancelPendingGraphSave } from './useAppStore';
import {
  MAX_PALETTES_PER_SHADER,
  MAX_COLORS_PER_PALETTE,
  MAX_COLOR_NAME,
  type Palette,
} from '@/utils/palettes';
import { makeNode } from '@/test-utils';
import { getNodeValues } from '@/types';

const ids = () => useAppStore.getState().shaderPalettes.map((p) => p.id);
const names = () => useAppStore.getState().shaderPalettes.map((p) => p.name);
const list = () => useAppStore.getState().shaderPalettes;
const pastLen = () => useAppStore.getState().past.length;

/** Seed the slice directly (setShaderPalettes is the no-history path). */
function seed(...palettes: Palette[]): void {
  useAppStore.getState().setShaderPalettes(palettes);
  useAppStore.setState({ past: [], future: [] });
}

describe('store palette slice', () => {
  // isolate: false shares this worker's globals with later files — leave no
  // fake clock, stubbed storage, or armed save timer behind.
  afterAll(() => {
    cancelPendingGraphSave();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useAppStore.setState({
      shaderPalettes: [], drawings: [], nodes: [], edges: [], past: [], future: [],
      coalescingHistory: false, interactionDepth: 0, isUndoRedo: false,
    });
  });

  beforeEach(() => {
    cancelPendingGraphSave();
    vi.useFakeTimers();
    const mem: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => { mem[k] = v; },
      removeItem: (k: string) => { delete mem[k]; },
    });
    setGraphPersistence(true);
    // Full reset — a prior undo() leaves isUndoRedo true, and a prior gesture
    // could leave a bracket open.
    useAppStore.setState({
      shaderPalettes: [], drawings: [], nodes: [], edges: [], past: [], future: [],
      isUndoRedo: false, coalescingHistory: false, interactionDepth: 0,
    });
  });

  describe('addPalette', () => {
    it('appends one sanitized palette as exactly ONE undo entry', () => {
      const id = useAppStore.getState().addPalette({ name: 'Sunset', colors: ['#FF0000', 'red', '#00ff00'] });
      expect(id).toBeTruthy();
      expect(pastLen()).toBe(1);
      expect(list()).toEqual([{ id, name: 'Sunset', colors: ['#ff0000', '#00ff00'] }]);

      useAppStore.getState().undo();
      expect(list()).toEqual([]);
      useAppStore.getState().redo();
      expect(ids()).toEqual([id]);
    });

    it('refuses a palette with no usable colour, and records nothing', () => {
      expect(useAppStore.getState().addPalette({ name: 'x', colors: ['red', 'nope'] })).toBeNull();
      expect(list()).toEqual([]);
      expect(pastLen()).toBe(0);
    });

    it('caps colours per palette and palettes per shader', () => {
      useAppStore.getState().addPalette({
        colors: Array.from({ length: MAX_COLORS_PER_PALETTE + 50 }, () => '#123456'),
      });
      expect(list()[0].colors).toHaveLength(MAX_COLORS_PER_PALETTE);

      useAppStore.setState({ shaderPalettes: [], past: [] });
      for (let i = 0; i < MAX_PALETTES_PER_SHADER; i++) {
        expect(useAppStore.getState().addPalette({ colors: ['#ff0000'] })).toBeTruthy();
      }
      // Full: refused outright rather than dropping the oldest — a palette is
      // authored content, not ink.
      expect(useAppStore.getState().addPalette({ colors: ['#ff0000'] })).toBeNull();
      expect(list()).toHaveLength(MAX_PALETTES_PER_SHADER);
      expect(pastLen()).toBe(MAX_PALETTES_PER_SHADER);
    });

    it('carries per-colour names through, and omits the key when nothing is labelled', () => {
      const id = useAppStore.getState().addPalette({
        name: 'Metals',
        colors: ['#FFE39D', '#fcfcfc'],
        names: ['Gold', 'Silver'],
      });
      expect(list()).toEqual([
        { id, name: 'Metals', colors: ['#ffe39d', '#fcfcfc'], names: ['Gold', 'Silver'] },
      ]);

      // An unlabelled palette keeps NO `names` key at all — that omission is
      // the whole back-compat story, so it is asserted on presence rather than
      // on value (toEqual treats an undefined property as absent).
      const bare = useAppStore.getState().addPalette({ name: 'Bare', colors: ['#ff0000'], names: ['', '  '] });
      expect(list()[1]).toEqual({ id: bare, name: 'Bare', colors: ['#ff0000'] });
      expect('names' in list()[1]).toBe(false);
    });

    it('never adopts an id already in the shader (a project import can seed one)', () => {
      // sanitizePalettes de-dupes within its own batch only.
      seed({ id: 'pal1_abc', name: 'imported', colors: ['#ff0000'] });
      const id = useAppStore.getState().addPalette({ colors: ['#00ff00'] });
      expect(id).not.toBe('pal1_abc');
      expect(new Set(ids()).size).toBe(2);
    });
  });

  describe('updatePalette', () => {
    beforeEach(() => seed({ id: 'p1', name: 'One', colors: ['#ff0000'] }));

    it('renames and recolours in ONE undo entry', () => {
      useAppStore.getState().updatePalette('p1', { name: 'Renamed', colors: ['#00ff00', '#0000ff'] });
      expect(pastLen()).toBe(1);
      expect(list()).toEqual([{ id: 'p1', name: 'Renamed', colors: ['#00ff00', '#0000ff'] }]);

      useAppStore.getState().undo();
      expect(list()).toEqual([{ id: 'p1', name: 'One', colors: ['#ff0000'] }]);
      useAppStore.getState().redo();
      expect(names()).toEqual(['Renamed']);
    });

    it('sanitizes the name and the colours', () => {
      // A bidi override in a label reorders the surrounding UI text.
      useAppStore.getState().updatePalette('p1', { name: 'a\u202eb', colors: ['#ABCDEF', 'nope'] });
      expect(list()[0]).toEqual({ id: 'p1', name: 'ab', colors: ['#abcdef'] });
    });

    it('is a no-op (and pushes NO history) for an unknown id, a no-change patch, or an all-invalid recolour', () => {
      useAppStore.getState().updatePalette('nope', { name: 'x' });
      useAppStore.getState().updatePalette('p1', { name: 'One' });
      useAppStore.getState().updatePalette('p1', { colors: ['#ff0000'] });
      useAppStore.getState().updatePalette('p1', { colors: ['not-a-colour'] });
      expect(pastLen()).toBe(0);
      expect(list()).toEqual([{ id: 'p1', name: 'One', colors: ['#ff0000'] }]);
    });
  });

  describe('updatePalette keeps `colors` and `names` aligned', () => {
    // `names[i]` labels `colors[i]`. Every one of these is about the pair
    // moving in lockstep: a label left on the wrong swatch, or silently
    // dropped, looks exactly like working software.

    it('a plain RENAME keeps the labels', () => {
      // THE defect this suite exists for: updatePalette rebuilt the row as
      // `{id, name, colors}`, so every edit — including one that never touched
      // a colour — erased every per-colour label the user had typed. Renaming
      // a palette is the cheapest, most innocent-looking way to lose them.
      seed({ id: 'p1', name: 'Metals', colors: ['#ffe39d', '#fcfcfc'], names: ['Gold', 'Silver'] });
      useAppStore.getState().updatePalette('p1', { name: 'Alloys' });
      expect(list()).toEqual([
        { id: 'p1', name: 'Alloys', colors: ['#ffe39d', '#fcfcfc'], names: ['Gold', 'Silver'] },
      ]);

      // Same for a recolour that carries no `names` patch: the labels belong to
      // the palette, not to the patch that happens to be in flight.
      useAppStore.getState().updatePalette('p1', { colors: ['#b87333', '#fcfcfc'] });
      expect(list()[0]).toEqual({
        id: 'p1', name: 'Alloys', colors: ['#b87333', '#fcfcfc'], names: ['Gold', 'Silver'],
      });
    });

    it('a names-ONLY edit really writes, as exactly ONE undo entry', () => {
      // The `unchanged` short-circuit compares names too. Comparing only the
      // palette name and the colours would make labelling a swatch a no-op —
      // the write is refused and the typed label vanishes on the next render.
      seed({ id: 'p1', name: 'Metals', colors: ['#ffe39d', '#fcfcfc'] });
      useAppStore.getState().updatePalette('p1', { names: ['Gold', ''] });
      expect(pastLen()).toBe(1);
      expect(list()[0]).toEqual({
        id: 'p1', name: 'Metals', colors: ['#ffe39d', '#fcfcfc'], names: ['Gold', ''],
      });

      useAppStore.getState().undo();
      expect(list()[0].names).toBeUndefined();
      useAppStore.getState().redo();
      expect(list()[0].names).toEqual(['Gold', '']);
    });

    it('re-committing the SAME labels still pushes nothing', () => {
      seed({ id: 'p1', name: 'Metals', colors: ['#ffe39d'], names: ['Gold'] });
      useAppStore.getState().updatePalette('p1', { names: ['Gold'] });
      useAppStore.getState().updatePalette('p1', { name: 'Metals', colors: ['#ffe39d'], names: ['Gold'] });
      expect(pastLen()).toBe(0);
      expect(list()[0].names).toEqual(['Gold']);
    });

    it('clearing the last label drops the key, and that IS a change', () => {
      // The palette goes back to the pre-names shape, so its stored bytes go
      // back with it — but the user did do something, so it must be undoable.
      seed({ id: 'p1', name: 'Metals', colors: ['#ffe39d'], names: ['Gold'] });
      useAppStore.getState().updatePalette('p1', { names: [''] });
      expect(pastLen()).toBe(1);
      expect('names' in list()[0]).toBe(false);
      useAppStore.getState().undo();
      expect(list()[0].names).toEqual(['Gold']);
    });

    it('patches colours and names through ONE sanitizer call, so a rejected colour drops its OWN label', () => {
      // Two sanitizer calls would leave ['#ff0000', '#0000ff'] beside
      // ['Red', 'Bogus', 'Blue'] and label the blue swatch "Bogus" — every
      // later name shifted by one, which is the silent misalignment the
      // single-loop shape exists to prevent.
      seed({ id: 'p1', name: 'One', colors: ['#000000'] });
      useAppStore.getState().updatePalette('p1', {
        colors: ['#ff0000', 'not-a-colour', '#0000ff'],
        names: ['Red', 'Bogus', 'Blue'],
      });
      expect(list()[0].colors).toEqual(['#ff0000', '#0000ff']);
      expect(list()[0].names).toEqual(['Red', 'Blue']);
    });

    it('truncating the colours truncates the labels with them', () => {
      // The cap is applied inside that same loop, so the tail cannot survive
      // as an over-long `names` array pointing past the last swatch.
      seed({ id: 'p1', name: 'One', colors: ['#000000'] });
      useAppStore.getState().updatePalette('p1', {
        colors: Array.from({ length: MAX_COLORS_PER_PALETTE + 5 }, () => '#123456'),
        names: Array.from({ length: MAX_COLORS_PER_PALETTE + 5 }, (_, i) => `c${i}`),
      });
      expect(list()[0].colors).toHaveLength(MAX_COLORS_PER_PALETTE);
      expect(list()[0].names).toHaveLength(MAX_COLORS_PER_PALETTE);
    });

    it('sends each label through the same boundary a palette name gets', () => {
      // The store must not patch labels raw: they are rendered, and they are
      // written into the line-oriented `.gpl` export, where an unstripped
      // newline forges a colour row.
      seed({ id: 'p1', name: 'One', colors: ['#ff0000', '#00ff00', '#0000ff'] });
      useAppStore.getState().updatePalette('p1', {
        names: ['Go\u202eld', 'Deep\u0009Gold', 'x'.repeat(MAX_COLOR_NAME + 10)],
      });
      expect(list()[0].names).toEqual(['Gold', 'Deep Gold', 'x'.repeat(MAX_COLOR_NAME)]);
    });
  });

  describe('deletePalette', () => {
    it('removes one palette as ONE undo entry that restores it', () => {
      seed(
        { id: 'p1', name: 'One', colors: ['#ff0000'] },
        { id: 'p2', name: 'Two', colors: ['#00ff00'] },
      );
      useAppStore.getState().deletePalette('p1');
      expect(pastLen()).toBe(1);
      expect(ids()).toEqual(['p2']);

      useAppStore.getState().undo();
      expect(ids()).toEqual(['p1', 'p2']);
      useAppStore.getState().redo();
      expect(ids()).toEqual(['p2']);
    });

    it('is a no-op for an unknown id', () => {
      seed({ id: 'p1', name: 'One', colors: ['#ff0000'] });
      useAppStore.getState().deletePalette('ghost');
      expect(pastLen()).toBe(0);
      expect(ids()).toEqual(['p1']);
    });
  });

  describe('reorderPalette', () => {
    beforeEach(() =>
      seed(
        { id: 'a', name: 'A', colors: ['#ff0000'] },
        { id: 'b', name: 'B', colors: ['#00ff00'] },
        { id: 'c', name: 'C', colors: ['#0000ff'] },
      ));

    it('moves a palette as ONE undo entry', () => {
      useAppStore.getState().reorderPalette('c', 0);
      expect(pastLen()).toBe(1);
      expect(ids()).toEqual(['c', 'a', 'b']);
      useAppStore.getState().undo();
      expect(ids()).toEqual(['a', 'b', 'c']);
    });

    it('clamps a drag past either end and no-ops on same-slot / unknown / junk', () => {
      useAppStore.getState().reorderPalette('a', 99);
      expect(ids()).toEqual(['b', 'c', 'a']);
      const entries = pastLen();
      useAppStore.getState().reorderPalette('a', 2);            // already there
      useAppStore.getState().reorderPalette('ghost', 0);
      useAppStore.getState().reorderPalette('b', Number.NaN);
      expect(pastLen()).toBe(entries);
      expect(ids()).toEqual(['b', 'c', 'a']);
    });
  });

  describe('setShaderPalettes', () => {
    it('replaces the list WITHOUT history (load / import / undo internals)', () => {
      useAppStore.getState().setShaderPalettes([{ id: 'z', name: 'Z', colors: ['#ff0000'] }]);
      expect(ids()).toEqual(['z']);
      expect(pastLen()).toBe(0);
    });
  });

  describe('THE TRAP: a live colour-pick bracket must not swallow a palette edit', () => {
    it('pushHistory really is suppressed while the bracket is open (the hazard)', () => {
      // Documents WHY the actions snapshot inline. useHistoryBracket holds this
      // bracket for 600 ms of idle after the last colour-picker input event.
      useAppStore.getState().beginInteraction();
      const after = pastLen();
      useAppStore.getState().pushHistory();
      expect(pastLen()).toBe(after);
    });

    it('addPalette records and stays undoable inside an open bracket', () => {
      // The real sequence: pick a colour on a node (PaletteColorPicker brackets
      // it), then — inside the 600 ms idle window — save that colour as a
      // palette.
      useAppStore.setState({ nodes: [makeNode('c1', 'color', { hex: '#ff0000' })] });
      seed({ id: 'p1', name: 'One', colors: ['#ff0000'] });

      useAppStore.getState().beginInteraction();   // the colour pick's bracket
      useAppStore.setState({ nodes: [makeNode('c1', 'color', { hex: '#00ff00' })] });
      expect(pastLen()).toBe(1);                   // the pick's own entry

      const id = useAppStore.getState().addPalette({ name: 'Picked', colors: ['#00ff00'] });
      expect(id).toBeTruthy();
      expect(pastLen()).toBe(2);                   // OUR entry, on top of the pick's

      useAppStore.getState().endInteraction();
      useAppStore.getState().undo();
      // Undo lands on the palette add ...
      expect(ids()).toEqual(['p1']);
      // ... and NOT past the colour pick, which keeps its new value.
      expect(getNodeValues(useAppStore.getState().nodes[0]).hex).toBe('#00ff00');
    });

    it('update / delete / reorder record inside an open bracket too', () => {
      seed(
        { id: 'p1', name: 'One', colors: ['#ff0000'] },
        { id: 'p2', name: 'Two', colors: ['#00ff00'] },
      );
      useAppStore.getState().beginInteraction();
      const base = pastLen();

      useAppStore.getState().updatePalette('p1', { name: 'Edited' });
      useAppStore.getState().reorderPalette('p1', 1);
      useAppStore.getState().deletePalette('p2');
      expect(pastLen()).toBe(base + 3);

      useAppStore.getState().endInteraction();
      useAppStore.getState().undo();
      expect(ids()).toEqual(['p2', 'p1']);
      useAppStore.getState().undo();
      expect(ids()).toEqual(['p1', 'p2']);
      useAppStore.getState().undo();
      expect(names()).toEqual(['One', 'Two']);
    });

    it('records even while isUndoRedo is still set', () => {
      // The other half of pushHistory's bail: an undo whose sync reconciliation
      // has not run yet must not make the next palette edit unrecoverable.
      seed({ id: 'p1', name: 'One', colors: ['#ff0000'] });
      useAppStore.setState({ isUndoRedo: true });
      useAppStore.getState().deletePalette('p1');
      expect(pastLen()).toBe(1);
      useAppStore.getState().undo();
      expect(ids()).toEqual(['p1']);
    });
  });

  describe('history rides BY REFERENCE, like drawings', () => {
    it('a graph-only edit leaves palettes alone and its undo preserves them', () => {
      seed({ id: 'p1', name: 'One', colors: ['#ff0000'] });
      const before = list();
      useAppStore.getState().pushHistory();
      useAppStore.setState({ nodes: [], edges: [] });
      useAppStore.getState().undo();
      // Same ARRAY, not a structuredClone of it.
      expect(useAppStore.getState().shaderPalettes).toBe(before);
    });
  });

  describe('fs:graph payload', () => {
    it('round-trips palettes through the autosave', () => {
      useAppStore.getState().addPalette({ name: 'Persisted', colors: ['#ff0000', '#00ff00'] });
      vi.advanceTimersByTime(1000);                // debounced saveGraph fires
      const reloaded = loadGraph();
      expect(reloaded?.palettes).toHaveLength(1);
      expect(reloaded?.palettes[0].name).toBe('Persisted');
      expect(reloaded?.palettes[0].colors).toEqual(['#ff0000', '#00ff00']);
    });

    it('round-trips per-colour names', () => {
      useAppStore.getState().addPalette({
        name: 'Metals', colors: ['#ffe39d', '#fcfcfc'], names: ['Gold', ''],
      });
      vi.advanceTimersByTime(1000);
      expect(loadGraph()?.palettes[0].names).toEqual(['Gold', '']);
    });

    it('writes an UNLABELLED palette exactly as a pre-names build did', () => {
      // The other half of the omission rule: no `"names": []` in the stored
      // JSON, so a shader whose palettes carry no labels keeps saving the bytes
      // it always saved.
      seed({ id: 'p1', name: 'Bare', colors: ['#ff0000'] });
      useAppStore.getState().setNodes([], 'graph');
      vi.advanceTimersByTime(1000);
      expect(localStorage.getItem('fs:graph')).toBe(JSON.stringify({
        nodes: [], edges: [], palettes: [{ id: 'p1', name: 'Bare', colors: ['#ff0000'] }],
      }));
    });

    it('omits the key entirely when the shader has none (pre-palette payload, byte for byte)', () => {
      useAppStore.getState().setNodes([], 'graph');
      vi.advanceTimersByTime(1000);
      expect(localStorage.getItem('fs:graph')).toBe(JSON.stringify({ nodes: [], edges: [] }));
      expect(loadGraph()?.palettes).toEqual([]);
    });

    it('sanitizes a TAMPERED fs:graph value on load', () => {
      // localStorage is user-writable; names are rendered and ids become React
      // keys / object lookups.
      localStorage.setItem('fs:graph', JSON.stringify({
        nodes: [],
        edges: [],
        palettes: [
          { id: '__proto__', name: 'ev\u202eil', colors: ['#FF0000', 'red', '#abc', '#00ff00'] },
          { id: 'has space', name: 'ok', colors: ['#0000ff'] },
          { name: 'colourless', colors: ['nope'] },
          ...Array.from({ length: 100 }, () => ({ name: 'flood', colors: ['#111111'] })),
        ],
      }));

      const out = loadGraph()!.palettes;
      expect(out).toHaveLength(MAX_PALETTES_PER_SHADER);
      expect(out[0].id).not.toBe('__proto__');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(out[0].name).toBe('evil');
      expect(out[0].colors).toEqual(['#ff0000', '#00ff00']);
      expect(out[1].id).not.toBe('has space');
      expect(out.map((p) => p.name)).not.toContain('colourless');
      expect(new Set(out.map((p) => p.id)).size).toBe(out.length);
    });

    it('survives a non-array palettes value', () => {
      localStorage.setItem('fs:graph', JSON.stringify({ nodes: [], edges: [], palettes: 'boom' }));
      expect(loadGraph()?.palettes).toEqual([]);
    });
  });
});
