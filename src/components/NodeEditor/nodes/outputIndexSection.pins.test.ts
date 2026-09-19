/**
 * Source pins for the minimal index-section UI and the mirror threading (GLB
 * Phase 5 Step 5). The vitest env is `node`, so a React component cannot be
 * rendered here; these pin the shapes whose absence would fail silently — a
 * picker offered on a section that has no mesh list, the red sentinel beside a
 * module that is really an object return, a signature outliving its sections,
 * or a module path that forgot the mirror plan (the preview would then paint
 * mirrors the export does not carry, or the reverse).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import lv from '@/i18n/lv.json';

const src = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const OUTPUT_NODE = src('OutputNode.tsx');
const CHIP = src('IndexSectionChip.tsx');
const PICKER_CSS = src('MeshTargetPicker.css');
const MENU = src('../menus/ShaderSettingsMenu.tsx');

/**
 * The DEFAULT section of an import-built Output shades nothing — every mesh
 * belongs to a section below — and said "All meshes", so it read as a second,
 * dead Output ("it doubles with the PBR … like a dead part", owner 2026-09-18).
 * It is MARKED, never removed: it is still the fallback for a mesh whose
 * material has no section and for the next model loaded, so nothing may hide a
 * control, disable one, or touch data.
 */
const UNUSED_TITLE =
  'Every mesh of this model has its own section below, so this one shades nothing — wiring it changes nothing. It shades any mesh whose material has no section, and the whole model again when a different one is loaded.';

