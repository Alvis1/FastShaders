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
// The cross-node plans moved to a zero-React module so the "computed ONCE
// for N cards" property could be EXECUTED (outputNodePlans.test.ts) rather
// than only grepped — a per-instance `useMemo` over the node SET reads
// perfectly correct in isolation, which is how the O(N²) shipped.
const PLANS = src('outputNodePlans.ts');
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
    expect(OUTPUT_NODE).toContain('label={formatSectionLabel(sectionLabel(materials, SELF, signature), language)}');
    // Asked of the node's OWN material, with no position guard: since the
    // per-material split an import-built node's glTF binding IS material 0's,
    // so `index > 0 &&` would have made every split index node render the mesh
    // PICKER — a checkbox list for a binding that has no mesh list at all.
    expect(OUTPUT_NODE).toContain('const indexSection = isIndexSection(material);');
  });

  it('an index section is shadowed by the SAME plan emission uses', () => {
    // The CROSS-NODE plan over the CONTRIBUTING set, under the MODULE's
    // signature — exactly what graphToCode walks, so a duplicate glTF index
    // held by a SIBLING node shadows this one the way emission shadows it. A
    // one-element set was right only while a duplicate could only be a sibling
    // SECTION.
    expect(PLANS).toContain('planIndexPartsAcross(contributing, moduleSignature)');
    expect(OUTPUT_NODE).toContain('indexPlanAcross.duplicates.get(id) ?? EMPTY_SECTIONS');
    expect(OUTPUT_NODE).toContain('indexDuplicates.has(SELF)');
    // ONE signature governs the table, and it is the one emission reads.
    expect(PLANS).toContain('const moduleSignature = moduleSignatureOf(contributing);');
    expect(src('../../../engine/graphToCode.ts')).toContain('const signature = moduleSignatureOf(outputs);');
  });

  it('the single-GLB export plan asks the same accessor, not a third spelling', () => {
    // It re-spelled `moduleSignatureOf`'s body inline, so a future change to how
    // the module picks its signature would have moved emission and the export
    // apart with `errors: []` — the export writing texture slot maps for a
    // different model than the module describes. No executable test can
    // distinguish two byte-identical spellings, which is why this is a pin.
    const PLAN = src('../../../engine/glbExportPlan.ts');
    expect(PLAN).toContain('const signature = moduleSignatureOf(outputs);');
    expect(PLAN).not.toContain('outputs.find((n) => outputMaterials(n).some(isIndexSection))');
  });

  it('emitsNothing is false whenever a section emits (the red sentinel is only for a bare return)', () => {
    const at = OUTPUT_NODE.indexOf('const emitsNothing = useMemo(');
    const body = OUTPUT_NODE.slice(at, OUTPUT_NODE.indexOf('});', at) + 3);
    // Asked across the CONTRIBUTING set: a targeted SIBLING's `parts` entry
    // takes graphToCode's object return, so the default's Color is then
    // three's white and not the sentinel.
    expect(body).toContain('if (namedPlanAcross.entries.length > 0 || indexPlanAcross.entries.length > 0) return false;');
    // …and only the node that owns the module's top-level channels can show
    // it at all: a targeted or parked node never emits the sentinel.
    expect(body).toContain('if (!isDefault) return false;');
  });

  it('an index section is removed by deleting the NODE — the node carries no ✕', () => {
    // A material is a NODE now, so the ordinary Delete / context-menu path
    // removes one and the node's `modelSignature` + `modelMeshes` go with it —
    // there is no in-node removal to keep in step, and no later section to
    // renumber handles for. (The mirror SOURCE moving off a deleted
    // lowest-ranked index node is B5's business, not the card's.)
    expect(OUTPUT_NODE).not.toContain('removeMaterial');
    expect(OUTPUT_NODE).not.toContain('output-node__mesh-remove');
    expect(OUTPUT_NODE).not.toContain("t('Remove this material section', language)");
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
    expect(MENU).toContain('formatSectionLabel(sectionLabel(materials, 0, readModelSignature(outputData)), language)');
  });
});

