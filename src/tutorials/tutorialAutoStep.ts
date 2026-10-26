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
import { freshNodeCost } from '@/utils/nodeCost';
import { initialNodeValues } from '@/utils/newNodeValues';
import { effectiveExposedPorts } from '@/utils/exposedPorts';
import { makeOpacityReadable } from '@/utils/libraryAutoWire';
import { getNodeValues, outputNodeValues } from '@/types';
import { evalAutomated, evalLog } from '@/eval/telemetry';
import type { AppNode, OutputNodeData, ShaderNodeData, MaterialSettings } from '@/types';
import { findTutorial } from './tutorialDefs';
import { planAddPosition } from './tutorialRun';
import type { TutorialRun } from './tutorialTypes';

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
      let feedsId: string | undefined;
      for (let i = run.step + 1; i < def.steps.length; i++) {
        const s = def.steps[i];
        if (s.kind === 'wire' && s.from[0] === step.role) { feedsId = bindings[s.to[0]]; break; }
      }
      return { addedId: id, feedsId };
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
