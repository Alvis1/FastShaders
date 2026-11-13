/**
 * "Do it for me": perform the current step through the store's OWN write paths,
 * exactly as the user's gesture would — `addNode` for a node (the AddNodeMenu's
 * node shape), `connectNodes` for a wire (one wire per input, hidden-socket
 * exposure, the Image UV handoff), `updateNodeData` for a value or an exposed
 * channel. One undo entry per step. A programmatic graph write like
 * `startSplatGraph` / `addDroppedShader` / `placeLibraryGroup`, NOT a tile
 * route (docs/dev/canvas-interaction.md). In an `/evalpro` session (the one
 * study entry with the tab) it logs ONE `tutorial-auto` and performs the step
 * inside `evalAutomated`, so the `node-add`/`node-edit` its writes log carry
 * `auto: true` — the study's work counts leave out what the app did
 * (`evalHooks.test.ts`).
 */

import { useAppStore } from '@/store/useAppStore';
import { connectNodes } from '@/components/NodeEditor/edgeInsert';
import { NODE_REGISTRY, getFlowNodeType } from '@/registry/nodeRegistry';
import { generateId } from '@/utils/idGenerator';
import { freshNodeCost, imageNodeCost } from '@/utils/nodeCost';
import { initialNodeValues } from '@/utils/newNodeValues';
import { effectiveExposedPorts } from '@/utils/exposedPorts';
import { makeOpacityReadable } from '@/utils/libraryAutoWire';
import { getNodeValues, outputNodeValues } from '@/types';
import { exceedsImageBudgetAdding, makeImageNodeFromEncode } from '@/utils/imageNode';
import { withImagePayload } from '@/utils/textureSources';
import { filePictureOrientation, replacementPictureOrientation } from '@/utils/pictureOrientation';
import { evalAutomated, evalLog } from '@/eval/telemetry';
import type { AppNode, MaterialSettings, NodeDefinition, OutputNodeData, ShaderNodeData } from '@/types';
import { findTutorial } from './tutorialDefs';
import { PICTURE_TYPE, holdsPicture, planAddPosition } from './tutorialRun';
import { tutorialPicture } from './tutorialPicture';
import type { AddStep, TutorialRun } from './tutorialTypes';

export interface AutoStepResult {
  /** The node an `add` step created — the panel glides to it. */
  addedId?: string;
  /** The node it will feed, for the same glide. */
  feedsId?: string;
}

/**
 * Perform `run`'s current step. Returns what moved so the panel can frame it;
 * `{}` when there was nothing to do (a `look`, a broken role, an unknown lesson).
 * `rand` seeds the fresh-node colour pick (tests pass a constant).
 */
export function tutorialAutoStep(run: TutorialRun, rand: () => number = Math.random): AutoStepResult {
  const def = findTutorial(run.id);
  if (!def?.steps[run.step]) return {};
  evalLog('tutorial-auto', { lesson: run.id, step: run.step });
  return evalAutomated(() => performStep(run, rand));
}

function performStep(run: TutorialRun, rand: () => number): AutoStepResult {
  const def = findTutorial(run.id);
  const step = def?.steps[run.step];
  if (!def || !step) return {};
  const store = useAppStore.getState();
  const { nodes, bindings } = { nodes: store.nodes, bindings: run.bindings };
  const nodeOf = (role: string): AppNode | undefined => nodes.find((n) => n.id === bindings[role]);

  switch (step.kind) {
    case 'look':
      return {};
    case 'add': {
      const nodeDef = NODE_REGISTRY.get(step.type);
      if (!nodeDef) return {};
      if (step.type === PICTURE_TYPE) return addPicture(run, step, nodeDef);
      const position = planAddPosition(nodeDef, run.step, def.steps, bindings, nodes);
      const id = generateId();
      // The AddNodeMenu's node, byte for byte (menus/AddNodeMenu.tsx): the
      // palette's fresh values (a 0–1 Perlin, a spread palette colour), then
      // the lesson's own values on top — the ramp stops and colours it does
      // not teach.
      const node = {
        id,
        type: getFlowNodeType(nodeDef),
        position,
        data: {
          registryType: nodeDef.type,
          label: nodeDef.label,
          cost: freshNodeCost(nodeDef.type) ?? 0,
          values: { ...initialNodeValues(nodeDef, [...nodes], rand), ...step.values },
        } as ShaderNodeData,
      } as AppNode;
      store.addNode(node);
      store.tutorialBind(step.role, id);
      return { addedId: id, feedsId: feedsOf(run, step.role) };
    }
    case 'wire': {
      const src = nodeOf(step.from[0]);
      const tgt = nodeOf(step.to[0]);
      if (!src || !tgt) return {};
      // The connect gesture's own bracket: `connectNodes` pushes no history
      // (NodeEditor's applyConnection relies on its caller's pushHistory too).
      store.pushHistory();
      connectNodes(src.id, step.from[1], tgt.id, step.to[1]);
      if (step.to[1] === 'opacity') {
        // A wire into Opacity on an opaque material changes nothing on screen
        // (the Ghost recipe, pressed, drew a solid sphere) — the library press
        // ticks Transparent for it, and so does this.
        const s = useAppStore.getState();
        const cur = s.nodes.find((n) => n.id === tgt.id);
        if (cur) {
          const next = makeOpacityReadable(cur, ['opacity']);
          if (next !== cur) s.setNodes(s.nodes.map((n) => (n.id === cur.id ? next : n)));
        }
      }
      return {};
    }
    case 'set': {
      const node = nodeOf(step.role);
      if (!node) return {};
      const current = node.type === 'output' ? outputNodeValues(node.data) : getNodeValues(node);
      store.updateNodeData(node.id, { values: { ...current, [step.key]: step.value } } as Partial<ShaderNodeData>);
      return {};
    }
    case 'expose': {
      const node = nodeOf(step.role);
      if (!node) return {};
      const current = effectiveExposedPorts(node);
      const exposedPorts = current.includes(step.handle) ? current : [...current, step.handle];
      const raw = (node.data as { materialSettings?: unknown }).materialSettings;
      const settings: MaterialSettings = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as MaterialSettings) : {};
      // Ticking Transparent in the Output menu exposes Opacity in the same
      // bracket (ShaderSettingsMenu.handleTransparentChange); the lesson's
      // `expose opacity` is that tick.
      const patch: Partial<OutputNodeData> =
        step.handle === 'opacity' && settings.transparent !== true
          ? { exposedPorts, materialSettings: { ...settings, transparent: true } }
          : { exposedPorts };
      store.updateNodeData(node.id, patch as Partial<ShaderNodeData>);
      return {};
    }
  }
}

