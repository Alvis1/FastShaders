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
  [key: string]: unknown;
}

export interface OutputNodeData {
  registryType: 'output';
  label: string;
  cost: number;
  [key: string]: unknown;
}

export type ShaderFlowNode = Node<ShaderNodeData, 'shader'>;
export type ColorFlowNode = Node<ShaderNodeData, 'color'>;
export type PreviewFlowNode = Node<ShaderNodeData, 'preview'>;
export type MathPreviewFlowNode = Node<ShaderNodeData, 'mathPreview'>;
export type OutputFlowNode = Node<OutputNodeData, 'output'>;
export type AppNode = ShaderFlowNode | ColorFlowNode | PreviewFlowNode | MathPreviewFlowNode | OutputFlowNode;

export interface TypedEdgeData {
  dataType: TSLDataType;
  [key: string]: unknown;
}

export type AppEdge = Edge<TypedEdgeData>;
