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
import { NODE_REGISTRY } from '@/registry/nodeRegistry';

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

// ── Polka Dots ──────────────────────────────────────────────────────────────
// 3D polka dots: tile 3D space into cells, place a sphere at each cell center.
// Uses fract() for repeating lattice and 3D distance-to-center per cell.
// Every call is fully flattened (no nested calls) for codeToGraph compatibility.
const POLKA_DOTS_CODE = `import { add, color, exp, Fn, fract, mix, mul, positionGeometry, smoothstep, sqrt, sub, uniform } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(3);
  const size = uniform(0.5);
  const blur = uniform(0.25);
  const pos = positionGeometry;

  const sPos = mul(pos, scale);

  const fractX = fract(sPos.x);
  const fx = sub(fractX, 0.5);
  const fractY = fract(sPos.y);
  const fy = sub(fractY, 0.5);
  const fractZ = fract(sPos.z);
  const fz = sub(fractZ, 0.5);

  const dxSq = mul(fx, fx);
  const dySq = mul(fy, fy);
  const dzSq = mul(fz, fz);
  const dXY = add(dxSq, dySq);
  const distSq = add(dXY, dzSq);
  const dist = sqrt(distSq);

  const sizeMul5 = mul(size, 5);
  const sizeShifted = sub(sizeMul5, 5);
  const xsize = exp(sizeShifted);
  const blur2 = mul(blur, blur);
  const xblur = mul(blur2, blur2);
  const lo = sub(xsize, xblur);
  const hi = add(xsize, xblur);
  const k = smoothstep(lo, hi, dist);

  const dotColor = color(0x262680);
  const bgColor = color(0xFFF7EB);
  const result = mix(dotColor, bgColor, k);
  return result;
});
export default shader;`;

// ── Grid ────────────────────────────────────────────────────────────────────
// 3-axis grid: distance-to-nearest-line on XY, XZ, and YZ planes combined.
const GRID_CODE = `import { abs, add, color, Fn, min, mix, mul, positionGeometry, round, smoothstep, sub, uniform } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(1);
  const count = uniform(8);
  const thickness = uniform(0.05);
  const pos = positionGeometry;

  const sPos = mul(pos, scale);
  const gx = mul(sPos.x, count);
  const gy = mul(sPos.y, count);
  const gz = mul(sPos.z, count);

  const nearX = round(gx);
  const nearY = round(gy);
  const nearZ = round(gz);
  const diffX = sub(gx, nearX);
  const diffY = sub(gy, nearY);
  const diffZ = sub(gz, nearZ);
  const distX = abs(diffX);
  const distY = abs(diffY);
  const distZ = abs(diffZ);

  const dXY = min(distX, distY);
  const d = min(dXY, distZ);

  const hi = add(thickness, 0.01);
  const k = smoothstep(thickness, hi, d);

  const lineColor = color(0x1A1A1A);
  const bgColor = color(0xF2F2F2);
  const result = mix(lineColor, bgColor, k);
  return result;
});
export default shader;`;

// ── Tiger Fur ───────────────────────────────────────────────────────────────
const TIGER_FUR_CODE = `import { add, color, div, exp, Fn, mix, mul, mx_noise_float, oneMinus, positionGeometry, smoothstep, sub, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(2);
  const lengths = uniform(4);
  const blur = uniform(0.3);
  const strength = uniform(0.3);
  const pos = positionGeometry;

  const halfScale = div(scale, 2);
  const xscale = add(halfScale, 1);
  const eScale = exp(xscale);
  const sX = mul(pos.x, eScale);
  const sY = mul(pos.y, eScale);
  const sZ = mul(pos.z, eScale);

  const lenDenom = add(lengths, 5);
  const lenInv = div(1, lenDenom);
  const stripeX = mul(sX, xscale);
  const stripeY = mul(sY, lenInv);
  const stripeZ = mul(sZ, lenInv);
  const stripePos = vec3(stripeX, stripeY, stripeZ);
  const stripeNoise = mx_noise_float(stripePos);

  const stripeShift = sub(strength, 0.5);
  const k = add(stripeNoise, stripeShift);
  const negBlur = mul(blur, -1);
  const stripes = smoothstep(negBlur, blur, k);
  const pattern = oneMinus(stripes);

  const bellyT = smoothstep(-1, 0.5, pos.y);

  const furColor = color(0xFFAB00);
  const bellyColor = color(0xFFFFED);
  const baseColor = mix(bellyColor, furColor, bellyT);
  const result = mul(baseColor, pattern);
  return result;
});
export default shader;`;

