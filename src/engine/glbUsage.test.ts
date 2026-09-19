/**
 * engine/glbUsage.ts — the GLB usage header the single-GLB module carries
 * and the A-Frame snippet that runs it. Pure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MODEL_SRC } from './glbShaderContract';
import { GLB_SRC_MODEL, glbAFrameSnippet, glbModuleHeaderLines, safeGlbFileName } from './glbUsage';

const REPO = path.resolve(__dirname, '../..');

describe('glbModuleHeaderLines', () => {
  const lines = glbModuleHeaderLines('x.glb');

  it('is exactly six `//` lines', () => {
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(l.startsWith('//'), l).toBe(true);
  });

  it('spells nothing the loaders\' source scans or the module comment could trip on', () => {
    const text = lines.join('\n');
    for (const ch of text) expect(ch.charCodeAt(0), `non-ASCII ${JSON.stringify(ch)}`).toBeLessThan(0x80);
    expect(text).not.toContain('{');
    expect(text).not.toContain('*/');
    expect(text).not.toContain('import');
    expect(text).not.toMatch(/params\.\w/);
    expect(text).not.toContain('</script');
  });

  it('names the opt-in, the loader floor and the snippet verbatim', () => {
    const text = lines.join('\n');
    expect(text).toContain('src: model');
    expect(text).toContain('0.8');
    expect(lines[2]).toBe(`//   ${glbAFrameSnippet('x.glb')}`);
    expect(GLB_SRC_MODEL).toBe(MODEL_SRC);
    expect(glbAFrameSnippet('my-shader.glb')).toBe(
      '<a-entity gltf-model="url(my-shader.glb)" shader="src: model" position="0 1.6 -3"></a-entity>',
    );
  });

  it('whitelists a hostile file name to [A-Za-z0-9._-], never closing the comment or injecting markup', () => {
    const hostile = 'a*/</script>{b}\n.glb';
    expect(safeGlbFileName(hostile)).toBe('ascriptb.glb');
    const text = glbModuleHeaderLines(hostile).join('\n');
    expect(text).not.toContain('*/');
    expect(text).not.toContain('<script');
    expect(text.split('\n')).toHaveLength(6);
    expect(safeGlbFileName('')).toBe('model.glb');
    expect(safeGlbFileName('.glb')).toBe('model.glb');
    expect(safeGlbFileName('x.js')).toBe('model.glb');
    expect(safeGlbFileName('Ēnotājs.glb')).toBe('notjs.glb');
  });

  it('the README spells the snippet the header spells, so the doc cannot drift from the code', () => {
    const readme = readFileSync(path.join(REPO, 'README.md'), 'utf8');
    expect(readme).toContain(glbAFrameSnippet('my-shader.glb'));
    // …and the section that explains it, with the one warning that matters.
    expect(readme).toContain('## Single-GLB export');
    expect(readme).toContain('Never use `src: model` on a page that loads models other people supply');
  });

  it('the preview template never passes glbFile (integration §3 C11): the run documents get the .js header only', () => {
    const preview = readFileSync(path.join(REPO, 'src/engine/tslToPreviewHTML.ts'), 'utf8');
    expect(preview).not.toContain('glbFile');
    expect(preview).not.toContain('glbUsage');
  });
});
