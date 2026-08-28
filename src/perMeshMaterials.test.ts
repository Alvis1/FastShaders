/**
 * Per-mesh materials, the two halves that live OUTSIDE `src/` and therefore
 * outside every other suite:
 *
 *  1. shaderloader 0.6's per-mesh dispatch — specifically the single-mesh
 *     fallback, where a parts-only module on a model with exactly ONE mesh
 *     puts its FIRST part on that mesh instead of leaving it authored. The
 *     component file is a plain script, so it is EVALUATED here and
 *     `applyMaterialToMesh` is called for real; a source grep would pass
 *     against a gate whose conditions had been quietly widened.
 *
 *  2. podest's mesh-material picker. The stage half is a string built by
 *     `buildStageDoc`, so nothing normally executes it — the same problem
 *     `previewGltfAnim.test.ts` has with `gltf-anim`, and the same answer:
 *     pull the emitted functions out of the page and run them against stubs.
 *     The parent half (menus, replay wiring) touches the DOM and cannot run
 *     under the `node` env, so it is pinned from SOURCE instead.
 *
 * The three conditions on the loader gate are the whole safety argument and
 * each is asserted separately: widening any one of them silently REPAINTS
 * models the shader never claimed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const repoRoot = path.resolve(__dirname, '..');
const LOADER = path.join(repoRoot, 'public/js/a-frame-shaderloader-0.6.js');
const LOADER_SRC = path.join(repoRoot, 'a-frame-shaderloader/js/a-frame-shaderloader-0.6.js');
const PODEST = path.join(repoRoot, 'public/podest.html');

const loaderText = readFileSync(LOADER, 'utf8');
const podestText = readFileSync(PODEST, 'utf8');

/* ── 1. shaderloader 0.6: applyMaterialToMesh ───────────────────────────── */

interface FakeMaterial { tag: string }
interface FakeMesh {
  isMesh: true;
  name: string;
  uuid: string;
  material: FakeMaterial;
}
interface ShaderComponent {
  originalMaterials: Record<string, FakeMaterial>;
  _appliedMaterials: Record<string, FakeMaterial> | null;
  applyMaterialToMesh: (
    mesh: unknown,
    material: FakeMaterial | null,
    partMaterials: Map<string, FakeMaterial> | null,
  ) => void;
}

/** Eval the real vendored component file and hand back its definition. */
function loadShaderComponent(): ShaderComponent {
  let def: ShaderComponent | null = null;
  const sandbox: Record<string, unknown> = {
    console: { log() {}, error() {}, warn() {} },
    URL,
    location: { href: 'https://example.test/podest.html' },
    AFRAME: {
      registerComponent(_name: string, d: ShaderComponent) { def = d; },
      registerShader() {},
      utils: {},
    },
    window: { THREE: null },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(LOADER, 'utf8'), sandbox);
  if (!def) throw new Error('the shader component never registered');
  return def;
}

const mesh = (name: string, uuid: string): FakeMesh => ({
  isMesh: true,
  name,
  uuid,
  material: { tag: `authored:${uuid}` },
});

/** A model root whose traverse() visits itself and then each mesh. */
function model(meshes: FakeMesh[]) {
  const root = {
    isMesh: false,
    traverse(fn: (n: unknown) => void) {
      fn(root);
      meshes.forEach(fn);
    },
  };
  return root;
}

/** Run applyMaterialToMesh against a fresh component instance. */
function dispatch(
  meshes: FakeMesh[],
  material: FakeMaterial | null,
  parts: Array<[string, FakeMaterial]> | null,
): ShaderComponent {
  const def = loadShaderComponent();
  const ctx = Object.create(def) as ShaderComponent;
  ctx.originalMaterials = {};
  meshes.forEach((m) => { ctx.originalMaterials[m.uuid] = m.material; });
  ctx._appliedMaterials = null;
  ctx.applyMaterialToMesh(model(meshes), material, parts ? new Map(parts) : null);
  return ctx;
}