// ── Static Noise ────────────────────────────────────────────────────────────
// Screen-space animated static (TV snow). Uses screenUV for pixel-fixed noise
// and round(time*speed) for frame-quantized flickering.
const STATIC_NOISE_CODE = `import { add, Fn, mul, mx_noise_float, round, screenUV, sin, time, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(80);
  const speed = uniform(30);
  const uv = screenUV;
  const t = time;

  const uvX = mul(uv.x, scale);
  const uvY = mul(uv.y, scale);

  const tScaled = mul(t, speed);
  const tRound = round(tScaled);
  const tSin = sin(tRound);
  const offset = mul(tSin, 1000);

  const nPos = vec3(uvX, uvY, offset);
  const k = mx_noise_float(nPos);

  const kHalf = mul(k, 0.5);
  const kNorm = add(kHalf, 0.5);
  const result = vec3(kNorm, kNorm, kNorm);
  return result;
});
export default shader;`;

// ── Crumpled Fabric ─────────────────────────────────────────────────────────
// Port of boytchev/tsl-textures crumpled-fabric: 4-iteration domain-warped
// noise where each iteration samples three noise channels on swizzled
// (xyz, yzx, zxy) positions and displaces the sample point by the resulting
// vector. The final noise value is blended between main/sub/background colors.
// Output is a vec3 color (connect to the Color channel of the Output node).
const CRUMPLED_FABRIC_CODE = `import { abs, add, clamp, color, div, exp, Fn, mul, mx_noise_float, oneMinus, positionGeometry, pow, sub, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(2);
  const pinch = uniform(0.5);
  const mainColor = color(0xB0F0FF);
  const subColor = color(0x4040F0);
  const bgColor = color(0x003000);
  const pos = positionGeometry;

  const scaleSub = sub(scale, 0.5);
  const eScale = exp(scaleSub);
  const pos0 = mul(pos, eScale);

  const x1 = mx_noise_float(pos0);
  const s1a = vec3(pos0.y, pos0.z, pos0.x);
  const y1 = mx_noise_float(s1a);
  const s1b = vec3(pos0.z, pos0.x, pos0.y);
  const z1 = mx_noise_float(s1b);
  const warp1 = vec3(x1, y1, z1);
  const warpS1 = mul(warp1, pinch);
  const pos1 = add(pos0, warpS1);

  const x2 = mx_noise_float(pos1);
  const s2a = vec3(pos1.y, pos1.z, pos1.x);
  const y2 = mx_noise_float(s2a);
  const s2b = vec3(pos1.z, pos1.x, pos1.y);
  const z2 = mx_noise_float(s2b);
  const warp2 = vec3(x2, y2, z2);
  const warpS2 = mul(warp2, pinch);
  const pos2 = add(pos1, warpS2);

  const x3 = mx_noise_float(pos2);
  const s3a = vec3(pos2.y, pos2.z, pos2.x);
  const y3 = mx_noise_float(s3a);
  const s3b = vec3(pos2.z, pos2.x, pos2.y);
  const z3 = mx_noise_float(s3b);
  const warp3 = vec3(x3, y3, z3);
  const warpS3 = mul(warp3, pinch);
  const pos3 = add(pos2, warpS3);

  const x4 = mx_noise_float(pos3);
  const s4a = vec3(pos3.y, pos3.z, pos3.x);
  const y4 = mx_noise_float(s4a);
  const s4b = vec3(pos3.z, pos3.x, pos3.y);
  const z4 = mx_noise_float(s4b);
  const warp4 = vec3(x4, y4, z4);
  const warpS4 = mul(warp4, pinch);
  const pos4 = add(pos3, warpS4);

  const nFinal = mx_noise_float(pos4);
  const nShift = add(nFinal, 1);
  const nHalf = div(nShift, 2);
  const k = clamp(nHalf, 0, 1);

  const k2 = mul(k, 2);
  const k2m1 = sub(k2, 1);
  const ak = abs(k2m1);
  const w1 = oneMinus(ak);
  const color1 = mul(mainColor, w1);

  const kSq = pow(k, 2);
  const color2 = mul(subColor, kSq);

  const kInv = oneMinus(k);
  const kInvSq = pow(kInv, 2);
  const color3 = mul(bgColor, kInvSq);

  const sum12 = add(color1, color2);
  const result = add(sum12, color3);
  return result;
});
export default shader;`;

