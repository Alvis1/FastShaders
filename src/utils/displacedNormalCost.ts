/**
 * The PRICE of normals that follow a displacement — the graph-side twin of the
 * module pass in engine/displacedNormals.ts (owner, 2026-11-10: full price).
 *
 * That pass re-runs a material's displacement chain at two more points per
 * vertex and builds a normal from the three, whenever the material is SMOOTH
 * (Faces: Smooth) and its chain READS THE POSITION. The table prices every node
 * per pixel, so the chain — already counted once by the reachable walk — costs
 * twice more, plus the fixed maths around it (`displacedNormalOverhead`). Under
 * a per-pixel table that is the honest worst case: on a light mesh (the 4.2k
 * vertex preview sphere) the real GPU cost is far smaller, on a dense model it
 * is not. A flat material, an unwired Position and a chain that reads no
 * position (a number, a uniform, a uv()-only height) cost nothing extra.
 *
 * The module pass decides on TEXT, this on the GRAPH; they agree through the
 * root set below — the four position reads the pass re-binds (`REBOUND`) —
 * and through `implicitRootOf`, the one rule for which root an unwired noise
 * reads. They can still differ on a chain the text pass cannot trace (one
 * reaching a multi-line imperative block): there this prices a recompute that
 * the module falls back from. Fresnel reads the world position INSIDE its
 * module helper, where the text pass cannot re-bind it, so it is not a reader.
 */
import type { AppEdge, AppNode, MaterialSettings } from '@/types';
import { getNodeValues } from '@/types';
import { getCost } from '@/utils/costTable';
import { closure, implicitRootOf } from '@/utils/sdfPartition';

/** The material menu's Faces tooltip — an i18n KEY (lv.json carries its Latvian). */
export const FACES_HINT_KEY =
  "Smooth: the light blends across neighbouring faces. While Position is wired, the normals follow the displaced shape, which runs the displacement three times per vertex and is counted in the points. Flat: every triangle is lit on its own, which follows any displacement at no extra cost.";

/** The position reads engine/displacedNormals.ts re-evaluates. */
export const DISPLACED_NORMAL_ROOTS: ReadonlySet<string> = new Set([
  'positionGeometry', 'positionLocal', 'positionWorld', 'positionView',
]);

const TOKEN = /(?<![\w$.])(?:positionGeometry|positionLocal|positionWorld|positionView)(?![\w$])/;

/**
 * The fixed maths of one recompute, in TABLE points under the ACTIVE table:
 * the tangent frame (two crosses, one normalize, the up-vector choice), the
 * two stepped points, the two extra displaced points (a mul and an add each),
 * the two edges and the final cross + normalize. 45 under the authored table.
 */
export function displacedNormalOverhead(): number {
  return 3 * getCost('cross') + 2 * getCost('normalize')
    + getCost('abs') + getCost('greaterThan') + getCost('select')
    + 4 * getCost('mul') + 4 * getCost('add') + 2 * getCost('sub');
}

/** Does this chain node READ the position the recompute moves? */
function readsPosition(n: AppNode, edges: readonly AppEdge[]): boolean {
  const type = n.data.registryType;
  if (DISPLACED_NORMAL_ROOTS.has(type)) return true;
  if (type === 'unknown') {
    const raw = getNodeValues(n).rawExpression;
    return typeof raw === 'string' && TOKEN.test(raw);
  }
  const root = implicitRootOf(n, (h) => edges.some((e) => e.target === n.id && e.targetHandle === h));
  return root !== null && DISPLACED_NORMAL_ROOTS.has(root);
}

/**
 * The node ids of `output`'s displacement chain when its normals are
 * recomputed, else null. `incoming` is the walk's target → sources map.
 */
export function displacedNormalChain(
  output: AppNode,
  edges: readonly AppEdge[],
  incoming: ReadonlyMap<string, string[]>,
  nodesById: ReadonlyMap<string, AppNode>,
): Set<string> | null {
  if (output.data.registryType !== 'output') return null;
  const settings = (output.data as { materialSettings?: MaterialSettings }).materialSettings;
  // Neither Faces: Flat nor the Unlit material reads a vertex normal.
  if (settings?.flatShading === true || settings?.unlit === true) return null;
  const edge = edges.find((e) => e.target === output.id && e.targetHandle === 'position');
  if (!edge) return null;
  const chain = closure([edge.source], (id) => incoming.get(id) ?? []);
  for (const id of chain) {
    const n = nodesById.get(id);
    if (n && readsPosition(n, edges)) return chain;
  }
  return null;
}
