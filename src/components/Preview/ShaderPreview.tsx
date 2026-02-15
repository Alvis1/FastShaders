import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { WebGPURenderer, MeshPhysicalNodeMaterial } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { useAppStore } from '@/store/useAppStore';
import { compileGraphToTSL } from '@/engine/graphToTSLNodes';
import { evaluateTSLScript } from '@/engine/evaluateTSLScript';
import './ShaderPreview.css';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMaterial = any;

type GeometryType = 'sphere' | 'cube' | 'torus' | 'plane';

const FRUSTUM_SIZE = 3;

function createGeometry(type: GeometryType): THREE.BufferGeometry {
  switch (type) {
    case 'cube': return new THREE.BoxGeometry(1.4, 1.4, 1.4);
    case 'torus': return new THREE.TorusGeometry(0.7, 0.3, 64, 64);
    case 'plane': return new THREE.PlaneGeometry(2, 2);
    default: return new THREE.SphereGeometry(1, 64, 64);
  }
}

function loadGeometry(): GeometryType {
  try {
    const v = localStorage.getItem('fs:previewGeometry');
    if (v === 'cube' || v === 'torus' || v === 'plane' || v === 'sphere') return v;
  } catch { /* */ }
  return 'cube';
}

export function ShaderPreview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const materialRef = useRef<AnyMaterial>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const readyRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const [geometry, setGeometry] = useState<GeometryType>(loadGeometry);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  playingRef.current = playing;

  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const activeScript = useAppStore((s) => s.activeScript);

  // Initialize WebGPU renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;

    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const renderer = new (WebGPURenderer as any)({ canvas, antialias: true });

      const scene = new THREE.Scene();
      scene.background = new THREE.Color('white');

      const aspect = (canvas.clientWidth / canvas.clientHeight) || 1;
      const camera = new THREE.OrthographicCamera(
        -FRUSTUM_SIZE * aspect / 2, FRUSTUM_SIZE * aspect / 2,
        FRUSTUM_SIZE / 2, -FRUSTUM_SIZE / 2,
        0.1, 100,
      );
      camera.position.set(0, 0, 5);
      camera.lookAt(0, 0, 0);

      const initialGeom = loadGeometry();
      const geom = createGeometry(initialGeom);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const material = new (MeshPhysicalNodeMaterial as any)({});
      materialRef.current = material;

      const mesh = new THREE.Mesh(geom, material);
      mesh.rotation.x = Math.PI / 4;
      mesh.rotation.y = Math.PI / 4;
      meshRef.current = mesh;
      scene.add(mesh);

      // Orbit controls — drag to rotate, scroll to zoom
      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.1;

      // Lighting
      const light = new THREE.DirectionalLight('white', 1.5);
      light.position.copy(camera.position);
      scene.add(light);
      scene.add(new THREE.AmbientLight('white', 2));

      // Animation loop
      renderer.setAnimationLoop(() => {
        if (disposed) return;
        if (playingRef.current) {
          mesh.rotation.y += 0.005;
          mesh.rotation.x += 0.002;
        }
        controls.update();
        light.position.copy(camera.position);
        renderer.render(scene, camera);
      });

      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      renderer.setSize(canvas.clientWidth, canvas.clientHeight);
      renderer.setPixelRatio(window.devicePixelRatio);

      // Observe resizes BEFORE async init so layout changes during init are caught
      const observer = new ResizeObserver(() => {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w > 0 && h > 0) {
          renderer.setSize(w, h);
          const a = w / h;
          camera.left = -FRUSTUM_SIZE * a / 2;
          camera.right = FRUSTUM_SIZE * a / 2;
          camera.top = FRUSTUM_SIZE / 2;
          camera.bottom = -FRUSTUM_SIZE / 2;
          camera.updateProjectionMatrix();
        }
      });
      observer.observe(canvas);

      // Init WebGPU device — animation loop starts after this
      await renderer.init();
      if (disposed) {
        observer.disconnect();
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

      cleanupRef.current = () => {
        renderer.setAnimationLoop(null);
        controls.dispose();
        observer.disconnect();
        renderer.dispose();
        geom.dispose();
        material.dispose();
      };
    })();

    return () => {
      disposed = true;
      readyRef.current = false;
      materialRef.current = null;
      meshRef.current = null;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  // Swap geometry when selection changes
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const oldGeom = mesh.geometry;
    const newGeom = createGeometry(geometry);
    mesh.geometry = newGeom;
    oldGeom.dispose();

    try { localStorage.setItem('fs:previewGeometry', geometry); } catch { /* */ }
  }, [geometry]);

  // Recompile TSL nodes when graph changes (skip in script mode)
  useEffect(() => {
    if (activeScript) return;
    if (!readyRef.current || !materialRef.current) return;
    const material = materialRef.current;

    const result = compileGraphToTSL(nodes, edges);
    if (result.success) {
      material.colorNode = result.colorNode;
      material.normalNode = result.normalNode ?? null;
      material.needsUpdate = true;
    }
  }, [nodes, edges, activeScript]);

  // Evaluate tsl-textures script when activeScript changes
  useEffect(() => {
    if (!activeScript || !readyRef.current || !materialRef.current) return;
    const material = materialRef.current;

    const result = evaluateTSLScript(activeScript);
    if (result.success) {
      material.colorNode = result.colorNode;
      material.normalNode = result.normalNode ?? null;
      material.needsUpdate = true;
    }
    if (result.error) {
      useAppStore.getState().setCodeErrors([{ message: result.error }]);
    }
  }, [activeScript]);

  return (
    <div className="shader-preview">
      <div className="shader-preview__header">
        <span>Preview</span>
        <div className="shader-preview__controls">
          <button
            className="shader-preview__play-btn"
            onClick={() => setPlaying((p) => !p)}
            title={playing ? 'Pause rotation' : 'Play rotation'}
          >
            {playing ? '\u23F8' : '\u25B6'}
          </button>
          <select
            className="shader-preview__geo-select"
            value={geometry}
            onChange={(e) => setGeometry(e.target.value as GeometryType)}
          >
            <option value="sphere">Sphere</option>
            <option value="cube">Cube</option>
            <option value="torus">Torus</option>
            <option value="plane">Plane</option>
          </select>
        </div>
      </div>
      <div className="shader-preview__body">
        <canvas ref={canvasRef} className="shader-preview__canvas" />
      </div>
    </div>
  );
}
