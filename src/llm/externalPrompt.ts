/**
 * The text the code panel's "?" hands to ANOTHER AI (owner, 2026-11-26): the
 * user copies it into any AI chat, adds what the shader should look like, and
 * pastes the reply into the TSL panel, where Apply builds the graph. So what
 * reads that reply is `codeToGraph`, never the generator's gate — and nothing
 * of the user's graph or files is in this text.
 *
 * SHORT ON PURPOSE (owner, the same day: "can it be made shorter?"). It is a
 * text a person pastes into a chat box, and its reader is a large chat model
 * that already knows three.js, so it is about half the generator's own prompt
 * (llm/prompt.ts, whose wording is the one measured on small local models and
 * is left alone):
 *  - four rules, each one a form the code panel's parser DROPS or MISREADS
 *    when it is broken (externalPrompt.test.ts runs each against the parser).
 *    What the parser reads anyway — a comment, `vec3(x)` with one value,
 *    `color(r, g, b)`, `PI`, three.js's own `colorNode` key, the fence and
 *    the sentences around the code (utils/replyProgram.ts) — is not a rule;
 *  - three.js's own functions as bare signatures, with no gloss: the model
 *    knows `smoothstep`. Only the functions three.js does NOT have (the app's
 *    module helpers) keep the one sentence the generator's list gives them;
 *  - the example carries the shape, so there is no separate template.
 *
 * The node list is still the generator's catalogue — read from the registry
 * under the user's own optional-category switches, so it never names a
 * function the parser cannot read back — and the example is parsed by the
 * test, so it cannot rot. English on purpose: the code is.
 *
 * Loaded with import() by components/CodeEditor/AiPromptDialog.tsx only.
 */
import { TSL_EXPORT_NAMES } from '@/engine/tslExportNames';
import { blurbOf, signatureOf, type Catalogue } from './catalogue';

/** Who is asked, for what, and the one thing about the reply's form. */
export const EXTERNAL_HEAD =
  'Write a shader for FastShaders, a node editor for three.js TSL (Three Shading Language). ' +
  'FastShaders turns your code into a node graph, so keep to these rules. ' +
  'Reply with ONE ```js code block shaped like the example.';

/**
 * The rules. Each names a form the parser cannot hold (measured 2026-11-26;
 * the test holds every one to the parser): an operator, a branch or a helper
 * function is dropped, and a method call is read argument by argument, which
 * for mix and smoothstep is NOT what three.js computes (it puts the receiver
 * last); a swizzle of two or more letters leaves its const unwired, and an
 * inline call is dropped in the positions that read names only; a uniform of
 * anything but a number or a hex colour loses its value; a bare number in a
 * channel is dropped.
 */
export const EXTERNAL_RULES = [
  'RULES',
  '1. Use only the inputs and functions listed below, as free functions: mul(a, b), mix(a, b, t). No methods (a.mul(b)), no operators (+ - * /), no if, loops or helper functions.',
  '2. One call per line: const name = fn(args); An argument is a number, an earlier const, an input, or ONE component of a const (name.x, name.y, name.z), never .xy or .rgb.',
  '3. A value the user may tune is a uniform on its own line: const speed = uniform(1.5); or const tint = uniform(color(0xff8800));',
  '4. Return one const (the colour), or an object of the channels below. A fixed value in it is float(0.5) or color(0xRRGGBB), never a bare number.',
].join('\n');

/**
 * The material channels rule 4 offers — each key is an Output socket id
 * (externalPrompt.test.ts holds them to the registry). Environment is left
 * out: it takes a picture, which pasted code cannot carry.
 */
export const EXTERNAL_CHANNELS: readonly (readonly [keys: readonly string[], gloss: string])[] = [
  [['color', 'emissive'], 'vec3'],
  [['roughness', 'metalness'], '0 to 1'],
  [['opacity'], '0 to 1; it shows once Transparent is ticked in the Output node\'s menu, so say so'],
  [['discard'], 'not 0 removes the surface; feed it greaterThan or lessThan'],
  [['normal'], 'the result of heightToNormal'],
  [['position'], 'a float: how far the surface moves along its normal'],
];

const channelsText = (): string =>
  ['CHANNELS', ...EXTERNAL_CHANNELS.map(([keys, gloss]) => `${keys.join(', ')}: ${gloss}`)].join('\n');

/** How a noise's range is said: the Perlin family is signed, the rest are not. */
const noiseText = (name: string, signed: boolean): string => (signed ? `${name} (-1 to 1)` : name);

/**
 * The node list, compact: inputs and three.js's own functions as signatures on
 * one line each group, the noise functions with their range, and the app's own
 * functions — the ones `three/tsl` does not export, so no model can know them
 * — each with its one-sentence gloss.
 */
export function externalListText(c: Catalogue): string {
  const inputs: string[] = [];
  const functions: string[] = [];
  const noise: string[] = [];
  const own: string[] = [];
  for (const e of c.entries) {
    if (e.kind === 'global' || e.kind === 'uv') inputs.push(signatureOf(e));
    else if (e.kind === 'noise') noise.push(noiseText(e.name, e.signed));
    else if (TSL_EXPORT_NAMES.has(e.name)) functions.push(signatureOf(e));
    else own.push(`- ${signatureOf(e)}: ${blurbOf(e.def)}`);
  }
  return [
    `INPUTS (bare, no parentheses, except uv()): ${inputs.join(', ')}`,
    '',
    `FUNCTIONS: ${functions.join(', ')}`,
    ...(noise.length > 0 ? ['', `NOISE (one argument, the position): ${noise.join(', ')}`] : []),
    ...(own.length > 0 ? ['', 'FASTSHADERS\' OWN FUNCTIONS (three.js does not have them):', ...own] : []),
  ].join('\n');
}

/** The worked example: one request, and a program in exactly the asked-for form. */
export const EXTERNAL_EXAMPLE = {
  request: 'Blue and orange patches that drift slowly, on a slightly shiny surface.',
  code: `import { add, color, float, Fn, mix, mul, mx_noise_float, positionGeometry, smoothstep, time, uniform } from "three/tsl";

const shader = Fn(() => {
  const patchScale = uniform(3);
  const driftSpeed = uniform(0.2);
  const coolColor = uniform(color(0x1e5aa8));
  const warmColor = uniform(color(0xf28c28));
  const drift = mul(time, driftSpeed);
  const scaled = mul(positionGeometry, patchScale);
  const moved = add(scaled, drift);
  const n = mx_noise_float(moved);
  const blend = smoothstep(-0.3, 0.3, n);
  const base = mix(coolColor, warmColor, blend);
  return { color: base, roughness: float(0.3) };
});
export default shader;`,
} as const;

/** The whole text: who and what, the rules, the channels, the node list, the example, the ask. */
export function externalPrompt(catalogue: Catalogue): string {
  return [
    EXTERNAL_HEAD,
    '',
    EXTERNAL_RULES,
    '',
    channelsText(),
    '',
    externalListText(catalogue),
    '',
    `EXAMPLE: ${EXTERNAL_EXAMPLE.request}`,
    '```js',
    EXTERNAL_EXAMPLE.code,
    '```',
    '',
    'Now write the shader I describe next.',
  ].join('\n');
}
