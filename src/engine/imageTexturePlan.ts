import { imageAssetFor, type ImageAsset } from './imageAssets';
import { readImageTextureSpec, imageTextureSpecKey, type ImageTextureSpec } from '@/utils/imageTextureSpec';

export { readImageTextureSpec, imageTextureSpecKey, type ImageTextureSpec };

/**
 * Which Image nodes SHARE their module-scope objects, decided in one place.
 *
 * graphToCode used to emit one `new Image()` + decode + `THREE.Texture` per
 * Image node, so two nodes holding the same picture uploaded it twice (and,
 * feeding Environment, prefiltered it twice: three's PMREM cache is keyed by
 * the texture OBJECT). This planner groups them instead:
 *
 *   - The TEXTURE is keyed by the exact canonical payload (`asset.src`, the
 *     `data:` URL re-encoded from the decoded bytes) x the texture-object spec
 *     (`readImageTextureSpec`: colour space, filter, wrap, `Texture.flipY`).
 *     Payloads are compared as FULL strings, never by the FNV digest in the
 *     placeholder, which is a 32-bit bucket key and collides.
 *   - The IMAGE ELEMENT is keyed by the exact canonical payload ALONE: one
 *     `new Image()` + decode (and so one inlined `data:` URL) per distinct
 *     picture, whatever its nodes set on the texture. Two Textures over one
 *     element are pixel-neutral: the element is only the upload's source, and
 *     everything a spec changes is set on the Texture.
 *
 * UV math never enters a key. Tile, offset, the Flip X/Y checkboxes, a wired
 * uv, a wired Direction and the glTF UV set / texture transform all live in
 * the uv EXPRESSION each node samples with, so nodes differing only there
 * sample one texture. (The node's `values.flipY` is the Flip Y checkbox, a uv
 * mirror; `Texture.flipY` is the spec's `flipY` — true, or false under the
 * glTF orientation, Phase 4's one Texture-object mapping setting. Two nodes
 * with one payload and different orientations therefore get two textures.)
 *
 * Each OWNER is the first node PLACED in its group: the Image element's is the
 * first node with that payload, each Texture's the first with that payload x
 * spec. graphToCode places nodes on their first emitted visit, in plan order,
 * so an owner's declarations always precede a sharer's use (the element's
 * owner is placed no later than any texture owner reading it), and only the
 * element owner's `fs-asset:` placeholder appears in the code. Placeholder keys stay per node (`collectImageAssets` still maps
 * every node), so a graph with no duplicate payloads emits byte-identically.
 *
 * RULE: every line that writes to the Texture OBJECT is derived from
 * `ImageTextureSpec` alone (`imageTextureSetupLines`). A future setting that
 * lands on the object (a glTF orientation, anisotropy...) MUST join the spec,
 * or two nodes differing in it would silently share one texture.
 *
 * Node ids and values come out of `.fastshader` files, so every lookup is a
 * `Map` (a plain object would resolve `__proto__`/`constructor`), and nothing
 * here interpolates a stored value: the lines are built from the canonical
 * asset, the whitelisted placeholder/comment and the spec's closed vocabulary.
 */

export interface ImageTexturePlacement {
  readonly asset: ImageAsset;
  readonly spec: ImageTextureSpec;
  /** The node whose `_<var>_img` / `_<var>_ok` this node reads. */
  readonly imageOwner: string;
  /** The node whose `_<var>_tex` this node samples. */
  readonly textureOwner: string;
  /** This node declares the Image element (and its placeholder). */
  readonly ownsImage: boolean;
  /** This node declares the Texture. */
  readonly ownsTexture: boolean;
}

export interface ImageTexturePlanner {
  /**
   * Place one Image node. Null (and nothing recorded) for a payload that fails
   * strict validation; the caller emits its inert fallback, and a later valid
   * node with the same bytes becomes the owner. Idempotent per id: a second
   * call returns the SAME placement.
   */
  place(id: string, values: Record<string, string | number>): ImageTexturePlacement | null;
  /** The placement recorded for `id`, if it was placed. */
  get(id: string): ImageTexturePlacement | undefined;
  /** Distinct Texture objects placed so far. */
  readonly textureCount: number;
  /** Distinct Image elements placed so far: one per distinct payload. */
  readonly imageCount: number;
}

interface PayloadGroup {
  /** The first node placed with this payload: it declares the Image element. */
  readonly imageOwner: string;
  /** specKey -> the node that owns that texture. */
  readonly textures: Map<string, string>;
}