describe('every module path passes the mirror plan (R7)', () => {
  it('export, the code panel, the preview and its XR popup', () => {
    // Every module path reads the mirror plan off the ONE Output-set resolver
    // (`contributingOutputs`), so none of them can contribute a different set.
    expect(src('../../../engine/exportShader.ts'))
      .toContain('materialPartsMirrorPlanAcross(contributingOutputs(state.nodes)),');
    const codeEditor = src('../../CodeEditor/CodeEditor.tsx');
    expect(codeEditor).toContain('materialPartsMirror,\n      );');
    expect(codeEditor).toContain('[settledCode, activeTab, materialSettings, properties, materialPartsMirror]');
    const preview = src('../../Preview/ShaderPreview.tsx');
    // The module is built from the placeholder code since the image-asset feed
    // (GLB Phase 6 S3) — the mirror key is still a dep beside it.
    expect(preview).toContain('[debouncedPreviewCode, debouncedMaterialSettingsKey, mirrorKey]');
    expect(preview).toContain('materialPartsMirror: materialPartsMirrorPlanAcross(contributingOutputs(useAppStore.getState().nodes)),');
    expect(src('../../../engine/tslToPreviewHTML.ts')).toContain(
      '?? buildPreviewShaderModule(tslCode, materialSettings, options.materialPartsMirror);',
    );
  });
});