describe('shaderloader 0.6 — single-mesh fallback for a parts-only module', () => {
  const body: FakeMaterial = { tag: 'part:Body' };
  const glass: FakeMaterial = { tag: 'part:Glass' };
  const dflt: FakeMaterial = { tag: 'default' };

  it('applies the FIRST part to the one mesh when nothing matched', () => {
    const only = mesh('SomeOtherName', 'u1');
    dispatch([only], null, [['Body', body], ['Glass', glass]]);
    expect(only.material).toBe(body);
  });

  it('"first" means ITERATION order, not alphabetical', () => {
    const only = mesh('SomeOtherName', 'u1');
    // Glass declared first in the module source ⇒ Glass wins.
    dispatch([only], null, [['Glass', glass], ['Body', body]]);
    expect(only.material).toBe(glass);
  });

  it('records the fallback in _appliedMaterials, so a highlight restores it', () => {
    const only = mesh('SomeOtherName', 'u1');
    const ctx = dispatch([only], null, [['Body', body]]);
    expect(ctx._appliedMaterials).toEqual({ u1: body });
  });

  it('a name match still wins over the fallback', () => {
    const only = mesh('Glass', 'u1');
    dispatch([only], null, [['Body', body], ['Glass', glass]]);
    expect(only.material).toBe(glass);
  });

  // ── the three gate conditions, each on its own ────────────────────────
  it('GATE: a MULTI-mesh model keeps its authored materials', () => {
    const a = mesh('Nope', 'u1');
    const b = mesh('AlsoNope', 'u2');
    const authoredA = a.material;
    const authoredB = b.material;
    dispatch([a, b], null, [['Body', body], ['Glass', glass]]);
    expect(a.material).toBe(authoredA);
    expect(b.material).toBe(authoredB);
  });

  it('GATE: a DEFAULT material wins over the fallback on a single mesh', () => {
    const only = mesh('Nope', 'u1');
    dispatch([only], dflt, [['Body', body], ['Glass', glass]]);
    expect(only.material).toBe(dflt);
  });

  it('GATE: a PARTLESS module behaves exactly as before', () => {
    const a = mesh('Nope', 'u1');
    const b = mesh('AlsoNope', 'u2');
    dispatch([a, b], dflt, null);
    expect(a.material).toBe(dflt);
    expect(b.material).toBe(dflt);

    // …and a partless module with no material at all touches nothing.
    const c = mesh('Nope', 'u3');
    const authored = c.material;
    dispatch([c], null, null);
    expect(c.material).toBe(authored);
  });

  it('the fallback is gated on all three conditions in SOURCE too', () => {
    // A behavioural test cannot tell "the gate is written correctly" from "the
    // gate happens to be unreachable", so pin the shape as well.
    const fn = loaderText.slice(
      loaderText.indexOf('applyMaterialToMesh: function'),
      loaderText.indexOf('disposeShaderMaterial: function'),
    );
    expect(fn).toContain('partMaterials && !material');
    expect(fn).toMatch(/meshCount\s*===\s*1/);
    expect(fn).toContain('partMaterials.values().next()');
  });

  it('the submodule source and the vendored copy carry the same gate', () => {
    // vendorSync.test.ts already fails on drift; this states WHY it matters
    // here — the submodule is the single source and public/js/ is a copy.
    expect(readFileSync(LOADER_SRC, 'utf8')).toBe(loaderText);
  });
});

/* ── 2. podest: the stage half of the fs:parts protocol ─────────────────── */

