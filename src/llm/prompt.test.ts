import { describe, expect, it } from 'vitest';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { DEFAULT_OPTIONAL_CATEGORIES } from '@/registry/optionalCategories';
import { buildCatalogue, signatureOf } from './catalogue';
import { DEFAULT_EXAMPLE_IDS, exampleCorpus, selectExamples } from './examples';
import { gateText } from './gate';
import { buildPrompt, buildRepairUser, CONTEXT_BUDGETS, estimateTokens } from './prompt';

const catalogue = buildCatalogue(DEFAULT_OPTIONAL_CATEGORIES);
const corpus = exampleCorpus([...getBuiltinPresets(), ...getBuiltinTextures()], catalogue);

describe('the prompt', () => {
  it.each(['small', 'medium', 'large'] as const)('the worst case fits the %s budget', (cls) => {
    // The longest examples, a long request.
    const longest = [...corpus].sort((a, b) => b.code.length - a.code.length);
    const p = buildPrompt('x'.repeat(400), catalogue, longest, cls);
    expect(estimateTokens(p.system) + estimateTokens(p.user)).toBeLessThanOrEqual(CONTEXT_BUDGETS[cls].prompt);
  });

  it('lists every catalogue form and both uniform forms', () => {
    const { system } = buildPrompt('a gradient', catalogue, corpus.slice(0, 3), 'medium');
    for (const e of catalogue.entries) expect(system, e.name).toContain(signatureOf(e));
    expect(system).toContain('uniform(number) and uniform(color(0xRRGGBB))');
  });

  it('sends nothing but the rules, the list, the examples and the request', () => {
    const p = buildPrompt('lava with "quotes" and `ticks`', catalogue, corpus.slice(0, 3), 'medium');
    expect(p.user).toBe('Request: lava with "quotes" and `ticks`');
  });

  it('every corpus example passes the gate as the prompt shows it', () => {
    expect(corpus.length).toBeGreaterThan(20);
    for (const e of corpus) {
      const r = gateText(`\`\`\`js\n${e.code}\n\`\`\``, { catalogue, takenNames: new Set() });
      expect(r.ok, e.id).toBe(true);
    }
  });
});

describe('example selection', () => {
  it('a request naming an example selects it first', () => {
    expect(selectExamples('a hologram with scanlines', corpus, 3)[0].id).toBe('hologram');
    expect(selectExamples('wood rings', corpus, 3)[0].id).toBe('wood');
    expect(selectExamples('polka dots everywhere', corpus, 3)[0].id).toBe('polka-dots');
  });

  it('falls back to the default trio when nothing matches, and fills up with it', () => {
    expect(selectExamples('zzz qqq', corpus, 3).map((e) => e.id)).toEqual(DEFAULT_EXAMPLE_IDS);
    const one = selectExamples('hologram', corpus, 3);
    expect(one).toHaveLength(3);
    expect(new Set(one.map((e) => e.id)).size).toBe(3);
  });

  it('is deterministic', () => {
    const a = selectExamples('rippling teal water with noise', corpus, 4).map((e) => e.id);
    const b = selectExamples('rippling teal water with noise', corpus, 4).map((e) => e.id);
    expect(a).toEqual(b);
  });
});

describe('the repair round', () => {
  it('carries the request, the previous program and each problem', () => {
    const u = buildRepairUser('a gradient', 'const a = 1;\nreturn a;', ['line 1: one', 'line 2: two']);
    expect(u).toBe('Request: a gradient\n\nYour previous program:\n```js\nconst a = 1;\nreturn a;\n```\n\nIt was rejected for these reasons:\n- line 1: one\n- line 2: two\n\nWrite the corrected program, in the same format.');
  });

  it('says so when there was no program at all', () => {
    expect(buildRepairUser('x', null, ['no program found'])).toMatch(/had no usable program/);
  });
});
