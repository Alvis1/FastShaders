import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { tslToShaderModule, LOADER_FILE } from './tslToShaderModule';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '@/test-utils';
import { buildShaderModule } from './tslCodeProcessor';
import { scriptToTSL } from './scriptToTSL';
import { glbModuleHeaderLines } from './glbUsage';
import { ACTIVE_LOADERS, loaderAvailable, transformsOf } from '../shaderloaderHarness';

/** graphToCode-style TSL: color + position + a wired discard. */
const COLOR_POS_DISCARD = `import { Fn, mix, vec3, greaterThan, Discard } from 'three/tsl';

const shader = Fn(() => {
  const mix1 = mix(vec3(1, 0, 0), vec3(0, 0, 1), 0.5);
  const greaterThan1 = greaterThan(0.5, 0.2);
  const mul3 = mix1.mul(0.1);
  Discard(greaterThan1);

  return { color: mix1, position: mul3 };
});

export default shader;
`;

/** color only + discard (single-value return). */
const COLOR_DISCARD = `import { Fn, mix, vec3, greaterThan, Discard } from 'three/tsl';

const shader = Fn(() => {
  const mix1 = mix(vec3(1, 0, 0), vec3(0, 0, 1), 0.5);
  const greaterThan1 = greaterThan(0.5, 0.2);
  Discard(greaterThan1);

  return mix1;
});

export default shader;
`;

/** color + position, no discard. */
const COLOR_POS = `import { Fn, mix, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const mix1 = mix(vec3(1, 0, 0), vec3(0, 0, 1), 0.5);
  const mul3 = mix1.mul(0.1);

  return { color: mix1, position: mul3 };
});

export default shader;
`;

describe('tslToShaderModule — discard + multi-channel (the struct-as-colorNode bug)', () => {
  const out = tslToShaderModule(COLOR_POS_DISCARD);

  it('never assigns a struct to colorNode', () => {
    // The bug: the simple-return regex greedily swallowed `{ color, position }`
    // and wrapped the whole struct in __pixel(), so `colorNode: __pixel()`
    // received a { color, position } struct.
    expect(out).not.toContain('colorNode: __pixel()');
    // A struct return inside __pixel is the tell-tale signature.
    expect(out).not.toMatch(/return\s*\{\s*color:/);
  });

  it('routes the color channel through __pixel with the color as a real value', () => {
    expect(out).toContain('colorNode: __pixel(greaterThan1, mix1)');
  });

  it('preserves the position channel (it was silently dropped before)', () => {
    expect(out).toContain('positionNode: positionLocal.add(normalLocal.mul(mul3))');
  });

  it('passes discard conditions + color as Fn parameters, never closure-captured', () => {
    // Closure capture failed in r173 where this was diagnosed (solid red material);
    // the bundle is now r184, but this explicit-param emission is version-independent.
    expect(out).toContain('const __pixel = Fn(([__c0, __color]) => {');
    expect(out).toContain('Discard(__c0);');
    expect(out).toContain('return __color;');
    expect(out).not.toMatch(/__pixel\s*=\s*Fn\(\(\)\s*=>/); // no empty-param closure form
  });

  it('re-imports Fn + positionLocal/normalLocal needed by the transforms', () => {
    expect(out).toMatch(/import \{[^}]*\bFn\b[^}]*\} from 'three\/tsl';/);
    expect(out).toMatch(/import \{[^}]*\bpositionLocal\b[^}]*\} from 'three\/tsl';/);
    expect(out).toMatch(/import \{[^}]*\bnormalLocal\b[^}]*\} from 'three\/tsl';/);
  });
});

describe('tslToShaderModule — color-only + discard', () => {
  const out = tslToShaderModule(COLOR_DISCARD);

  it('wraps the single color value in a param-passing __pixel', () => {
    expect(out).toContain('colorNode: __pixel(greaterThan1, mix1)');
    expect(out).toContain('const __pixel = Fn(([__c0, __color]) => {');
    expect(out).not.toContain('colorNode: __pixel()');
  });
});

describe('tslToShaderModule — multi-channel, no discard', () => {
  const out = tslToShaderModule(COLOR_POS);

  it('emits both channels directly, no __pixel', () => {
    expect(out).toContain('colorNode: mix1');
    expect(out).toContain('positionNode: positionLocal.add(normalLocal.mul(mul3))');
    expect(out).not.toContain('__pixel');
  });
});

