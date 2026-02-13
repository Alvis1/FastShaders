/**
 * Node Registry
 * Defines all available node types with VR performance costs
 */

import { NodeDefinition } from '../../../core/types';

/**
 * All available nodes for FastShaders
 * Costs are based on VR performance impact (90 FPS target)
 */
export const NODE_REGISTRY: Record<string, NodeDefinition> = {
  // INPUT NODES (Procedural & Sources)
  noise: {
    id: 'noise',
    type: 'noise',
    label: 'Noise node',
    category: 'input',
    color: '#E89F71',            // Orange (from mockup)
    complexity: 50,
    vrImpact: 'high',
    tslFunction: 'noiseNode',
    inputs: [],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'float', required: true }
    ],
    description: 'Procedural noise - expensive in VR (runs per pixel on both eyes)'
  },

  texture: {
    id: 'texture',
    type: 'texture',
    label: 'Texture',
    category: 'input',
    color: '#E89F71',
    complexity: 10,
    vrImpact: 'medium',
    tslFunction: 'texture',
    inputs: [
      { id: 'uv', label: 'UV', dataType: 'vec2', required: false }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'vec4', required: true }
    ],
    description: 'Texture lookup - moderate VR cost'
  },

  // COLOR NODES
  color: {
    id: 'color',
    type: 'color',
    label: 'Color',
    category: 'operation',
    color: '#F4E7A1',            // Yellow (from mockup)
    complexity: 2,
    vrImpact: 'minimal',
    tslFunction: 'color',
    inputs: [],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'color', required: true }
    ],
    defaultParams: { value: 0xff0000 },
    description: 'Constant color value - negligible VR overhead'
  },

  // ARITHMETIC NODES
  mul: {
    id: 'mul',
    type: 'mul',
    label: 'Multiply',
    category: 'operation',
    color: '#A8D5A8',            // Green (from mockup)
    complexity: 1,
    vrImpact: 'minimal',
    tslFunction: 'mul',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any', required: true },
      { id: 'b', label: 'B', dataType: 'any', required: true }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'any', required: true }
    ],
    description: 'Multiply - very cheap operation'
  },

  add: {
    id: 'add',
    type: 'add',
    label: 'Add',
    category: 'operation',
    color: '#A8D5A8',
    complexity: 1,
    vrImpact: 'minimal',
    tslFunction: 'add',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any', required: true },
      { id: 'b', label: 'B', dataType: 'any', required: true }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'any', required: true }
    ],
    description: 'Add - very cheap operation'
  },

  sub: {
    id: 'sub',
    type: 'sub',
    label: 'Subtract',
    category: 'operation',
    color: '#A8D5A8',
    complexity: 1,
    vrImpact: 'minimal',
    tslFunction: 'sub',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any', required: true },
      { id: 'b', label: 'B', dataType: 'any', required: true }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'any', required: true }
    ],
    description: 'Subtract - very cheap operation'
  },

  div: {
    id: 'div',
    type: 'div',
    label: 'Divide',
    category: 'operation',
    color: '#A8D5A8',
    complexity: 2,
    vrImpact: 'low',
    tslFunction: 'div',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any', required: true },
      { id: 'b', label: 'B', dataType: 'any', required: true }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'any', required: true }
    ],
    description: 'Divide - slightly more expensive than multiply'
  },

  // DEFORM NODE (from mockup - actually a multiply operation)
  deform: {
    id: 'deform',
    type: 'deform',
    label: 'Deform',
    category: 'operation',
    color: '#A8D5A8',            // Green (from mockup)
    complexity: 1,
    vrImpact: 'minimal',
    tslFunction: 'mul',
    inputs: [
      { id: 'a', label: 'A', dataType: 'float', required: true },
      { id: 'b', label: 'B', dataType: 'float', required: true }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'float', required: true }
    ],
    description: 'Deform operation - very cheap'
  },

  // TRIGONOMETRIC NODES
  sin: {
    id: 'sin',
    type: 'sin',
    label: 'Sine',
    category: 'operation',
    color: '#F4E7A1',
    complexity: 8,
    vrImpact: 'medium',
    tslFunction: 'sin',
    inputs: [
      { id: 'x', label: 'X', dataType: 'float', required: true }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'float', required: true }
    ],
    description: 'Sine - adds up quickly in VR'
  },

  cos: {
    id: 'cos',
    type: 'cos',
    label: 'Cosine',
    category: 'operation',
    color: '#F4E7A1',
    complexity: 8,
    vrImpact: 'medium',
    tslFunction: 'cos',
    inputs: [
      { id: 'x', label: 'X', dataType: 'float', required: true }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'float', required: true }
    ],
    description: 'Cosine - adds up quickly in VR'
  },

  // VECTOR NODES
  vec2: {
    id: 'vec2',
    type: 'vec2',
    label: 'Vector 2',
    category: 'operation',
    color: '#F4E7A1',
    complexity: 1,
    vrImpact: 'minimal',
    tslFunction: 'vec2',
    inputs: [
      { id: 'x', label: 'X', dataType: 'float', required: true },
      { id: 'y', label: 'Y', dataType: 'float', required: true }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'vec2', required: true }
    ],
    description: 'Create 2D vector - very cheap'
  },

  vec3: {
    id: 'vec3',
    type: 'vec3',
    label: 'Vector 3',
    category: 'operation',
    color: '#F4E7A1',
    complexity: 1,
    vrImpact: 'minimal',
    tslFunction: 'vec3',
    inputs: [
      { id: 'x', label: 'X', dataType: 'float', required: true },
      { id: 'y', label: 'Y', dataType: 'float', required: true },
      { id: 'z', label: 'Z', dataType: 'float', required: true }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'vec3', required: true }
    ],
    description: 'Create 3D vector - very cheap'
  },

  // BLENDING NODES
  mix: {
    id: 'mix',
    type: 'mix',
    label: 'Mix',
    category: 'operation',
    color: '#A8D5A8',
    complexity: 3,
    vrImpact: 'low',
    tslFunction: 'mix',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any', required: true },
      { id: 'b', label: 'B', dataType: 'any', required: true },
      { id: 't', label: 'T', dataType: 'float', required: true }
    ],
    outputs: [
      { id: 'out', label: 'Output', dataType: 'any', required: true }
    ],
    description: 'Linear interpolation - relatively cheap'
  },

  // OUTPUT NODE
  output: {
    id: 'output',
    type: 'output',
    label: 'Output Node',
    category: 'output',
    color: '#E89FA8',            // Pink/Salmon (from mockup)
    complexity: 0,
    vrImpact: 'minimal',
    tslFunction: 'output',
    inputs: [
      { id: 'color', label: 'Color', dataType: 'color', required: false },
      { id: 'position', label: 'Position', dataType: 'vec3', required: false },
      { id: 'normal', label: 'Normal', dataType: 'vec3', required: false }
    ],
    outputs: [],
    description: 'Final shader output'
  }
};

/**
 * Get node definition by type
 */
export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return NODE_REGISTRY[type];
}

/**
 * Get all node types
 */
export function getAllNodeTypes(): string[] {
  return Object.keys(NODE_REGISTRY);
}

/**
 * Get nodes by category
 */
export function getNodesByCategory(category: 'input' | 'operation' | 'output'): NodeDefinition[] {
  return Object.values(NODE_REGISTRY).filter(node => node.category === category);
}

/**
 * Search nodes by label or description
 */
export function searchNodes(query: string): NodeDefinition[] {
  const lowerQuery = query.toLowerCase();
  return Object.values(NODE_REGISTRY).filter(node =>
    node.label.toLowerCase().includes(lowerQuery) ||
    node.description?.toLowerCase().includes(lowerQuery) ||
    node.type.toLowerCase().includes(lowerQuery)
  );
}
