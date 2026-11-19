import { describe, expect, it } from 'vitest';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { DEFAULT_OPTIONAL_CATEGORIES } from '@/registry/optionalCategories';
import { buildCatalogue } from './catalogue';
import { exampleCorpus } from './examples';
import { runGeneration, type RunOptions } from './orchestrate';
import type { GenerateRequest, GenerateResult, GeneratorProvider } from './providerTypes';

const catalogue = buildCatalogue(DEFAULT_OPTIONAL_CATEGORIES);
const corpus = exampleCorpus([...getBuiltinPresets(), ...getBuiltinTextures()], catalogue);

const GOOD = 'A ramp.\n```js\nconst shader = Fn(() => {\n  const a = uniform(color(0x112233));\n  const b = uniform(color(0xFFEEDD));\n  const u = uv();\n  const r = mix(a, b, u.y);\n  return r;\n});\nexport default shader;\n```';
const BAD = '```js\nconst shader = Fn(() => {\n  const u = uv();\n  const r = mix(u.x, missing, 0.5);\n  return r;\n});\nexport default shader;\n```';

function scripted(replies: GenerateResult[]): GeneratorProvider & { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  return {
    id: 'local', model: 'fake', contextClass: 'medium', calls,
    async generate(r) { calls.push(r); return replies.shift() ?? { ok: false, failure: 'bad-response' }; },
  };
}

const run = (provider: GeneratorProvider, extra: Partial<RunOptions> = {}) => runGeneration({
  provider, request: 'a gradient', catalogue, corpus, takenNames: new Set(), signal: new AbortController().signal, inStudy: () => false, ...extra,
});

describe('runGeneration', () => {
  it('a rejected round is repaired: the next prompt quotes the program and its problems', async () => {
    const p = scripted([{ ok: true, text: BAD }, { ok: true, text: GOOD }]);
    const r = await run(p);
    expect(r).toMatchObject({ ok: true, rounds: 2 });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1].user).toMatch(/Your previous program:\n```js\n[\s\S]*mix\(u\.x, missing, 0\.5\)/);
    expect(p.calls[1].user).toMatch(/- line \d+ `const r = mix\(u\.x, missing, 0\.5\);`: missing is not declared/);
    // The system prompt is the same each round: only the request part changes.
    expect(p.calls[1].system).toBe(p.calls[0].system);
  });

  it('stops after three rejections with the last problems', async () => {
    const p = scripted([{ ok: true, text: BAD }, { ok: true, text: BAD }, { ok: true, text: BAD }, { ok: true, text: GOOD }]);
    const r = await run(p);
    expect(r).toMatchObject({ ok: false, kind: 'rejected', rounds: 3 });
    expect(r.ok === false && r.kind === 'rejected' && r.problems[0]).toMatch(/missing is not declared/);
    expect(p.calls).toHaveLength(3);
  });

  it('passes a provider failure straight through', async () => {
    expect(await run(scripted([{ ok: false, failure: 'not-running', detail: 'x' }])))
      .toEqual({ ok: false, kind: 'provider', failure: 'not-running', detail: 'x', rounds: 1 });
  });

  it('an abort before or between rounds is a cancel', async () => {
    const ac = new AbortController();
    ac.abort();
    const p = scripted([{ ok: true, text: GOOD }]);
    expect(await run(p, { signal: ac.signal })).toMatchObject({ ok: false, failure: 'cancelled' });
    expect(p.calls).toHaveLength(0);
  });

  it('refuses in a study session before anything is sent', async () => {
    const p = scripted([{ ok: true, text: GOOD }]);
    expect(await run(p, { inStudy: () => true })).toEqual({ ok: false, kind: 'study' });
    expect(p.calls).toHaveLength(0);
  });

  it('a provider that throws, or a gate that throws, is an outcome — never a rejected run', async () => {
    const throwing: GeneratorProvider = { id: 'local', model: 'x', contextClass: 'medium', generate: async () => { throw new Error('boom'); } };
    expect(await run(throwing)).toMatchObject({ ok: false, kind: 'provider', failure: 'bad-response', detail: 'boom' });
    // A reply the parser underneath chokes on (here: a catalogue whose lookup throws).
    const brokenCatalogue = { ...catalogue, byName: { get: () => { throw new Error('bug'); } } } as unknown as typeof catalogue;
    const r = await run(scripted([{ ok: true, text: GOOD }, { ok: true, text: GOOD }, { ok: true, text: GOOD }]), { catalogue: brokenCatalogue });
    expect(r).toMatchObject({ ok: false, kind: 'rejected' });
    expect(r.ok === false && r.kind === 'rejected' && r.problems[0]).toMatch(/could not be checked/);
  });

  it('reports each phase with its round', async () => {
    const seen: string[] = [];
    await run(scripted([{ ok: true, text: BAD }, { ok: true, text: GOOD }]), { onStatus: (s) => seen.push(`${s.round}:${s.phase}`) });
    expect(seen).toEqual(['1:connecting', '1:checking', '2:connecting', '2:checking']);
  });
});
