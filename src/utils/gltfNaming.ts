/**
 * PREDICTS the names three r184's GLTFLoader gives the meshes of a glTF scene —
 * pure and import-free, fed an already-validated, normalized graph by the
 * trusted-side reader (`gltfReader.ts`), so it never sees raw JSON.
 *
 * WHY A PREDICTION IS NEEDED AT ALL. Sub-mesh names are what loader 0.6's
 * `parts` dispatch matches, and they are not the names in the file: GLTFLoader
 * runs every name through `PropertyBinding.sanitizeNodeName` and de-duplicates
 * collisions through ONE counter shared by scenes, nodes, cameras, lights and
 * meshes. The prediction serves exactly two uses — the index-section vs
 * name-section double-claim check and the 0.6 mirror keys — and is never a
 * source of TARGETS (the sandbox's inventory stays that; see meshInventory.ts).
 *
 * WHAT IS REPLAYED (GLTFLoader.js r184; line numbers from that file):
 *   (0) the counter is `createUniqueName` verbatim (:3703-3716), over a PLAIN
 *       `{}` (the loader's `nodeNamesUsed`, :2577);
 *   (1) `_markDefs` (:2708-2745): a mesh's reference count over ALL nodes, and
 *       which nodes are skin joints (bones);
 *   (2) the SYNCHRONOUS reservations, in the order `parse` reaches them
 *       (:2656-2663): every scene (its name, then `loadNode` over its roots —
 *       node name, mesh queued, camera, light, then children, then the skin's
 *       joints shallow), then every animation channel's target node, then the
 *       cameras nothing referenced;
 *   (3) the mesh names, which the loader assigns LATER, in each `loadMesh`
 *       then-callback (:3895): one name per primitive, POINTS and LINES
 *       included;
 *   (4) `_instance_<k>` on every reference of a mesh used by more than one node
 *       (`_getNodeRef`, :2795-2823), in shallow-load order;
 *   (5) a named, non-bone node holding exactly one object gives that object its
 *       own reserved name (`_loadNodeShallow`, :4341-4365).
 *
 * WHAT CANNOT BE PREDICTED, AND IS SAID SO. Step (3) is asynchronous: the
 * loader names a mesh when its materials and geometry resolve. For meshes with
 * DIFFERENT sanitized base names the order does not matter — the counter keys
 * on the base, and a suffixed name is never recorded as a key — but two
 * distinct mesh DEFS sharing a base are suffixed in resolution order, which
 * follows texture decoding (measured: a textured mesh referenced first came
 * out `X_1`). Every name derived from such a group is `certain: false`, and an
 * uncertain name never becomes a 0.6 mirror key.
 *
 * THE PLAIN `{}` IS DELIBERATE. The loader checks `sanitizedName in
 * this.nodeNamesUsed` on a plain object, so `constructor`, `toString` and
 * `__proto__` come out as `constructor_NaN`, `toString_NaN` and
 * `__proto___NaN` (`++` on an inherited function or object is NaN). The
 * replica must reproduce that to predict those names, and it is safe here: the
 * object is local and never escapes, nothing reads a key back out of it, and
 * the one write an inherited name can cause is `used['__proto__'] = NaN`, which
 * the `__proto__` setter ignores for a non-object — so no prototype is ever
 * written. The parity suite pins it against the real loader.
 *
 * Every walk is iterative: depth is bounded by the node count, never by the
 * call stack. The reader has already refused cycles, a second parent and every
 * out-of-range index; the checks here are only a backstop against throwing.
 */

export interface GltfSceneGraph {
  nodes: {
    name: string;
    children: number[];
    mesh: number | null;
    camera: number | null;
    skin: number | null;
    light: number | null;
  }[];
  meshes: {
    name: string;
    primitives: { material: number | null; mode: number; tangents: boolean; vertexColors: boolean }[];
  }[];
  scenes: { name: string; nodes: number[] }[];
  defaultScene: number;
  skins: { joints: number[] }[];
  /** Every animation channel's `target.node`, in animation then channel order. */
  animationTargets: number[];
  cameras: { name: string; hasParams: boolean }[];
  lights: { name: string }[];
}