describe('tslToShaderModule — property schema', () => {
  const withProp = `import { Fn, uniform, mul, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const amount = uniform(2.5);
  const mul1 = positionGeometry.mul(amount);

  return mul1;
});

export default shader;
`;
  const out = tslToShaderModule(withProp, undefined, [
    { name: 'amount', type: 'float', defaultValue: 2.5 },
  ]);

  it('rewrites the uniform to params and exports a schema with the declared default', () => {
    expect(out).toContain('const amount = params.amount;');
    expect(out).toContain("amount: { type: 'number', default: 2.5 },");
    expect(out).toContain('export default function(params) {');
  });
});

describe('preview ↔ export parity (single source of truth)', () => {
  it('export output is exactly the usage header + the preview module', () => {
    const previewModule = buildShaderModule(COLOR_POS_DISCARD, {});
    const exportModule = tslToShaderModule(COLOR_POS_DISCARD);
    // Strip the leading `// ...` header block + the blank line that follows it.
    const lines = exportModule.split('\n');
    let i = 0;
    while (i < lines.length && lines[i].startsWith('//')) i++;
    while (i < lines.length && lines[i].trim() === '') i++;
    const exportBody = lines.slice(i).join('\n');
    expect(exportBody).toBe(previewModule);
  });
});

describe('usage header: plain Three.js', () => {
  // The header replaced an unqualified "also usable with Three.js" claim with
  // the loader 0.8 core calls, and links the README section that spells them
  // out. Its words are also read by the loaders' source scans
  // (autoInjectTSLImports matches an UNANCHORED import brace, comments
  // included; autoDetectSchema looks for params members), so the header may
  // spell neither.
  const README_RECIPE = 'https://github.com/Alvis1/FastShaders#using-the-shader-module-with-plain-threejs';
  const withProp = `import { Fn, uniform, mul, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const amount = uniform(2.5);
  const mul1 = positionGeometry.mul(amount);

  return mul1;
});

export default shader;
`;
  const cases: Array<[string, string]> = [
    ['no properties', tslToShaderModule(COLOR_POS_DISCARD)],
    ['a declared property', tslToShaderModule(withProp, undefined, [
      { name: 'amount', type: 'float', defaultValue: 2.5 },
    ])],
  ];
  for (const [label, out] of cases) {
    const hdr = out.split('\n').filter((l) => l.startsWith('//')).join('\n');

    it(`${label}: names the loader core calls and links the README recipe`, () => {
      expect(out).not.toContain('Also usable directly with Three.js');
      expect(hdr).toContain('FastShaders.use');
      expect(hdr).toContain('FastShaders.apply');
      expect(hdr).toContain('FastShaders.load');
      expect(hdr).toContain(README_RECIPE);
      // The two statements the loader switch made false must not come back:
      // the module now imports THREE itself (C2) and every TSL function it
      // calls (C3).
      expect(hdr).not.toContain('globalThis.THREE');
      expect(hdr).not.toMatch(/not in its import line/);
    });

    it(`${label}: the plain-three block names no loader FILE, so a bump never edits it`, () => {
      const lines = hdr.split('\n');
      const from = lines.findIndex((l) => l.includes('Plain Three.js r'));
      const to = lines.findIndex((l) => l.includes(README_RECIPE));
      const block = lines.slice(from, to + 1).join('\n');
      expect(block).not.toContain('a-frame-shaderloader-');
      expect(block).not.toContain(LOADER_FILE);
      // …while the A-Frame setup lines above it DO carry the pinned loader.
      expect(lines.slice(0, from).join('\n')).toContain(LOADER_FILE);
      // A dead API never ships again: P3d's first draft wrote
      // `apply(mesh, url, { THREE })`, which 0.8 does not define.
      expect(block).not.toMatch(/\{\s*THREE\s*\}/);
    });

    it(`${label}: spells nothing the loader's source scans would act on`, () => {
      expect(hdr).not.toMatch(/import\s*\{/);
      expect(hdr).not.toMatch(/params\.\w/);
      expect(hdr).not.toMatch(/\bconst\s+\w+\s*=\s*uniform\(/);
      for (const bad of ['*/', 'FASTSHADERS_PROJECT_V1']) {
        expect(hdr, `header contains ${bad}`).not.toContain(bad);
      }
      // The A-Frame setup lines above it legitimately name `<script>` tags, so
      // the markup rule is scoped to the plain-three block itself.
      const lines = hdr.split('\n');
      const from = lines.findIndex((l) => l.includes('Plain Three.js r'));
      const to = lines.findIndex((l) => l.includes(README_RECIPE));
      expect(to - from).toBe(6);
      expect(lines.slice(from, to + 1).join('\n')).not.toContain('</script');
    });
  }

  it('the linked README section exists, so the header link cannot 404', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    // The WHOLE heading line, not a prefix: a suffix ("… Three.js r184")
    // changes GitHub's anchor, so a substring match would stay green while
    // every export header's link lands at the top of the README.
    const heading = '## Using the shader module with plain Three.js';
    expect(readme.split(/\r?\n/)).toContain(heading);
    // GitHub's anchor, DERIVED from that heading (lower-cased, everything but
    // letters/digits/spaces/hyphens dropped, spaces to hyphens) — never a
    // second copy of the literal the link was built from.
    const slug = heading
      .slice(3)
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '')
      .replace(/ /g, '-');
    expect(README_RECIPE.split('#')[1]).toBe(slug);
    // README's own in-page link to the section must resolve to it too.
    expect(readme).toContain(`](#${slug})`);
  });
});

