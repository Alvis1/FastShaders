import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  readImagePlacement,
  placementAt,
  foldLegacyUvTransform,
  wiredPlacementSockets,
  wiredPlacementIndex,
  PLACEMENT_SOCKETS,
} from './imagePlacement';
import { readImageUvMapping, turnSignOf } from './imageUvMapping';
import { sanitizeImageNodes } from './imageNode';
import { graphToCode } from '@/engine/graphToCode';
import { parseStoredGraph, parseStoredGroupsReport } from '@/store/useAppStore';
import { getNodeValues, type AppNode } from '@/types';
import { makeNode, makeEdge } from '../test-utils';

/**
 * The placement reader and the legacy fold (utils/imagePlacement.ts). The fold
 * is checked against an INDEPENDENT model of the chain graphToCode emits —
 * written out again here, not borrowed from the module — so a slip in the
 * module's own chain (`placementAt`, which the fold's recheck trusts) cannot
 * hide behind itself. engine/imageRotation.test.ts runs the same comparison
 * through the real emitter and real three.
 */

type Values = Record<string, string | number>;
type P = [number, number];

const TAU = 2 * Math.PI;
const C = 0.5;

// ── the reference model: graphToCode's image chain, re-derived ─────────────
const snap = (x: number): number => {
  if (Math.abs(x) < 1e-12) return 0;
  const r = Math.round(x);
  if (Math.abs(x - r) < 1e-12) return r === 0 ? 0 : r;
  return x === 0 ? 0 : x;
};
const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6 ? v : d);
const numv = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
/** Rows (cos, sin), (−sin, cos): the KHR reference rotation, snapped. */
const R = (a: number): [P, P] => {
  const r = a % TAU;
  return [[snap(Math.cos(r)), snap(Math.sin(r))], [snap(-Math.sin(r)), snap(Math.cos(r))]];
};
function legacyXf(v: Values): { m: [P, P]; t: P } | null {
  const ox = fin(v.xfOffsetX, 0), oy = fin(v.xfOffsetY, 0), rot = fin(v.xfRotation, 0);
  const sx = fin(v.xfScaleX, 1), sy = fin(v.xfScaleY, 1);
  if (ox === 0 && oy === 0 && rot === 0 && sx === 1 && sy === 1) return null;
  const r = rot % TAU, c = Math.cos(r), s = Math.sin(r);
  return { m: [[snap(c * sx), snap(s * sy)], [snap(-s * sx), snap(c * sy)]], t: [snap(ox), snap(oy)] };
}
function turnOf(v: Values): number {
  const r = fin(v.rotation, 0) % TAU;
  const m = R(r);
  return m[0][0] === 1 && m[0][1] === 0 ? 0 : r;
}
function flagsOf(v: Values) {
  const gltf = v.orientation === 'gltf';
  const fx = numv(v.flipX, 0) >= 0.5;
  const fy = numv(v.flipY, 0) >= 0.5;
  // Each ticked box mirrors its axis, in either orientation; nothing else does
  // (the app's baked 1-u, removed 2026-10-08, read mirrored on every primitive).
  return { gltf, fx, fy, mx: fx, my: fy };
}
/** The whole chain at u: [xf] → mirror → tile → offset → turn about c. */
function chain(v: Values, u: P): P {
  let p: P = [u[0], u[1]];
  const xf = legacyXf(v);
  if (xf) p = [xf.m[0][0] * p[0] + xf.m[0][1] * p[1] + xf.t[0], xf.m[1][0] * p[0] + xf.m[1][1] * p[1] + xf.t[1]];
  const f = flagsOf(v);
  if (f.mx) p[0] = -p[0] + 1;
  if (f.my) p[1] = -p[1] + 1;
  p = [p[0] * numv(v.tileX, 1) + numv(v.offsetX, 0), p[1] * numv(v.tileY, 1) + numv(v.offsetY, 0)];
  const th = turnOf(v);
  if (th === 0) return p;
  // ψ = θ·(exactly one Flip ticked ? −1 : 1): three.js's and glTF's sense.
  const M = R(th * (f.fx !== f.fy ? -1 : 1));
  const b: P = [snap(C - (M[0][0] * C + M[0][1] * C)), snap(C - (M[1][0] * C + M[1][1] * C))];
  return [M[0][0] * p[0] + M[0][1] * p[1] + b[0], M[1][0] * p[0] + M[1][1] * p[1] + b[1]];
}

