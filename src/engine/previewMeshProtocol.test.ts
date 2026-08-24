/**
 * Pins the preview's SUB-MESH protocol — the `fs:model-meshes` report the
 * sandbox posts up, and the `fs:highlight-mesh` message the parent posts down.
 *
 * Both halves live inside a generated template string, so nothing executes them
 * here and nothing else in the suite would notice them disappearing. The rules
 * below are the ones that fail SILENTLY if they rot: a report with the wrong
 * key is indistinguishable from a stale one and is simply dropped by the
 * parent, a report emitted for a primitive would offer an unnamed mesh nobody
 * can target, and a highlight that restores from a stashed material reference
 * restores a DISPOSED material — the loader disposes the outgoing shader
 * material before assigning the new one, so the stash is only ever valid until
 * the next shader edit, which in this editor is seconds away.
 */

import { describe, it, expect } from 'vitest';
import { tslToPreviewHTML } from './tslToPreviewHTML';

const TSL = `const shader = Fn(() => {
  return { color: vec3(1, 0, 0) };
});
export default shader;`;

const customModel = { kind: 'glb' as const, id: 7 };

describe('fs:model-meshes (sandbox → parent)', () => {
  it('is emitted for a dropped model, keyed to that mesh instance', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'custom', customModel });
    expect(html).toContain('fs:model-meshes');
    // The key is what lets the parent tell a live report from one posted by a
    // document it has already torn down (every shader edit mints a new one).
    expect(html).toContain('var __fsMeshKey = "custom:7";');
  });

  it('is emitted for a built-in model, keyed by geometry name', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'teapot' });
    expect(html).toContain('var __fsMeshKey = "teapot";');
  });

  it('is NOT emitted for primitives — there is nothing addressable to report', () => {
    for (const geometry of ['sphere', 'cube', 'plane'] as const) {
      const html = tslToPreviewHTML(TSL, { geometry });
      expect(html).not.toContain('fs:model-meshes');
      expect(html).not.toContain('fs:highlight-mesh');
    }
  });

  it('is NOT emitted into the XR popup — it is an authoring channel', () => {
    // The popup is a top-level document with no editor attached; posting to
    // `window.parent` there would be posting to itself.
    const html = tslToPreviewHTML(TSL, { geometry: 'custom', customModel, xr: true });
    expect(html).not.toContain('fs:model-meshes');
  });

  it('reports the AUTHORED material name, not the shader material', () => {
    // By report time the loader has usually stamped its own material over every
    // mesh; it keeps the originals keyed by uuid, so that map is asked first.
    const html = tslToPreviewHTML(TSL, { geometry: 'custom', customModel });
    expect(html).toContain('comp.originalMaterials[n.uuid]');
  });

  it('defers the report a tick past model-loaded', () => {
    // fit-bounds bakes geometry and the loader stores the authored materials on
    // the same event, both registered earlier; reading synchronously would race
    // whichever of them happens to run after us.
    const html = tslToPreviewHTML(TSL, { geometry: 'custom', customModel });
    expect(html).toContain('e.addEventListener("model-loaded", function () { setTimeout(report, 0); });');
    // …and a model that finished loading before the listener existed is still
    // reported, or a fast blob: URL leaves the picker permanently empty.
    expect(html).toContain('if (e.getObject3D && e.getObject3D("mesh")) setTimeout(report, 0);');
  });
});

describe('fs:highlight-mesh (parent → sandbox)', () => {
  it('accepts the message only from the parent document', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'custom', customModel });
    const block = html.slice(html.indexOf('__fsMeshKey'));
    expect(block).toContain('if (e.source !== window.parent) return;');
  });

  it('restores by RE-DERIVING from the live component, never from a stash', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'custom', customModel });
    const block = html.slice(html.indexOf('__fsMeshKey'));
    // The restore reads the material that is current NOW…
    expect(block).toContain('comp._shaderMaterial');
    expect(block).toContain('comp.originalMaterials ? comp.originalMaterials[n.uuid] : null');
    // …and must never have captured one on the way in. Asserted against the
    // CODE with comments stripped — the prose right above the restore explains
    // this very hazard and would otherwise trip the guard describing it.
    const code = block.replace(/\/\/[^\n]*/g, '');
    // `lit` holds MESHES, so the restore can ask the component about each one.
    // The moment it starts holding materials, a highlight spanning a shader
    // re-apply puts a DISPOSED material back and the mesh renders black with
    // no error anywhere.
    expect(code).toContain('lit.push(list[i]);');
    expect(code).not.toMatch(/lit\.push\(\{/);
    expect(code).not.toMatch(/(prev|saved|stashed)Material/i);
  });

  it('mints ONE shared highlight material, not one per hovered row', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'custom', customModel });
    const block = html.slice(html.indexOf('__fsMeshKey'));
    expect(block).toContain('if (!hlMat && window.THREE)');
    expect((block.match(/new window\.THREE\.MeshBasicMaterial/g) ?? [])).toHaveLength(1);
  });

  it('clears a previous highlight before applying a new one', () => {
    // Hovering row after row must not leave earlier rows lit.
    const html = tslToPreviewHTML(TSL, { geometry: 'custom', customModel });
    const block = html.slice(html.indexOf('__fsMeshKey'));
    const fn = block.slice(block.indexOf('function highlight(name)'));
    expect(fn.slice(0, 200)).toContain('clearHighlight();');
  });
});