describe('usage header: GLB mode (opts.glbFile — the single-GLB export)', () => {
  const plain = tslToShaderModule(COLOR_POS_DISCARD);
  const glb = tslToShaderModule(COLOR_POS_DISCARD, undefined, undefined, undefined, { glbFile: 'my-shader.glb' });
  const headerOf = (out: string) => {
    const lines = out.split('\n');
    let i = 0;
    while (i < lines.length && lines[i].startsWith('//')) i++;
    return { header: lines.slice(0, i), body: lines.slice(i).join('\n') };
  };

  it('the GLB block sits directly above the plain-three block, then one `//` separator', () => {
    const { header } = headerOf(glb);
    const block = glbModuleHeaderLines('my-shader.glb');
    const from = header.indexOf(block[0]);
    expect(from).toBeGreaterThan(0);
    expect(header.slice(from, from + block.length)).toEqual(block);
    expect(header[from + block.length]).toBe('//');
    expect(header[from + block.length + 1]).toMatch(/^\/\/ Plain Three\.js r/);
    expect(header[from - 1]).toBe('//');
  });

  it('the body after the header is byte-identical to the .js export, and the .js header is unchanged', () => {
    expect(headerOf(glb).body).toBe(headerOf(plain).body);
    const { header: h1 } = headerOf(plain);
    const { header: h2 } = headerOf(glb);
    expect(h2).toHaveLength(h1.length + glbModuleHeaderLines('x').length + 1);
    expect(h2.filter((l) => !glbModuleHeaderLines('my-shader.glb').includes(l) || h1.includes(l))).toHaveLength(h1.length + 1);
    // An empty opts object is the no-option output, byte for byte.
    expect(tslToShaderModule(COLOR_POS_DISCARD, undefined, undefined, undefined, {})).toBe(plain);
  });

  for (const v of ACTIVE_LOADERS) {
    it.skipIf(!loaderAvailable(v))(`loader ${v}: the GLB block injects no import and declares no property (comment-strip proof)`, () => {
      const t = transformsOf(v);
      const importLine = (s: string) => /^import \{[^}]*\} from 'three\/tsl';/m.exec(s)?.[0] ?? null;
      expect(importLine(t.autoInjectTSLImports(glb))).toBe(importLine(t.autoInjectTSLImports(plain)));
      expect(t.autoInjectTSLImports(glb)).not.toMatch(/\b(url|gltf|model|a)\b[^\n]*from 'three\/tsl'/);
      expect(Object.keys(t.autoDetectSchema(glb))).toEqual(Object.keys(t.autoDetectSchema(plain)));
    });
  }
});

describe('round-trip: export → scriptToTSL recovers the original channels', () => {
  it('color + position + discard survives the round-trip', () => {
    const exported = tslToShaderModule(COLOR_POS_DISCARD);
    const back = scriptToTSL(exported);

    // The param-passing wrapper is fully unwound.
    expect(back).not.toContain('__pixel');
    expect(back).not.toContain('__color');
    expect(back).not.toContain('__c0');
    // Discard restored as a bare statement with the real condition.
    expect(back).toContain('Discard(greaterThan1);');
    // Channels renamed back and displacement unwrapped.
    expect(back).toContain('return { color: mix1, position: mul3 };');
    expect(back).not.toContain('positionLocal');
    // Wrapped back into the canonical Fn shader form.
    expect(back).toContain('const shader = Fn(() => {');
    expect(back).toContain('export default shader;');
  });

  it('color-only + discard survives the round-trip', () => {
    const exported = tslToShaderModule(COLOR_DISCARD);
    const back = scriptToTSL(exported);
    expect(back).not.toContain('__pixel');
    expect(back).toContain('Discard(greaterThan1);');
    expect(back).toContain('return { color: mix1 };');
  });
});

