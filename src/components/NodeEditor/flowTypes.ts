/**
 * The ONE React Flow type registry, shared by every surface that mounts a
 * <ReactFlow>: the editor canvas (NodeEditor.tsx) and the read-only overview
 * viewer on node-editor.html (Graphs/GraphModal.tsx).
 *
 * It is shared rather than mirrored because the mirror already drifted once:
 * GraphModal was missing `mic`, and an unregistered type falls back to React
 * Flow's DEFAULT node — a bare white box with top/bottom handles — so the Mic
 * node rendered there as something that looked like a broken node rather than
 * like itself. Nothing failed; it just looked wrong on one page. A second copy
 * is a second chance to forget the next node type.
 *
 * MODULE SCOPE is load-bearing, not tidiness: React Flow memoizes on the
 * identity of these objects, so a map built per render re-registers every type
 * on every frame of a drag.
 */
import { ShaderNode } from '@/components/NodeEditor/nodes/ShaderNode';
import { ColorNode } from '@/components/NodeEditor/nodes/ColorNode';
import { PreviewNode } from '@/components/NodeEditor/nodes/PreviewNode';
import { MathPreviewNode } from '@/components/NodeEditor/nodes/MathPreviewNode';
import { ClockNode } from '@/components/NodeEditor/nodes/ClockNode';
import { MicNode } from '@/components/NodeEditor/nodes/MicNode';
import { AudioInputNode } from '@/components/NodeEditor/nodes/AudioInputNode';
import { OutputNode } from '@/components/NodeEditor/nodes/OutputNode';
import { SdfOutputNode } from '@/components/NodeEditor/nodes/SdfOutputNode';
import { GroupNode } from '@/components/NodeEditor/nodes/GroupNode';
import { NoteNode } from '@/components/NodeEditor/nodes/NoteNode';
import { TypedEdge } from '@/components/NodeEditor/edges/TypedEdge';

export const nodeTypes = {
  shader: ShaderNode,
  color: ColorNode,
  preview: PreviewNode,
  mathPreview: MathPreviewNode,
  clock: ClockNode,
  mic: MicNode,
  audio: AudioInputNode,
  output: OutputNode,
  sdfOutput: SdfOutputNode,
  group: GroupNode,
  note: NoteNode,
};

export const edgeTypes = {
  typed: TypedEdge,
};
