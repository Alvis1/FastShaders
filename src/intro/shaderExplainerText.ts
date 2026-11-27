/**
 * The words and links of the intro's "What is a shader?" tab (ShaderTab.tsx),
 * as PURE data: no React, no store. Every string is a key in lv.json `ui`,
 * keyed by its English text like the intro's captions, and
 * `shaderExplainer.test.ts` holds each one to its Latvian.
 *
 * Written for someone who opens the app knowing nothing about shaders, many
 * of them students under 18 (owner, 2026-11-25): short sentences, one idea
 * each, and nothing the app contradicts a minute later. The intro's own code
 * slide teaches typing TSL, so you do not HAVE to type a shader; the cost bar
 * prices the device picked above it, so the points measure the TARGET device.
 */
import { TUTORIALS } from '@/tutorials/tutorialDefs';

/** The intro's third tab. */
export const EXPLAINER_TITLE = 'What is a shader?';

/** Under the three drawn spheres (shaderFigure.ts), in their order. */
export const FIGURE_CAPTIONS = ['One colour', 'A pattern', 'A moved surface'] as const;

const ABOUT: readonly string[] = [
  'A shader is a small program that tells the graphics card (GPU) how to draw a surface. For every pixel of the surface it answers one question: what colour is this pixel? And for every corner point of the model: where does this point go?',
  'The graphics card runs it for millions of pixels at once, in every frame, 60 or more times a second. That is how a shader makes water ripple, metal shine or a surface glow in real time.',
  'In FastShaders you don’t have to type a shader: you build it from nodes. Each node does one small step: it makes a colour or a pattern, or adds two numbers. Wires carry the numbers from node to node, and the Output node decides what the surface shows. The code panel shows the same shader as code in TSL, the shading language of three.js. Code you type there becomes nodes.',
];

/**
 * The paragraph about points. Left out wherever the intro leaves out its
 * point-budget slide (`introShowsBudget`: `/evalp`, a `costbar=off` link),
 * since there it would hand that condition the very feedback it removes.
 */
export const COST_PARAGRAPH =
  'Because a shader runs so many times, every node adds work. FastShaders counts that work in points, so you can see whether your shader fits your target device.';

export function explainerParagraphs(showCost: boolean): readonly string[] {
  return showCost ? [...ABOUT, COST_PARAGRAPH] : ABOUT;
}

/**
 * The next step, filled at render through t() with the labels the app itself
 * shows: the intro's Start button, the asset bar's lessons tab and the first
 * lesson's title. The test reads both labels back out of the components, so a
 * renamed button or tab fails it rather than leaving this sentence stale.
 */
export const NEXT_STEP = 'Try it: press {start}, open the {tab} tab and start the first lesson, {lesson}.';
export const START_LABEL = 'Start';
export const LESSONS_TAB_LABEL = 'Step by step';
export const FIRST_LESSON_TITLE = TUTORIALS[0].title;

export const READ_MORE = 'Read more';
/** Shown in Latvian only: every page behind the links is English. */
export const PAGES_IN_ENGLISH = 'These pages are in English.';

export interface ShaderLink {
  /** The page's own name, never translated. */
  title: string;
  url: string;
  /** What the reader finds there, in English; lv.json `ui` holds the Latvian. */
  line: string;
}

/** Each checked live on 2026-11-26. Shadertoy answers a script with 403 but
 *  opens in a browser, so check these by hand, not with curl. The TSL address
 *  is the one README.md links. */
export const SHADER_LINKS: readonly ShaderLink[] = [
  {
    title: 'The Book of Shaders',
    url: 'https://thebookofshaders.com/',
    line: 'A gentle start, step by step, with examples you can change right in the browser. Its examples are in GLSL, another shading language, but the ideas are the same.',
  },
  {
    title: 'Three.js Shading Language (TSL)',
    url: 'https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language',
    line: 'The language you see in the code panel: its functions, with examples.',
  },
  {
    title: 'Shadertoy',
    url: 'https://www.shadertoy.com/',
    line: 'Thousands of shaders by other people, each with its code.',
  },
  {
    title: 'The Art of Code (YouTube)',
    url: 'https://www.youtube.com/@TheArtofCodeIsCool',
    line: 'Video lessons that build shaders from nothing.',
  },
  {
    title: 'Inigo Quilez — articles',
    url: 'https://iquilezles.org/articles/',
    line: 'Deeper reading on noise, shapes and colour, from a co-creator of Shadertoy.',
  },
];

/** Every English string the tab prints through t(), for the test. The
 *  link TITLES are not among them: they stay as their sites name them. */
export function explainerKeys(): string[] {
  return [
    EXPLAINER_TITLE,
    ...FIGURE_CAPTIONS,
    ...explainerParagraphs(true),
    NEXT_STEP,
    START_LABEL,
    LESSONS_TAB_LABEL,
    FIRST_LESSON_TITLE,
    READ_MORE,
    PAGES_IN_ENGLISH,
    ...SHADER_LINKS.map((l) => l.line),
    'Copy',
    'Copied',
  ];
}