export interface PredictedMesh {
  /** The name the loader gives this primitive's Mesh object. */
  name: string;
  /** False when the name comes from a same-base group of mesh defs (see above). */
  certain: boolean;
  /** The primitive's glTF material index, null for the default material. */
  material: number | null;
  mesh: number;
  primitive: number;
  node: number;
  tangents: boolean;
  vertexColors: boolean;
}

const RESERVED_RE = new RegExp('[' + '\\[\\]\\.:\\/' + ']', 'g');

/** `PropertyBinding.sanitizeNodeName` VERBATIM (PropertyBinding.js:185-187). */
export function sanitizeGltfNodeName(name: string): string {
  return name.replace(/\s/g, '_').replace(RESERVED_RE, '');
}

/** The primitive modes the loader turns into a Mesh (TRIANGLES, STRIP, FAN). */
const MESH_MODES: ReadonlySet<number> = new Set([4, 5, 6]);

const inRange = (i: number | null, n: number): i is number => i !== null && Number.isInteger(i) && i >= 0 && i < n;

/**
 * Predict the Mesh objects of the DEFAULT scene, in the pre-order a
 * `scene.traverse` visits them (a node's own primitives before its children),
 * one entry per TRIANGLES-family primitive per referencing node. `exact` is
 * true when every prediction is certain.
 */