describe('the code panel tabs say an import-built graph is shown on a primitive (integration §4)', () => {
  it('the index.html label carries the note only while the graph HAS index sections, in both languages', () => {
    const codeEditor = src('../../CodeEditor/CodeEditor.tsx');
    // Asked of the CONTRIBUTING SET, never of `findDefaultOutput`: since the
    // Output split each material is its own node and the untargeted default
    // carries neither the signature nor an index section, so reading it there
    // answered false for every import-built shader and the label silently
    // stopped saying what the tab cannot do.
    expect(codeEditor).toContain(
      '(n) => readModelSignature(n.data) !== null && outputMaterials(n).some(isIndexSection),',
    );
    expect(codeEditor).toContain('const hasIndexSections = useAppStore((s) =>\n    contributingOutputs(s.nodes).some(');
    expect(codeEditor).not.toContain('findDefaultOutput');
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
    // Both whole-store derivations pass it — through ONE opts builder, so
    // `outputDormancyFromState` and `outputEdgeIsDormant` cannot ask different
    // questions. The two CROSS-NODE opts are what forced the shared builder:
    // `defaultContributes` is about the MODULE's default (usually a sibling of
    // the node being judged) and `firstNamedHere` decides which single node may
    // claim the 0.6 single-mesh exemption.
    expect(MATERIALS).toContain('indexSectionsAwake: indexAwakeFor(out, outputMaterials(out), shownPreviewMesh(state)),');
    expect(MATERIALS.match(/dormancyOptsFor\(state, out\)/g) ?? []).toHaveLength(2);
    expect(MATERIALS).toContain('defaultContributes: def ? outputDefaultContributes(def, state.edges) : false,');
    expect(MATERIALS).toContain('firstNamedHere: firstNamedOutputId(outs) === out.id,');
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
    expect(OUTPUT_NODE).toContain('coverage={coverage.get(SELF)}');
    expect(OUTPUT_NODE).toContain('indexClaimed={indexHints}');
    expect(PLANS).toContain('indexSectionCoverageAcross(contributing, moduleSignature, loaded, named)');
    expect(OUTPUT_NODE).toContain('coverageAcross.get(id) ?? EMPTY_COVERAGE');
    expect(PICKER).toContain('const also = indexClaimed?.get(name);');
    expect(PICKER).toContain("t('Also in material section “{material}” — a mesh section wins', language)");
    expect(CHIP).toContain("${unused ? ' mesh-picker--missing' : ''}");
  });

  it('the dormant chip speaks about index sections in its own words', () => {
    // One node is one material, so the chip is always singular now; the plural
    // key stays translated for the folded documents `outputDormancyFromState`
    // still counts.
    expect(OUTPUT_NODE).toContain("'{n} material section for another model'");
    expect(OUTPUT_NODE).toContain("'mesh material for another model'");
    expect(OUTPUT_NODE).toContain('title={dormantTitle}');
    expect(OUTPUT_NODE).toContain("loaded.kind === 'gltf'");
  });

  it('a dormant NODE renders compact and re-measures on waking', () => {
    // Dormancy hid a SECTION and unmounted its handles; a material is a node
    // now, so it hides the node's BODY — header plus the chip — and unmounts
    // every channel handle with it, which is what keeps the wires into it
    // invisible exactly as before. Never the node itself: the wiring behind it
    // must not read as deleted.
    expect(OUTPUT_NODE).toContain('const nodeDormant = dormant.has(SELF);');
    expect(OUTPUT_NODE).toContain('{nodeDormant ? (');
    expect(OUTPUT_NODE).toContain("const exposedKey = nodeDormant ? '~' : exposedPorts.join('|');");
    // …and the 008 swallow follows, or a sleeping node floods the console at
    // pan rate with warnings about the handles it deliberately unmounted.
    expect(MATERIALS).toContain('dormantIndicesForPreview(outputMaterials(out), dormancyOptsFor(state, out))');
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

  it('the node derives it from the ONE pure rule, for the DEFAULT node only', () => {
    expect(OUTPUT_NODE).toContain('defaultSectionUnusedAcross(meshNames, contributing, namedPlanAcross, coverageAcross)');
    // Gated on `isDefault` INSIDE the memo now, so sixteen of a 16-material
    // import's seventeen cards skip the walk they could never display.
    expect(OUTPUT_NODE).toContain('isDefault && defaultSectionUnusedAcross(meshNames, contributing, namedPlanAcross, coverageAcross)');
    expect(OUTPUT_NODE).toContain('unused={defaultUnused}');
    expect(OUTPUT_NODE).toContain("${defaultUnused ? ' output-node__material--unused' : ''}");
    // The pure rule judges `defaultOutput`, not the lowest-ranked node: split
    // per material, an untargeted Output need not be first (a PARKED variant is
    // untargeted too, and an import-built document's first node is a TARGETED
    // index node whose binding would read as "material 0 names a mesh" and bail).
    const MATS = src('../../../utils/outputMaterials.ts');
    const at = MATS.indexOf('export function defaultSectionUnusedAcross(');
    const body = MATS.slice(at, MATS.indexOf('\n}\n', at));
    expect(body).toContain('const def = defaultOutput(ordered);');
    expect(body).not.toContain('ordered[0]');
  });

  it('the picker says so instead of promising "All meshes", and explains on hover', () => {
    expect(PICKER).toContain("t(parked ? 'Not rendered' : unused ? 'Nothing left' : 'All meshes', language)");
    expect(PICKER).toContain(UNUSED_TITLE);
    expect(PICKER).toContain("${unused ? ' mesh-picker--unused' : ''}");
    expect(src('MeshTargetPicker.css')).toContain('.mesh-picker--unused {');
  });

  it('nothing is hidden or disabled — only the channel rows are dimmed', () => {
    expect(NODE_CSS).toContain('.output-node__material--unused .output-node__section,');
    // The section still renders its rows, its picker and its preview socket:
    // no `unused &&` guard may gate any of them.
    expect(OUTPUT_NODE).not.toMatch(/defaultUnused\s*(\?|&&)[^;]*(showMeshRow|preview-socket|renderRow)/);
    expect(OUTPUT_NODE).not.toContain('aria-disabled={defaultUnused');
  });
});
