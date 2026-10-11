/**
 * Render on demand, the parent's half (previewRenderMode.ts): which modules
 * and which preview states keep the stage drawing every frame, and how
 * ShaderPreview posts and replays the answer (source pins: the vitest env is
 * `node`, see previewRebuild.test.ts).
 *
 * The rule errs towards continuous: a false "continuous" costs only the idle
 * saving, a false "static" freezes a picture that should move.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode, makeEdge } from '@/test-utils';
import { graphToCode } from '@/engine/graphToCode';
import { RENDER_MODE_MESSAGE, buildPreviewShaderModule } from '@/engine/tslToPreviewHTML';
import {
  moduleIsTimeVarying,
  previewRendersContinuously,
  type RenderModeInputs,
} from './previewRenderMode';

const SRC = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');

/** The module the preview would run for a graph, through the real pipeline. */
function previewModuleOf(nodes: ReturnType<typeof makeNode>[], edges: ReturnType<typeof makeEdge>[]): string {
  return buildPreviewShaderModule(graphToCode(nodes, edges).code);
}

describe('moduleIsTimeVarying: the module text', () => {
  it('a static graph, through graphToCode and the module wrapper, does not read time', () => {
    // The wrapper's own text (imports, schema, revision) must not trip it, or
    // every shader would draw every frame and the feature would do nothing.
    const mod = previewModuleOf(
      [makeNode('c', 'color', { value: '#ff8800' }), makeNode('out', 'output')],
      [makeEdge('c', 'out', 'out', 'color')],
    );
    // The whole wrapper is in view: the completed import, the revision export
    // and the material return.
    expect(mod).toContain("from 'three/tsl';");
    expect(mod).toContain('export const threeRevision');
    expect(mod).toContain('colorNode');
    expect(moduleIsTimeVarying(mod)).toBe(false);
  });

  it('the same graph with a Time node feeding it does', () => {
    const mod = previewModuleOf(
      [makeNode('t', 'time'), makeNode('s', 'sin', { x: 0 }), makeNode('out', 'output')],
      [makeEdge('t', 'out', 's', 'x'), makeEdge('s', 'out', 'out', 'color')],
    );
    expect(moduleIsTimeVarying(mod)).toBe(true);
  });

  it('every TSL clock and per-frame hook', () => {
    for (const src of [
      'const t = time;',
      'const d = deltaTime.mul(2);',
      'const f = frameId;',
      'oscSine()', 'oscSquare(t)', 'oscTriangle()', 'oscSawtooth()',
      'timerLocal()', 'timerGlobal(2)', 'timerDelta()',
      'u.onFrameUpdate(() => 1)', 'u.onRenderUpdate(fn)', 'u.onObjectUpdate(fn)',
    ]) {
      expect(moduleIsTimeVarying(src), src).toBe(true);
    }
  });

  it('plain-JS ways for module code to change a value later, and the wall clock', () => {
    for (const src of [
      'setInterval(f, 10)', 'setTimeout(f)', 'requestAnimationFrame(loop)',
      'v.requestVideoFrameCallback(cb)', "window.addEventListener('pointermove', f)",
      'Date.now()', 'performance.now()',
    ]) {
      expect(moduleIsTimeVarying(src), src).toBe(true);
    }
  });

  it('is word-bounded: a property named timeScale or uptime is not a clock', () => {
    for (const src of ['const timeScale = uniform(1);', 'const uptime = 3;', 'const runtimeX = 1;', 'lifetimes']) {
      expect(moduleIsTimeVarying(src), src).toBe(false);
    }
  });

});

describe('previewRendersContinuously: ANY input keeps it drawing', () => {
  const still: RenderModeInputs = {
    moduleAnimates: false,
    turntable: false,
    clipPlaying: false,
    splatShown: false,
    stats: false,
    soundArmed: false,
  };

  it('a still scene with nothing on is the one static case', () => {
    expect(previewRendersContinuously(still)).toBe(false);
  });

  it.each(Object.keys(still) as (keyof RenderModeInputs)[])('%s alone makes it continuous', (key) => {
    expect(previewRendersContinuously({ ...still, [key]: true })).toBe(true);
  });
});

describe('ShaderPreview: the post, the inputs and the replay (source)', () => {
  it('the message type is the contract’s, spelled ONCE: the stage’s constant, imported', () => {
    expect(RENDER_MODE_MESSAGE).toBe('fs:render-mode');
    // ShaderPreview takes it from the stage module like SHADER_SWAP_MESSAGE,
    // and no second spelling of the literal exists on the parent side.
    const imports = SRC.slice(0, SRC.indexOf("} from '@/engine/tslToPreviewHTML';"));
    expect(imports.slice(imports.lastIndexOf('import {'))).toContain('RENDER_MODE_MESSAGE,');
    expect(SRC).not.toContain("'fs:render-mode'");
    const parentModule = readFileSync(resolve(__dirname, 'previewRenderMode.ts'), 'utf8');
    expect(parentModule).not.toMatch(/=\s*'fs:render-mode'/);
  });

  it('computes the flag from the six inputs, the module being the one the live document runs', () => {
    const at = SRC.indexOf('const moduleAnimates = useMemo(');
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, SRC.indexOf('}, [renderContinuous]);', at));
    expect(block).toContain('const moduleAnimates = useMemo(() => moduleIsTimeVarying(previewModule), [previewModule]);');
    expect(block).toContain('turntable: playing,');
    expect(block).toContain('clipPlaying: animInfo !== null && animPlaying,');
    expect(block).toContain("splatShown: previewGeometry === 'custom' && splatLoaded,");
    expect(block).toContain('stats: showStats,');
    expect(block).toContain("soundArmed: mic.status === 'on' || mic.status === 'starting',");
  });

  it('posts on change and mirrors the value for the handler', () => {
    const at = SRC.indexOf('const moduleAnimates = useMemo(');
    const block = SRC.slice(at, SRC.indexOf('}, [renderContinuous]);', at));
    expect(block).toContain('renderContinuousRef.current = renderContinuous;');
    expect(block).toContain(
      "iframeRef.current?.contentWindow?.postMessage({ type: RENDER_MODE_MESSAGE, continuous: renderContinuous }, '*');",
    );
    // The ref starts on the side a fresh document is already on.
    expect(SRC).toContain('const renderContinuousRef = useRef(true);');
  });

  it('replays it on every fs:preview-ready, tagged or not, beside the stats re-arm', () => {
    const at = SRC.indexOf("if (data.type === 'fs:preview-ready') {");
    const branch = SRC.slice(at, SRC.indexOf("} else if (data.type === 'fs:camera') {", at));
    const stats = branch.indexOf("if (showStatsRef.current) win.postMessage({ type: 'fs:stats-on', on: true }, '*');");
    const mode = branch.indexOf("win.postMessage({ type: RENDER_MODE_MESSAGE, continuous: renderContinuousRef.current }, '*');");
    expect(stats).toBeGreaterThan(-1);
    expect(mode).toBeGreaterThan(stats);
    // Unconditional: not gated on the flag's value or on a gen.
    const line = branch.slice(branch.lastIndexOf('\n', mode), mode);
    expect(line.trim()).toBe('');
  });

  it('the XR popup is not told: it is a top-level document with no parent loop to pace', () => {
    const at = SRC.indexOf('const handleOpenVR = useCallback(');
    const body = SRC.slice(at, SRC.indexOf('w.document.write(html);', at));
    expect(body).not.toContain('RENDER_MODE_MESSAGE');
  });
});
