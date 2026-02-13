import { useEffect } from 'react';
import { NodeEditor } from './components/node-editor/NodeEditor';
import { CodeEditor } from './components/code-editor/CodeEditor';
import { useStore } from './store';
import { getNodeDefinition } from './components/node-editor/nodes/NodeRegistry';

function App() {
  const { setNodes, setEdges, setCode } = useStore();

  // Initialize with example nodes from the mockup
  useEffect(() => {
    const noiseNode = getNodeDefinition('noise');
    const colorNode = getNodeDefinition('color');
    const deformNode = getNodeDefinition('deform');
    const outputNode = getNodeDefinition('output');

    if (!noiseNode || !colorNode || !deformNode || !outputNode) return;

    // Create camouflage shader nodes
    const exampleNodes = [
      // Position input
      {
        id: 'position-1',
        type: 'vec3',
        position: { x: 50, y: 50 },
        data: {
          label: 'positionGeometry',
          type: 'vec3',
          complexity: 1,
          vrImpact: 'minimal' as const,
          color: '#A8D5A8',
          inputs: [],
          outputs: [{ id: 'out', label: 'Output', dataType: 'vec3' as const, required: true }],
        },
      },
      // Scale and position transform
      {
        id: 'mul-1',
        type: 'mul',
        position: { x: 250, y: 50 },
        data: {
          label: 'Scale Position',
          type: 'mul',
          complexity: 1,
          vrImpact: 'minimal' as const,
          color: '#A8D5A8',
          inputs: [
            { id: 'a', label: 'Position', dataType: 'vec3' as const, required: true },
            { id: 'b', label: 'Scale', dataType: 'float' as const, required: true },
          ],
          outputs: [{ id: 'out', label: 'Output', dataType: 'vec3' as const, required: true }],
        },
      },
      // Noise node 1 (pos)
      {
        id: 'noise-1',
        type: 'noise',
        position: { x: 450, y: 50 },
        data: {
          label: 'Noise (pos)',
          type: 'noise',
          complexity: 50,
          vrImpact: 'high' as const,
          color: noiseNode.color,
          inputs: [{ id: 'in', label: 'Input', dataType: 'vec3' as const, required: true }],
          outputs: [{ id: 'out', label: 'Output', dataType: 'float' as const, required: true }],
        },
      },
      // Noise node 2 (pos.yzx)
      {
        id: 'noise-2',
        type: 'noise',
        position: { x: 450, y: 150 },
        data: {
          label: 'Noise (pos.yzx)',
          type: 'noise',
          complexity: 50,
          vrImpact: 'high' as const,
          color: noiseNode.color,
          inputs: [{ id: 'in', label: 'Input', dataType: 'vec3' as const, required: true }],
          outputs: [{ id: 'out', label: 'Output', dataType: 'float' as const, required: true }],
        },
      },
      // Noise node 3 (pos.zxy)
      {
        id: 'noise-3',
        type: 'noise',
        position: { x: 450, y: 250 },
        data: {
          label: 'Noise (pos.zxy)',
          type: 'noise',
          complexity: 50,
          vrImpact: 'high' as const,
          color: noiseNode.color,
          inputs: [{ id: 'in', label: 'Input', dataType: 'vec3' as const, required: true }],
          outputs: [{ id: 'out', label: 'Output', dataType: 'float' as const, required: true }],
        },
      },
      // Color nodes
      {
        id: 'color-a',
        type: 'color',
        position: { x: 650, y: 50 },
        data: {
          label: 'Color A (Tan)',
          type: 'color',
          complexity: 2,
          vrImpact: 'minimal' as const,
          color: colorNode.color,
          inputs: [],
          outputs: [{ id: 'out', label: 'Output', dataType: 'color' as const, required: true }],
        },
      },
      {
        id: 'color-b',
        type: 'color',
        position: { x: 650, y: 150 },
        data: {
          label: 'Color B (Brown)',
          type: 'color',
          complexity: 2,
          vrImpact: 'minimal' as const,
          color: colorNode.color,
          inputs: [],
          outputs: [{ id: 'out', label: 'Output', dataType: 'color' as const, required: true }],
        },
      },
      {
        id: 'color-c',
        type: 'color',
        position: { x: 650, y: 250 },
        data: {
          label: 'Color C (Green)',
          type: 'color',
          complexity: 2,
          vrImpact: 'minimal' as const,
          color: colorNode.color,
          inputs: [],
          outputs: [{ id: 'out', label: 'Output', dataType: 'color' as const, required: true }],
        },
      },
      {
        id: 'color-d',
        type: 'color',
        position: { x: 650, y: 350 },
        data: {
          label: 'Color D (Olive)',
          type: 'color',
          complexity: 2,
          vrImpact: 'minimal' as const,
          color: colorNode.color,
          inputs: [],
          outputs: [{ id: 'out', label: 'Output', dataType: 'color' as const, required: true }],
        },
      },
      // Mix/Select node (represents If/ElseIf logic)
      {
        id: 'mix-1',
        type: 'mix',
        position: { x: 850, y: 200 },
        data: {
          label: 'Color Selection',
          type: 'mix',
          complexity: 3,
          vrImpact: 'low' as const,
          color: '#A8D5A8',
          inputs: [
            { id: 'a', label: 'Colors', dataType: 'color' as const, required: true },
            { id: 'b', label: 'Conditions', dataType: 'float' as const, required: true },
          ],
          outputs: [{ id: 'out', label: 'Output', dataType: 'color' as const, required: true }],
        },
      },
      // Output node
      {
        id: 'output-1',
        type: 'output',
        position: { x: 1050, y: 200 },
        data: {
          label: outputNode.label,
          type: outputNode.type,
          complexity: outputNode.complexity,
          vrImpact: outputNode.vrImpact,
          color: outputNode.color,
          inputs: outputNode.inputs,
          outputs: outputNode.outputs,
        },
      },
    ];

    // Create edges for camouflage shader
    const exampleEdges = [
      // Position → Scale
      {
        id: 'e-position-mul',
        source: 'position-1',
        target: 'mul-1',
        sourceHandle: 'out',
        targetHandle: 'a',
        animated: true,
      },
      // Scaled position → Noise nodes
      {
        id: 'e-mul-noise1',
        source: 'mul-1',
        target: 'noise-1',
        sourceHandle: 'out',
        targetHandle: 'in',
        animated: true,
      },
      {
        id: 'e-mul-noise2',
        source: 'mul-1',
        target: 'noise-2',
        sourceHandle: 'out',
        targetHandle: 'in',
        animated: true,
      },
      {
        id: 'e-mul-noise3',
        source: 'mul-1',
        target: 'noise-3',
        sourceHandle: 'out',
        targetHandle: 'in',
        animated: true,
      },
      // Noise outputs → Mix (conditions)
      {
        id: 'e-noise1-mix',
        source: 'noise-1',
        target: 'mix-1',
        sourceHandle: 'out',
        targetHandle: 'b',
        animated: true,
      },
      {
        id: 'e-noise2-mix',
        source: 'noise-2',
        target: 'mix-1',
        sourceHandle: 'out',
        targetHandle: 'b',
        animated: true,
      },
      {
        id: 'e-noise3-mix',
        source: 'noise-3',
        target: 'mix-1',
        sourceHandle: 'out',
        targetHandle: 'b',
        animated: true,
      },
      // Colors → Mix
      {
        id: 'e-colorA-mix',
        source: 'color-a',
        target: 'mix-1',
        sourceHandle: 'out',
        targetHandle: 'a',
        animated: true,
      },
      {
        id: 'e-colorB-mix',
        source: 'color-b',
        target: 'mix-1',
        sourceHandle: 'out',
        targetHandle: 'a',
        animated: true,
      },
      {
        id: 'e-colorC-mix',
        source: 'color-c',
        target: 'mix-1',
        sourceHandle: 'out',
        targetHandle: 'a',
        animated: true,
      },
      {
        id: 'e-colorD-mix',
        source: 'color-d',
        target: 'mix-1',
        sourceHandle: 'out',
        targetHandle: 'a',
        animated: true,
      },
      // Mix → Output
      {
        id: 'e-mix-output',
        source: 'mix-1',
        target: 'output-1',
        sourceHandle: 'out',
        targetHandle: 'color',
        animated: true,
      },
    ];

    setNodes(exampleNodes);
    setEdges(exampleEdges);

    // Set example TSL code - Camouflage shader
    const exampleCode = `import { Color } from 'three';
import { Fn, If, positionGeometry } from 'three/tsl';
import { noise } from './tsl-utils.js';

// Camouflage Procedural Texture Shader
// Based on: https://github.com/boytchev/tsl-textures

const camouflageShader = Fn(() => {
  // Position input scaled by scale factor
  const scale = 2.0;
  const seed = 0.0;
  const pos = positionGeometry.mul(Math.exp(scale)).add(seed);

  // Define camouflage colors
  const colorA = new Color(0xc2bea8); // Light tan
  const colorB = new Color(0x9c895e); // Brown
  const colorC = new Color(0x92a375); // Green
  const colorD = new Color(0x717561); // Dark olive

  // Start with default color
  let color = colorD;

  // Layered noise-based color selection
  If(noise(pos).greaterThanEqual(0.3), () => {
    color = colorA;
  })
  .ElseIf(noise(pos.yzx).greaterThanEqual(0.2), () => {
    color = colorB;
  })
  .ElseIf(noise(pos.zxy).greaterThanEqual(0.1), () => {
    color = colorC;
  });

  return color;
});

export default camouflageShader;
`;

    setCode(exampleCode);
  }, [setNodes, setEdges, setCode]);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div
        style={{
          height: '60px',
          background: 'var(--bg-panel)',
          borderBottom: '1px solid var(--border-color)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          boxShadow: 'var(--shadow-panel)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>
          FastShaders
        </h1>
        <div style={{ marginLeft: '20px', color: 'var(--color-text-secondary)', fontSize: '14px' }}>
          Bi-Directional TSL Shader Editor for WebXR/VR
        </div>
      </div>

      {/* Split Pane Layout */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left Panel - Node Editor */}
        <div style={{ flex: 1, borderRight: '1px solid var(--border-color)', position: 'relative' }}>
          <NodeEditor />
        </div>

        {/* Right Panel - Code Editor */}
        <div style={{ flex: 1, position: 'relative' }}>
          <CodeEditor />
        </div>
      </div>
    </div>
  );
}

export default App;
