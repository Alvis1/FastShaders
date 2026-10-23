import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VR_HEADSETS, deviceCostOverrides } from '@/store/useAppStore';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { groupFrameSize } from '@/utils/groupFrame';
import { setCostOverrides } from '@/utils/nodeCost';
import { POINT_BUDGET, toBudgetPoints } from '@/utils/budgetPoints';
import {
  BUDGET_OUTPUT,
  BUDGET_TEXTURE,
  budgetFrame,
  budgetGraph,
  buildBudgetTour,
  drawnMembers,
} from './budgetTour';
import { connectionEnd } from './sceneGraph';

const asset = () => getBuiltinTextures().find((t) => t.id === BUDGET_TEXTURE)!;
const geo = { from: { x: 300, y: 190 }, to: { x: 404, y: 180 }, total: { x: 420, y: 60 } };

describe('intro scene 3: wire a texture group in, the total passes the budget', () => {
  // isolate: false shares the price table with the next file: never leave a
  // device's prices applied.
  afterEach(() => setCostOverrides(null));

  it('stages the real built-in, wiring its LAST node (the one its return names) into Color', () => {
    const g = budgetGraph(asset())!;
    expect(g).not.toBeNull();
    expect(g.frame.type).toBe('group');
    expect(g.wire).toMatchObject({ target: BUDGET_OUTPUT, targetHandle: 'color' });
    expect(asset().outputEdges.some((e) => e.source === g.wire.source && e.targetHandle === 'color')).toBe(true);
  });

  it('costs nothing unwired, and more than the device’s budget once wired, on every built-in device — what the scene exists to show', () => {
    // computeReachableCost is the bar's own sum, under the selected device's
    // price table, and the bar prints it as a share of that device's budget,
    // which reads 100 on every device. The scene shows the user's OWN device,
    // so it has to pass on each one; if the texture ever got cheaper than a
    // budget, the scene would show it under and this fails.
    for (const h of VR_HEADSETS) {
      setCostOverrides(deviceCostOverrides(h.id, []));
      const g = budgetGraph(asset())!;
      expect(g.before, h.id).toBe(0);
      expect(g.after, h.id).toBeGreaterThan(h.maxPoints);
      expect(toBudgetPoints(g.after, h.maxPoints), h.id).toBeGreaterThan(POINT_BUDGET);
    }
  });

  it('draws only the group’s right end, the last node included, and the sources of its wires', () => {
    const g = budgetGraph(asset())!;
    const frameAt = { x: 334 - groupFrameSize(g.frame).w, y: 118 };
    const drawn = drawnMembers(g, frameAt, 560, 300);
    const ids = new Set(drawn.map((n) => n.id));
    expect(ids.has(g.wire.source)).toBe(true);
    expect(drawn.length).toBeLessThan(g.members.length / 2);
    // A wire arriving at a member on stage enters from wherever its source is.
    const onStage = drawn.filter((n) => frameAt.x + n.position.x > 0 && frameAt.y + n.position.y < 300);
    expect(onStage.length).toBeGreaterThan(2);
    for (const n of onStage) {
      for (const e of g.edges) if (e.target === n.id) expect(ids.has(e.source)).toBe(true);
    }
  });

  it('plays press → drag → release (connected) → pointer on the total, in that order', () => {
    const tour = buildBudgetTour(geo);
    const seen: string[] = [];
    for (let t = 0; t < tour.tl.total; t += 5) {
      const { state, cursor } = budgetFrame(tour, t);
      const tag = state.connected
        ? cursor.x === geo.total.x && cursor.y === geo.total.y ? 'total' : 'connected'
        : state.dragging ? 'drag' : state.pressed ? 'press' : 'idle';
      if (seen[seen.length - 1] !== tag) seen.push(tag);
    }
    expect(seen.slice(0, 6)).toEqual(['idle', 'press', 'drag', 'connected', 'total', 'connected']);
  });

  it('its still is wired, with the pointer on the total', () => {
    const tour = buildBudgetTour(geo);
    const f = budgetFrame(tour, tour.still);
    expect(f.state.connected).toBe(true);
    expect(f.cursor).toEqual(geo.total);
  });

  it('the dragged line snaps to the socket inside the canvas’s connection radius', () => {
    expect(connectionEnd({ x: 0, y: 0 }, { x: 100, y: 0 }, 40)).toEqual({ x: 0, y: 0 });
    expect(connectionEnd({ x: 70, y: 0 }, { x: 100, y: 0 }, 40)).toEqual({ x: 100, y: 0 });
  });

  it('loads the library on demand, never statically — the intro opens at boot', () => {
    const src = readFileSync(path.join(__dirname, 'BudgetScene.tsx'), 'utf8');
    expect(src).toContain("import('@/registry/builtinTextures')");
    expect(src).not.toMatch(/^import [^;]*from '@\/registry\/builtin(Textures|Presets)'/m);
    expect(src).not.toMatch(/setNodes|setEdges|pushHistory|addNode\(/);
  });
});
