import { memo, useEffect, useMemo, type MouseEvent, type ReactNode } from 'react';
import { NodeResizeControl, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { AppEdge, AppNode, GroupFlowNode } from '@/types';
import { useAppStore, MIN_GROUP_W, MIN_GROUP_H } from '@/store/useAppStore';
import { getGroupFrameColors } from '@/utils/colorUtils';
import { nodeCostPoints } from '@/utils/nodeCost';
import { getUnwrappedEdges } from '@/engine/cpuEvaluator';
import { useBudgetPoints } from '@/hooks/useDeviceBudget';
import { Points } from '@/components/Points/Points';
import { assetText, t, type Language } from '@/i18n';
import { TypedHandle } from '../handles/TypedHandle';
import './GroupNode.css';

/**
 * What a collapsed pill's badge sums, in TABLE points: the LIVE price
 * (`nodeCostPoints`, under the selected device's table) of every node the
 * group holds directly — `parentId === groupId`, the member set
 * `toggleGroupCollapsed` collapses. A nested group is one member and prices 0
 * (it has no registry type), exactly as in the store's collapse-time sum.
 * Informational, never the budget: `computeReachableCost` walks the members
 * themselves, reached or not.
 *
 * `edges` must be the UNWRAPPED view (`getUnwrappedEdges`): collapsing
 * rewrote every wire crossing the frame onto the pill's own sockets, so a
 * variadic member read through the raw array would lose the operands fed from
 * outside and price below what the collapse charged it.
 */
export function groupMemberCost(nodes: readonly AppNode[], edges: AppEdge[], groupId: string): number {
  let total = 0;
  for (const n of nodes) if (n.parentId === groupId) total += nodeCostPoints(n, edges);
  return total;
}

/** The store fields a member sum reads. */
interface GroupCostInputs {
  nodes: AppNode[];
  edges: AppEdge[];
  costVersion: number;
}

/** What one sum was taken over: the members in node order (`id` and `data`
 *  ref), the edges array and the table's version. */
interface MemberCostMemo {
  nodes: readonly AppNode[];
  edges: readonly AppEdge[];
  version: number;
  ids: string[];
  data: unknown[];
  cost: number;
}

/** Same members, holding the same `data` objects, in the same order. */
function sameMembers(nodes: readonly AppNode[], groupId: string, m: MemberCostMemo): boolean {
  let k = 0;
  for (const n of nodes) {
    if (n.parentId !== groupId) continue;
    if (k >= m.ids.length || m.ids[k] !== n.id || m.data[k] !== n.data) return false;
    k++;
  }
  return k === m.ids.length;
}

/**
 * A store selector for one group's badge figure (`groupMemberCost` over the
 * live store, in table points), with its own one-slot cache.
 *
 * The selector runs on every store notify, and a drag notifies at pointer
 * rate — moving the pill itself or any node beside it — while changing
 * nothing this sum reads: `setNodes` re-mints the nodes array but keeps every
 * node's `data` and the whole edges array by reference (useLiveNodeCost's
 * contract). So the cache is keyed on the members' ids and `data` refs, the
 * edges array and the table's `costVersion`: a position-only notify costs one
 * scan of reference compares and prices nothing, and anything that can move
 * the sum — a member edit, a rewire, a member joining or leaving, a device
 * change — re-sums. Safe inside a selector for useLiveNodeCost's reason: the
 * result is a pure function of that key.
 */
export function makeGroupMemberCostSelector(groupId: string): (s: GroupCostInputs) => number {
  let memo: MemberCostMemo | null = null;
  return (s) => {
    if (memo && memo.edges === s.edges && memo.version === s.costVersion
      && (memo.nodes === s.nodes || sameMembers(s.nodes, groupId, memo))) {
      memo.nodes = s.nodes;
      return memo.cost;
    }
    const ids: string[] = [];
    const data: unknown[] = [];
    for (const n of s.nodes) {
      if (n.parentId !== groupId) continue;
      ids.push(n.id);
      data.push(n.data);
    }
    const cost = groupMemberCost(s.nodes, getUnwrappedEdges(s.nodes, s.edges), groupId);
    memo = { nodes: s.nodes, edges: s.edges, version: s.costVersion, ids, data, cost };
    return cost;
  };
}

/**
 * The collapsed pill's badge figure, LIVE: a device change, a member edit or
 * a rewire reprices it. Until 2026-10-23 the badge printed a `data.cost` sum
 * the collapse took under whichever device was then selected, and it never
 * moved again while the pill stayed collapsed. An expanded frame shows no
 * badge and prices nothing.
 */
function useGroupMemberCost(groupId: string, collapsed: boolean): number {
  const select = useMemo(() => makeGroupMemberCostSelector(groupId), [groupId]);
  return useAppStore((s) => (collapsed ? select(s) : 0));
}

/**
 * A frame's coloured header strip and its name — the canvas group's, and the
 * intro window's (intro/BudgetScene.tsx), which draws a frame without React
 * Flow. `children` is the +/− control: a button here, an inert mark there.
 */
export function GroupHeader({ data, language, children }: {
  data: Pick<GroupFlowNode['data'], 'label' | 'color' | 'titleSize'>;
  language: Language;
  children: ReactNode;
}) {
  const color = data.color ?? '#6366f1';
  return (
    <div
      className="group-node__header"
      style={{ background: color, height: data.titleSize && data.titleSize > 1 ? 22 * data.titleSize : undefined }}
    >
      <span className="group-node__label" style={data.titleSize && data.titleSize > 1 ? { fontSize: `calc(var(--font-size-xs) * ${data.titleSize})` } : undefined}>{typeof data.label === 'string' && data.label ? assetText(data.label, language) : t('Group', language)}</span>
      {children}
    </div>
  );
}

/**
 * Group node — a labeled, colored frame that holds member nodes via React Flow's
 * parent/child mechanism. Members set `parentId` to this node's id; dragging the
 * group header drags the children with it automatically.
 *
 * Visual: a tinted rectangle with a colored header bar showing the group name
 * and a +/− toggle on the right that collapses the group into a compact pill
 * (children + their edges hide via React Flow's `hidden` flag) or restores it.
 *
 * Interaction: the HEADER is the whole interactive surface of an expanded
 * frame — click it to select & drag, right-click it for the GroupSettingsMenu
 * (rename + recolor + save + ungroup). The frame BODY is pass-through and
 * behaves like bare canvas (right-click adds a node, drag rubber-bands/pans),
 * so a frame never swallows the canvas gestures underneath it; see the
 * pointer-events block in GroupNode.css. A COLLAPSED pill is fully
 * interactive instead — it stands in for a node, sockets and all.
 */
export const GroupNode = memo(function GroupNode({
  id,
  data,
  selected,
}: NodeProps<GroupFlowNode>) {
  const color = data.color ?? '#6366f1';
  const collapsed = !!data.collapsed;
  const toggleGroupCollapsed = useAppStore((s) => s.toggleGroupCollapsed);
  // The frame mixes from the node body, which flips with the theme — see
  // getGroupFrameColors. (`codeEditorTheme` is the app-wide dark switch; the
  // store field keeps its historical name.)
  const darkTheme = useAppStore((s) => s.codeEditorTheme === 'vs-dark');
  const language = useAppStore((s) => s.language);
  // The members' summed price (table points), and the share of the selected
  // device's 100 the badge prints.
  const memberCost = useGroupMemberCost(id, collapsed);
  const memberPoints = useBudgetPoints(memberCost);
  // A dropped preset/texture keeps its ENGLISH name as data (a saved file must
  // not carry the UI language); the header shows it in Latvian while it is
  // still that built-in name. A renamed group shows exactly what was typed.

  // Tell React Flow to re-measure handle positions when boundary sockets
  // change. Without this, dynamically mounted synthetic handles (__in_*,
  // __out_*) aren't in React Flow's bounds map and edges fail to render.
  const updateNodeInternals = useUpdateNodeInternals();
  const socketKey = [
    ...(data.collapsedInputs ?? []).map((s) => s.socketId),
    ...(data.collapsedOutputs ?? []).map((s) => s.socketId),
  ].join('|');
  useEffect(() => {
    if (collapsed) {
      updateNodeInternals(id);
    }
  }, [id, collapsed, socketKey, updateNodeInternals]);

  const onToggle = (e: MouseEvent) => {
    // Stop the click from also selecting/dragging the group node.
    e.stopPropagation();
    toggleGroupCollapsed(id);
  };

  // While collapsed, the group exposes a synthetic handle for every boundary
  // edge so the wires stay live. The store action populated these arrays at
  // collapse time and rewrote the affected edges to point at the synthetic ids.
  const inputs = collapsed ? (data.collapsedInputs ?? []) : [];
  const outputs = collapsed ? (data.collapsedOutputs ?? []) : [];
  const SOCKET_H = 18;
  const HEADER_H = 28;
  // Extra gap below the header so the first socket's handle dot doesn't
  // visually collide with the colored header strip. Must match the value used
  // by toggleGroupCollapsed when sizing the pill.
  const SOCKET_TOP_PAD = 8;

  return (
    <div
      className={`group-node${selected ? ' group-node--selected' : ''}${collapsed ? ' group-node--collapsed' : ''}`}
      style={{
        // OPAQUE fill in the group color (full color on the header). Never an
        // alpha tint: the canvas backdrop is user-pickable, so a translucent
        // body would take its color from whatever is behind it.
        ...getGroupFrameColors(color, !!selected, darkTheme),
        width: '100%',
        height: '100%',
      }}
    >
      {/* Resized from the bottom-right corner only, with the same enlarged grab
          box the sticky notes use — an expanded frame's edges sit right against
          member nodes and the surrounding canvas, so edge/corner handles all the
          way round turned every near-miss into an accidental resize. Groups now
          match notes exactly: drag by the header, scale by the one corner.
          Only rendered when expanded (a collapsed group is a fixed-size pill)
          and when selected — the frame body is pointer-events:none, so the
          header is what selects it. The control keeps React Flow's
          `.react-flow__resize-control` class, which is what the pass-through
          block below opts back into pointer events. */}
      {!collapsed && selected && (
        <NodeResizeControl
          position="bottom-right"
          color={color}
          minWidth={MIN_GROUP_W}
          minHeight={MIN_GROUP_H}
          style={{ width: 15, height: 15, borderRadius: 0, border: '2px solid #fff' }}
        />
      )}
      <GroupHeader data={data} language={language}>
        <button
          type="button"
          className="group-node__toggle nodrag"
          onClick={onToggle}
          onPointerDown={(e) => e.stopPropagation()}
          title={t(collapsed ? 'Expand group' : 'Collapse group', language)}
          aria-label={t(collapsed ? 'Expand group' : 'Collapse group', language)}
        >
          {collapsed ? '+' : '\u2212'}
        </button>
      </GroupHeader>

      {/* Cost badge above the collapsed pill — same styling as regular nodes,
          the members' LIVE summed price (useGroupMemberCost), never the
          `data.cost` the collapse snapshots onto the group. */}
      {collapsed && memberCost > 0 && (
        <span className="node-base__cost-badge group-node__cost-badge"><Points value={memberPoints} /></span>
      )}

      {/* Boundary sockets — only rendered while collapsed. Each handle is
          positioned manually so the SVG edges land on a deterministic spot
          regardless of how many sockets the group exposes. The label next to
          the dot is the source-of-edge node name. */}
      {collapsed && inputs.map((sock, i) => {
        const top = HEADER_H + SOCKET_TOP_PAD + SOCKET_H * (i + 0.5);
        return (
          <span
            key={sock.socketId}
            className="group-node__socket group-node__socket--in"
            style={{ top }}
          >
            <TypedHandle
              type="target"
              position={Position.Left}
              id={sock.socketId}
              dataType={sock.dataType}
              label={sock.name}
              style={{ top: 0, transform: 'translateY(-50%)' }}
            />
            <span className="group-node__socket-label">
              {sock.name ?? ''}
            </span>
          </span>
        );
      })}
      {collapsed && outputs.map((sock, i) => {
        const top = HEADER_H + SOCKET_TOP_PAD + SOCKET_H * (i + 0.5);
        return (
          <span
            key={sock.socketId}
            className="group-node__socket group-node__socket--out"
            style={{ top }}
          >
            <span className="group-node__socket-label">
              {sock.name ?? ''}
            </span>
            <TypedHandle
              type="source"
              position={Position.Right}
              id={sock.socketId}
              dataType={sock.dataType}
              label={sock.name}
              style={{ top: 0, transform: 'translateY(-50%)' }}
            />
          </span>
        );
      })}
    </div>
  );
});
