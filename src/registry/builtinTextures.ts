/**
 * Built-in texture definitions for the Textures category in the content browser.
 *
 * Each texture is defined as TSL code that gets parsed into a node graph via
 * codeToGraph on first use, then wrapped in a group container so it can be
 * dragged onto the canvas like a saved group.
 *
 * Loaded ON DEMAND by every app surface (`import()` in the content browser and
 * the store): a static import from the boot path puts Babel on the entry wave.
 */

import { buildCodeGroup, type CodeGroupAsset, type CodeGroupEntry } from '@/registry/codeGroupBuilder';

export type BuiltinTexture = CodeGroupAsset;

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

// ── LED Display ─────────────────────────────────────────────────────────────
// A display seen up close: every display pixel is three emitters — R and G side
// by side, B centred beneath them — on a dark board, and the picture is MADE of
// them: each emitter shines with its own channel of the picture, nothing more.
// The emitters are round in UV space, so they are round on the Plane and ovals
// on the default Sphere, whose UV is stretched about twice as wide as it is tall
// (the description sends the user to the Plane, as the Circle preset's does).
// The only texture here that is a FILTER over a swappable picture rather than a
// pattern of its own, which is why it lives in UV space (an Image node samples
// by UV) and not in positionGeometry like most of its neighbours.
//
// Seven things are load-bearing (ledDisplayTexture.test.ts pins each):
//
//  - THE GRID IS A WHOLE NUMBER: floor(diodeScale + 0.5), then max(…, 1). The
//    Uniforms slider moves in steps of 0.4, and a fractional grid ends in a
//    partial column — a seam of cut emitters where the UV wraps round a sphere,
//    and a last cell whose centre lies past u = 1, where a repeating image
//    shows its OPPOSITE edge. floor(+0.5), not round(): round() breaks .5 ties
//    half-to-even on WGSL and away from zero on GLSL, so a tuned 40.5 drew 40
//    columns in the WebGPU preview and 41 in WebGL2 (Safari, the VR popup).
//    The max is the scrub-to-zero guard: the slider starts at 0, and a zero
//    grid would divide by zero (at 0 the surface shows one giant pixel).
//  - THE HAND-OFF. `floor` picks the display pixel, `+ 0.5` moves to its
//    centre, and the ONE Divide turns that back into ordinary 0-1 UV. That wire
//    feeds the picture source, so the source is sampled once per display pixel
//    and every emitter is lit evenly: the noise today, an Image node's UV
//    socket when the user wants a picture. The centre, not the corner: a corner
//    sample sits exactly on u = 0 for the first column, where a repeating,
//    linearly filtered image blends its two opposite edges.
//  - LINEAR DRIVE. Light out = the emitter's own channel × a fixed disc ×
//    diodeBrightness (1), so a dim channel is a dim emitter and a deep blue area
//    lights only its blue ones — which is all it takes for the diodes to
//    REPRODUCE the picture rather than sit on top of it. The first version
//    over-drove a squared dome ×8 and let the display clip it: every emitter
//    over about an eighth looked fully lit on an unlit surface (and from about
//    0.4 on Color, sooner on a sphere's lit side), a blue sky lit its green
//    emitters almost fully and read cyan, and the picture showed mainly as dot
//    size — an RGB pattern laid over the image, as the owner put it. Against a
//    photo, per display pixel, as each version was meant to be wired (v1 on
//    Color, this one as below): hue error 6.8° → 3.4°, tone correlation
//    0.952 → 0.991.
//  - THE EMITTED LIGHT IS THE ONLY LIGHT. A screen makes its own light, so the
//    group ends in TWO nodes: the diodes, for the Output's Emissive, and
//    `board`, a black Color for its Color — the description names both wires.
//    Both are needed. With Color left unwired, loader 0.8 copies the emission
//    into the base colour and the scene lights it too: ×1.4 on the lit Plane,
//    ×1.9 on a sphere's key side, so every channel over about 0.7 clipped (the
//    over-drive again, milder). With Color still wired to an older graph (the
//    boot demo), that material stayed under the diodes — the overlay itself.
//    On Color alone the scene lights the diodes like paint, about half as
//    bright and dark on the shaded side.
//  - A COLOUR PICTURE BY DEFAULT. mx_noise_vec3 gives three independent
//    channels, so neighbouring areas light different emitters and the diodes
//    are seen making the colours. The first version's grey cell noise lit all
//    three emitters of every pixel equally, which reads as the same overlay.
//    max(·, 0) keeps the noise's negative half dark (abs() folded it back and
//    lit all three in most pixels — a busy RGB carpet), and it is the identity
//    on an image, which is 0-1: nothing between the source and the drive may
//    assume the source is a noise. It is also the price: 68 of the 94 points,
//    against 5-10 for an Image in its place.
//  - BINARY ARITHMETIC ONLY. A three-operand Multiply is priced base x (N - 1)
//    by the CostBar and 1 by the tile badge, so the tile would print less than
//    the graph costs.
//  - THE IMAGE SWAP IS TWO GESTURES, never a hunt for a socket. An Image node
//    shows no input sockets at rest, so "wire Divide into its UV" was the step
//    users missed — and an image sampled at its own uv() shows its detail
//    inside every emitter, the overlay again. Deleting the noise bridges its
//    input to its reader (bridgeEdgesAcrossDeletedNodes), and a node dropped
//    on a wire is spliced in at its FIRST input (pickSpliceInputPort) — for an
//    Image that is UV, with Color out — so Divide → UV and Color → max. DELETE
//    FIRST, as the note says: the wire it leaves runs across the frame, clear
//    of the others. The wire INTO the noise is short and crossed by the
//    emitter wires, and a drop aimed at it caught one of those.
//
// The emitter maths runs in units of the emitter's own radius: the cell is 4.4
// wide, so the centres sit at 1.1 / 3.3 / 2.2 and `1 - distance²` reaches zero
// exactly at the rim; ×4 and a clamp make it a flat disc (radius 0.87) with a
// soft rim, so an emitter is evenly lit, as a real one is. 4.4 rather than 4
// leaves a strip of bare board round every emitter — they read as separate
// lamps, and it keeps them off the cell border, where an Image shows a
// one-pixel seam (the cell-centre UV jumps there, so the sampler picks a
// blurrier mip level). The seam is fainter for it, not gone. All three channels
// are done in one node each: emitterX / emitterY hold one centre per colour, so
// every Subtract, Multiply and Clamp below them is a vec3.
//
// LIMIT: an emitter needs a few screen pixels. In the default-size preview a
// display pixel is ~5 px at 40 and ~2.7 px at 80 (the slider's top), where the
// emitters alias into bands and swirls that have nothing to do with the picture.
// Real displays blend into the picture at a distance; this needs derivatives to
// fade to the cell average, and the registry has no such node.
const LED_DISPLAY_CODE = `import { add, clamp, color, div, floor, Fn, fract, max, mul, mx_noise_vec3, oneMinus, sub, uniform, uv, vec3 } from "three/tsl";

const shader = Fn(() => {
  const diodeScale = uniform(40);
  const diodeBrightness = uniform(1);
  const u = uv();

  const nearest = add(diodeScale, 0.5);
  const whole = floor(nearest);
  const grid = max(whole, 1);
  const cell = mul(u, grid);
  const corner = floor(cell);
  const centre = add(corner, 0.5);
  const cellUV = div(centre, grid);

  const noise = mx_noise_vec3(cellUV.mul(3));
  const picture = max(noise, 0);

  const inCell = fract(cell);
  const q = mul(inCell, 4.4);
  const emitterX = vec3(1.1, 3.3, 2.2);
  const emitterY = vec3(3.3, 3.3, 1.1);
  const dx = sub(emitterX, q.x);
  const dy = sub(emitterY, q.y);
  const dx2 = mul(dx, dx);
  const dy2 = mul(dy, dy);
  const d2 = add(dx2, dy2);
  const dome = oneMinus(d2);
  const edge = mul(dome, 4);
  const disc = clamp(edge, 0, 1);
  const lit = mul(picture, disc);
  const result = mul(lit, diodeBrightness);

  const board = color(0x000000);
  return { color: board, emissive: result };
});
export default shader;`;