describe('the Output node and index sections', () => {
  it('an index section renders the read-only chip, never a MeshTargetPicker', () => {
    const at = OUTPUT_NODE.indexOf('{indexSection ? (');
    expect(at).toBeGreaterThan(-1);
    const branch = OUTPUT_NODE.slice(at, OUTPUT_NODE.indexOf(') : (', at));
    expect(branch).toContain('<IndexSectionChip');
    expect(branch).not.toContain('MeshTargetPicker');
    expect(OUTPUT_NODE).toContain('label={formatSectionLabel(sectionLabel(materials, index, signature), language)}');
    expect(OUTPUT_NODE).toContain('const indexSection = index > 0 && isIndexSection(material);');
  });

  it('an index section is shadowed by the SAME plan emission uses', () => {
    expect(OUTPUT_NODE).toContain('planIndexParts(materials, signature)');
    expect(OUTPUT_NODE).toContain('indexPlan.duplicates.has(index)');
  });

  it('emitsNothing is false whenever a section emits (the red sentinel is only for a bare return)', () => {
    const at = OUTPUT_NODE.indexOf('const emitsNothing = useMemo(');
    const body = OUTPUT_NODE.slice(at, OUTPUT_NODE.indexOf('});', at) + 3);
    expect(body).toContain('if (namedPlan.entries.length > 0 || indexPlan.entries.length > 0) return false;');
  });

  it('removing the last index section drops the signature AND the mirror source in ONE updateNodeData', () => {
    const at = OUTPUT_NODE.indexOf('const removeMaterial = useCallback(');
    const body = OUTPUT_NODE.slice(at, OUTPUT_NODE.indexOf('[id, def.inputs, readAdded, updateNodeData]', at));
    expect(body).toContain('asOneHistoryEntry(');
    expect(body).toContain('!added.some(isIndexSection)');
    expect(body).toContain('{ modelSignature: undefined, modelMeshes: undefined }');
    expect(body.match(/updateNodeData\(/g) ?? []).toHaveLength(1);
  });

  it('"+ Add output" counts NAMED sections only', () => {
    expect(OUTPUT_NODE).toContain('const atSectionCap = countSections(materials).named >= MAX_ADDED_MATERIALS;');
    expect(OUTPUT_NODE).toContain('if (countSections(all).named >= MAX_ADDED_MATERIALS) return;');
  });

  it('the ✕ on an index section says what it removes', () => {
    expect(OUTPUT_NODE).toContain("indexSection ? t('Remove this material section', language) : t('Remove this mesh material', language)");
  });

  it('the chip is inert — a hover hint only (Step 10) — and inside the picker width cap', () => {
    expect(CHIP).toContain('className={`mesh-picker mesh-picker--material');
    expect(CHIP).toContain('<span className="mesh-picker__label">{label}</span>');
    expect(CHIP).not.toContain('<button');
    expect(CHIP).not.toContain('createPortal');
    // Nothing a press can do: no click, no pointerdown, no focus. Hovering
    // lights the section's meshes in the 3D preview (meshHighlight.test.ts).
    expect(CHIP).not.toMatch(/onClick|onPointerDown|onPointerUp|onKeyDown|tabIndex/);
    expect(CHIP).toContain('onPointerEnter=');
    expect(CHIP).toContain('onPointerLeave={() => highlightMesh(null)}');
    expect(PICKER_CSS).toContain('.mesh-picker--material {');
  });

  it('the settings menu labels a section through the ONE label derivation', () => {
    expect(MENU).toContain('formatSectionLabel(sectionLabel(materials, activeIndex, readModelSignature(outputData)), language)');
  });
});

describe('every module path passes the mirror plan (R7)', () => {
  it('export, the code panel, the preview and its XR popup', () => {
    expect(src('../../../engine/exportShader.ts')).toContain('materialPartsMirrorPlan(outputNode),');
    const codeEditor = src('../../CodeEditor/CodeEditor.tsx');
    expect(codeEditor).toContain('materialPartsMirror,\n      );');
    expect(codeEditor).toContain('[settledCode, activeTab, materialSettings, properties, materialPartsMirror]');
    const preview = src('../../Preview/ShaderPreview.tsx');
    // The module is built from the placeholder code since the image-asset feed
    // (GLB Phase 6 S3) — the mirror key is still a dep beside it.
    expect(preview).toContain('[debouncedPreviewCode, debouncedMaterialSettingsKey, mirrorKey]');
    expect(preview).toContain('materialPartsMirror: materialPartsMirrorPlan(findDefaultOutput(useAppStore.getState().nodes)),');
    expect(src('../../../engine/tslToPreviewHTML.ts')).toContain(
      '?? buildPreviewShaderModule(tslCode, materialSettings, options.materialPartsMirror);',
    );
  });
});

describe('the code panel tabs say an import-built graph is shown on a primitive (integration §4)', () => {
  it('the index.html label carries the note only while the default Output has index sections, in both languages', () => {
    const codeEditor = src('../../CodeEditor/CodeEditor.tsx');
    expect(codeEditor).toContain(
      'return !!out && readModelSignature(out.data) !== null && outputMaterials(out).some(isIndexSection);',
    );
    // The GLB export (Phase 7) made the label a fillTemplate branch per tab and
    // format; the note is appended to whichever branch ran.
    // Phase 7: the note is appended only for a page that shows a PRIMITIVE — in
    // .glb mode the A-Frame page loads the model, where the sections DO apply.
    expect(codeEditor).toContain("hasIndexSections && (activeTab === 'three' || exportFormat !== 'glb')");
    const key = codeEditor.match(/const INDEX_SECTIONS_TAB_NOTE =\s*"([^"]+)";/)?.[1];
    expect(key).toContain('primitive');
    const ui = (lv as { ui: Record<string, string> }).ui;
    expect(ui[key!]).toBeTypeOf('string');
    expect(ui[key!]).not.toBe(key);
  });
});