export function createImageTexturePlanner(): ImageTexturePlanner {
  // Nested maps keyed by the full `src`, then the short spec key, so no
  // megabyte-long concatenated key is ever built.
  const groups = new Map<string, PayloadGroup>();
  const placements = new Map<string, ImageTexturePlacement>();
  let textureCount = 0;
  let imageCount = 0;

  return {
    place(id, values) {
      const prior = placements.get(id);
      if (prior) return prior;
      const asset = imageAssetFor(id, values);
      if (!asset) return null;
      const spec = readImageTextureSpec(values);
      const specKey = imageTextureSpecKey(spec);
      let group = groups.get(asset.src);
      if (!group) {
        group = { imageOwner: id, textures: new Map() };
        groups.set(asset.src, group);
      }
      let textureOwner = group.textures.get(specKey);
      if (textureOwner === undefined) {
        textureOwner = id;
        group.textures.set(specKey, id);
      }
      // The Image element is per payload, whatever the spec: a node whose
      // texture settings differ builds its own Texture over the element the
      // payload's first node declared (one decode, one inlined payload).
      const imageOwner = group.imageOwner;
      const placement: ImageTexturePlacement = {
        asset,
        spec,
        imageOwner,
        textureOwner,
        ownsImage: imageOwner === id,
        ownsTexture: textureOwner === id,
      };
      if (placement.ownsTexture) textureCount++;
      if (placement.ownsImage) imageCount++;
      placements.set(id, placement);
      return placement;
    },
    get(id) {
      return placements.get(id);
    },
    get textureCount() {
      return textureCount;
    },
    get imageCount() {
      return imageCount;
    },
  };
}

/**
 * The Image element: created, pointed at the asset's placeholder, decoded with
 * top-level await. A garbage payload fails `decode()` and sets the ok flag
 * false instead of rejecting the whole module. Emitted as FLAT statements
 * (never an async IIFE: codeToGraph's ReturnStatement visitor would mistake its
 * `return` for the shader output).
 */
export function imageElementSetupLines(imgVar: string, okVar: string, asset: ImageAsset): string[] {
  return [
    `const ${imgVar} = new Image();`,
    `${imgVar}.src = "${asset.placeholder}"; ${asset.comment}`,
    `let ${okVar} = true;`,
    `try { await ${imgVar}.decode(); } catch { ${okVar} = false; }`,
  ];
}

/**
 * The Texture over an Image element, falling back to a 1x1 black DataTexture
 * when the element failed to decode. Every line is a function of `spec` (plus
 * the variable names), which is what makes the spec a safe sharing key.
 */
export function imageTextureSetupLines(
  texVar: string,
  imgVar: string,
  okVar: string,
  spec: ImageTextureSpec,
): string[] {
  const lines: string[] = [];
  const isData = spec.colorSpace === 'data';
  // Filtering: 'nearest' takes the closest texel (hard pixel edges); anything
  // else, absent included, is three's default LINEAR and emits nothing new, so
  // every image saved before the option existed is byte-identical.
  const nearest = spec.nearest;
  lines.push(
    `const ${texVar} = ${okVar} ? new globalThis.THREE.Texture(${imgVar}) : new globalThis.THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, globalThis.THREE.RGBAFormat, globalThis.THREE.UnsignedByteType);`,
  );
  lines.push(`${texVar}.colorSpace = globalThis.THREE.${isData ? 'NoColorSpace' : 'SRGBColorSpace'};`);
  if (isData) {
    // Data maps (normal/height): linear values, no mip pre-filtering.
    const filter = nearest ? 'NearestFilter' : 'LinearFilter';
    lines.push(`${texVar}.generateMipmaps = false;`);
    lines.push(`${texVar}.minFilter = globalThis.THREE.${filter};`);
    lines.push(`${texVar}.magFilter = globalThis.THREE.${filter};`);
  } else if (nearest) {
    // A colour image keeps its mipmaps, so minification takes the nearest
    // texel of the nearest mip level: crisp at every distance, without the
    // shimmer plain nearest sampling of a far-away texture gives.
    // Magnification is the pixel-art look itself.
    lines.push(`${texVar}.minFilter = globalThis.THREE.NearestMipmapNearestFilter;`);
    lines.push(`${texVar}.magFilter = globalThis.THREE.NearestFilter;`);
  }
  // Repeat (default) so tiling (via the node's tile settings or the uv node's
  // tilingU/tilingV) wraps instead of smearing the edge pixels; the settings
  // menu can switch to clamp. flipY written explicitly so orientation never
  // rides on a three.js default: true, or false for a glTF-oriented node (a
  // texture that came with a model is stored top-down, as GLTFLoader uploads
  // it).
  const wrapMode = spec.repeat ? 'RepeatWrapping' : 'ClampToEdgeWrapping';
  lines.push(`${texVar}.wrapS = globalThis.THREE.${wrapMode};`);
  lines.push(`${texVar}.wrapT = globalThis.THREE.${wrapMode};`);
  lines.push(`${texVar}.flipY = ${spec.flipY ? 'true' : 'false'};`);
  lines.push(`${texVar}.needsUpdate = true;`);
  return lines;
}
