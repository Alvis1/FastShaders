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
  | 'texture'
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
}

export interface OutputNodeData {
  registryType: 'output';
  label: string;
  cost: number;
  materialSettings?: MaterialSettings;
  exposedPorts?: string[];
  [key: string]: unknown;
}

export type ShaderFlowNode = Node<ShaderNodeData, 'shader'>;
export type ColorFlowNode = Node<ShaderNodeData, 'color'>;
export type PreviewFlowNode = Node<ShaderNodeData, 'preview'>;
export type MathPreviewFlowNode = Node<ShaderNodeData, 'mathPreview'>;
export type ClockFlowNode = Node<ShaderNodeData, 'clock'>;
export type TexturePreviewFlowNode = Node<ShaderNodeData, 'texturePreview'>;
export type OutputFlowNode = Node<OutputNodeData, 'output'>;
export type AppNode = ShaderFlowNode | ColorFlowNode | PreviewFlowNode | MathPreviewFlowNode | ClockFlowNode | TexturePreviewFlowNode | OutputFlowNode;

export interface TypedEdgeData {
  dataType: TSLDataType;
  [key: string]: unknown;
}

export type AppEdge = Edge<TypedEdgeData>;

/** Safely extract values from any AppNode's data. */
export function getNodeValues(node: AppNode): Record<string, string | number> {
  return (node.data as ShaderNodeData).values ?? {};
}

/** Safely extract exposedPorts from any AppNode's data. */
export function getNodeExposedPorts(node: AppNode): string[] {
  return (node.data as ShaderNodeData).exposedPorts ?? [];
}