const TEXTURE_ENTRIES: CodeGroupEntry[] = [
  { id: 'polka-dots', name: 'Polka Dots', color: '#3949AB', code: POLKA_DOTS_CODE,
    description: 'A repeating lattice of soft-edged dots — adjustable scale, size and blur.' },
  { id: 'grid', name: 'Grid', color: '#546E7A', code: GRID_CODE, titleSize: 2,
    description: 'Graph-paper grid of thin dark lines on a light background.' },
  { id: 'tiger-fur', name: 'Tiger Fur', color: '#F57C00', code: TIGER_FUR_CODE,
    description: 'Orange fur with noise-broken dark stripes, fading to a pale belly.' },
  { id: 'static-noise', name: 'Static Noise', color: '#757575', code: STATIC_NOISE_CODE,
    description: 'Fine grayscale noise, like analogue TV static.' },
  { id: 'crumpled-fabric', name: 'Crumpled Fabric', color: '#26A69A', code: CRUMPLED_FABRIC_CODE,
    description: 'Crinkled cloth-like color pattern — domain-warped noise blending pale cyan, indigo and deep green.' },
  { id: 'gas-giant', name: 'Gas Giant', color: '#AB47BC', code: GAS_GIANT_CODE,
    description: 'Banded planet atmosphere with turbulent storm swirls, Jupiter-style.' },
  { id: 'marble', name: 'Marble', color: '#5C6BC0', code: MARBLE_CODE,
    description: 'Pale stone run through with sharp noise-driven veins.' },
  { id: 'wood', name: 'Wood', color: '#8D6E63', code: WOOD_CODE, titleSize: 2,
    description: 'Concentric growth rings warped by noise, in warm timber tones.' },
  // The one texture that pins a note: its picture source is meant to be
  // swapped, and how is not obvious from the graph alone.
  { id: 'led-display', name: 'LED Display', color: '#1E88E5', code: LED_DISPLAY_CODE,
    description: 'An LED screen seen up close: each pixel is three diodes, red, green and blue, each lit by only its own color of the picture. Wire the black Color node into the Output node\'s Color and the last Multiply into its Emissive (right-click the Output and tick Emissive): the board stays dark and the diodes make their own light. diodeScale sets how many pixels fit across; the note in the frame says how to show a picture. Switch the preview Model to Plane to see the diodes round; the sphere stretches UV twice as wide as it is tall, so there they are ovals.',
    note: {
      heading: 'Swap Noise for an Image',
      text: 'To show a picture: drop it on the canvas, delete the noise node, then drag the new Image node over the wire that is left until the wire lights up. Divide feeds it each pixel\'s center UV.',
    } },
];

/**
 * Parse each texture's TSL code into nodes/edges, wrap in a group container,
 * and apply auto-layout. Built by the FIRST call and cached; this module is
 * loaded on demand, never at boot.
 */
let _cachedTextures: BuiltinTexture[] | null = null;

/**
 * The texture ids, WITHOUT building the textures. The list itself lives in the
 * Babel-free leaf `builtinTextureIds.ts` and is re-exported here, so whoever
 * already holds this module keeps its one import. Anything on the BOOT path
 * (the content browser's module scope) imports the leaf: importing this module
 * statically pulls `codeGroupBuilder` → `codeToGraph` → @babel/* into the
 * entry wave.
 */
export { getBuiltinTextureIds } from './builtinTextureIds';

export function getBuiltinTextures(): BuiltinTexture[] {
  if (_cachedTextures) return _cachedTextures;
  _cachedTextures = TEXTURE_ENTRIES.map((entry) => buildCodeGroup(entry, 'builtin-texture-'));
  return _cachedTextures;
}