describe('index-section dormancy and the double claim (Step 6)', () => {
  const MATERIALS = src('../../../utils/outputMaterials.ts');
  const PREVIEW_MESH = src('../../../utils/previewMesh.ts');
  const PICKER = src('MeshTargetPicker.tsx');

  it('the facts are derived in the single constructor, so drop, zip and restore all get them', () => {
    const at = PREVIEW_MESH.indexOf('export function createPreviewMesh(');
    const body = PREVIEW_MESH.slice(at, PREVIEW_MESH.indexOf('\n}\n', at));
    // ONE read (Phase 7 widened it to report WHY a refusal happened, for the
    // single-GLB export's availability line) — never a second parse.
    expect(body).toContain("const read = gltfPreviewFactsOrRefusal(owned, kind);");
    expect(body).toContain("if (read && 'facts' in read) mesh.gltf = read.facts;");
    expect(body.match(/gltfPreviewFactsOrRefusal\(/g) ?? []).toHaveLength(1);
  });

  it('dormancy is trusted-side: the node reads previewMesh, never a sandbox report', () => {
    expect(OUTPUT_NODE).toContain('const shownMesh = useAppStore(shownPreviewMesh);');
    expect(OUTPUT_NODE).toContain('const loaded = useMemo(() => loadedModelOf(shownMesh), [shownMesh]);');
    expect(OUTPUT_NODE).toContain('indexSectionsAwake: indexAwake,');
    expect(OUTPUT_NODE).not.toContain('fs:model-meshes');
    expect(OUTPUT_NODE).not.toContain('shader-material-parts');
    const at = MATERIALS.indexOf('export function loadedModelOf(');
    const body = MATERIALS.slice(at, MATERIALS.indexOf('\n}\n', at));
    expect(body).not.toContain('previewMeshInventory');
    expect(body).not.toContain('inventory');
    // The opt is REQUIRED, so a caller that forgets index sections fails tsc.
    expect(MATERIALS).toMatch(/\n\s+indexSectionsAwake: boolean;\n/);
    // Both whole-store derivations pass it.
    expect(MATERIALS.match(/indexSectionsAwake: indexAwakeFor\(out, materials, shownPreviewMesh\(state\)\)/g) ?? []).toHaveLength(2);
  });

  it('a primitive in the Model menu sleeps them: ShaderPreview reports what it SHOWS, emission never reads it', () => {
    const PREVIEW = src('../../Preview/ShaderPreview.tsx');
    expect(PREVIEW).toContain("useEffect(() => setPreviewShowsModel(previewGeometry === 'custom'), [previewGeometry, setPreviewShowsModel]);");
    const STORE = src('../../../store/useAppStore.ts');
    expect(STORE).toContain('  previewShowsModel: true,\n');
    // Session-only: never in the autosave payload or an undo snapshot.
    for (const fn of ['function graphPayload(', 'function snapshotOf(']) {
      const at = STORE.indexOf(fn);
      expect(at, fn).toBeGreaterThan(-1);
      expect(STORE.slice(at, STORE.indexOf('\n}\n', at))).not.toContain('previewShowsModel');
    }
    for (const f of ['graphToCode.ts', 'tslCodeProcessor.ts', 'tslToShaderModule.ts', 'tslToPreviewHTML.ts', 'exportShader.ts']) {
      expect(src(`../../../engine/${f}`)).not.toContain('previewShowsModel');
    }
    expect(OUTPUT_NODE).toContain("'Material sections for a glTF model — the preview is showing a different shape. They still emit, and return (wiring intact) when that model is shown'");
    expect((lv as Record<string, Record<string, string>>).ui['Material sections for a glTF model — the preview is showing a different shape. They still emit, and return (wiring intact) when that model is shown']).toBeTruthy();
  });

  it('the chip gets the coverage, the pickers get the double-claim hint', () => {
    expect(OUTPUT_NODE).toContain('coverage={coverage.get(index)}');
    expect(OUTPUT_NODE).toContain('indexClaimed={indexHints}');
    expect(OUTPUT_NODE).toContain('indexSectionCoverage(materials, signature, loaded, namedPlan)');
    expect(PICKER).toContain('const also = indexClaimed?.get(name);');
    expect(PICKER).toContain("t('Also in material section “{material}” — a mesh section wins', language)");
    expect(CHIP).toContain("${unused ? ' mesh-picker--missing' : ''}");
  });

  it('"+ Add output" picks through pickFreeMesh, re-derived from the current store', () => {
    expect(OUTPUT_NODE).toContain('const canAddMaterial = !atSectionCap && pickFreeMesh(meshNames, materials, coverage) !== null;');
    const at = OUTPUT_NODE.indexOf('const addMaterial = useCallback(');
    const body = OUTPUT_NODE.slice(at, OUTPUT_NODE.indexOf('}, [id, readAdded, meshNames, setAddedMaterials]);', at));
    expect(body).toContain('loadedModelOf(shownPreviewMesh(state))');
    expect(body).toContain('pickFreeMesh(');
  });

  it('the dormant chip speaks about index sections in its own words', () => {
    expect(OUTPUT_NODE).toContain("'{n} material section for another model'");
    expect(OUTPUT_NODE).toContain("'{n} material sections for another model'");
    expect(OUTPUT_NODE).toContain('title={dormantTitle}');
    expect(OUTPUT_NODE).toContain("loaded.kind === 'gltf'");
  });
});

describe('Latvian (Step 6)', () => {
  it('carries every new string, placeholders intact', async () => {
    const lv = (await import('@/i18n/lv.json')).default as { ui: Record<string, string> };
    for (const k of [
      'glTF material “{name}” — shades: {meshes}',
      'Shaded instead by a mesh section: {meshes}',
      'glTF material “{name}” — no mesh of the loaded model uses it',
      'Every mesh of glTF material “{name}” is shaded by a mesh section — this section does nothing',
      '{n} material section for another model',
      '{n} material sections for another model',
      'Material sections for a glTF model — none is loaded. They still emit, and return (wiring intact) when that model is loaded',
      'Material sections for a model with other materials — the materials of the loaded model differ. They still emit, and return (wiring intact) when that model is loaded',
      'Also in material section “{material}” — a mesh section wins',
      'Nothing left',
      UNUSED_TITLE,
    ]) {
      expect(lv.ui[k], k).toBeTruthy();
      expect(lv.ui[k]).not.toBe(k);
      for (const p of k.match(/\{\w+\}/g) ?? []) expect(lv.ui[k], k).toContain(p);
    }
  });
});

describe('the unused default section', () => {
  const PICKER = src('MeshTargetPicker.tsx');
  const NODE_CSS = src('OutputNode.css');

  it('the node derives it from the ONE pure rule, for material 0 only', () => {
    expect(OUTPUT_NODE).toContain('defaultSectionUnused(meshNames, materials, namedPlan, coverage)');
    expect(OUTPUT_NODE).toContain('const unused = index === 0 && defaultUnused;');
    expect(OUTPUT_NODE).toContain('unused={unused}');
    expect(OUTPUT_NODE).toContain("`output-node__material${unused ? ' output-node__material--unused' : ''}`");
  });

  it('the picker says so instead of promising "All meshes", and explains on hover', () => {
    expect(PICKER).toContain("t(unused ? 'Nothing left' : 'All meshes', language)");
    expect(PICKER).toContain(UNUSED_TITLE);
    expect(PICKER).toContain("${unused ? ' mesh-picker--unused' : ''}");
    expect(src('MeshTargetPicker.css')).toContain('.mesh-picker--unused {');
  });

  it('nothing is hidden or disabled — only the channel rows are dimmed', () => {
    expect(NODE_CSS).toContain('.output-node__material--unused .output-node__section {');
    // The section still renders its rows, its picker and its preview socket:
    // no `unused &&` guard may gate any of them.
    expect(OUTPUT_NODE).not.toMatch(/unused\s*(\?|&&)[^;]*(showMeshRow|preview-socket|renderRow)/);
    expect(OUTPUT_NODE).not.toContain('aria-disabled={unused');
  });
});