export function predictSceneMeshes(g: GltfSceneGraph): { meshes: PredictedMesh[]; exact: boolean } {
  const nodeCount = g.nodes.length;
  const meshCount = g.meshes.length;

  // (0) The loader's counter, over a plain object on purpose (header).
  const used = {} as Record<string, number>;
  const unique = (orig: string): string => {
    const s = sanitizeGltfNodeName(orig || '');
    if (s in used) return s + '_' + ++used[s];
    used[s] = 0;
    return s;
  };

  // (1) _markDefs: references over ALL nodes, and the bones of ALL skins.
  const refs = new Uint32Array(meshCount);
  for (const node of g.nodes) if (inRange(node.mesh, meshCount)) refs[node.mesh]++;
  const isBone = new Uint8Array(nodeCount);
  for (const skin of g.skins) for (const j of skin.joints) if (inRange(j, nodeCount)) isBone[j] = 1;

  // (2) The synchronous phase.
  const shallowDone = new Uint8Array(nodeCount);
  const loadDone = new Uint8Array(nodeCount);
  const skinDone = new Uint8Array(g.skins.length);
  const camDone = new Uint8Array(g.cameras.length);
  const lightDone = new Uint8Array(g.lights.length);
  const nodeName: string[] = new Array<string>(nodeCount).fill('');
  const meshQueued = new Uint8Array(meshCount);
  const meshQueue: number[] = [];
  const meshRefNodes: number[][] = g.meshes.map(() => []);

  const reserveCamera = (c: number) => {
    if (camDone[c]) return;
    camDone[c] = 1;
    const cam = g.cameras[c];
    if (cam.hasParams && cam.name) unique(cam.name);
  };

  // _loadNodeShallow: the node's name, then its mesh (named later), its camera,
  // its light.
  const shallow = (n: number) => {
    if (!inRange(n, nodeCount) || shallowDone[n]) return;
    shallowDone[n] = 1;
    const node = g.nodes[n];
    nodeName[n] = node.name ? unique(node.name) : '';
    if (inRange(node.mesh, meshCount)) {
      if (!meshQueued[node.mesh]) {
        meshQueued[node.mesh] = 1;
        meshQueue.push(node.mesh);
      }
      meshRefNodes[node.mesh].push(n);
    }
    if (inRange(node.camera, g.cameras.length)) reserveCamera(node.camera);
    if (inRange(node.light, g.lights.length) && !lightDone[node.light]) {
      lightDone[node.light] = 1;
      unique(g.lights[node.light].name || 'light_' + node.light);
    }
  };

  // loadNode: shallow, then every child fully, then the skin's joints shallow.
  const load = (root: number) => {
    const stack: { n: number; next: number }[] = [];
    const enter = (n: number) => {
      if (!inRange(n, nodeCount) || loadDone[n]) return;
      loadDone[n] = 1;
      shallow(n);
      stack.push({ n, next: 0 });
    };
    enter(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const children = g.nodes[top.n].children;
      if (top.next < children.length) {
        enter(children[top.next++]);
        continue;
      }
      stack.pop();
      const skin = g.nodes[top.n].skin;
      if (inRange(skin, g.skins.length) && !skinDone[skin]) {
        skinDone[skin] = 1;
        for (const j of g.skins[skin].joints) shallow(j);
      }
    }
  };

  for (const scene of g.scenes) {
    if (scene.name) unique(scene.name);
    for (const root of scene.nodes) load(root);
  }
  for (const t of g.animationTargets) load(t);
  for (let c = 0; c < g.cameras.length; c++) reserveCamera(c);

  // (3) The mesh names, in first-reference order; same-base groups uncertain.
  const primName: string[][] = new Array<string[]>(meshCount);
  const byBase = new Map<string, number>();
  const uncertainMesh = new Uint8Array(meshCount);
  const firstOfBase = new Map<string, number>();
  for (const m of meshQueue) {
    const base = g.meshes[m].name || 'mesh_' + m;
    primName[m] = g.meshes[m].primitives.map(() => unique(base));
    const key = sanitizeGltfNodeName(base);
    const count = (byBase.get(key) ?? 0) + 1;
    byBase.set(key, count);
    if (count === 1) firstOfBase.set(key, m);
    else {
      uncertainMesh[m] = 1;
      uncertainMesh[firstOfBase.get(key)!] = 1;
    }
  }

  // (4) Instance suffixes, in shallow-load order.
  const suffix: string[] = new Array<string>(nodeCount).fill('');
  for (let m = 0; m < meshCount; m++) {
    if (refs[m] <= 1) continue;
    let k = 0;
    for (const n of meshRefNodes[m]) suffix[n] = '_instance_' + k++;
  }

  // (5) + (6) The default scene, pre-order.
  const out: PredictedMesh[] = [];
  const scene = inRange(g.defaultScene, g.scenes.length) ? g.scenes[g.defaultScene] : null;
  if (scene) {
    const visited = new Uint8Array(nodeCount);
    const stack: number[] = [];
    for (let i = scene.nodes.length - 1; i >= 0; i--) stack.push(scene.nodes[i]);
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (!inRange(n, nodeCount) || visited[n]) continue;
      visited[n] = 1;
      const node = g.nodes[n];
      const m = node.mesh;
      if (inRange(m, meshCount) && primName[m]) {
        const prims = g.meshes[m].primitives;
        const objectCount = 1 + (node.camera !== null ? 1 : 0) + (node.light !== null ? 1 : 0);
        const overridden = !isBone[n] && objectCount === 1 && !!node.name;
        for (let p = 0; p < prims.length; p++) {
          if (!MESH_MODES.has(prims[p].mode)) continue;
          let name: string;
          let certain = !uncertainMesh[m];
          if (prims.length === 1) {
            // The mesh object IS the node's object: the suffix lands on it, and
            // a named node's reserved name replaces it outright.
            if (overridden) {
              name = nodeName[n];
              certain = true;
            } else name = primName[m][0] + suffix[n];
          } else {
            // A Group holds the primitives; the suffix and the node name go on
            // the Group, never on a child.
            name = primName[m][p];
          }
          out.push({
            name,
            certain,
            material: prims[p].material,
            mesh: m,
            primitive: p,
            node: n,
            tangents: prims[p].tangents,
            vertexColors: prims[p].vertexColors,
          });
        }
      }
      const children = node.children;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  return { meshes: out, exact: out.every((p) => p.certain) };
}
