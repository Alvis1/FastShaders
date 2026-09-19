/**
 * The ONE formatter of an Output section's label: `sectionLabel`
 * (utils/outputMaterials.ts) decides WHAT the label is, this turns it into
 * words. ShaderSettingsMenu's scope line and the node's index-section chip
 * read it, so the menu names a section the way the node does ("No mesh" for an
 * empty added section, never `#2`; a glTF material's name, or "Material #3").
 *
 * Pure apart from `t()`, so a node test can call it.
 */
import { t, type Language } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import type { IndexCoverage, SectionLabel } from '@/utils/outputMaterials';

/**
 * What an ADDED material section says while it sets nothing
 * (`sectionSilent` in OutputNode): no wire on any of its handles and no
 * emitting stored value, so `buildShaderModule` drops its part and the meshes
 * it names keep exactly what they had.
 *
 * ONE sentence for the two surfaces that carry that mark — the mesh picker and
 * every unset colour swatch in the section — so they cannot describe the same
 * state differently. It lives here rather than in OutputNode because
 * MeshTargetPicker reads it too, and OutputNode imports MeshTargetPicker.
 */
export const SECTION_SILENT_KEY =
  'This material sets no channel yet — the meshes it names keep their current look';

export function formatSectionLabel(label: SectionLabel, language: Language): string {
  switch (label.kind) {
    case 'default':
      return t('All meshes (default)', language);
    case 'named':
      // The ellipsis is a separate word, the node picker's own rule: the one
      // thing worth reading is WHICH mesh, and "there are more" beside it.
      return label.more ? `${label.first} …` : label.first;
    case 'empty':
      return t('No mesh', language);
    case 'index':
      // An unnamed glTF material is numbered 0-based, as in the glTF JSON
      // (owner default), so the label matches what an author sees in Blender's
      // glTF export or a JSON viewer. `name` is already display-sanitized.
      return label.name || fillTemplate(t('Material #{n}', language), { n: label.gltfIndex });
    default: {
      const never: never = label;
      return never;
    }
  }
}

/** A list for a hover title: at most `max` entries, then an ellipsis. The
 *  names are attacker-supplied; a title is text, and the cap keeps a
 *  256-mesh model from producing a tooltip taller than the screen. */
export function joinCapped(list: readonly string[], max = 12): string {
  const head = list.slice(0, Math.max(0, max)).join(', ');
  return list.length > max ? `${head}, …` : head;
}

/**
 * The index-section chip's hover text, by coverage state (`indexSectionCoverage`
 * in utils/outputMaterials.ts). Every fill goes through fillTemplate in ONE
 * pass, so a material name that SPELLS `{meshes}` or `{name}` cannot hijack a
 * slot. `coverage` undefined (no facts yet, or a section outside its
 * signature) reads as `unknown`: just the material's name.
 */
export function indexChipTitle(label: string, coverage: IndexCoverage | undefined, language: Language): string {
  const state = coverage?.state ?? 'unknown';
  switch (state) {
    case 'duplicate':
      return fillTemplate(
        t('glTF material “{name}” is already shaded by a section above — this one does nothing', language),
        { name: label },
      );
    case 'overridden':
      return fillTemplate(
        t('Every mesh of glTF material “{name}” is shaded by a mesh section — this section does nothing', language),
        { name: label },
      );
    case 'unused':
      return fillTemplate(t('glTF material “{name}” — no mesh of the loaded model uses it', language), { name: label });
    case 'covered': {
      const c = coverage!;
      const over = new Set(c.overridden);
      const shades = c.meshes.filter((n) => !over.has(n));
      const first = fillTemplate(t('glTF material “{name}” — shades: {meshes}', language), {
        name: label,
        meshes: joinCapped(shades),
      });
      return c.overridden.length === 0
        ? first
        : `${first}\n${fillTemplate(t('Shaded instead by a mesh section: {meshes}', language), { meshes: joinCapped(c.overridden) })}`;
    }
    case 'unknown':
    default:
      return fillTemplate(t('glTF material “{name}”', language), { name: label });
  }
}
