/**
 * The program inside a pasted AI reply (utils/replyProgram.ts): Apply reads
 * the code out of a ```js fence, so a whole reply can be pasted into the TSL
 * panel. Real code — which may hold backticks of its own — is never cut.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { programInReply } from './replyProgram';
import { codeToGraph } from '@/engine/codeToGraph';
import { loadUnknownExpressionValidator } from '@/engine/unknownExpression';
import { EXTERNAL_EXAMPLE } from '@/llm/externalPrompt';
import { readFileSync } from 'node:fs';
import path from 'node:path';

beforeAll(() => loadUnknownExpressionValidator());

const PROGRAM = EXTERNAL_EXAMPLE.code;
const fence = (code: string, lang = 'js') => `\`\`\`${lang}\n${code}\n\`\`\``;

describe('a reply with the program in a fence', () => {
  it('is the program, whatever stands around it', () => {
    expect(programInReply(`Here is the shader:\n\n${fence(PROGRAM)}\n\nIt drifts slowly.`)).toBe(PROGRAM);
    expect(programInReply(fence(PROGRAM))).toBe(PROGRAM);
    expect(programInReply(fence(PROGRAM, 'javascript'))).toBe(PROGRAM);
    expect(programInReply(fence(PROGRAM, ''))).toBe(PROGRAM);
    expect(programInReply(`  ${fence(PROGRAM).replace(/\n```$/, '\n  ```')}`)).toBe(PROGRAM);
  });

  it('keeps Windows line ends inside the program and drops only the last one', () => {
    const crlf = PROGRAM.replace(/\n/g, '\r\n');
    expect(programInReply(`Plan.\r\n\`\`\`js\r\n${crlf}\r\n\`\`\`\r\n`)).toBe(crlf);
  });

  it('with several blocks, is the last one that returns something — else the last', () => {
    const install = fence('npm install three', 'bash');
    expect(programInReply(`${install}\n\n${fence(PROGRAM)}\n\nThen run:\n\n${install}`)).toBe(PROGRAM);
    expect(programInReply(`${fence('const a = 1;')}\n${fence('const b = 2;')}`)).toBe('const b = 2;');
    const second = PROGRAM.replace('0.3', '0.9');
    expect(programInReply(`${fence(PROGRAM)}\nA shinier one:\n${fence(second)}`)).toBe(second);
  });

  it('is what Apply then parses: the same graph as the bare program', () => {
    const bare = codeToGraph(PROGRAM);
    const pasted = codeToGraph(programInReply(`Sure!\n\n${fence(PROGRAM)}\n`)!);
    expect(pasted.errors).toEqual([]);
    expect(pasted.nodes.map((n) => n.data.registryType)).toEqual(bare.nodes.map((n) => n.data.registryType));
    expect(pasted.edges).toHaveLength(bare.edges.length);
  });

  it('WHY it is needed: a reply that is only the fenced block is valid JavaScript holding nothing', () => {
    // Three backticks open an empty template literal, so the block reads as a
    // tagged template: no error, and an empty graph.
    const r = codeToGraph(fence(PROGRAM));
    expect(r.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    expect(r.nodes.filter((n) => n.data.registryType !== 'output')).toEqual([]);
  });
});

describe('text that is the code itself', () => {
  it('is left alone: no fence, no cut', () => {
    expect(programInReply(PROGRAM)).toBeNull();
    expect(programInReply('')).toBeNull();
    expect(programInReply('const s = `one ${a} two`;')).toBeNull();
  });

  it('a backtick run that is not a fence LINE is not one', () => {
    // In a comment, in a string, after code on the same line.
    expect(programInReply('// see ```js in the docs\nconst a = float(1);\n// ```\nreturn a;')).toBeNull();
    expect(programInReply('const a = "```";\nconst b = "```";\nreturn a;')).toBeNull();
    expect(programInReply('const a = float(1); ```js\nreturn a;\n```')).toBeNull();
  });

  it('an unclosed or an empty fence is not a program', () => {
    expect(programInReply(`\`\`\`js\n${PROGRAM}`)).toBeNull();
    expect(programInReply('```js\n\n```')).toBeNull();
    expect(programInReply('```js\n```')).toBeNull();
  });

  it('a very long text with many backticks is still read in one pass', () => {
    const big = `${'`'.repeat(200_000)}\n${fence(PROGRAM)}`;
    const t0 = Date.now();
    expect(programInReply(big)).toBe(PROGRAM);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a megabyte of opening fences that never close does not hang (one pass, no lazy match per fence)', () => {
    const hostile = '```js\nconst a = float(1);\n'.repeat(60_000);
    expect(hostile.length).toBeGreaterThan(1_500_000);
    const t0 = Date.now();
    expect(programInReply(hostile)).toBeNull();
    // …and the same with one real block at the very end: an opening fence
    // INSIDE a block is content, so the first opener runs to the one closer.
    const closed = programInReply(`${hostile}return a;\n\`\`\``);
    expect(closed?.endsWith('return a;')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('where it runs', () => {
  const engine = readFileSync(path.join(__dirname, '../hooks/useSyncEngine.ts'), 'utf8');

  it('Apply reads the program, and the panel and the preview take that text', () => {
    expect(engine).toContain('const program = programInReply(typed);');
    expect(engine).toContain('const codeStr = program ?? typed;');
    expect(engine).toContain('useAppStore.setState({ code: codeStr, previewCode: codeStr });');
    // Before the direct-assignment test and the parse, which both read it.
    expect(engine.indexOf('programInReply(typed)')).toBeLessThan(engine.indexOf('isDirectAssignmentCode(codeStr)'));
    expect(engine.indexOf('isDirectAssignmentCode(codeStr)')).toBeLessThan(engine.indexOf('codeToGraph(codeStr)'));
  });

  it('is a leaf: the sync engine never reaches src/llm/ for it', () => {
    const leaf = readFileSync(path.join(__dirname, 'replyProgram.ts'), 'utf8');
    expect(leaf).not.toMatch(/^import /m);
    expect(engine).not.toMatch(/from '@\/llm\//);
  });
});