describe('scriptToTSL pass-through: raw editor-style TSL is returned unchanged', () => {
  const RAW_TSL = [
    'import { Fn, vec3, uv, mx_noise_float, uniform } from "three/tsl";',
    '',
    'const shader = Fn(() => {',
    '  const scale = uniform(2);',
    '  const n = mx_noise_float(uv().mul(scale));',
    '  return { color: vec3(n, n, n) };',
    '});',
    '',
    'export default shader;',
    '',
  ].join('\n');

  it('returns editor-shaped TSL byte-identical (no body loss)', () => {
    // Without the pass-through, the conversion loop only recognises the
    // `export default function` module shape and silently drops the whole
    // Fn body — a raw-TSL drop imported as an empty graph.
    expect(scriptToTSL(RAW_TSL)).toBe(RAW_TSL);
  });

  it('still converts a module that CONTAINS nested Fn wrappers', () => {
    // The __pixel discard form has Fn( inside the module wrapper — it must
    // take the conversion path, not the pass-through.
    const exported = tslToShaderModule(COLOR_DISCARD);
    expect(exported).toContain('export default function');
    const back = scriptToTSL(exported);
    expect(back).toContain('const shader = Fn(() => {');
    expect(back).not.toContain('export default function');
  });
});

describe('tslToShaderModule — environment + metalness node props', () => {
  it('maps metalness → metalnessNode and env → envNode', () => {
    const src = `import { Fn, color, float, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const color1 = color(0x112233);
  const float1 = float(0.8);

  return { color: color1, metalness: float1, env: vec3(0.5, 0.5, 0.5) };
});

export default shader;
`;
    const out = tslToShaderModule(src);
    expect(out).toContain('metalnessNode: float1');
    expect(out).toContain('envNode: vec3(0.5, 0.5, 0.5)');
  });

  it('carries a graphToCode image→env graph end-to-end (envNode: texture(tex))', () => {
    const img = makeNode('img', 'imageNode', {
      imageB64: `data:image/webp;base64,${btoa('abc')}`,
      width: 2,
      height: 2,
      fileName: 'forest.webp',
      colorSpace: 'color',
    });
    const c = makeNode('c', 'color', { hex: '#112233' });
    const outNode = makeNode('out', 'output');
    const edges = [
      makeEdge('c', 'out', 'out', 'color'),
      makeEdge('img', 'out', 'out', 'env'),
    ];
    const { code } = graphToCode([img, c, outNode], edges);
    const module = tslToShaderModule(code);
    // The env channel survives module conversion as a material envNode
    // referencing the module-scope texture (shaderloader 0.5 assigns it;
    // three's EnvironmentNode PMREMs it for IBL).
    expect(module).toContain('envNode: texture(_image1_tex)');
    expect(module).toContain('const _image1_tex =');
  });
});

describe('tslToShaderModule — module header is not a code-injection surface', () => {
  it('cannot break out of the module header via a stored hex', () => {
    // A newline in values.hex ends the `//` comment and would inject a real
    // top-level statement into the downloaded .js.
    const EVIL = "#ff0000\nglobalThis.__HDR_PWNED = 1;\n// ";
    const p = makeNode('p', 'property_color', { name: 'col', hex: EVIL });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([p, out], [makeEdge('p', 'out', 'out', 'color')]);
    const mod = tslToShaderModule(code, undefined, [
      { name: 'col', type: 'color', defaultValue: EVIL },
    ]);
    expect(mod.split('\n').some((l) => l.trim().startsWith('globalThis.'))).toBe(false);
    expect(mod).toContain('col: #000000');
  });
});