/** Pull one `L.push('…')` payload out of podest.html by a unique substring. */
function stagePayload(needle: string): string {
  const line = podestText
    .split('\n')
    .find((l) => l.includes(`L.push('`) && l.includes(needle));
  if (!line) throw new Error(`no L.push line containing ${needle}`);
  const start = line.indexOf(`L.push('`) + `L.push('`.length;
  const end = line.lastIndexOf(`');`);
  return line.slice(start, end).replace(/\\'/g, "'");
}

interface StageParts {
  reportParts: () => void;
  assignPart: (mesh: unknown, part: unknown) => void;
  setAttached: (v: boolean) => void;
}

interface StubComponent {
  _partMaterials: Map<string, FakeMaterial> | null;
  _shaderMaterial: FakeMaterial | null;
  originalMaterials: Record<string, FakeMaterial>;
}

/** Build the stage's parts helpers with a stub entity + message sink. */
function loadStageParts(
  meshes: FakeMesh[],
  comp: StubComponent | null,
  attached = true,
): { api: StageParts; sent: Array<Record<string, unknown>> } {
  const body = [
    stagePayload('function shaderComp()'),
    stagePayload('function meshList()'),
    stagePayload('function reportParts()'),
    stagePayload('function assignPart('),
  ].join('\n');
  const sent: Array<Record<string, unknown>> = [];
  const entity = {
    components: comp ? { shader: comp } : {},
    getObject3D: (k: string) => (k === 'mesh' ? model(meshes) : null),
  };
  const api = new Function(
    'entity',
    'toParent',
    'initialAttached',
    `var attached = initialAttached;\n${body}\n` +
      'return { reportParts: reportParts, assignPart: assignPart,' +
      ' setAttached: function (v) { attached = v; } };',
  )(entity, (m: Record<string, unknown>) => sent.push(m), attached) as StageParts;
  return { api, sent };
}

describe('podest stage — fs:parts / fs:assign-part', () => {
  const body: FakeMaterial = { tag: 'part:Body' };
  const glass: FakeMaterial = { tag: 'part:Glass' };
  const dflt: FakeMaterial = { tag: 'default' };

  const comp = (): StubComponent => ({
    _partMaterials: new Map([['Body', body], ['Glass', glass]]),
    _shaderMaterial: dflt,
    originalMaterials: {},
  });

  it('reports the meshes, the parts and whether there is a default', () => {
    const meshes = [mesh('Hull', 'u1'), mesh('Window', 'u2')];
    const { api, sent } = loadStageParts(meshes, comp());
    api.reportParts();
    expect(sent).toEqual([
      { type: 'fs:parts', meshes: ['Hull', 'Window'], parts: ['Body', 'Glass'], hasDefault: true },
    ]);
  });

  it('reports NO parts while the shader is detached (model-materials mode)', () => {
    const { api, sent } = loadStageParts([mesh('Hull', 'u1')], comp(), false);
    api.reportParts();
    expect(sent[0]).toMatchObject({ parts: [], hasDefault: false, meshes: ['Hull'] });
  });

  it('assigns the named part to every mesh carrying that name', () => {
    const a = mesh('Hull', 'u1');
    const b = mesh('Hull', 'u2');
    const c = mesh('Window', 'u3');
    const authoredC = c.material;
    const { api } = loadStageParts([a, b, c], comp());
    api.assignPart('Hull', 'Glass');
    expect(a.material).toBe(glass);
    expect(b.material).toBe(glass);
    expect(c.material).toBe(authoredC);
  });

  it('a null part means the default material', () => {
    const a = mesh('Hull', 'u1');
    const { api } = loadStageParts([a], comp());
    api.assignPart('Hull', 'Body');
    expect(a.material).toBe(body);
    api.assignPart('Hull', null);
    expect(a.material).toBe(dflt);
  });

  it('falls back to the AUTHORED material when there is no default', () => {
    const a = mesh('Hull', 'u1');
    const authored = a.material;
    const c = comp();
    c._shaderMaterial = null;
    c.originalMaterials = { u1: authored };
    const { api } = loadStageParts([a], c);
    api.assignPart('Hull', 'Body');
    expect(a.material).toBe(body);
    api.assignPart('Hull', null);
    expect(a.material).toBe(authored);
  });

  it('RE-DERIVES from the live component, never from a stashed reference', () => {
    // The loader disposes the outgoing material before assigning the new one,
    // so a reference cached across a shader re-apply would restore a disposed
    // material. Swap the component's maps and re-assign: the mesh must land on
    // the NEW objects.
    const a = mesh('Hull', 'u1');
    const c = comp();
    const { api } = loadStageParts([a], c);
    api.assignPart('Hull', 'Body');
    expect(a.material).toBe(body);
    const rebuiltBody: FakeMaterial = { tag: 'part:Body (re-applied)' };
    c._partMaterials = new Map([['Body', rebuiltBody]]);
    api.assignPart('Hull', 'Body');
    expect(a.material).toBe(rebuiltBody);
  });

  it('an unknown mesh or a non-string name is inert', () => {
    const a = mesh('Hull', 'u1');
    const { api } = loadStageParts([a], comp());
    api.assignPart('Nope', 'Body');
    api.assignPart(null, 'Body');
    api.assignPart(42, 'Body');
    expect(a.material.tag).toBe('authored:u1');
  });
});

/* ── 3. podest: the parent half, pinned from source ─────────────────────── */

describe('podest parent — mesh-material picker wiring', () => {
  it('carries both directions of the protocol', () => {
    expect(podestText).toContain('"fs:parts"');
    expect(podestText).toContain('"fs:assign-part"');
    // The right-click shortcut: the stage covers the viewport, so the
    // contextmenu is forwarded — and only while the parent has armed it.
    expect(podestText).toContain('"fs:contextmenu"');
    expect(podestText).toContain('"fs:context-hook"');
  });

  it('replays the assignments from applyStateToStage', () => {
    const fn = podestText.slice(
      podestText.indexOf('function applyStateToStage()'),
      podestText.indexOf('function noteStageAlive()'),
    );
    expect(fn).toContain('sendPartAssignments()');
    expect(fn).toContain('fs:context-hook');
    // …and again once the stage reports what it actually built, which is when
    // the part materials exist.
    const onParts = podestText.slice(
      podestText.indexOf('function onStageParts(m)'),
      podestText.indexOf('function syncPartsButton()'),
    );
    expect(onParts).toContain('sendPartAssignments()');
  });

  it('prunes assignments that the latest report no longer knows about', () => {
    const onParts = podestText.slice(
      podestText.indexOf('function onStageParts(m)'),
      podestText.indexOf('function syncPartsButton()'),
    );
    expect(onParts).toContain('meshes.indexOf(mesh) < 0');
    expect(onParts).toContain('parts.indexOf(p) < 0');
    // Null-prototype: the keys are mesh names out of a dropped file.
    expect(onParts).toContain('Object.create(null)');
    // …but NEVER against an empty report. Every stage rebuild replays the
    // geometry, whose clearGeo posts one before the model has loaded, so
    // pruning on that would wipe the assignments on exactly the restart the
    // replay exists to hide.
    expect(onParts).toContain('if (meshes.length && parts.length)');
    // Nothing stale is sent either way: each entry is re-checked, because the
    // stage resolves an unknown part to the DEFAULT material.
    const send = podestText.slice(
      podestText.indexOf('function sendPartAssignments()'),
      podestText.indexOf('function onStageParts(m)'),
    );
    expect(send).toContain('if (!partsAvailable()) return;');
    expect(send).toContain('partsInfo.parts.indexOf(p) < 0');
  });

  it('has a VISIBLE affordance, not only the right-click', () => {
    expect(podestText).toContain('id="parts-btn"');
    expect(podestText).toContain('Mesh materials…');
    expect(podestText).toContain('partsBtn.addEventListener("click"');
  });

  it('is hidden in presentation mode', () => {
    expect(podestText).toMatch(/:root\.is-present #parts-menu \{ display: none; \}/);
    // The CSS alone would let it spring back open on leaving the mode.
    expect(podestText).toMatch(/if \(presenting\(\)\) closePartsMenu\(\);/);
  });

  it('renders adversarial names as text, capped, never as markup', () => {
    const render = podestText.slice(
      podestText.indexOf('function renderPartsMenu()'),
      podestText.indexOf('function placePartsMenu('),
    );
    expect(render).not.toContain('innerHTML');
    expect(render).toContain('partsLabel(mesh)');
    expect(render).toMatch(/\.textContent = /);
    // The cap is a DISPLAY cap: the full string is the protocol key, so a
    // truncated one would address no mesh at all.
    expect(podestText).toContain('PARTS_LABEL_MAX');
    expect(podestText).toContain('s.length > PARTS_NAME_MAX) continue;');
  });
});