/** The node `role` will feed next in the lesson, for the panel's glide. */
function feedsOf(run: TutorialRun, role: string): string | undefined {
  const steps = findTutorial(run.id)?.steps ?? [];
  for (let i = run.step + 1; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === 'wire' && s.from[0] === role) return run.bindings[s.to[0]];
  }
  return undefined;
}

/**
 * An Image step: the painted sky (`tutorialPicture.ts`) — into the EMPTY Image
 * node the reader already added from the palette, if there is one (newest
 * first, as `evaluateStep` binds), else as a new node where the lesson's
 * layout puts it. Nothing before the picture is ready: the panel keeps the
 * button off until then. A payload ADDED is checked against the project's
 * image budget like every other path that adds one, and an over-budget add
 * asks first, through the same notice ("Add anyway" places it).
 */
function addPicture(run: TutorialRun, step: AddStep, nodeDef: NodeDefinition): AutoStepResult {
  const picture = tutorialPicture();
  if (!picture) return {};
  const store = useAppStore.getState();
  const taken = new Set(Object.values(run.bindings));
  const empty = [...store.nodes].reverse().find(
    (n) => !taken.has(n.id) && n.type !== 'group' && n.type !== 'note' &&
      (n.data as { registryType?: unknown }).registryType === PICTURE_TYPE && !holdsPicture(n),
  );
  const cost = imageNodeCost(freshNodeCost(PICTURE_TYPE) ?? 0, picture.width, picture.height);
  const place = (): AutoStepResult => {
    const s = useAppStore.getState();
    if (empty && s.nodes.some((n) => n.id === empty.id)) {
      const current = getNodeValues(s.nodes.find((n) => n.id === empty.id)!);
      // "From file…"'s write into an existing node, orientation rule included.
      const orientation = replacementPictureOrientation(s, current);
      s.updateNodeData(empty.id, { values: withImagePayload(current, { ...picture, orientation }), cost } as Partial<ShaderNodeData>);
      s.tutorialBind(step.role, empty.id);
      return { addedId: empty.id, feedsId: feedsOf(run, step.role) };
    }
    const tut = s.tutorial;
    const lesson = findTutorial(run.id);
    if (!lesson) return {};
    const bindings = tut?.id === run.id ? tut.bindings : run.bindings;
    const id = generateId();
    // The drop's node (makeImageNodeFromEncode, the ONE construction path, and
    // the drop's orientation rule: the glTF way over a glTF model's own UVs —
    // moot while it is only a sky, not once the reader wires it into Color)
    // over the palette's fresh values. No stash: the picture is painted, never
    // downscaled, so there is nothing to revert to.
    const data = makeImageNodeFromEncode(picture, cost, picture.fileName, undefined, filePictureOrientation(s));
    s.addNode({
      id,
      type: getFlowNodeType(nodeDef),
      position: planAddPosition(nodeDef, run.step, lesson.steps, bindings, s.nodes),
      data: { ...data, values: { ...initialNodeValues(nodeDef, [...s.nodes]), ...data.values } },
    } as AppNode);
    s.tutorialBind(step.role, id);
    return { addedId: id, feedsId: feedsOf(run, step.role) };
  };
  if (exceedsImageBudgetAdding(store.nodes, [picture.dataUrl], store.ignoreImageLimits)) {
    store.enqueueLimitNotice({
      id: generateId(),
      kind: 'image-total-cap',
      fileName: picture.fileName,
      proceed: () => { evalAutomated(place); },
    });
    return {};
  }
  return place();
}
