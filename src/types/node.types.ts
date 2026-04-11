import type { Node, Edge } from '@xyflow/react';

export type TSLDataType = 'float' | 'int' | 'vec2' | 'vec3' | 'vec4' | 'color' | 'any';

export interface PortDefinition {
  id: string;
  label: string;
  dataType: TSLDataType;
}

export type NodeCategory =
  | 'input'
  | 'type'
  | 'arithmetic'
  | 'math'
  | 'interpolation'
  | 'vector'
  | 'noise'
  | 'color'
  | 'unknown'
  | 'output';

export interface NodeDefinition {
  type: string;
  label: string;
  category: NodeCategory;
  tslFunction: string;
  tslImportModule: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  defaultValues?: Record<string, string | number>;
  description?: string;
  chainable?: boolean;
}

export interface ShaderNodeData {
  registryType: string;
  label: string;
  cost: number;
  values: Record<string, string | number>;
  exposedPorts?: string[];
  [key: string]: unknown;
}

export interface MaterialSettings {
  transparent?: boolean;
  side?: 'front' | 'back' | 'double';
  depthWrite?: boolean;
  /** How displacement is applied: 'normal' = along surface normal, 'offset' = raw vec3 offset. */
  displacementMode?: 'normal' | 'offset';
  /** Alpha clip threshold. 0 = disabled, >0 = discard fragments below this alpha value. */
  alphaTest?: number;
}

export interface OutputNodeData {
  registryType: 'output';
  label: string;
  cost: number;
  materialSettings?: MaterialSettings;
  exposedPorts?: string[];
  [key: string]: unknown;
}

/**
 * A boundary edge endpoint promoted to a synthetic handle on a collapsed group.
 * `originalNodeId/originalHandleId` are the in-group node + port the edge used
 * to terminate at — captured at collapse time so expand can rewire the edge
 * back to its real destination.
 */
export interface BoundarySocket {
  /** Synthetic handle id rendered on the group node while collapsed. */
  socketId: string;
  /** Original child node + port the edge used to point at. */
  originalNodeId: string;
  originalHandleId: string;
  dataType: TSLDataType;
  /**
   * Display name shown next to the socket. Always the label of the *source*
   * node of the edge — i.e. the upstream node producing the value through this
   * socket. For output sockets that's the internal child; for input sockets
   * that's the external feeder.
   */
  name?: string;
}

export interface GroupNodeData {
  registryType: 'group';
  label: string;
  /** Hex color used for the header strip + tinted body. */
  color: string;
  /** Cached size — React Flow uses width/height on the node itself for groups. */
  width: number;
  height: number;
  /** When true, members + their edges are hidden and the group renders as a compact pill. */
  collapsed?: boolean;
  /** Saved expanded dimensions so toggling collapsed → expanded restores the original frame. */
  expandedWidth?: number;
  expandedHeight?: number;
  /** While collapsed: input sockets exposed on the group (one per crossing edge). */
  collapsedInputs?: BoundarySocket[];
  /** While collapsed: output sockets exposed on the group (one per upstream pin). */
  collapsedOutputs?: BoundarySocket[];
  /** Sum of GPU costs of all members — populated while collapsed for the cost badge. */
  cost?: number;
  [key: string]: unknown;
}

export type ShaderFlowNode = Node<ShaderNodeData, 'shader'>;
export type ColorFlowNode = Node<ShaderNodeData, 'color'>;
export type PreviewFlowNode = Node<ShaderNodeData, 'preview'>;
export type MathPreviewFlowNode = Node<ShaderNodeData, 'mathPreview'>;
export type ClockFlowNode = Node<ShaderNodeData, 'clock'>;
export type OutputFlowNode = Node<OutputNodeData, 'output'>;
export type GroupFlowNode = Node<GroupNodeData, 'group'>;
export type AppNode =
  | ShaderFlowNode
  | ColorFlowNode
  | PreviewFlowNode
  | MathPreviewFlowNode
  | ClockFlowNode
  | OutputFlowNode
  | GroupFlowNode;

export interface TypedEdgeData {
  dataType: TSLDataType;
  [key: string]: unknown;
}

export type AppEdge = Edge<TypedEdgeData>;

/** Safely extract values from any AppNode's data. */
export function getNodeValues(node: AppNode): Record<string, string | number> {
  if (node.type === 'output' || node.type === 'group') return {};
  return (node.data as ShaderNodeData).values ?? {};
}

/** Safely extract exposedPorts from any AppNode's data. */
export function getNodeExposedPorts(node: AppNode): string[] {
  return (node.data as ShaderNodeData).exposedPorts ?? [];
}
