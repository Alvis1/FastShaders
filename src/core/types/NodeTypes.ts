/**
 * Node Types for FastShaders
 * Defines the structure for React Flow nodes
 */

export type NodeCategory = 'input' | 'operation' | 'output';
export type VRImpact = 'minimal' | 'low' | 'medium' | 'high';
export type DataType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'color' | 'texture' | 'any';

/**
 * Port definition for node inputs/outputs
 */
export interface PortDefinition {
  id: string;
  label: string;
  dataType: DataType;
  required: boolean;
}

/**
 * Node definition from registry
 */
export interface NodeDefinition {
  id: string;
  type: string;
  label: string;
  category: NodeCategory;
  color: string;              // Hex color from design system
  complexity: number;         // VR performance cost
  vrImpact: VRImpact;        // VR impact level
  tslFunction: string;        // TSL function name (e.g., 'noiseNode', 'color')
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  defaultParams?: Record<string, any>;
  description?: string;
}

/**
 * React Flow node data
 */
export interface NodeData {
  label: string;
  type: string;
  complexity: number;
  vrImpact: VRImpact;
  color: string;
  params?: Record<string, any>;
  inputs?: PortDefinition[];
  outputs?: PortDefinition[];
}

/**
 * React Flow node
 */
export interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: NodeData;
  selected?: boolean;
  dragging?: boolean;
}

/**
 * React Flow edge
 */
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  animated?: boolean;
  style?: React.CSSProperties;
}

/**
 * Graph data (nodes + edges)
 */
export interface GraphData {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/**
 * Node registry - maps node types to definitions
 */
export type NodeRegistry = Record<string, NodeDefinition>;
