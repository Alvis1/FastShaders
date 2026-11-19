/**
 * A syntax error Babel RECOVERS from is still a syntax error.
 *
 * `codeToGraph` parses with `errorRecovery: true`, so some mistakes do not
 * throw: they land in `ast.errors` and the parse goes on. Nothing read that
 * list, so an Apply of `cosnt extra = float(0.25);` reported `errors: []`,
 * committed the graph without the line and the panel's regeneration then
 * deleted it — a study participant's "Apply TSL deletes code (sometimes when
 * there are syntax errors)", 2026-11-19. A hole in an argument list surfaced
 * as an internal TypeError with no line.
 */
import { describe, it, expect } from 'vitest';
import { codeToGraph } from './codeToGraph';

const wrap = (body: string) =>
  `import { Fn, float, vec3, mix } from 'three/tsl';\n\nconst shader = Fn(() => {\n  const a = vec3(1, 0, 0);\n${body}\n  return { color: a };\n});\n\nexport default shader;\n`;

/** Each is on line 5 of `wrap`'s text. */
const RECOVERED: Array<[string, string]> = [
  ['a mistyped keyword', '  cosnt extra = float(0.25);'],
  ['a missing semicolon between two statements', '  const b = float(0.25) const c = float(0.5);'],
  ['a const with no value', '  const b;'],
  ['a hole in an argument list', '  const b = mix(a,, a);'],
  ['an assignment to a call', '  float(1) = a;'],
];

describe('codeToGraph reports the syntax errors Babel recovers from', () => {
  for (const [name, line] of RECOVERED) {
    it(`${name} blocks the Apply and names its line`, () => {
      const g = codeToGraph(wrap(line));
      expect(g.nodes).toEqual([]);
      expect(g.edges).toEqual([]);
      expect(g.errors.length).toBeGreaterThan(0);
      // Blocking: useSyncEngine commits a parse only when every entry is a warning.
      expect(g.errors.every((e) => e.severity !== 'warning')).toBe(true);
      expect(g.errors[0].line).toBe(5);
      // Babel's own sentence, never an internal exception's.
      expect(g.errors[0].message).not.toMatch(/Cannot read properties/);
    });
  }

  it('the same module without the mistake parses with no error', () => {
    const g = codeToGraph(wrap('  const b = float(0.25);'));
    expect(g.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    expect(g.nodes.length).toBeGreaterThan(0);
  });

  it('a bare shader body keeps its top-level return', () => {
    // Accepted input (the parts tests, a pasted body): its `return` used to be
    // a RECOVERED error, so reporting those needs `allowReturnOutsideFunction`.
    const g = codeToGraph('const a = vec3(1, 0, 0);\nreturn { color: a };');
    expect(g.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    expect(g.nodes.some((n) => n.data.registryType === 'output')).toBe(true);
  });
});