/** mulberry32: a seeded generator, so a failure names a reproducible case. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const XF_KEYS = ['xfOffsetX', 'xfOffsetY', 'xfRotation', 'xfScaleX', 'xfScaleY'];
const close = (a: P, b: P, tol: number) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

describe('readImagePlacement: the one read of the flags, the stored numbers and the turn', () => {
  it('an untouched node: app orientation, NOTHING mirrored, no turn', () => {
    // No baked 1-u: a dropped picture samples as stored, which reads the right
    // way round on three's primitives (u right, v up).
    const p = readImagePlacement({});
    expect(p).toEqual({
      gltf: false, flipX: false, flipY: false, mirrorX: false, mirrorY: false,
      tileX: 1, tileY: 1, offsetX: 0, offsetY: 0, theta: 0, turnSign: 1, psi: 0, xf: null,
    });
  });

  it('each ticked box mirrors its axis in both orientations, and the turn\'s sign is the flip parity alone', () => {
    for (const gltf of [false, true]) {
      for (const fx of [0, 1]) {
        for (const fy of [0, 1]) {
          const p = readImagePlacement({ ...(gltf ? { orientation: 'gltf' } : {}), flipX: fx, flipY: fy, rotation: 0.5 });
          expect(p.mirrorX).toBe(fx === 1);
          expect(p.mirrorY).toBe(fy === 1);
          const sign = fx !== fy ? -1 : 1;
          expect(p.turnSign).toBe(sign);
          expect(p.turnSign).toBe(turnSignOf(fx === 1, fy === 1));
          // The sign IS the mirror's determinant, which is what it cancels.
          expect(p.turnSign).toBe((p.mirrorX ? -1 : 1) * (p.mirrorY ? -1 : 1));
          expect(p.psi).toBe(0.5 * sign);
        }
      }
    }
  });

  it('reads the flags and the stored numbers the way the emitter does', () => {
    // `Number()` semantics, minus the throw: '1' and true tick, a non-finite
    // number is the default, '' is 0 (exactly what the emitter's `num(Number())` wrote).
    const p = readImagePlacement({ flipX: '1', flipY: true as unknown as number, tileX: '2', tileY: '', offsetX: Infinity, offsetY: 'x' });
    expect([p.flipX, p.flipY]).toEqual([true, true]);
    expect([p.tileX, p.tileY, p.offsetX, p.offsetY]).toEqual([2, 0, 0, 0]);
    expect(readImagePlacement({ flipX: 0.49 }).flipX).toBe(false);
    expect(readImagePlacement({ flipX: 0.5 }).flipX).toBe(true);
    expect(readImagePlacement({ flipX: Infinity }).flipX).toBe(false);
  });

  it('survives every hostile value without throwing, reading it as the default', () => {
    const hostile: unknown[] = [
      { toString: 1 }, Symbol('s'), { valueOf: () => { throw new Error('x'); } }, NaN, 2e6, '1', true, null, [],
    ];
    const keys = ['flipX', 'flipY', 'tileX', 'tileY', 'offsetX', 'offsetY', 'rotation', 'orientation', ...XF_KEYS];
    for (const key of keys) {
      for (const v of hostile) {
        expect(() => readImagePlacement({ [key]: v } as Record<string, unknown>), `${key} ${typeof v}`).not.toThrow();
      }
    }
    const p = readImagePlacement({ rotation: { toString: 1 }, tileX: Symbol('t'), flipX: { toString: 1 } } as Record<string, unknown>);
    expect([p.theta, p.psi, p.tileX, p.flipX]).toEqual([0, 0, 1, false]);
    expect(readImagePlacement({ rotation: 2e6 }).theta).toBe(0);
    expect(readImagePlacement({ rotation: '1' } as Record<string, unknown>).theta).toBe(0);
    for (const bad of [5, null, undefined, 'x']) {
      expect(() => readImagePlacement(bad as unknown as Record<string, unknown>)).not.toThrow();
    }
  });

  it('never yields −0 for an unturned node, whatever its sign', () => {
    expect(Object.is(readImagePlacement({ orientation: 'gltf', flipX: 1 }).psi, 0)).toBe(true);
    expect(Object.is(readImagePlacement({ orientation: 'gltf', rotation: TAU }).psi, 0)).toBe(true);
  });

  it('placementAt is the reference chain', () => {
    const rnd = prng(7);
    for (let i = 0; i < 2000; i++) {
      const v: Values = {
        ...(rnd() < 0.5 ? { orientation: 'gltf' } : {}),
        flipX: rnd() < 0.5 ? 1 : 0, flipY: rnd() < 0.5 ? 1 : 0,
        tileX: rnd() * 8 - 4, tileY: rnd() * 8 - 4, offsetX: rnd() * 4 - 2, offsetY: rnd() * 4 - 2,
        rotation: rnd() * 14 - 7, xfRotation: rnd() < 0.5 ? 0 : rnd() * 14 - 7, xfScaleX: rnd() * 6 - 3,
      };
      const u: P = [rnd() * 5 - 2, rnd() * 5 - 2];
      expect(close(placementAt(readImagePlacement(v), u[0], u[1]), chain(v, u), 1e-12), JSON.stringify(v)).toBe(true);
    }
  });
});

describe('foldLegacyUvTransform: exact, or not at all', () => {
  it('the spec\'s example 1 as legacy keys: Tile 2×1, Offset (0.303590, 0.040192), Rotation +30°', () => {
    const v: Values = { orientation: 'gltf', xfRotation: Math.PI / 6, xfScaleX: 2, xfOffsetX: 0.1, xfOffsetY: 0.2 };
    const f = foldLegacyUvTransform(v, false);
    expect(f).not.toBe(v);
    for (const k of XF_KEYS) expect(f, k).not.toHaveProperty(k);
    expect(f.orientation).toBe('gltf');
    expect([f.tileX, f.tileY]).toEqual([2, 1]);
    expect(f.offsetX as number).toBeCloseTo(0.30359, 5);
    expect(f.offsetY as number).toBeCloseTo(0.040192, 6);
    // The file's own +30°: three.js's and glTF's sign, on an unflipped glTF node.
    expect(f.rotation as number).toBeCloseTo(Math.PI / 6, 14);
    // …which is the KHR reference transform itself: scale, rotate about the
    // origin, offset (u = (1, 0) → (1.832051, −0.8)).
    expect(chain(f, [1, 0])[0]).toBeCloseTo(1.832051, 6);
    expect(chain(f, [1, 0])[1]).toBeCloseTo(-0.8, 12);
  });

  it('the spec\'s example 2: Flip X kept, Tile 4×2, Offset (−2.264359, −0.559808), Rotation +30°', () => {
    // Under the chain without the baked 1-u: Flip X ticked now MIRRORS (it used
    // to cancel the default mirror, and the node folded to Offset (0.65,
    // 0.240192) then). Same legacy keys, the new emitter's picture, folded.
    const v: Values = {
      flipX: 1, tileX: 2, tileY: 2, offsetX: 0.3, offsetY: -0.2,
      xfRotation: Math.PI / 6, xfScaleX: 2, xfScaleY: 1, xfOffsetX: 0.1, xfOffsetY: 0.2,
    };
    const f = foldLegacyUvTransform(v, false);
    expect(f.flipX).toBe(1);
    expect([f.tileX, f.tileY]).toEqual([4, 2]);
    expect(f.offsetX as number).toBeCloseTo(-2.264359353944898, 12);
    expect(f.offsetY as number).toBeCloseTo(-0.5598076211353316, 12);
    expect(f.rotation as number).toBeCloseTo(Math.PI / 6, 14);
    // One ticked box: the chain turns by ψ = −θ, the xf's 30° seen through the mirror.
    expect(readImagePlacement(f).psi).toBeCloseTo(-Math.PI / 6, 14);
    expect(close(chain(f, [0.25, 0.75]), chain(v, [0.25, 0.75]), 1e-12)).toBe(true);
    expect(chain(v, [0.25, 0.75])[0]).toBeCloseTo(0.483975, 6);
    expect(chain(v, [0.25, 0.75])[1]).toBeCloseTo(0.999038, 6);
    // Tile 2×1 under the same 30° turn: no row holds — residue, untouched.
    const uneven = { ...v, tileY: 1 };
    expect(foldLegacyUvTransform(uneven, false)).toBe(uneven);
    // The glTF-oriented twin folds to the very same placement: the orientation
    // no longer touches the chain.
    const g = { ...v, orientation: 'gltf' };
    const gf = foldLegacyUvTransform(g, false);
    expect(gf).not.toBe(g);
    expect(close(chain(gf, [0.25, 0.75]), chain(g, [0.25, 0.75]), 1e-12)).toBe(true);
    expect({ ...gf, orientation: undefined }).toEqual({ ...f, orientation: undefined });
  });

  it('an unrotated KHR transform on an unmirrored default node keeps its exact digits', () => {
    // The BLENDER fixture's texture: what the importer wrote before this change.
    const f = foldLegacyUvTransform({ orientation: 'gltf', xfOffsetX: 0.25, xfScaleX: 2, xfScaleY: 2 }, false);
    expect(f).toEqual({ orientation: 'gltf', tileX: 2, tileY: 2, offsetX: 0.25, offsetY: 0 });
  });

  it('a half turn becomes Rotation 180° with the tiles kept, not two Flips', () => {
    const v: Values = { orientation: 'gltf', xfRotation: Math.PI, xfScaleX: 2, xfScaleY: 3 };
    const f = foldLegacyUvTransform(v, false);
    expect([f.tileX, f.tileY]).toEqual([2, 3]);
    expect(f).not.toHaveProperty('flipX');
    expect(f).not.toHaveProperty('flipY');
    expect(Math.abs(f.rotation as number)).toBeCloseTo(Math.PI, 14);
    for (const u of [[0, 0], [1, 0], [0, 1], [0.3, 0.8]] as P[]) expect(close(chain(f, u), chain(v, u), 1e-12)).toBe(true);
    // …and it is what importing the same KHR rotation writes (rotation = φ on an unflipped glTF node).
    expect(f.rotation as number).toBeCloseTo(Math.PI, 14);
  });

  it('a negative legacy scale folds to a FLIP — never a negative Tile — with the picture unchanged', () => {
    // K·(d·u + e) + o ≡ (−K)·(−d·u + 1 − e) + (o + K): the axis's box toggles,
    // the tile is |k|, the offset o + k, and θ is re-signed so ψ stays.
    expect(foldLegacyUvTransform({ orientation: 'gltf', xfScaleX: -1 }, false))
      .toEqual({ orientation: 'gltf', flipX: 1, tileX: 1, tileY: 1, offsetX: -1, offsetY: 0 });
    // App orientation: the same rule — a ticked box mirrors, whatever the
    // orientation — so (−2u + 0.25) is Flip X, tile 2 and offset 0.25 − 2.
    expect(foldLegacyUvTransform({ xfScaleX: -2, xfOffsetX: 0.25 }, false))
      .toEqual({ flipX: 1, tileX: 2, tileY: 1, offsetX: -1.75, offsetY: 0 });
    // A ticked box the fold toggles off is written as the menu writes it:
    // (u, 1 − (−3v)) is (u, 3v + 1), unmirrored.
    expect(foldLegacyUvTransform({ orientation: 'gltf', flipY: 1, xfScaleY: -3 }, false))
      .toEqual({ orientation: 'gltf', flipY: 0, tileX: 1, tileY: 3, offsetX: 0, offsetY: 1 });
    const cases: Values[] = [
      // One negative scale under an oblique turn: one box toggles, so θ changes sign.
      { orientation: 'gltf', xfRotation: 0.5, xfScaleX: -2, xfScaleY: 2, xfOffsetX: 0.1 },
      { xfRotation: 0.5, xfScaleX: -2, xfScaleY: 2, flipY: 1, tileX: 3, tileY: 3, offsetY: 0.4, rotation: 0.2 },
      // Both negative: both boxes toggle, θ keeps its sign.
      { orientation: 'gltf', xfRotation: 1.2, xfScaleX: -1.5, xfScaleY: -1.5, rotation: -0.7 },
      // A half turn of a negative scale, and a quarter turn under kx = −ky.
      { orientation: 'gltf', xfRotation: Math.PI, xfScaleX: -2, xfScaleY: 3 },
      { flipX: 1, xfRotation: Math.PI / 2, xfScaleX: 2, xfScaleY: 0.5, tileX: 2, tileY: -2 },
      // The node's OWN negative tile under a legacy transform is rewritten too.
      { orientation: 'gltf', tileX: -2, tileY: -2, xfRotation: 0.3, xfOffsetY: 0.5 },
    ];
    for (const v of cases) {
      const f = foldLegacyUvTransform(v, false);
      expect(f, JSON.stringify(v)).not.toBe(v);
      for (const k of XF_KEYS) expect(f, k).not.toHaveProperty(k);
      expect(numv(f.tileX, 1) >= 0 && numv(f.tileY, 1) >= 0, JSON.stringify(f)).toBe(true);
      const before = flagsOf(v);
      const after = flagsOf(f);
      expect(after.fx !== before.fx || after.fy !== before.fy, `a box toggled: ${JSON.stringify(v)}`).toBe(true);
      for (const u of [[0, 0], [1, 0], [0, 1], [0.3, 0.8], [-1.5, 2.5]] as P[]) {
        expect(close(chain(f, u), chain(v, u), 1e-12), `${JSON.stringify(v)} at ${u}`).toBe(true);
      }
    }
  });

  it(`agrees with today's chain on ${20_000} random legacy nodes, both orientations, every flip, an existing turn`, () => {
    const rnd = prng(0x5eed);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const r = (a: number, b: number) => a + rnd() * (b - a);
    let folded = 0;
    let residue = 0;
    let identity = 0;
    let toggled = 0;
    const bad: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const v: Values = {
        flipX: pick([0, 1, '1', 0.7]), flipY: pick([0, 1]),
        tileX: pick([1, 2, -1, 0.5, r(-4, 4)]), offsetX: pick([0, r(-2, 2)]), offsetY: pick([0, r(-2, 2)]),
        xfRotation: pick([0, Math.PI / 2, Math.PI, -Math.PI / 2, 3 * Math.PI / 2, r(-7, 7)]),
        xfScaleX: pick([1, 2, r(-3, 3)]), xfScaleY: pick([1, 2, r(-3, 3)]),
        xfOffsetX: pick([0, r(-1, 1)]), xfOffsetY: pick([0, r(-1, 1)]),
      };
      if (rnd() < 0.5) v.orientation = 'gltf';
      v.tileY = pick([v.tileX as number, -(v.tileX as number), 1, r(-4, 4)]);
      if (rnd() < 0.3) v.rotation = r(-7, 7);
      const f = foldLegacyUvTransform(v, false);
      if (!readImageUvMapping(v).transform) {
        identity++;
        if (f !== v) bad.push(`identity moved: ${JSON.stringify(v)}`);
        continue;
      }
      if (f === v) {
        residue++;
        // Every residue is a case today's GLB export already calls inexact:
        // K·D·M is not a rotation times a diagonal (its columns are not
        // orthogonal). The generator never draws an exact zero scale.
        const xf = legacyXf(v)!;
        const fl = flagsOf(v);
        const kx = numv(v.tileX, 1) * (fl.mx ? -1 : 1);
        const ky = numv(v.tileY, 1) * (fl.my ? -1 : 1);
        const a00 = kx * xf.m[0][0], a01 = kx * xf.m[0][1], a10 = ky * xf.m[1][0], a11 = ky * xf.m[1][1];
        const dot = a00 * a01 + a10 * a11;
        if (Math.abs(dot) < 1e-9 * Math.max(1, Math.abs(a00 * a01), Math.abs(a10 * a11))) bad.push(`foldable left as residue: ${JSON.stringify(v)}`);
        continue;
      }
      folded++;
      for (const k of XF_KEYS) if (k in f) bad.push(`kept ${k}: ${JSON.stringify(v)}`);
      if (f.orientation !== v.orientation) bad.push(`orientation moved: ${JSON.stringify(v)}`);
      // No tile is ever WRITTEN negative: such an axis becomes its box toggled,
      // written as the menu writes one; an untouched box keeps the file's value.
      if (!(numv(f.tileX, 1) >= 0 && numv(f.tileY, 1) >= 0)) bad.push(`negative tile written: ${JSON.stringify(f)}`);
      for (const k of ['flipX', 'flipY'] as const) {
        if (f[k] === v[k]) continue;
        toggled++;
        if (f[k] !== 0 && f[k] !== 1) bad.push(`${k} written as ${String(f[k])}: ${JSON.stringify(v)}`);
        if ((numv(f[k], 0) >= 0.5) === (numv(v[k], 0) >= 0.5)) bad.push(`${k} rewritten, not toggled: ${JSON.stringify(v)}`);
      }
      if (foldLegacyUvTransform(f, false) !== f) bad.push(`not idempotent: ${JSON.stringify(v)}`);
      const tol = 1e-8 * Math.max(1, Math.abs(numv(v.tileX, 1)), Math.abs(numv(v.tileY, 1)));
      for (let j = 0; j < 3; j++) {
        const u: P = [r(-2, 3), r(-2, 3)];
        if (!close(chain(v, u), chain(f, u), tol)) bad.push(`picture moved at ${u}: ${JSON.stringify(v)} → ${JSON.stringify(f)}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    // Not vacuous: most nodes fold, the residue path is exercised too, and so
    // are the folds that write a negative tile as a Flip.
    expect(folded).toBeGreaterThan(0.5 * (20_000 - identity));
    expect(residue).toBeGreaterThan(100);
    expect(toggled).toBeGreaterThan(1000);
  });

  describe('every blocker returns the SAME object', () => {
    const foldable: Values = { orientation: 'gltf', xfRotation: 0.3, xfScaleX: 2, xfScaleY: 2, tileX: 3, tileY: 3 };

    it('is foldable without one (the control)', () => {
      expect(foldLegacyUvTransform(foldable, false)).not.toBe(foldable);
    });

    it('a wired placement socket', () => {
      expect(foldLegacyUvTransform(foldable, true)).toBe(foldable);
    });

    it('no row: an uneven tile under an oblique turn', () => {
      const v = { ...foldable, tileY: 2 };
      expect(foldLegacyUvTransform(v, false)).toBe(v);
    });

    it('a result past 1e6', () => {
      const v = { ...foldable, tileX: 9e5, tileY: 9e5 };
      expect(foldLegacyUvTransform(v, false)).toBe(v);
    });

    it('nothing to fold: no transform, or one at the identity', () => {
      for (const v of [{}, { tileX: 2 }, { xfScaleX: 1, xfRotation: 0 }, { xfScaleX: 'x' }, { rotation: 0.5 }] as Values[]) {
        expect(foldLegacyUvTransform(v, false)).toBe(v);
      }
    });
  });
});

describe('wiredPlacementSockets: a local scan of the arriving arrays', () => {
  it('names each placement socket an edge goes into, and nothing else', () => {
    for (const socket of PLACEMENT_SOCKETS) {
      expect([...wiredPlacementSockets('img', [makeEdge('f', 'out', 'img', socket)], [])]).toEqual([socket]);
    }
    const others = [
      makeEdge('f', 'out', 'img', 'uv'), makeEdge('f', 'out', 'img', 'dir'), makeEdge('f', 'out', 'img', 'rotation'),
      makeEdge('img', 'tileX', 'f', 'a'), makeEdge('f', 'out', 'other', 'tileX'),
    ];
    expect(wiredPlacementSockets('img', others, []).size).toBe(0);
  });

  it('counts a collapsed group\'s boundary socket that stands for one', () => {
    for (const socket of PLACEMENT_SOCKETS) {
      const group = {
        id: 'g', type: 'group', position: { x: 0, y: 0 },
        data: {
          registryType: 'group', collapsed: true,
          collapsedInputs: [{ socketId: 'in-0', originalNodeId: 'img', originalHandleId: socket, dataType: 'float' }],
        },
      };
      // The edge lands on the GROUP, so only the boundary list knows.
      const edges = [makeEdge('f', 'out', 'g', 'in-0')];
      expect([...wiredPlacementSockets('img', edges, [group])]).toEqual([socket]);
    }
  });

  it('never throws on junk arrays or elements', () => {
    const junk: unknown[] = [null, 5, 'x', [], {}, { target: 'img' }, { data: null }, { data: { collapsedInputs: [null, 1, {}] } }];
    expect(wiredPlacementSockets('img', junk, junk).size).toBe(0);
    expect(wiredPlacementSockets('img', null as unknown as unknown[], 5 as unknown as unknown[]).size).toBe(0);
  });

  it('indexes the whole graph in one pass, keyed safely by ids that come from files', () => {
    const edges = [
      makeEdge('f', 'out', '__proto__', 'tileX'), makeEdge('f', 'out', 'constructor', 'offsetY'),
      makeEdge('f', 'out', 'a', 'tileY'), makeEdge('f', 'out', 'a', 'offsetX'), makeEdge('f', 'out', 'b', 'uv'),
    ];
    const index = wiredPlacementIndex(edges, []);
    expect([...index.keys()].sort()).toEqual(['__proto__', 'a', 'constructor']);
    expect([...index.get('a')!].sort()).toEqual(['offsetX', 'tileY']);
    expect(index.has('b')).toBe(false);
    expect(index.has('toString')).toBe(false);
  });
});

describe('sanitizeImageNodes runs the fold on every restore path', () => {
  const PNG = `data:image/png;base64,${btoa('abc')}`;
  const legacy = (id: string, extra: Values = {}) =>
    makeNode(id, 'imageNode', { imageB64: PNG, width: 2, height: 2, orientation: 'gltf', xfRotation: 0.3, xfScaleX: 2, xfScaleY: 2, ...extra });
  const folded = (n: AppNode) => readImageUvMapping(getNodeValues(n)).transform === null;

  it('folds, and returns the SAME array when nothing folds or changes', () => {
    const nodes = [legacy('a')];
    const r = sanitizeImageNodes(nodes, [], false);
    expect(r.nodes).not.toBe(nodes);
    expect(folded(r.nodes[0])).toBe(true);
    // Once folded, a second restore changes nothing.
    expect(sanitizeImageNodes(r.nodes, [], false).nodes).toBe(r.nodes);
    const plain = [makeNode('b', 'imageNode', { imageB64: PNG, width: 2, height: 2, rotation: 0.5 })];
    expect(sanitizeImageNodes(plain, [], false).nodes).toBe(plain);
  });

  it('a wire into Tile/Offset, direct or through a collapsed group, keeps the node as it is', () => {
    for (const socket of PLACEMENT_SOCKETS) {
      const nodes = [legacy('a'), makeNode('f', 'float', { value: 2 })];
      expect(sanitizeImageNodes(nodes, [makeEdge('f', 'out', 'a', socket)], false).nodes, socket).toBe(nodes);
      const group = {
        id: 'g', type: 'group', position: { x: 0, y: 0 },
        data: { registryType: 'group', label: 'G', collapsed: true, collapsedInputs: [{ socketId: 's', originalNodeId: 'a', originalHandleId: socket, dataType: 'float' }] },
      } as unknown as AppNode;
      const viaGroup = [...nodes, group];
      expect(sanitizeImageNodes(viaGroup, [makeEdge('f', 'out', 'g', 's')], false).nodes, socket).toBe(viaGroup);
    }
  });

  it('the fs:graph / desktop boot restore folds, and keeps a wired node as residue', () => {
    const g = parseStoredGraph({ nodes: [legacy('a'), legacy('b'), makeNode('f', 'float', { value: 2 })], edges: [makeEdge('f', 'out', 'b', 'offsetY')] })!;
    expect(folded(g.nodes.find((n) => n.id === 'a')!)).toBe(true);
    expect(folded(g.nodes.find((n) => n.id === 'b')!)).toBe(false);
  });

  it('the saved-groups restore folds on the group\'s own edges', () => {
    const r = parseStoredGroupsReport([
      { id: 'g1', name: 'one', nodes: [legacy('a'), legacy('b'), makeNode('f', 'float', { value: 2 })], edges: [makeEdge('f', 'out', 'b', 'tileX')] },
    ]);
    const nodes = r.groups[0].nodes;
    expect(folded(nodes.find((n) => n.id === 'a')!)).toBe(true);
    expect(folded(nodes.find((n) => n.id === 'b')!)).toBe(false);
  });

  it('every caller hands over the arriving edges', () => {
    // A source sweep (tsc already refuses a missing argument): the second
    // argument of every call names the edges of the graph being restored.
    const root = new URL('../', import.meta.url);
    const files = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    const calls: string[] = [];
    for (const f of files) {
      const src = readFileSync(new URL(f, root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const m of src.matchAll(/(?<!function )sanitizeImageNodes\(([^,()]+),\s*([^,()]+),/g)) calls.push(`${f}: ${m[2].trim()}`);
    }
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) expect(c).toMatch(/: (\w+\.)?\w*[eE]dges$/);
  });
});

describe('the BLENDER texture keeps its module byte for byte through the fold', () => {
  const folded = (nodes: AppNode[]) => readImageUvMapping(getNodeValues(nodes[0])).transform === null;

  it('emits uv().mul(vec2(2, 2)).add(vec2(0.25, 0)) before and after', () => {
    const PNG = `data:image/png;base64,${btoa('abc')}`;
    const nodes = [
      makeNode('img1', 'imageNode', { imageB64: PNG, width: 2, height: 2, colorSpace: 'color', orientation: 'gltf', xfOffsetX: 0.25, xfScaleX: 2, xfScaleY: 2 }),
      makeNode('out1', 'output'),
    ];
    const edges = [makeEdge('img1', 'out', 'out1', 'color')];
    const before = graphToCode(nodes, edges).code;
    const restored = sanitizeImageNodes(nodes, edges, false).nodes;
    expect(folded(restored)).toBe(true);
    expect(graphToCode(restored, edges).code).toBe(before);
    expect(before).toContain('texture(_image1_tex, uv().mul(vec2(2, 2)).add(vec2(0.25, 0))).rgb');
  });
});
