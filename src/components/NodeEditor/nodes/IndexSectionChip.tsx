/**
 * The read-only label an import-built INDEX section shows where a mesh
 * section shows its MeshTargetPicker.
 *
 * READ-ONLY on purpose: an index section is bound to a glTF MATERIAL, so it
 * has no mesh list to edit — the model decides which meshes wear that
 * material. To restyle one of those meshes, add a mesh section, which
 * overrides it (a name claim wins, loader 0.8's precedence).
 *
 * It reuses `.mesh-picker` (plus `--material`) so the picker's pinned 104px
 * width cap applies unchanged (outputTargetChip.test.ts): a glTF material name
 * is attacker-supplied and may be up to 1024 characters, and the Output node is
 * `width: fit-content` inside React Flow's abspos wrapper, so an uncapped label
 * would stretch the node. A `<span>`: not focusable, no caret, no popover.
 * Its ONLY pointer behaviour is a hover HINT (GLB Phase 5 Step 10): entering
 * it lights every mesh the section shades in the 3D preview — the same
 * `highlightMesh` path the mesh picker's rows use, over the coverage's
 * predicted names — and leaving clears it. Nothing is edited.
 *
 * Its marks come from the loaded model's TRUSTED facts (`indexSectionCoverage`):
 * dimmed (`--shadowed`) when the section does nothing — a duplicate glTF index,
 * or every mesh of the material claimed by a mesh section, which wins — and
 * marked `--missing` when no mesh of the loaded model wears the material. The
 * title names the meshes it shades and the ones a mesh section took over.
 * `duplicate` is the emission plan's own answer (`planIndexParts`), so the
 * mark can never disagree with what the module emits.
 */
import { useAppStore } from '@/store/useAppStore';
import type { IndexCoverage } from '@/utils/outputMaterials';
import { highlightMesh, highlightMeshes } from '@/utils/meshHighlight';
import { indexChipTitle } from './sectionLabelText';

export function IndexSectionChip({
  label,
  duplicate,
  coverage,
}: {
  label: string;
  duplicate: boolean;
  coverage: IndexCoverage | undefined;
}) {
  const language = useAppStore((s) => s.language);
  const effective: IndexCoverage | undefined = duplicate
    ? { meshes: coverage?.meshes ?? [], overridden: coverage?.overridden ?? [], state: 'duplicate' }
    : coverage?.state === 'duplicate' ? { ...coverage, state: 'unknown' } : coverage;
  const state = effective?.state;
  const shadowed = state === 'duplicate' || state === 'overridden';
  const unused = state === 'unused';
  return (
    <span
      className={`mesh-picker mesh-picker--material${shadowed ? ' mesh-picker--shadowed' : ''}${unused ? ' mesh-picker--missing' : ''}`}
      title={indexChipTitle(label, effective, language)}
      onPointerEnter={() => { if (effective && effective.meshes.length > 0) highlightMeshes(effective.meshes); }}
      onPointerLeave={() => highlightMesh(null)}
    >
      <span className="mesh-picker__label">{label}</span>
    </span>
  );
}
