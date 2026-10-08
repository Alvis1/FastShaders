import { useAppStore } from '@/store/useAppStore';
import { t, formatNodeLabel, portLabel } from '@/i18n';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { usesExposedPorts } from '@/utils/exposedPorts';
import { rowStyle, labelStyle, NodeActions } from './menuShared';
import { uniformTypeFor, constantTypeFor, convertPropertyNode } from '@/utils/propertyConvert';
import { isEvalMode } from '@/eval/evalMode';
import { ParamRow } from './ParamRow';
import { ImageNodeSettings } from './ImageNodeSettings';
import { PreviewChannelRow } from './PreviewChannelRow';
import { SoundNodeSettings } from './SoundNodeSettings';
import { NoiseNodeSettings } from './NoiseNodeSettings';
import { WireframeNodeSettings } from './WireframeNodeSettings';
import { DataNodeStats } from './DataColumnStats';
import { hasNoiseRangeFlag } from '@/utils/noiseRange';
import { modeOf } from '@/engine/moduleHelpers';


interface NodeSettingsMenuProps {
  nodeId: string;
}

export function NodeSettingsMenu({ nodeId }: NodeSettingsMenuProps) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);

  // Subscribe to THIS node, not to the whole array (the idiom every settings
  // menu here follows, RampColorPorts included). React Flow's
  // `applyNodeChanges` reuses the node objects it did not touch, so the found
  // object is a stable reference and `Object.is` bails on every notification
  // that did not change this node — otherwise an open menu re-renders its
  // whole row list on every FRAME of an unrelated node drag, and only
  // `onPaneClick` closes it, so that is an ordinary state to be in.
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
  if (!node) return null;

  const def = NODE_REGISTRY.get(node.data.registryType);
  /** The Image (Texture) node — this menu's one shape-changing special case:
   *  its preview control is a row of channel buttons at the TOP rather than
   *  the shared footer's five `Preview <socket>` rows, and the two lines that
   *  spelled "Image" under the headings are gone with them. */
  const imageNode = node.data.registryType === 'imageNode';
  /** The Image node draws its Tile/Offset rows itself (ImageNodeSettings: the
   *  same ParamRow, named, beside the turn they work with) — except in a study
   *  session, which keeps today's menu: the raw-key rows below, in this order.
   *  `isEvalMode` is sampled once per page, so every render agrees. */
  const imageOwnsParamRows = imageNode && !isEvalMode();

  // Only opt-in-socket nodes get the socket-only rows below (ParamRow draws
  // each row's checkbox on the same test). Everywhere else the ports are
  // always rendered, so a checkbox would be a dead switch whose uncheck
  // silently deletes edges. This used to be a second, hand-maintained
  // category list here; it is the shared rule now, so adding a node to
  // usesExposedPorts can't leave its checkboxes behind.
  const showPortToggles = usesExposedPorts(def);

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t('Node Settings', language)}</div>
      {/* The node's own name, under the heading — the only thing saying WHICH
          node this menu is about, for ~90 types.

          The Image node is the exception: its name is already on the card
          right beside the menu, in the header AND (with a picture) as the
          filename under it, so the line said "Image" a second time and the
          block below said it a third. Both were dropped on 2026-09-19 at the
          owner's request; what takes this slot instead is the control that
          brought them to the menu — the channel preview. */}
      {imageNode ? (
        <PreviewChannelRow nodeId={nodeId} />
      ) : (
        <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)' }}>
            {def ? formatNodeLabel(def.label, node.data.registryType, language) : node.data.registryType}
          </div>
        </div>
      )}

      {/* MODE — one def, several emitted helper variants (engine/moduleHelpers.ts).
          Lives in values.mode, never defaultValues (the socket list); one
          updateNodeData so a change is one undo entry. */}
      {def?.modes && (
        <div style={rowStyle}>
          <label style={labelStyle}>{t('Mode', language)}</label>
          <select
            className="context-menu__select"
            value={modeOf(def, getNodeValues(node))}
            onChange={(e) => updateNodeData(nodeId, { values: { ...getNodeValues(node), mode: e.target.value } })}
            title={t('Which operation this node performs', language)}
          >
            {def.modes.values.map((m) => (
              <option key={m} value={m}>{t(def.modes!.labels[m] ?? m, language)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Input ports not in defaultValues (tslRef params like position, time) — only show toggles for non-basic categories */}
      {showPortToggles && def?.inputs
        .filter((inp) => !def.defaultValues || !(inp.id in def.defaultValues))
        .map((inp) => (
          <ParamRow key={inp.id} nodeId={nodeId} paramKey={inp.id} label={portLabel(inp.label, language)} />
        ))}

      {/* One row per registry default, under its raw key (ParamRow). The
          Image node's are drawn by ImageNodeSettings instead, outside a study
          session — see `imageOwnsParamRows`. */}
      {def?.defaultValues &&
        !imageOwnsParamRows &&
        Object.keys(def.defaultValues).map((key) => <ParamRow key={key} nodeId={nodeId} paramKey={key} />)}

      {/* Image node: the picture, where it lands (Tile/Offset through the same
          ParamRow, outside a study session; the turn; the Flips), provenance
          and the revert for the drop-time power-of-two snap. Its own
          component because it needs hooks — see ImageNodeSettings. */}
      {node.data.registryType === 'imageNode' && <ImageNodeSettings nodeId={nodeId} />}

      {/* Sound node: which source to capture from. Session-only — it never
          reaches node.data.values, so it has no undo entry and never ships in a
          shared project. See SoundNodeSettings. */}
      {node.data.registryType === 'soundNode' && <SoundNodeSettings />}

      {/* The noise RANGE mode. Its own component (and its own values key rather
          than a defaultValues entry) because on a noise node defaultValues is
          the socket list — see NoiseNodeSettings. */}
      {hasNoiseRangeFlag(node.data.registryType) && <NoiseNodeSettings nodeId={nodeId} />}

      {/* Wireframe node: the mesh-edge switch. A view of the active Output's
          material setting, not a value of this node — see WireframeNodeSettings. */}
      {node.data.registryType === 'wireframe' && <WireframeNodeSettings nodeId={nodeId} />}

      {/* Data node: what is actually IN each column. Every downstream tone and
          domain control is expressed in normalized units, so without the real
          ranges here the user is tuning against numbers they cannot see. */}
      {node.data.registryType === 'dataNode' && <DataNodeStats nodeId={nodeId} />}

      {/* The TSL (or, for Brightness/Contrast, the formula) a node expands
          to, read-only and unlabelled. Only nodes whose maths is out of sight
          declare `construction` — the hand-emitted ones and a helper whose name
          does not state its formula: everything else emits a call to the
          function its own label already names, so a line there would restate
          the title. For these the construction lives in a graphToCode branch or
          a module-scope helper, and the only other way to see it is to wire the
          node up and read the code panel — which is after the decision it
          informs. No heading: the divider above already separates it, and a
          monospace block under a settings list does not need to be announced
          as code. Left untranslated for the same reason — it is code or
          maths, not prose. */}
      {def?.construction && (
        <>
          <div className="context-menu__divider" />
          <div className="context-menu__construction">
            <pre>{def.construction}</pre>
          </div>
        </>
      )}

      {/* Constant ↔ uniform conversion: Float/Color become a named Property
          (uniform) node in place — same id, position and outgoing edges — and
          Property nodes convert back. One history entry, undoable. */}
      {(() => {
        const registryType = node.data.registryType;
        const target = uniformTypeFor(registryType) ?? constantTypeFor(registryType);
        if (!target) return null;
        const toUniform = uniformTypeFor(registryType) !== null;
        const handleConvert = () => {
          const store = useAppStore.getState();
          const converted = convertPropertyNode(node, target, store.nodes);
          if (!converted) return;
          store.pushHistory();
          store.setNodes(store.nodes.map((n) => (n.id === nodeId ? converted : n)));
          store.closeContextMenu();
        };
        return (
          <>
            <div className="context-menu__divider" />
            <button className="context-menu__item" onClick={handleConvert}>
              {toUniform ? t('Convert to Property (uniform)', language) : t('Convert to Constant', language)}
            </button>
          </>
        );
      })()}

      {/* `preview={false}` on the Image node ONLY: PreviewChannelRow above is
          the same act in one line, and two controls for one store field is
          two ways to be looking at a different channel than you think. */}
      <NodeActions nodeId={nodeId} preview={!imageNode} />
    </div>
  );
}
