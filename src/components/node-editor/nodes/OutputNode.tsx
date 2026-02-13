/**
 * OutputNode Component
 * Pink node - Final shader output with live preview
 */

import { useEffect, useRef } from 'react';
import { NodeProps, Handle, Position } from 'reactflow';
import * as THREE from 'three';
import styles from './BaseNode.module.css';

export const OutputNode: React.FC<NodeProps> = ({ data, selected }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    // Initialize Three.js scene
    const canvas = canvasRef.current;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true
    });
    renderer.setSize(200, 150);
    renderer.setPixelRatio(window.devicePixelRatio);
    rendererRef.current = renderer;

    // Create scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Create camera
    const camera = new THREE.PerspectiveCamera(50, 200 / 150, 0.1, 1000);
    camera.position.z = 3;
    cameraRef.current = camera;

    // Create sphere geometry
    const geometry = new THREE.SphereGeometry(1, 32, 32);

    // Create material with gradient shader
    const material = new THREE.MeshBasicMaterial({
      color: 0xc2bea8, // Default to camouflage tan color
    });

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    meshRef.current = mesh;

    // Add lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 5, 5);
    scene.add(directionalLight);

    // Animation loop
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);

      if (meshRef.current) {
        meshRef.current.rotation.y += 0.005;
      }

      renderer.render(scene, camera);
    };
    animate();

    // Cleanup
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      renderer.dispose();
      geometry.dispose();
      material.dispose();
    };
  }, []);

  // Get VR impact color
  const getVRImpactColor = (impact: string) => {
    switch (impact) {
      case 'minimal':
        return 'var(--complexity-comfortable)';
      case 'low':
        return 'var(--complexity-acceptable)';
      case 'medium':
        return 'var(--complexity-heavy)';
      case 'high':
        return 'var(--complexity-critical)';
      default:
        return 'var(--complexity-comfortable)';
    }
  };

  return (
    <div
      className={`${styles.node} ${selected ? styles.selected : ''}`}
      style={{
        borderColor: data.color || 'var(--node-color)',
        minWidth: '240px',
        minHeight: '280px',
      }}
    >
      {/* Input handles */}
      {data.inputs?.map((input: any) => (
        <Handle
          key={input.id}
          type="target"
          position={Position.Left}
          id={input.id}
          style={{ top: '50%' }}
          className={styles.handle}
        />
      ))}

      {/* Node header */}
      <div className={styles.header}>
        <div className={styles.title}>
          <div
            className={styles.vrIndicator}
            style={{ backgroundColor: getVRImpactColor(data.vrImpact) }}
          />
          <span>{data.label}</span>
        </div>
        <div className={styles.complexity}>
          {data.complexity} {data.complexity === 1 ? 'point' : 'points'}
        </div>
      </div>

      {/* Shader Preview */}
      <div style={{
        padding: '8px',
        background: 'var(--bg-primary)',
        borderRadius: '4px',
        margin: '8px 8px 0 8px'
      }}>
        <div style={{
          fontSize: '11px',
          color: 'var(--color-text-secondary)',
          marginBottom: '4px',
          fontWeight: 500
        }}>
          Shader Preview
        </div>
        <canvas
          ref={canvasRef}
          width={200}
          height={150}
          style={{
            width: '100%',
            height: 'auto',
            borderRadius: '2px',
            display: 'block',
            border: '1px solid var(--border-color)',
          }}
        />
      </div>

      {/* Port labels */}
      {data.inputs && data.inputs.length > 0 && (
        <div className={styles.ports}>
          <div className={styles.inputPorts}>
            {data.inputs.map((input: any) => (
              <div key={input.id} className={styles.port}>
                {input.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Output handles */}
      {data.outputs?.map((output: any) => (
        <Handle
          key={output.id}
          type="source"
          position={Position.Right}
          id={output.id}
          style={{ top: '50%' }}
          className={styles.handle}
        />
      ))}
    </div>
  );
};

export default OutputNode;