describe('tslToShaderModule — the declared property list is not derivable from `code`', () => {
  it('changes the module even when the emitted TSL is byte-identical', () => {
    // The declared property list is NOT derivable from `code`: graphToCode's
    // claimName pre-pass already emitted `x` and `x2`, so renaming the second
    // node from "x" to "x2" leaves the TSL byte-identical while buildHeader's
    // dedupe-by-sanitized-name (tslToShaderModule.ts:57-63) gains a row. This
    // is the invariant CodeEditor's Output-tab memo keys on; it is a
    // DOCUMENTATION pin, not a guard — no node-env test can observe that memo's
    // dep array (vitest env is `node`, include is src/**/*.test.ts).
    const out = makeNode('out1', 'output');
    const pa = makeNode('pa', 'property_float', { name: 'x', value: 0.5 });
    const pbDup = makeNode('pb', 'property_float', { name: 'x', value: 0.25 });
    const pbRenamed = makeNode('pb', 'property_float', { name: 'x2', value: 0.25 });
    // BOTH properties are wired: this test is about the claimName pre-pass
    // producing `x` and `x2`, and an unwired property no longer emits at all
    // (graphToCode skips a property with no consumer), which would leave
    // nothing to collide.
    const edges = [
      makeEdge('pa', 'out', 'out1', 'color'),
      makeEdge('pb', 'out', 'out1', 'opacity'),
    ];

    const codeA = graphToCode([pa, pbDup, out], edges).code;
    const codeB = graphToCode([pa, pbRenamed, out], edges).code;
    expect(codeB).toBe(codeA); // byte-identical TSL
    expect(codeA).toContain('const x = uniform(0.5);');
    expect(codeA).toContain('const x2 = uniform(0.25);');

    const modA = tslToShaderModule(codeA, undefined, [
      { name: 'x', type: 'float', defaultValue: 0.5 },
      { name: 'x', type: 'float', defaultValue: 0.25 },
    ]);
    const modB = tslToShaderModule(codeB, undefined, [
      { name: 'x', type: 'float', defaultValue: 0.5 },
      { name: 'x2', type: 'float', defaultValue: 0.25 },
    ]);
    expect(modB).not.toBe(modA);
    expect(modA).toContain('src: shader.js; x: 0.5"');
    expect(modB).toContain('src: shader.js; x: 0.5; x2: 0.25"');
    expect(modB).toContain("el.setAttribute('shader', { x2: value });");
    expect(modA).not.toContain('x2: value');
  });
});

/**
 * `mergeVertices` is how the Output node's "Merge Vertices" reaches
 * shaderloader 0.6, which welds a displaced primitive's coincident vertices so
 * a box does not split into floating faces. It is the FIRST key here that is
 * not a THREE.Material property — the loader reads it off the module's return
 * object rather than copying it onto the material.
 *
 * The polarity is what makes it safe: only an explicit `false` is emitted, so
 * every module written before the key existed is byte-identical to one written
 * after, and absent === weld matches the editor's own `undefined === true`.
 */
describe('mergeVertices — the opt-OUT key', () => {
  it('emits nothing for every state except an explicit false', () => {
    const base = buildShaderModule(COLOR_POS);
    for (const settings of [undefined, {}, { mergeVertices: true }]) {
      const out = buildShaderModule(COLOR_POS, { materialSettings: settings });
      expect(out, JSON.stringify(settings)).toBe(base);
      expect(out).not.toContain('mergeVertices');
    }
  });

  it('emits the key only when the author unticked the box', () => {
    const out = buildShaderModule(COLOR_POS, { materialSettings: { mergeVertices: false } });
    expect(out).toContain('mergeVertices: false');
  });

  // The settings menu writes a literal `true` when the box is re-ticked, so a
  // `!== true` or truthiness gate would add the key to a perfectly default
  // node — and every already-exported shader would stop matching its own
  // re-export. Pinned because the difference is one operator.
  it('an explicit true is indistinguishable from absent', () => {
    expect(buildShaderModule(COLOR_POS, { materialSettings: { mergeVertices: true } }))
      .toBe(buildShaderModule(COLOR_POS, { materialSettings: {} }));
  });
});

describe('adversarial dispatch keys never resolve through the prototype chain', () => {
  // These dictionaries are indexed by strings out of untrusted input (a
  // .fastshader's materialSettings, a pasted module's return-object keys). A
  // bare Record resolved 'constructor' to Object.prototype's constructor — a
  // truthy Function that was stringified into the emitted module as
  // `function Object() { [native code] }`, a SyntaxError that killed the
  // whole shader with an opaque parse error.
  it('a tampered materialSettings.side emits side: 0, never an inherited Function', () => {
    for (const evil of ['constructor', 'toString', 'valueOf', '__proto__']) {
      const out = buildShaderModule(COLOR_POS, {
        materialSettings: { transparent: true, side: evil as never },
      });
      expect(out, evil).toContain('side: 0');
      expect(out, evil).not.toContain('native code');
    }
  });

  it('a pasted return-object channel named constructor is dropped, not emitted', () => {
    const src = `import { Fn, vec3 } from 'three/tsl';

const shader = Fn(() => {
  return { constructor: vec3(1, 0, 0), color: vec3(0, 1, 0) };
});

export default shader;
`;
    const out = buildShaderModule(src, {});
    expect(out).not.toContain('native code');
    expect(out).toContain('colorNode:');
  });
});
