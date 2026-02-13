import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { WebGPURenderer, MeshPhysicalNodeMaterial } from 'three/webgpu';
import { useAppStore } from '@/store/useAppStore';
import { compileGraphToTSL } from '@/engine/graphToTSLNodes';
import './ShaderPreview.css';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMaterial = any;

export function ShaderPreview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const materialRef = useRef<AnyMaterial>(null);
  const readyRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);

  // Initialize WebGPU renderer — matches tsl-textures/online.js pattern
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;

    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const renderer = new (WebGPURenderer as any)({ canvas, antialias: true });

      const scene = new THREE.Scene();
      scene.background = new THREE.Color('white');

      const camera = new THREE.PerspectiveCamera(
        30,
        canvas.clientWidth / canvas.clientHeight,
        0.1,
        100,
      );
      camera.position.set(0, 0, 5);
      camera.lookAt(0, 0, 0);

      const geometry = new THREE.SphereGeometry(1, 64, 64);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const material = new (MeshPhysicalNodeMaterial as any)({});
      materialRef.current = material;

      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);

      // Lighting matching tsl-textures: directional + ambient
      const light = new THREE.DirectionalLight('white', 1.5);
      light.position.copy(camera.position);
      scene.add(light);
      scene.add(new THREE.AmbientLight('white', 2));

      // Animation loop — registered BEFORE init, runs AFTER init resolves
      renderer.setAnimationLoop(() => {
        if (disposed) return;
        mesh.rotation.y += 0.005;
        mesh.rotation.x += 0.002;
        light.position.copy(camera.position);
        renderer.render(scene, camera);
      });

      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      renderer.setSize(canvas.clientWidth, canvas.clientHeight);
      renderer.setPixelRatio(window.devicePixelRatio);

      // Init WebGPU device — animation loop starts after this
      await renderer.init();
      if (disposed) {
        renderer.dispose();
        return;
      }

      // Initial TSL compilation
      const state = useAppStore.getState();
      const compiled = compileGraphToTSL(state.nodes, state.edges);
      if (compiled.success && compiled.colorNode) {
        material.colorNode = compiled.colorNode;
        if (compiled.normalNode) material.normalNode = compiled.normalNode;
        material.needsUpdate = true;
      }

      readyRef.current = true;

      // Resize handling
      const observer = new ResizeObserver(() => {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w > 0 && h > 0) {
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        }
      });
      observer.observe(canvas);

      cleanupRef.current = () => {
        renderer.setAnimationLoop(null);
        observer.disconnect();
        renderer.dispose();
        geometry.dispose();
        material.dispose();
      };
    })();

    return () => {
      disposed = true;
      readyRef.current = false;
      materialRef.current = null;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  // Recompile TSL nodes when graph changes
  useEffect(() => {
    if (!readyRef.current || !materialRef.current) return;
    const material = materialRef.current;

    const result = compileGraphToTSL(nodes, edges);
    if (result.success) {
      material.colorNode = result.colorNode;
      material.normalNode = result.normalNode ?? null;
      material.needsUpdate = true;
    }
  }, [nodes, edges]);

  return (
    <div className="shader-preview">
      <div className="shader-preview__header">Preview</div>
      <canvas ref={canvasRef} className="shader-preview__canvas" />
    </div>
  );
}
