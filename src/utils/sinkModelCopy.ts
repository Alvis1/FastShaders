/**
 * The words of utils/sinkModelFit.ts — which output node fits the 3D object on
 * screen — kept apart from its graph predicates so the canvas note
 * (utils/importNote.ts, which the store imports) can render them without
 * pulling those into the store's import graph: this module imports only the
 * i18n overlay and fillTemplate. The English sentence IS the lv.json key, and
 * the preview pane and the canvas note render through the ONE function below.
 */
import { t, type Language } from '@/i18n';
import { fillTemplate } from './fillTemplate';

export type SinkModelIssue =
  /** A Splat Output drives, and no splat is loaded. */
  | 'splat-needs-splat'
  /** A Splat Output drives, and the loaded splat is parked behind another model. */
  | 'splat-pick-splat'
  /** A wired plain Output drives while a splat is shown. */
  | 'output-on-splat'
  /** …and a WIRED Splat Output exists, just not as the active output. */
  | 'output-on-splat-parked'
  /** A Raymarch Output drives through a splat. */
  | 'march-on-splat'
  /** A Raymarch Output drives over a dropped model whose per-mesh Outputs are wired. */
  | 'march-over-mesh-outputs'
  /** An UNLIT Splat Output drives a shown splat, and a Normal node feeds it — which
   *  reads the direction to the camera there, so a rim or lit side comes out flat. */
  | 'splat-normal-faces-camera';

/**
 * The English sentence for each issue — the lv.json key. `{name}` is the
 * dropped model's file name, quoted by the caller.
 */
export const SINK_MODEL_ISSUE_KEY: { readonly [I in SinkModelIssue]: string } = {
  'splat-needs-splat': 'Drop a .splat, .spz, .ply or .ksplat to see the Splat Output',
  'splat-pick-splat': 'Pick the splat in the Model menu to see the Splat Output',
  'output-on-splat':
    'An Output node shades meshes, and {name} is a Gaussian splat, so this shader does not change it. Wire a Splat Output instead, or pick a mesh in the Model menu.',
  'output-on-splat-parked':
    '{name} is a Gaussian splat, but an Output node is the active output, and it shades meshes only. Click the Splat Output’s preview socket to shade the splat.',
  'march-on-splat':
    'An SDF Output marches from a mesh surface, and {name} is a Gaussian splat with no surface. Pick “SDF group” or a mesh in the Model menu.',
  'march-over-mesh-outputs':
    'The SDF Output renders the whole of {name}, so the Output nodes for its meshes are ignored. Click an Output’s preview socket to show them again.',
  'splat-normal-faces-camera':
    'On {name}, a Normal node points at the camera, so shading that reads it (a rim, a fresnel, a lit side) looks flat. Tick “React to light” in the Splat Output’s settings to give each splat its own surface normal.',
};

const NAME_MAX = 40;

/**
 * The sentence for `issue`, naming the dropped model. The name is the
 * sanitized file name (`PreviewMesh.name`); it is capped here and quoted by
 * this function, never inside the key, and filled in ONE pass.
 */
export function sinkModelIssueText(issue: SinkModelIssue, name: string, lang: Language): string {
  const chars = Array.from(typeof name === 'string' ? name : '');
  const shown = chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join('')}…` : chars.join('');
  return fillTemplate(t(SINK_MODEL_ISSUE_KEY[issue], lang), { name: `“${shown}”` });
}
