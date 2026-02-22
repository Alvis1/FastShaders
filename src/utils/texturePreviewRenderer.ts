/**
 * Shared off-screen WebGPU renderer for texture node previews.
 * Maintains a single renderer + per-node material cache to avoid
 * shader recompilation during animation frames.
 */
import {
  WebGPURenderer,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import { Scene, OrthographicCamera, PlaneGeometry, Mesh, Color, Vector2, Vector3 } from 'three';
import { time as tslTime } from 'three/tsl';
import * as tslTextures from 'tsl-textures';
import { getParamClassifications } from '@/registry/tslTexturesRegistry';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { hexToRgb01 } from '@/utils/colorUtils';

const PREVIEW_SIZE = 96;

// --- Singleton state ---
let renderer: WebGPURenderer | null = null;
let scene: Scene | null = null;
let camera: OrthographicCamera | null = null;
let plane: Mesh | null = null;
let initPromise: Promise<boolean> | null = null;
let available = false;

// Per-node cached material
interface NodeEntry {
  material: InstanceType<typeof MeshBasicNodeMaterial>;
  targetCanvas: HTMLCanvasElement;
  registryType: string;
  valuesKey: string; // JSON snapshot for dirty detection
  hasTime: boolean;
}

const nodeEntries = new Map<string, NodeEntry>();

// Animation loop
let animFrameId: number | null = null;
const animatedNodes = new Set<string>();

// Render queue lock — serialise async renders
let renderLock = Promise.resolve();

async function init(): Promise<boolean> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = PREVIEW_SIZE;
    canvas.height = PREVIEW_SIZE;
    canvas.style.position = 'absolute';
    canvas.style.left = '-9999px';
    canvas.style.top = '-9999px';
    document.body.appendChild(canvas);

    renderer = new WebGPURenderer({ canvas, antialias: false });
    renderer.setSize(PREVIEW_SIZE, PREVIEW_SIZE);
    await renderer.init();

    camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    scene = new Scene();
    const geometry = new PlaneGeometry(2, 2);
    plane = new Mesh(geometry, new MeshBasicNodeMaterial());
    scene.add(plane);

    available = true;
    return true;
  } catch (e) {
    console.warn('WebGPU texture preview unavailable:', e);
    available = false;
    return false;
  }
}

export function ensureInit(): Promise<boolean> {
  if (!initPromise) initPromise = init();
  return initPromise;
}

export function isAvailable(): boolean {
  return available;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildColorNode(
  registryType: string,
  values: Record<string, string | number>,
  hasTime: boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const def = NODE_REGISTRY.get(registryType);
  if (!def) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const texFn = (tslTextures as any)[def.tslFunction];
  if (typeof texFn !== 'function') return null;

  const classifications = getParamClassifications(def.tslFunction);
  const params: Record<string, unknown> = {};

  for (const param of classifications) {
    if (param.kind === 'meta') continue;

    if (param.kind === 'tslRef') {
      // position: let library use its default (positionLocal → maps to plane geometry)
      // time: pass TSL time node when connected upstream
      if (param.key === 'time' && hasTime) {
        params[param.key] = tslTime;
      }
      // Otherwise omit → library uses its own default
    } else if (param.kind === 'number') {
      params[param.key] = Number(values[param.key] ?? param.defaultValue ?? 0);
    } else if (param.kind === 'color') {
      const hex = String(values[param.key] ?? '#000000');
      const [r, g, b] = hexToRgb01(hex);
      params[param.key] = new Color(r, g, b);
    } else if (param.kind === 'vec3') {
      params[param.key] = new Vector3(
        Number(values[`${param.key}_x`] ?? 0),
        Number(values[`${param.key}_y`] ?? 0),
        Number(values[`${param.key}_z`] ?? 0),
      );
    } else if (param.kind === 'vec2') {
      params[param.key] = new Vector2(
        Number(values[`${param.key}_x`] ?? 0),
        Number(values[`${param.key}_y`] ?? 0),
      );
    }
  }

  try {
    return texFn(params);
  } catch (e) {
    console.warn(`Texture preview build failed for ${registryType}:`, e);
    return null;
  }
}

async function doRender(
  nodeId: string,
  registryType: string,
  values: Record<string, string | number>,
  hasTime: boolean,
  targetCanvas: HTMLCanvasElement,
): Promise<void> {
  if (!available || !renderer || !scene || !camera || !plane) return;

  const valuesKey = JSON.stringify(values);
  let entry = nodeEntries.get(nodeId);

  // Rebuild material if params changed or node type changed
  const needsRebuild = !entry
    || entry.registryType !== registryType
    || entry.valuesKey !== valuesKey
    || entry.hasTime !== hasTime;

  if (needsRebuild) {
    const colorNode = buildColorNode(registryType, values, hasTime);
    if (!colorNode) return;

    const material = entry?.material ?? new MeshBasicNodeMaterial();
    material.colorNode = colorNode;
    material.needsUpdate = true;

    entry = {
      material,
      targetCanvas,
      registryType,
      valuesKey,
      hasTime,
    };
    nodeEntries.set(nodeId, entry);
  } else {
    // Update target canvas ref (might change across renders)
    entry!.targetCanvas = targetCanvas;
  }

  // entry is guaranteed to be set at this point
  const current = nodeEntries.get(nodeId)!;

  // Render
  plane.material = current.material;
  try {
    await renderer.renderAsync(scene, camera);
  } catch {
    // Fallback to sync render
    renderer.render(scene, camera);
  }

  // Copy to target canvas
  const ctx = targetCanvas.getContext('2d');
  if (ctx && renderer.domElement) {
    ctx.drawImage(renderer.domElement, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  }
}

/** Queue a render for a texture node. Serialised to prevent race conditions. */
export function renderPreview(
  nodeId: string,
  registryType: string,
  values: Record<string, string | number>,
  hasTime: boolean,
  targetCanvas: HTMLCanvasElement,
): Promise<void> {
  const job = renderLock.then(() =>
    doRender(nodeId, registryType, values, hasTime, targetCanvas),
  );
  renderLock = job.catch(() => {});
  return job;
}

export function registerAnimated(nodeId: string, targetCanvas: HTMLCanvasElement): void {
  animatedNodes.add(nodeId);
  const entry = nodeEntries.get(nodeId);
  if (entry) entry.targetCanvas = targetCanvas;
  if (!animFrameId) startAnimLoop();
}

export function unregisterAnimated(nodeId: string): void {
  animatedNodes.delete(nodeId);
  if (animatedNodes.size === 0 && animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

function startAnimLoop(): void {
  const tick = async () => {
    if (!available || !renderer || !scene || !camera || !plane) return;
    for (const nodeId of animatedNodes) {
      const entry = nodeEntries.get(nodeId);
      if (!entry) continue;
      plane.material = entry.material;
      try {
        await renderer.renderAsync(scene, camera);
      } catch {
        renderer.render(scene, camera);
      }
      const ctx = entry.targetCanvas.getContext('2d');
      if (ctx && renderer.domElement) {
        ctx.drawImage(renderer.domElement, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
      }
    }
    animFrameId = requestAnimationFrame(tick);
  };
  animFrameId = requestAnimationFrame(tick);
}

export function dispose(nodeId: string): void {
  const entry = nodeEntries.get(nodeId);
  if (entry) {
    entry.material.dispose();
    nodeEntries.delete(nodeId);
  }
  animatedNodes.delete(nodeId);
  if (animatedNodes.size === 0 && animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}