// ── Gas Giant ───────────────────────────────────────────────────────────────
// Jupiter-like horizontal bands with multi-scale noise distortion.
// Three noise octaves distort the band y-coordinate; two overlapping cosine
// patterns with different frequencies create the banding; three colors mix.
const GAS_GIANT_CODE = `import { abs, add, color, div, exp, Fn, mix, mul, mx_noise_float, oneMinus, positionGeometry, pow, smoothstep, sub, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(2);
  const turbulence = uniform(0.3);
  const blur = uniform(0.6);
  const pos = positionGeometry;

  const halfScale = div(scale, 2);
  const xscale = add(halfScale, 1);
  const eScale = exp(xscale);
  const sPos = mul(pos, eScale);

  const yHalf = mul(pos.y, 0.5);
  const yp1 = vec3(0, yHalf, 0);
  const yt1 = mx_noise_float(yp1);
  const yp2 = vec3(0, pos.y, 0);
  const yt2r = mx_noise_float(yp2);
  const yt2 = mul(yt2r, 0.5);
  const yDbl = mul(pos.y, 2);
  const yp3 = vec3(1, yDbl, 1);
  const yt3r = mx_noise_float(yp3);
  const yt3 = mul(yt3r, 0.25);
  const ytS12 = add(yt1, yt2);
  const ytAll = add(ytS12, yt3);
  const turbStr = mul(ytAll, turbulence);
  const turbAbs = abs(turbStr);
  const xturb = mul(turbAbs, 5);

  const wn1 = mx_noise_float(sPos);
  const sPosOff1 = add(sPos, 100);
  const wn2 = mx_noise_float(sPosOff1);
  const sPosOff2 = add(sPos, 200);
  const wn3 = mx_noise_float(sPosOff2);
  const warpVec = vec3(wn1, wn2, wn3);
  const warpAmt = mul(warpVec, xturb);
  const wPos = add(sPos, warpAmt);

  const wBandY = mul(wPos.y, xscale);
  const bandPos = vec3(0, wBandY, 0);
  const bandRaw = mx_noise_float(bandPos);

  const hfPos = mul(wPos, 15);
  const hfRaw = mx_noise_float(hfPos);
  const blurPow = pow(blur, 0.2);
  const blurInv = oneMinus(blurPow);
  const hfScaled = mul(hfRaw, blurInv);
  const bandTotal = add(bandRaw, hfScaled);

  const bandShifted = sub(bandTotal, 0.5);
  const bandShaped = smoothstep(-1, 1, bandShifted);
  const k = oneMinus(bandShaped);

  const yCol = mul(pos.y, 0.75);
  const yColPos = vec3(0, yCol, 0);
  const yColN = mx_noise_float(yColPos);
  const yColK = add(yColN, 1);

  const colorA = color(0xFFF8F0);
  const colorB = color(0xF0E8B0);
  const colorC = color(0xAFA0D0);

  const base = mix(colorB, colorA, yColK);
  const turbMix = mul(xturb, 0.3);
  const withStorm = mix(base, colorC, turbMix);
  const result = mul(withStorm, k);
  return result;
});
export default shader;`;

