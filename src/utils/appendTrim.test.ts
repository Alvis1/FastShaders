/**
 * Append says when a wire does not fit.
 *
 * `append(vec3, vec3)` is emitted as `vec4(a, b.x)` — the vector holds four
 * channels, so the emitter trims the overflow. Nothing on the canvas showed it:
 * a study participant wired Time into the second vector's Z, saw no change and
 * reported "vector add seemed not to work" (2026-11-19). `appendTrimmedOperands`
 * is the canvas's copy of the emitter's walk, so the first block holds the two
 * together against the EMITTED text; the second pins the note `connectNodes`
 * posts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { appendTrimmedOperands, type ChannelOf } from './appendCapacity';
import { importNoteLineText } from './importNote';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from '@/engine/graphToCode';
import { connectNodes } from '@/components/NodeEditor/edgeInsert';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeNode, makeEdge, makeKnot, HISTORY_IDLE } from '@/test-utils';

const APPEND = NODE_REGISTRY.get('append')!;
const WIDTH: Record<string, number> = { float: 1, vec2: 2, vec3: 3, vec4: 4 };
const PORTS = ['a', 'b', 'c', 'd'];

/** Every way to wire 2–4 constant sources into Append's sockets, in order. */
function* combos(): Generator<string[]> {
  const types = Object.keys(WIDTH);
  for (let n = 2; n <= 4; n++) {
    const idx = new Array(n).fill(0);
    for (;;) {
      yield idx.map((i) => types[i]);
      let k = n - 1;
      while (k >= 0 && ++idx[k] === types.length) idx[k--] = 0;
      if (k < 0) break;
    }
  }
}

describe('appendTrimmedOperands agrees with the emitted constructor', () => {
  for (const types of combos()) {
    it(`append(${types.join(', ')})`, () => {
      const sources = types.map((t, i) => makeNode(`s${i}`, t));
      const nodes = [...sources, makeNode('ap', 'append'), makeNode('o', 'output')];
      const edges = [
        ...types.map((_, i) => makeEdge(`s${i}`, 'out', 'ap', PORTS[i])),
        makeEdge('ap', 'out', 'o', 'color'),
      ];
      const out = graphToCode(nodes, edges);
      const name = (id: string) => out.varNames.get(id)!;
      const line = out.code.split('\n').find((l) => l.includes(`const ${name('ap')} = `))!;
      const args = line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')).split(', ');

      const channelOf: ChannelOf = (port) => {
        const i = PORTS.indexOf(port);
        return i >= 0 && i < types.length ? WIDTH[types[i]] : undefined;
      };
      const trims = appendTrimmedOperands(APPEND, PORTS.slice(0, types.length), [], channelOf);
      const byPort = new Map(trims.map((x) => [x.portId, x]));

      types.forEach((t, i) => {
        const trim = byPort.get(PORTS[i]);
        const v = name(`s${i}`);
        if (!trim) expect(args, `${v} whole`).toContain(v);
        else if (trim.kept > 0) {
          expect(args, `${v} trimmed`).toContain(`${v}.${'xyzw'.slice(0, trim.kept)}`);
          expect(trim.of).toBe(WIDTH[t]);
        } else expect(args.some((a) => a === v || a.startsWith(`${v}.`)), `${v} dropped`).toBe(false);
      });
    });
  }

  it('reports nothing for a node that folds its operands', () => {
    expect(appendTrimmedOperands(NODE_REGISTRY.get('add'), ['a', 'b'], [], () => 4)).toEqual([]);
    expect(appendTrimmedOperands(undefined, ['a', 'b'], [], () => 4)).toEqual([]);
  });

  it('an unwired operand past the limit is not news', () => {
    // vec4 into `a`: `b` is unwired, and its `0` simply is not emitted.
    expect(appendTrimmedOperands(APPEND, ['a'], [], (p) => (p === 'a' ? 4 : undefined))).toEqual([]);
  });
});

describe('the note a wire into a full Append posts', () => {
  beforeEach(() => {
    cancelPendingGraphSave();
    useAppStore.setState({
      nodes: [makeNode('pos', 'positionGeometry'), makeNode('v', 'vec3'), makeNode('f', 'float'), makeNode('ap', 'append'), makeNode('o', 'output')],
      edges: [],
      importNote: null,
      nodeVarNames: Object.assign(Object.create(null), { v: 'vec31', f: 'float1', pos: 'positionGeometry1' }),
      ...HISTORY_IDLE,
    });
  });

  const note = () => useAppStore.getState().importNote?.lines ?? null;

  it('says which part of the trimmed vector is used', () => {
    connectNodes('pos', 'out', 'ap', 'a');
    expect(note()).toBeNull();
    connectNodes('v', 'out', 'ap', 'b');
    expect(note()).toEqual([{ kind: 'append-trimmed', name: 'vec31', kept: 1 }]);
    expect(importNoteLineText(note()![0], 'en')).toBe('Append holds 4 numbers: only X of “vec31” is used');
    expect(importNoteLineText(note()![0], 'lv')).toBe('Mezglā “Apvienot” ietilpst 4 skaitļi: no “vec31” izmanto tikai X');
  });

  it('names the wire that was pushed out when the new one fits', () => {
    connectNodes('v', 'out', 'ap', 'b');
    expect(note()).toBeNull();
    // Position (3) into `a` now leaves `b` one channel of its three.
    connectNodes('pos', 'out', 'ap', 'a');
    expect(note()).toEqual([{ kind: 'append-trimmed', name: 'vec31', kept: 1 }]);
  });

  it('a wire into a Branch that feeds the Append says so too', () => {
    useAppStore.setState({ nodes: [...useAppStore.getState().nodes, makeKnot('k')] });
    connectNodes('pos', 'out', 'ap', 'a');
    connectNodes('k', 'out', 'ap', 'b');
    expect(note()).toBeNull();
    connectNodes('v', 'out', 'k', 'in');
    expect(note()).toEqual([{ kind: 'append-trimmed', name: 'vec31', kept: 1 }]);
  });

  it('a wire that fits says nothing', () => {
    connectNodes('pos', 'out', 'ap', 'a');
    connectNodes('f', 'out', 'ap', 'b');
    expect(note()).toBeNull();
  });

  it('never replaces a note that is still up', () => {
    useAppStore.getState().showImportNote([{ kind: 'export-left-out', count: 2 }]);
    connectNodes('pos', 'out', 'ap', 'a');
    connectNodes('v', 'out', 'ap', 'b');
    expect(note()).toEqual([{ kind: 'export-left-out', count: 2 }]);
  });

  it('a dropped operand and a long or non-string name still print', () => {
    expect(importNoteLineText({ kind: 'append-trimmed', name: 'float1', kept: 0 }, 'en')).toBe('Append holds 4 numbers: “float1” does not fit');
    expect(importNoteLineText({ kind: 'append-trimmed', name: 'float1', kept: 0 }, 'lv')).toBe('Mezglā “Apvienot” ietilpst 4 skaitļi: “float1” tajā vairs neietilpst');
    const long = importNoteLineText({ kind: 'append-trimmed', name: 'n'.repeat(200), kept: 2 }, 'en');
    expect(long.length).toBeLessThan(100);
    expect(long).toContain('only XY of');
    expect(importNoteLineText({ kind: 'append-trimmed', name: 5 as unknown as string, kept: 9 }, 'en')).toContain('only XYZ of “”');
  });
});
