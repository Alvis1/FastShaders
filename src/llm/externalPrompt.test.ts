/**
 * The text the code panel's "?" hands to another AI (externalPrompt.ts). What
 * reads the reply is the code panel's own parser, so: every rule the text
 * states must be a form that parser really cannot hold, the example must parse
 * into nodes exactly as the rules promise, every channel must be a real Output
 * socket — and the text must stay SHORT, which is what it was rewritten for.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import lv from '@/i18n/lv.json';
import { codeToGraph } from '@/engine/codeToGraph';
import { graphToCode } from '@/engine/graphToCode';
import { loadUnknownExpressionValidator } from '@/engine/unknownExpression';
import { TSL_EXPORT_NAMES } from '@/engine/tslExportNames';
import { MODULE_HELPER_NAMES, HELPER_ALIASES } from '@/engine/moduleHelpers';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { DEFAULT_OPTIONAL_CATEGORIES } from '@/registry/optionalCategories';
import { blurbOf, buildCatalogue, signatureOf } from './catalogue';
import { RULES, catalogueText } from './prompt';
import {
  EXTERNAL_CHANNELS,
  EXTERNAL_EXAMPLE,
  EXTERNAL_HEAD,
  EXTERNAL_RULES,
  externalListText,
  externalPrompt,
} from './externalPrompt';

beforeAll(() => loadUnknownExpressionValidator());

const catalogue = buildCatalogue(DEFAULT_OPTIONAL_CATEGORIES);
const src = (rel: string) => readFileSync(path.join(__dirname, '..', rel), 'utf8');
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const wrap = (body: string) => `import { Fn } from "three/tsl";\n\nconst shader = Fn(() => {\n${body}\n});\nexport default shader;`;
const messages = (body: string) => codeToGraph(wrap(body)).errors.map((e) => e.message);
const regenerated = (body: string) => {
  const r = codeToGraph(wrap(body));
  return graphToCode(r.nodes, r.edges).code;
};

describe('the text', () => {
  const text = externalPrompt(catalogue);

  it('is the head, the rules, the channels, the node list, the example and the ask', () => {
    expect(text.startsWith(`${EXTERNAL_HEAD}\n\n${EXTERNAL_RULES}\n\nCHANNELS\n`)).toBe(true);
    expect(text).toContain(`\n\n${externalListText(catalogue)}\n\nEXAMPLE: ${EXTERNAL_EXAMPLE.request}\n\`\`\`js\n${EXTERNAL_EXAMPLE.code}\n\`\`\`\n`);
    expect(text.endsWith('\n\nNow write the shader I describe next.')).toBe(true);
  });

  it('is SHORT: under 4,000 characters, and well under the generator\'s own rules and list', () => {
    // A person pastes this into a chat box (owner, 2026-11-26: "can it be made
    // shorter?" — it was 8,599 characters). A node added to the registry adds a
    // signature; a gloss on every function is what must not come back.
    expect(text.length).toBeLessThan(4000);
    expect(text.split('\n').length).toBeLessThan(55);
    const generators = `${RULES}\n\n${catalogueText(catalogue, 'standard')}`;
    expect(text.length).toBeLessThan(generators.length * 0.6);
  });

  it('leaves the generator\'s own prompt as it was measured', () => {
    // prompt.ts holds ONE rules text again: this one no longer shares it.
    expect(src('llm/prompt.ts')).not.toContain('STYLE_RULES');
    expect(RULES).toContain('8. Return ONE const: the final colour (a vec3, or a float for a grey value).');
  });

  it('offers only channels the Output node has — every one but Environment, which needs a picture', () => {
    const sockets = NODE_REGISTRY.get('output')!.inputs.map((p) => p.id);
    const offered = EXTERNAL_CHANNELS.flatMap(([keys]) => [...keys]);
    for (const key of offered) expect(sockets, key).toContain(key);
    expect([...offered].sort()).toEqual(sockets.filter((s) => s !== 'env').sort());
    for (const key of offered) expect(text).toMatch(new RegExp(`\\n(?:\\w+, )*${key}(?:, \\w+)*: `));
  });
});

describe('the node list', () => {
  const list = externalListText(catalogue);
  const own = catalogue.entries.filter((e) => (e.kind === 'call' || e.kind === 'ctor') && !TSL_EXPORT_NAMES.has(e.name));

  it('names every catalogue entry exactly once', () => {
    // A signature holds commas of its own (`mix(a, b, t)`), so the items are
    // cut at the commas OUTSIDE parentheses.
    const items = (line: string) => line.slice(line.indexOf(': ') + 2).split(/, (?![^(]*\))/);
    const lines = list.split('\n');
    const named = [
      ...items(lines.find((l) => l.startsWith('INPUTS'))!),
      ...items(lines.find((l) => l.startsWith('FUNCTIONS: '))!),
      ...items(lines.find((l) => l.startsWith('NOISE'))!).map((n) => n.replace(' (-1 to 1)', '')),
      ...lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2, l.indexOf('): ') + 1)),
    ];
    const expected = catalogue.entries.map((e) => (e.kind === 'noise' ? e.name : signatureOf(e)));
    expect([...named].sort()).toEqual([...expected].sort());
    expect(new Set(named).size).toBe(named.length);
  });

  it('glosses ONLY the functions three.js does not have', () => {
    expect(own.map((e) => e.name).sort()).toEqual(['brightContrast', 'fsFresnel', 'heightToNormal', 'hsl', 'toHsl']);
    for (const e of own) {
      expect(list).toContain(`- ${signatureOf(e)}: ${blurbOf(e.def)}`);
      // "three.js does not have them" is the app's own claim: each is one of
      // its module helpers.
      expect(MODULE_HELPER_NAMES.has(e.name) || HELPER_ALIASES.has(e.name), e.name).toBe(true);
    }
    // Everything else is a bare signature — no " — " gloss anywhere in the list.
    const plain = list.split('\n').filter((l) => !l.startsWith('- ') && !l.startsWith('FASTSHADERS'));
    for (const line of plain) expect(line).not.toContain(' — ');
    for (const e of catalogue.entries) {
      if (e.kind === 'call' && !own.includes(e)) expect(TSL_EXPORT_NAMES.has(e.name), e.name).toBe(true);
    }
  });

  it('says which noise is signed', () => {
    for (const e of catalogue.entries) {
      if (e.kind !== 'noise') continue;
      const signed = list.includes(`${e.name} (-1 to 1)`);
      expect(signed, e.name).toBe(e.signed);
    }
  });
});

describe('every rule names a form the parser cannot hold', () => {
  it('1 — an operator, a branch and a helper function are dropped', () => {
    expect(messages('  const n = mx_noise_float(positionGeometry) * 0.5;\n  return n;')[0]).toContain('shader values have no * operator');
    expect(messages('  const c = vec3(0, 0, 0).toVar();\n  If(greaterThan(time, 1), () => { c.assign(vec3(1, 0, 0)); });\n  return c;')[0]).toContain('If(…) has no graph equivalent');
    expect(messages('  const twice = (x) => mul(x, 2);\n  const v = twice(time);\n  return v;')[0]).toContain('a function of your own is not a node');
  });

  it('1 — a method call is read argument by argument, which for mix and smoothstep is not three.js', () => {
    // three.js: t.mix(a, b) is mix(a, b, t). The parser puts the receiver FIRST.
    expect(regenerated('  const a = color(0x112233);\n  const b = color(0xffaa00);\n  const t = float(0.25);\n  const c = t.mix(a, b);\n  return c;'))
      .toContain('mix(float1, color1, color2)');
    expect(regenerated('  const x = float(0.25);\n  const s = x.smoothstep(0, 1);\n  return s;')).toContain('smoothstep(float1, 0, 1)');
  });

  it('2 — a swizzle of several letters leaves its const unwired; an inline call is dropped where names are read', () => {
    expect(messages('  const p = positionGeometry;\n  const q = p.xy;\n  const n = mx_noise_float(q);\n  return n;')[0]).toContain('Cannot represent "p.xy"');
    expect(messages('  const u = uv();\n  const c = vec3(u, sin(time));\n  return c;')[0]).toBe('"sin(time)" (argument of vec3) was dropped — give it its own const first.');
  });

  it('3 — a uniform of anything but a number or a hex colour loses its value', () => {
    expect(messages('  const v = uniform(vec3(1, 0, 0));\n  return v;')[0]).toContain('lost its value');
    expect(messages('  const speed = uniform(1.5);\n  const tint = uniform(color(0xff8800));\n  const c = mul(tint, speed);\n  return c;')).toEqual([]);
  });

  it('4 — a bare number in a channel is dropped; the stated forms are stored on the Output', () => {
    expect(messages('  const c = color(0x112233);\n  return { color: c, roughness: 0.3 };')[0]).toContain('write roughness: float(0.3)');
    const r = codeToGraph(wrap('  const n = mx_noise_float(positionGeometry);\n  return { color: color(0x112233), roughness: float(0.5), position: n };'));
    expect(r.errors).toEqual([]);
    const output = r.nodes.find((n) => n.data.registryType === 'output')!;
    expect((output.data as { values?: Record<string, unknown> }).values).toMatchObject({ color: '#112233', roughness: 0.5 });
  });

  it('and what is NOT a rule is read: one-value vectors, color(r, g, b), PI, a comment', () => {
    const body = '  // grey from a noise\n  const n = mx_noise_float(positionGeometry);\n  const g = vec3(n);\n  const k = color(1, 0.5, 0);\n  const w = mul(g, k, PI);\n  return w;';
    expect(messages(body)).toEqual([]);
    const text = regenerated(body);
    expect(text).toContain('vec3(noise1, noise1, noise1)');
    expect(text).toContain('vec3(1, 0.5, 0)');
    expect(text).toContain('3.141592653589793');
  });
});

describe('the example parses into nodes exactly as the rules promise', () => {
  const r = codeToGraph(EXTERNAL_EXAMPLE.code);
  const types = r.nodes.map((n) => (n.data as { registryType?: string }).registryType);

  it('with no error or warning, one node per const', () => {
    expect(r.errors).toEqual([]);
    expect(types.sort()).toEqual(
      ['add', 'mix', 'mul', 'mul', 'output', 'perlin', 'positionGeometry', 'property_color', 'property_color', 'property_float', 'property_float', 'smoothstep', 'time'].sort(),
    );
  });

  it('the colour wired in, the fixed roughness stored on the Output', () => {
    const output = r.nodes.find((n) => (n.data as { registryType?: string }).registryType === 'output')!;
    expect(r.edges.some((e) => e.target === output.id && e.targetHandle === 'color')).toBe(true);
    expect((output.data as { values?: Record<string, unknown> }).values?.roughness).toBe(0.3);
  });

  it('calls only what the list names, and breaks none of its own rules', () => {
    const called = [...EXTERNAL_EXAMPLE.code.matchAll(/\b([A-Za-z_]\w*)\(/g)].map((m) => m[1]);
    for (const name of called) {
      if (name === 'Fn' || name === 'uniform') continue;
      expect(catalogue.byName.has(name), name).toBe(true);
    }
    for (const input of ['time', 'positionGeometry']) expect(catalogue.byName.get(input)?.kind).toBe('global');
    const body = EXTERNAL_EXAMPLE.code.split('\n').slice(3, -2);
    for (const line of body.slice(0, -1)) expect(line).toMatch(/^  const [A-Za-z]\w* = [A-Za-z_]\w*\([^()]*(?:\([^()]*\))?[^()]*\);$/);
    expect(EXTERNAL_EXAMPLE.code).not.toMatch(/\)\.[a-z]/);
  });
});

describe('the dialog', () => {
  const dialog = codeOnly(src('components/CodeEditor/AiPromptDialog.tsx'));
  const editor = codeOnly(src('components/CodeEditor/CodeEditor.tsx'));

  it('loads the text only with import(), so src/llm/ never rides the code panel\'s chunk', () => {
    expect(dialog).toContain("import('@/llm/externalPrompt')");
    for (const s of [dialog, editor]) expect(s).not.toMatch(/from '@\/llm\//);
  });

  it('its "?" leads the tab row, just before the TSL tab, on every tab (owner, 2026-11-26)', () => {
    const tabs = editor.slice(editor.indexOf('<div className="code-editor__tabs">'), editor.indexOf('<div className="code-editor__actions">'));
    const help = tabs.indexOf('className="code-editor__help"');
    expect(help).toBeGreaterThan(-1);
    expect(help).toBeLessThan(tabs.indexOf('data-label="TSL"'));
    // One button, and no longer beside Import.
    expect(editor.match(/className="code-editor__help"/g)).toHaveLength(1);
    // Not tied to the TSL tab: hidden on the others, it would shift the row.
    expect(tabs).not.toMatch(/isTSL && !isEvalMode\(\)/);
  });

  it('is never offered in a study session, and logs nothing', () => {
    expect(editor).toMatch(/\{!isEvalMode\(\) && \(\s*<button[^>]*className="code-editor__help"/);
    expect(dialog).not.toMatch(/\bevalLog\(/);
  });

  it('is a modal dialog: Escape closes it, Tab stays inside it', () => {
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toMatch(/useModalKeys\(true, \(e\) => \{\s*if \(e\.key === 'Escape'\)/);
    expect(dialog).toContain("if (e.key !== 'Tab') return;");
  });

  it('every string has its Latvian', () => {
    const ui = (lv as { ui: Record<string, string> }).ui;
    const keys = [...dialog.matchAll(/\bt\('([^']+)', language\)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(5);
    for (const key of [...keys, 'Write TSL with another AI']) {
      expect(ui[key], key).toBeTruthy();
      expect(ui[key], key).not.toBe(key);
    }
  });
});
