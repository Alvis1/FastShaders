/**
 * What is sent to a model: fixed rules, the node list, a few worked examples
 * and the user's own request — NEVER anything from the user's graph or files.
 *
 * The rules ask for the strict, flat style the gate re-emits; the gate also
 * forgives the common deviations exactly (dialect.ts), so a model that nests a
 * call or writes `a * b` is not sent back for it. The wording of RULES is the
 * one the 2026-10-02 spike measured (scripts/llm-probe/spike.test.ts).
 *
 * Repair rounds are STATELESS — the request, the previous program and its
 * problem lines in a fresh prompt — because prefix-cache reuse is unreliable on
 * the local models measured, and a growing conversation overflows small windows.
 */
import { blurbOf, signatureOf, type Catalogue } from './catalogue';
import type { Example } from './examples';

export const RULES = `You write shader programs for FastShaders, a visual node editor for three.js TSL (Three Shading Language). Your program is turned into a node graph, so it must follow the restricted style below exactly.

FORMAT
First write one or two plain sentences with your plan, in the language of the request. Then write the program in ONE \`\`\`js code block, in exactly this shape:

import { ...every name you use... } from "three/tsl";

const shader = Fn(() => {
  const name = ...;
  ...
  return result;
});
export default shader;

RULES
1. Every line inside the function is \`const <name> = <one thing>;\` where the one thing is ONE function call, ONE input, or ONE uniform. Never nest calls: make an intermediate const instead.
2. Call arguments may only be numbers, names of EARLIER consts, inputs, or a one-letter swizzle of an earlier const (name.x, name.y or name.z). Never .xy, .rgb or any longer swizzle.
3. Use only the FUNCTIONS and INPUTS listed below. Call functions as free functions: mix(a, b, t), smoothstep(lo, hi, x). Never a.mix(...), a.mul(...) or any other method call.
4. No arithmetic operators (+ - * /), no if, loops, arrow functions, helper functions, strings or comments. Use add, sub, mul and div.
5. Tunable parameters are uniforms, each on its own line: const speed = uniform(1.5); for a number, const tint = uniform(color(0xff8800)); for a colour. Use 2 to 5 uniforms with descriptive, unique English names.
6. A colour literal is color(0xRRGGBB). Vectors take every component: vec2(x, y), vec3(x, y, z).
7. A noise function takes ONE position argument: an earlier const or an input. To scale it, make the scaled position its own const first: const p = mul(positionGeometry, scale); const n = mx_noise_float(p);
8. Return ONE const: the final colour (a vec3, or a float for a grey value).`;

/** How much a provider can take — chosen per provider, measured in tokens. */
export type ContextClass = 'small' | 'medium' | 'large';

export const CONTEXT_BUDGETS: Record<ContextClass, { prompt: number; output: number; examples: number }> = {
  small: { prompt: 4_000, output: 1_500, examples: 1 },
  medium: { prompt: 8_000, output: 3_000, examples: 3 },
  large: { prompt: 16_000, output: 4_000, examples: 4 },
};

/** A deliberately pessimistic token estimate (≈3.2 characters per token). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.2);

/** The node list: `standard` glosses each entry with its first sentence;
 *  `compact` is signatures only, for a small window. */
export function catalogueText(c: Catalogue, level: 'standard' | 'compact'): string {
  const inputs: string[] = [];
  const functions: string[] = [];
  for (const e of c.entries) {
    const line = level === 'compact' ? signatureOf(e) : `${signatureOf(e)} — ${blurbOf(e.def)}`;
    (e.kind === 'global' || e.kind === 'uv' ? inputs : functions).push(`- ${line}`);
  }
  return [
    'INPUTS (write them bare, without parentheses, except uv())',
    ...inputs,
    '',
    'FUNCTIONS',
    ...functions,
    '- uniform(number) and uniform(color(0xRRGGBB)) — tunable parameters (rule 5).',
  ].join('\n');
}

export interface BuiltPrompt {
  system: string;
  user: string;
  /** Example ids used — recorded by the probe. */
  exampleIds: string[];
}

/**
 * The richest prompt that fits `cls`: the standard node list with the class's
 * example count, falling back to fewer examples, then to the compact list.
 */
export function buildPrompt(
  request: string,
  catalogue: Catalogue,
  examples: readonly Example[],
  cls: ContextClass,
  picture: readonly string[] = [],
): BuiltPrompt {
  const budget = CONTEXT_BUDGETS[cls];
  const user = userText(request, picture);
  let best: BuiltPrompt | null = null;
  for (const level of ['standard', 'compact'] as const) {
    for (let k = Math.min(budget.examples, examples.length); k >= 0; k--) {
      const used = examples.slice(0, k);
      const system = [
        RULES,
        '',
        catalogueText(catalogue, level),
        ...(used.length ? ['', 'EXAMPLES', ...used.map((e) => `Request: ${e.request}\n\`\`\`js\n${e.code}\n\`\`\``)] : []),
      ].join('\n');
      const candidate = { system, user, exampleIds: used.map((e) => e.id) };
      best ??= candidate;
      if (estimateTokens(system) + estimateTokens(user) <= budget.prompt) return candidate;
    }
  }
  return best!;
}

/**
 * The request the APP sends for a picture with no words. Never shown and
 * never translated: it is sent to the model, and requests are English.
 */
export const PICTURE_ONLY_REQUEST = 'Make a shader that looks like this picture.';

/**
 * The request line. The text is the user's DATA, quoted verbatim. `picture` is
 * the app's own measurement of an added picture (imageAnalysis.ts
 * `pictureLines` — hex colours, counts and fixed words, never text from the
 * file); with a picture and no words the line is `PICTURE_ONLY_REQUEST`.
 */
export const userText = (request: string, picture: readonly string[] = []): string => {
  const line = `Request: ${request.trim() || (picture.length > 0 ? PICTURE_ONLY_REQUEST : '')}`;
  return picture.length > 0 ? [line, '', ...picture].join('\n') : line;
};

/** A stateless repair round: the request (and its picture block), the
 *  rejected program and why. */
export function buildRepairUser(
  request: string,
  previousCode: string | null,
  problems: readonly string[],
  picture: readonly string[] = [],
): string {
  return [
    userText(request, picture),
    '',
    ...(previousCode ? ['Your previous program:', '```js', previousCode.trim(), '```', ''] : ['Your previous reply had no usable program.', '']),
    'It was rejected for these reasons:',
    ...problems.slice(0, 8).map((p) => `- ${p}`),
    '',
    'Write the corrected program, in the same format.',
  ].join('\n');
}
