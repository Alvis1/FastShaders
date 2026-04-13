/**
 * Built-in texture definitions for the Textures category in the content browser.
 *
 * Each texture is defined as TSL code that gets parsed into a node graph via
 * codeToGraph at startup, then wrapped in a group container so it can be
 * dragged onto the canvas like a saved group.
 */

import type { AppNode, AppEdge, GroupNodeData } from '@/types';
import { codeToGraph } from '@/engine/codeToGraph';
import { autoLayout } from '@/engine/layoutEngine';
import { generateId } from '@/utils/idGenerator';

export interface BuiltinTexture {
  id: string;
  name: string;
  color: string;
  code: string;
  totalCost: number;
  nodes: AppNode[];
  edges: AppEdge[];
}

// ─── Texture TSL code definitions ───────────────────────────────────────────

const WOOD_CODE = `import { add, cos, div, exp, Fn, max, mix, mul, mx_noise_float, positionGeometry, sin, sub, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(2.5);
  const rings = uniform(4.5);
  const lengths = uniform(1);
  const angle = uniform(0);
  const fibers = uniform(0.3);
  const fibersDensity = uniform(10);
  const pos = positionGeometry;

  const angleRad = mul(angle, 0.01745329);
  const cosA = cos(angleRad);
  const sinA = sin(angleRad);

  const xCos = mul(pos.x, cosA);
  const ySin = mul(pos.y, sinA);
  const xSin = mul(pos.x, sinA);
  const yCos = mul(pos.y, cosA);
  const rotX = sub(xCos, ySin);
  const rotY = add(xSin, yCos);

  const scaleSub3 = sub(scale, 3);
  const scaleE = exp(scaleSub3);
  const safeLengths = max(lengths, 0.01);
  const invLen = div(1, safeLengths);
  const ringScaleXZ = mul(scaleE, invLen);
  const ringScaleY = mul(scaleE, 4);
  const ringPosX = mul(rotX, ringScaleXZ);
  const ringPosY = mul(rotY, ringScaleY);
  const ringPosZ = mul(pos.z, ringScaleXZ);
  const ringPos = vec3(ringPosX, ringPosY, ringPosZ);

  const rNoise = mx_noise_float(ringPos);
  const rShifted = add(rNoise, 1);
  const rMul10 = mul(rShifted, 10);
  const rBase = mul(rMul10, rings);
  const rCos1 = cos(rBase);
  const rSum = add(rBase, rCos1);
  const rCos2 = cos(rSum);
  const rNorm = add(rCos2, 1);
  const k = div(rNorm, 2);

  const scaleSub2 = sub(scale, 2);
  const fiberE = exp(scaleSub2);
  const fiberScaleY = mul(fiberE, fibersDensity);

  const f0X = mul(rotX, fiberE);
  const f0Y = mul(rotY, fiberScaleY);
  const f0Z = mul(pos.z, fiberE);
  const fPos0 = vec3(f0X, f0Y, f0Z);
  const fn0 = mx_noise_float(fPos0);
  const fw0 = mul(2, fn0);

  const f1s = mul(fiberE, 1.8);
  const f1sY = mul(fiberScaleY, 1.8);
  const f1X = mul(rotX, f1s);
  const f1Y = mul(rotY, f1sY);
  const f1Z = mul(pos.z, f1s);
  const fPos1 = vec3(f1X, f1Y, f1Z);
  const fn1 = mx_noise_float(fPos1);
  const fw1 = mul(1.2, fn1);

  const f2s = mul(fiberE, 3.24);
  const f2sY = mul(fiberScaleY, 3.24);
  const f2X = mul(rotX, f2s);
  const f2Y = mul(rotY, f2sY);
  const f2Z = mul(pos.z, f2s);
  const fPos2 = vec3(f2X, f2Y, f2Z);
  const fn2 = mx_noise_float(fPos2);
  const fw2 = mul(0.72, fn2);

  const f3s = mul(fiberE, 5.832);
  const f3sY = mul(fiberScaleY, 5.832);
  const f3X = mul(rotX, f3s);
  const f3Y = mul(rotY, f3sY);
  const f3Z = mul(pos.z, f3s);
  const fPos3 = vec3(f3X, f3Y, f3Z);
  const fn3 = mx_noise_float(fPos3);
  const fw3 = mul(0.432, fn3);

  const fAcc01 = add(fw0, fw1);
  const fAcc012 = add(fAcc01, fw2);
  const fAcc0123 = add(fAcc012, fw3);
  const fScaled = mul(fAcc0123, 11.49);
  const fSin = sin(fScaled);
  const fNorm = add(fSin, 1);
  const kk = div(fNorm, 2);

  const blended = mix(k, kk, fibers);
  const woodColor = vec3(0.8, 0.4, 0);
  const bgColor = vec3(0.4, 0.1, 0);
  const result = mix(woodColor, bgColor, blended);
  return result;
});
export default shader;`;

interface TextureEntry {
  id: string;
  name: string;
  color: string;
  code: string;
}

const TEXTURE_ENTRIES: TextureEntry[] = [
  { id: 'wood', name: 'Wood', color: '#8D6E63', code: WOOD_CODE },
];

/**
 * Parse each texture's TSL code into nodes/edges, wrap in a group container,
 * and apply auto-layout. Called once at startup.
 */
let _cachedTextures: BuiltinTexture[] | null = null;

export function getBuiltinTextures(): BuiltinTexture[] {
  if (_cachedTextures) return _cachedTextures;

  _cachedTextures = TEXTURE_ENTRIES.map((entry) => {
    const { nodes: rawNodes, edges: rawEdges } = codeToGraph(entry.code);

    // Filter out the output node — textures are sub-graphs, not full shaders
    const nodes = rawNodes.filter((n) => n.data.registryType !== 'output');
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = rawEdges.filter(
      (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
    );

    // Sum node costs
    const totalCost = nodes.reduce((sum, n) => {
      return sum + ((n.data as { cost?: number }).cost ?? 0);
    }, 0);

    // Auto-layout with tight spacing for compact groups
    const laid = autoLayout(nodes, edges, 'LR', { nodesep: 10, ranksep: 30 });

    // Compute bounding box for the group container
    const NODE_W = 160;
    const NODE_H = 80;
    const PAD = 20;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of laid) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + NODE_W);
      maxY = Math.max(maxY, n.position.y + NODE_H);
    }

    // Create group container
    const groupId = `builtin-texture-${entry.id}`;
    const groupNode: AppNode = {
      id: groupId,
      type: 'group',
      position: { x: 0, y: 0 },
      data: {
        registryType: 'group',
        label: entry.name,
        color: entry.color,
        collapsed: false,
      } as GroupNodeData,
      style: {
        width: maxX - minX + PAD * 2,
        height: maxY - minY + PAD * 2,
      },
    } as AppNode;

    // Reparent nodes into group, offset positions relative to group
    for (const n of laid) {
      n.parentId = groupId;
      n.position.x -= minX - PAD;
      n.position.y -= minY - PAD;
    }

    return {
      id: entry.id,
      name: entry.name,
      color: entry.color,
      code: entry.code,
      totalCost,
      nodes: [groupNode, ...laid],
      edges,
    };
  });

  return _cachedTextures;
}
