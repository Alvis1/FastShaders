/**
 * Canonical TSL from the internal form, in the built-in presets' exact shape:
 *
 *   import { … } from "three/tsl";
 *
 *   const shader = Fn(() => {
 *     const name = f(a, b);
 *     …
 *     return x;
 *   });
 *   export default shader;
 *
 * Every byte comes from the app's own tables except step NAMES (checked by
 * names.ts before this runs) and NUMBERS (finite, written with String()). No
 * comments and no string other than the import path — so the text carries no
 * FASTSHADERS_PROJECT block for the ADD path to find, and a Fn( wrapper with
 * no `export default function (`, which scriptToTSL passes through untouched.
 */
import { fmtNum, type Arg, type Program, type StepOp } from './ir';

const hex6 = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(6, '0')}`;

export function emitCanonical(p: Program): string {
  const imports = new Set<string>(['Fn']);
  const arg = (a: Arg): string => {
    switch (a.k) {
      case 'ref': return p.steps[a.id].name;
      case 'num': return fmtNum(a.v);
      case 'global': imports.add(a.name); return a.name;
      case 'swz': return `${arg(a.of)}.${a.c}`;
    }
  };
  const expr = (op: StepOp): string => {
    switch (op.op) {
      case 'uniform': imports.add('uniform'); return `uniform(${fmtNum(op.value)})`;
      case 'uniformColor': imports.add('uniform'); imports.add('color'); return `uniform(color(${hex6(op.hex)}))`;
      case 'color': imports.add('color'); return `color(${hex6(op.hex)})`;
      case 'float': imports.add('float'); return `float(${fmtNum(op.v)})`;
      case 'int': imports.add('int'); return `int(${fmtNum(op.v)})`;
      case 'alias': imports.add(op.global); return op.global;
      case 'uv':
        imports.add('uv');
        if (!op.tiling) return 'uv()';
        imports.add('mul');
        imports.add('vec2');
        return `mul(uv(), vec2(${fmtNum(op.tiling[0])}, ${fmtNum(op.tiling[1])}))`;
      case 'time': imports.add('time'); return `time.mul(${arg(op.speed)})`;
      case 'noise': {
        imports.add(op.fn);
        const scale = op.scale.k === 'num' && op.scale.v === 1 ? '' : `.mul(${arg(op.scale)})`;
        return `${op.fn}(${arg(op.pos)}${scale})${op.unsigned ? '.mul(0.5).add(0.5)' : ''}`;
      }
      case 'call': imports.add(op.fn); return `${op.fn}(${op.args.map(arg).join(', ')})`;
    }
  };
  const lines = p.steps.map((s) => `  const ${s.name} = ${expr(s.op)};`);
  const ret = `  return ${arg(p.ret)};`;
  return [
    `import { ${[...imports].sort().join(', ')} } from "three/tsl";`,
    '',
    'const shader = Fn(() => {',
    ...lines,
    ret,
    '});',
    'export default shader;',
    '',
  ].join('\n');
}