// ── Marble ──────────────────────────────────────────────────────────────────
const MARBLE_CODE = `import { abs, add, color, Fn, mix, mul, mx_noise_float, oneMinus, positionGeometry, pow, uniform } from "three/tsl";

const shader = Fn(() => {
  const scale = uniform(3);
  const sharpness = uniform(0.2);
  const detail = uniform(0.3);
  const pos = positionGeometry;

  const sPos = mul(pos, scale);

  const n1 = mx_noise_float(sPos);
  const sPos2 = mul(sPos, 2);
  const n2raw = mx_noise_float(sPos2);
  const n2 = mul(n2raw, 0.5);
  const sPos6 = mul(sPos, 6);
  const n3raw = mx_noise_float(sPos6);
  const n3 = mul(n3raw, 0.1);

  const nSum12 = add(n1, n2);
  const nSum = add(nSum12, n3);

  const nAbs = abs(nSum);
  const nPow = pow(nAbs, sharpness);
  const veins = oneMinus(nPow);

  const detailPos = mul(sPos, 50);
  const detailNoise = mx_noise_float(detailPos);
  const detailAbs = abs(detailNoise);
  const detailPow = pow(detailAbs, 3);
  const detailScaled = mul(detailPow, detail);
  const withDetail = add(veins, detailScaled);

  const veinColor = color(0x4545D3);
  const bgColor = color(0xF0F8FF);
  const result = mix(bgColor, veinColor, withDetail);
  return result;
});
export default shader;`;

// ── Wood ────────────────────────────────────────────────────────────────────
const WOOD_CODE = `import { add, color, cos, div, exp, Fn, max, mix, mul, mx_noise_float, positionGeometry, sin, sub, uniform, vec3 } from "three/tsl";

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
  const woodColor = color(0xCC6600);
  const bgColor = color(0x661A00);
  const result = mix(woodColor, bgColor, blended);
  return result;
});
export default shader;`;

interface TextureEntry {
  id: string;
  name: string;
  color: string;
  code: string;
  titleSize?: number;
}

const TEXTURE_ENTRIES: TextureEntry[] = [
  { id: 'polka-dots', name: 'Polka Dots', color: '#3949AB', code: POLKA_DOTS_CODE },
  { id: 'grid', name: 'Grid', color: '#546E7A', code: GRID_CODE, titleSize: 2 },
  { id: 'tiger-fur', name: 'Tiger Fur', color: '#F57C00', code: TIGER_FUR_CODE },
  { id: 'static-noise', name: 'Static Noise', color: '#757575', code: STATIC_NOISE_CODE },
  { id: 'crumpled-fabric', name: 'Crumpled Fabric', color: '#26A69A', code: CRUMPLED_FABRIC_CODE },
  { id: 'gas-giant', name: 'Gas Giant', color: '#AB47BC', code: GAS_GIANT_CODE },
  { id: 'marble', name: 'Marble', color: '#5C6BC0', code: MARBLE_CODE },
  { id: 'wood', name: 'Wood', color: '#8D6E63', code: WOOD_CODE, titleSize: 2 },
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

    // Auto-expose input ports that have incoming edges (mirrors useSyncEngine logic)
    for (const n of laid) {
      const def = NODE_REGISTRY.get(n.data.registryType);
      if (!def) continue;
      const usesExposedPorts = def.category === 'noise' || def.type === 'output' || def.type === 'uv';
      if (!usesExposedPorts) continue;

      const connectedPorts = new Set<string>();
      for (const e of edges) {
        if (e.target === n.id && e.targetHandle) {
          connectedPorts.add(e.targetHandle);
        }
      }
      if (connectedPorts.size > 0) {
        (n.data as Record<string, unknown>).exposedPorts = Array.from(connectedPorts);
      }
    }

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
        titleSize: entry.titleSize,
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
