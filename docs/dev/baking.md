# Bake to texture

> The one-line rules are in `CLAUDE.md`. **This file holds the reasoning, the
> measurements and the negative results behind them**. Read it before changing
> anything it covers.

## Contents

- What a bake is, and what it is for
- The pipeline, end to end
- What can be baked: one class per node type
- The stage's half, and the two traps measured in it
- The trusted side's half: range, dilation, encode
- The commit: one undo entry, and why it never expands a group
- Study sessions (`consent-17`)
- Limits, and what is not built yet

---

### What a bake is, and what it is for

- **"Bake to Texture…" turns what leaves a node, a selection or a group into a picture on an Image node.** Four doors (owner, 2026-11-21: "add the entry also to the search bar; allow to bake also a selection, without a group"): the node menu (its row reads "Bake Selection to Texture…" when the node is part of a wider selection, and bakes all of it), the group menu, the Space / right-click menu's SELECTION section (any selection of one node or more, no group needed — beside Organize and Group Selection), and a search for "bake" (Latvian "iecept") in EITHER search box: the Space menu puts the row first, the asset bar shows a button beside the box and takes Enter. The query rule is `bakeQueryMatches` (`utils/bakeQuery.ts`, a LEAF: at most four words, the first a start of "bake" or "iecept", diacritic-blind), so a sentence stays the generator's. With nothing selected the row and the button stay, inert (`aria-disabled`), saying "Select the nodes to bake first". A frame selected WITH its members (what a marquee takes) parks as itself, never inside a second frame. That Image takes over the wires, and the originals are parked unwired in a collapsed group beside it (owner, 2026-11-21). It is offered on every web and desktop build, including study sessions (see below). It is never offered in the embed (`?embed=1`), where no preview runs to render it.
- **It exists to save GPU points.** A noise stack can cost 60 points or more, while an Image costs 5–10 (size-aware, `imageNodeCost`). On a headset budget that is the largest single saving the app offers. Measured in Chrome on the first test: a `perlin(uv·8)` chain went from 18.5 to 5 points on the Meta Quest 3 table.
- **Step 1 of two** (owner, 2026-11-21). Step 1, built, bakes one socket at a time into one texture (a vec4 makes two). Step 2, not built, bakes a whole Output into a PBR set (base colour + opacity, ORM, emissive, and a normal map last) wired through the standard sockets. The existing single-GLB export (`engine/glbExportPlan.ts`) would then write that set as real glTF `baseColorTexture` / `metallicRoughnessTexture` / `emissiveTexture` slots. The plan is in the 2026-11-21 session's plan file.

### The pipeline, end to end

1. **Plan** (`utils/bakePlan.ts`, pure). `planBake` finds every socket whose value leaves the selection (`bakeSockets`: unwrapped wires, NOT mute-bypassed). It classifies each socket's upstream on the unwrapped, mute-bypassed graph (what codegen emits). The result is a layout, a UV channel, a shape, a colour space, a refusal or null, and warnings. The dialog shows one row per socket. Bake stays disabled (`aria-disabled`, the reason in its title) while any row is refused, nothing leaves the selection, or more than `MAX_BAKE_SOCKETS` (4) sockets do.
2. **Module** (`engine/bakeModule.ts`). This is Preview mode's derived graph (`previewGraph`): the socket wired into the Output's Color, every other sink input unplugged, every other plain Output gone. The one Output left is made UNLIT, and it has no Position wire, so nothing is displaced. A vec4's ALPHA pass adds a synthesized Split (`BAKE_SPLIT_ID`) and routes its `w`. The text then goes through the code panel's own codegen (`panelCodegen`) and the preview's own module builder (`buildPreviewShaderModule`).
3. **Render** (`BAKE_SCRIPT` in `engine/tslToPreviewHTML.ts`, reached through `components/Preview/previewBake.ts`). ShaderPreview registers the one baker. Before `fs:bake`, it posts any image payloads the module names that the document lacks, through the same feed a hot swap uses (`planPreviewAssetFeed` over the nodes the module was generated from, never the live store), charged to the same retained-memory budget. The reply, `fs:bake-result`, is matched by `id` and by source window.
4. **Pixels** (`utils/bakePixels.ts`, pure). `validateBakeReply` checks the reply, then `bakeImage` measures the range, dilates and quantizes.
5. **Encode** (`components/Modals/bakeRun.ts`). The 8-bit picture goes onto a canvas and out as a PNG (`encodeBlob`). From there it goes through the SAME encoder a dropped picture uses (`encodeImageFile`: the device's size cap, the per-image budget walk, WebP where the browser has it, lossless preferred for a data map), the same stash (`resolveImageDrop` + `stashImageOrigin`, so the Resolution ladder and Revert work), and the ONE Image construction (`makeImageNodeFromEncode`).
6. **Commit** (`store.commitBake` → `utils/bakeCommit.ts`). Before writing, the run rebuilds every bake module from the LIVE store and compares it with what was rendered. Then it asks the project image budget as every path that ADDS a payload does. An over-budget stop offers "Add anyway", which commits the pictures already made without rendering them again.

### What can be baked: one class per node type

A texture can only hold a value that is a function of the SURFACE POINT, the same every frame from every camera. `bakeClassOf` gives every registry type one class, and `bakePlan.test.ts` sweeps the registry. A type that is not in `TYPE_CLASS` must be listed in that test's `PURE` list, so **a new node type fails the suite until someone has asked what it does to a bake.** Unwired inputs are read through `implicitRootOf` (`utils/sdfPartition.ts`), the table that already names what a noise's unwired `pos` or an Image's unwired `uv` stands for. Any root identifier the table does not know is refused as `view`, the conservative answer.

| Class | Types (or roots) | Effect |
|---|---|---|
| `uv` | `uv`; the `uv` root (Image, colormap, dataRange, isolines, dataviz, stripes, Data) | the UV SQUARE layout |
| `surface` | `positionGeometry`, `positionLocal`, `normalLocal`, `tangentLocal`, `vertexColor`; a noise with `pos` unwired | the MESH layout |
| `world` | `positionWorld`, `positionWorldDirection`, `normalWorld` | mesh layout, and a warning: baked at the model's current turn |
| `view` | `positionView`, `positionViewDirection`, `cameraPosition`/`Near`/`Far`, `screenUV`, `rayDirection`, `fresnel`, `heightToNormal` (its slope is the screen derivative of the VIEW position, and its result a view-space normal) | refused |
| `live` | `time`, `soundNode` | a warning: frozen at the moment of the bake |
| `tuned` | `property_float`, `property_color`, `slider` | a warning: baked at the current value |
| `derivative` | `stripes`, `isolines`, `wireframe` (grid mode) | a warning: line widths come out in texels, not screen pixels |
| `refuse` | `unknown`; `wireframe` in edges mode (barycentrics the bake mesh does not carry) | refused |

Other refusals:
- **`constant`**: no `uv` or surface root, so the value is one number and there is nothing to bake.
- **`uv-channels`**: two different UV channels are read.
- **`uv-channel-wired`**: a UV node's Channel is a wire, and three names the attribute at BUILD time.
- **`needs-mesh`**: a surface chain while the Cube, the Teapot or a Raymarch window is shown. The Cube's six faces each span the whole UV square and the Teapot's patches overlap, so a mesh-layout bake would draw them on top of each other.
- **`no-preview`**: the embed, or a splat is shown.
- **`sdf-driven`**: a Raymarch or Splat Output drives the view.

A socket's layout is decided by its upstream, never chosen by the user: a UV-only chain is always the UV square, which covers every texel with no seams, so a mesh layout of it would only add seams.

### The stage's half, and the two traps measured in it

- **The module runs through the loader core** (`FastShaders.load` → `FastShaders.apply`, `weld: false`) on TEMPORARY meshes in a `Scene` of the stage's own. That is a 2×2 plane for the UV square, with `uv1..uv3` copied from `uv` so a chain reading another channel still reads it. For the mesh layout it is one plain `Mesh` per shown mesh: the SAME geometry object with that mesh's world matrix (so a world-space read matches the view), filtered by name and by `FastShaders.materialIndexOf` to the meshes wearing a material the socket feeds (`bakeMeshFilter`). Nothing is added to `preview-entity`, because the loader walks that subtree. Instanced draws are skipped. A non-splat document must name nothing splat (`tslToPreviewHTML.test.ts`), hence `isInstancedBufferGeometry`, not `isGaussianSplat`.
- **Each material gets `vertexNode = vec4(uv·2 − 1, 0, 1)`**, so every triangle lands where its texture coordinates are. It is drawn double-sided (a mirrored island winds backwards), with no depth test or blending, and `frustumCulled = false`. The camera is a dummy, because the vertex node ignores it.
- **Trap 1: three's colour path clamps a NEGATIVE to 0.** This was measured on r184 WebGPU: `MeshBasicNodeMaterial` with `colorNode = vec3(-0.5, 2, 0.25)` reads back `(0, 2, 0.25)`, with every render-target colour space and with tone mapping off. Values above 1 pass. The first browser run baked a signed Perlin with its negative half at 0: the preview's blacks came back dark grey, about 5% of the pixels off by more than 16. **So the bake sets `fragmentNode = vec4(vec3(colorNode), 1)`**, which carries the value through (`outputNode` does too). After the fix the same bake matches the original preview to a mean 0.03 of 255.
- **Trap 2: which way up a render target reads back is a property of the backend.** The bake does not assume it. Once per pixel type, a 64 px probe draws its own uv and the stage reads which row holds v ≈ 0, then flips if needed, so the reply's rows are always TOP FIRST with row 0 at v ≈ 1. That is the order a picture is stored in, which an Image node in the app orientation (three's `flipY`) samples back at the same uv. The same probe tests that a FLOAT target renders. If it does not, the 8-bit target is used, which clamps to 0..1. The readback is un-padded where a backend pads rows (WebGPU aligns rows to 256 bytes; every offered size is a multiple of 64 texels, so it does not happen in practice).
- **The tuned uniform values are copied by NAME** from the shader the view is running (`entity.components.shader._propertyUniforms`), Sound's current numbers included, so a bake shows what is on screen. Names are claimed over the whole graph, so the derived graph names every property as the panel does.
- **The reply is NUMBERS only**: an RGBA `Float32Array` (or `Uint8Array`), transferred. A failure is answered, never dropped, and the parent stops waiting after `BAKE_TIMEOUT_MS`.

### The trusted side's half: range, dilation, encode

- **The reply is adversarial** (the stage runs the user's shader). `validateBakeReply` accepts only a `Float32Array` or `Uint8Array` of exactly `size × size × 4` at the requested size. NaN or Infinity in a covered texel refuses the bake (`non-finite`), and an empty coverage refuses it (`empty`).
- **The range is MEASURED, never guessed.** The low and high of the covered texels over the channels that carry the value are read off the actual pixels, so the result is exact for this bake rather than an interval bound. Inside 0..1 the values are stored as they are. Outside it (a signed Perlin, an HDR colour) they are stored normalised, and the commit adds a Multiply by the span and an Add of the low end. That way the shader reads the original numbers within one 8-bit step. A remapped value is always stored as `data` (linear). An in-range colour is sRGB-encoded and stored as `color`, so its sRGB texture samples it back linear with more precision in the darks.
- **A mesh-layout bake is DILATED** `BAKE_DILATE_PX` (8) rings, each new texel the mean of its covered neighbours. What no ring reaches takes the mean of the covered texels, so filtering and mipmaps never pull black in along a UV seam.
- **A baked Image CLAMPS (`repeat: 0`).** A bake holds exactly the 0..1 square, and the Image node's default repeat blended its u = 0 and u = 1 edges along the sphere's seam: 0.04% of the preview's pixels were off by up to 98. With clamping, one pixel stays above 16.
- **No orientation key.** The bake writes its rows in the app orientation, which is right over any mesh's UVs. The file-picture rule (`filePictureOrientation`: a picture added over a glTF model is stored glTF-oriented) is for pictures authored outside the app. Asking it would store a bake over a glTF model upside down. `pictureOrientation.test.ts` pins `bakeRun.ts` as the one encode that must not ask it.

### The commit: one undo entry, and why it never expands a group

- **One act, one undo entry.** `commitBake` pushes history once and writes the planned graph. Collapsing the park frame inside a swallowed history bracket (`coalescingHistory` set directly, not `beginInteraction`, which would also log a `gesture`) keeps the collapse's own `pushHistory` from adding a second entry. The group actions log no telemetry of their own, so the act is exactly one `bake` event.
- **The Image takes over the wires that carried the socket OUT of the selection**, onto the same target sockets. A scalar reads the Image's R, a vec3 or colour its Color, a vec2 a Vec2 of R and G, and a vec4 an Append of the Color and a second, grey Image's R. A wire inside the selection stays with the originals. Each bake's Image and helpers are placed as one BLOCK whose right edge sits where the baked node's was, moved to the nearest spot that overlaps nothing that stays (`freeFrameSpot`). The collapsed pill then goes to the nearest free spot left of the first Image.
- **The PARK set** is the selection plus every node upstream of it that now feeds only parked nodes. A feeder still used elsewhere stays, and sinks, frames and notes never move. Only nodes at the selection's own level move: a frame inside the selection's level moves only when every node inside it is parked. A single selected group parks as itself. Parked nodes reach no Output, so they cost nothing, leave the code panel (connected-only) and leave the export (unless "Include unconnected nodes" is ticked).
- **It NEVER expands a collapsed group.** A collapsed group stores its boundary wires rewritten onto its pill, and collapsing is TWO-PHASE: the pill's wires are rewired a frame later, in a `requestAnimationFrame` (`toggleGroupCollapsed`). The first cut expanded every collapsed group the edit touched, rewired, then re-collapsed them. Two collapses in one act each compute their deferred rewire from a state the other has not finished, and the later one overwrites the earlier: the wires into the first group's pill come back with their original endpoints and `hidden: true`, so they are kept and compiled but never drawn. Found in review before it shipped. Instead, every wire is found by its stored ID through the unwrapped view (`unwrapCollapsedGroupEdges` keeps ids), and only its SOURCE moves to the Image. A wire ending on a collapsed pill's input socket keeps that socket, and a pill OUTPUT that no longer leads anywhere is pruned. The park frame is the one group a bake collapses.
- **It fires neither `fs:graph-imported` nor `fs:graph-merged`.** A bake is an edit of the open document, like grouping. `fs:graph-merged` would make NodeEditor re-frame the whole canvas and make the settled preview treat the edit as a whole-graph replacement.
- **The graph must still be the one that was baked.** Between the Bake press and the commit the stage takes from a tenth of a second to a few seconds. `runBake` rebuilds every bake module from the live store and refuses with `changed` if any text differs. A semantic comparison would be weaker, and an identity one (`nodes` array) would refuse on a React Flow measurement.

### Study sessions (`consent-17`)

Bake is offered in every study arm (owner, 2026-11-21, "Offer everywhere"). Since it lowers the points a participant's shader costs, the very thing the arms differ in, it is logged. **`bake`** is a closed-vocabulary event logged from the ONE commit, `commitBake`: `layout` uv|mesh, `size` in texels, `sockets` baked, `parked` nodes moved. These are counts and enums only, pinned in `evalHooks.test.ts`. It is an ACTIVITY and a STRUCTURAL event, so a snapshot follows it. The Image nodes a bake adds log no `node-add`; the snapshot counts them. The data disclosure's events line now names "nodes baked into textures" in both languages, and `CONSENT_TEXT_VERSION` is `consent-17` (`docs/dev/eval-mode.md`).

### Limits, and what is not built yet

- **8 bits per channel.** The Image node's payload path is 8-bit (a canvas encode, then the drop path's WebP/PNG). The range restore keeps the numbers, but a slow gradient over a wide range can band. A 16-bit path would need its own decoder, because `HTMLImageElement` uploads 8-bit.
- **The UV square covers 0..1.** A mesh whose UVs run outside 0..1 (a tiled glTF) was shading the function there, and the clamped bake cannot reproduce it.
- **A mesh layout needs non-overlapping UVs.** Overlap is not detected; the last triangle drawn wins.
- **Time and Sound freeze**, and so does a world-space read at the current turn.
- **Not tested on WebGL2** (Safari forces it): the float target needs `EXT_color_buffer_float`, and without it the probe falls back to 8 bits. Measured on Chrome WebGPU only.
- **The PBR set (step 2) is not built**, nor a "Download textures" zip.
- **The Latvian word for "bake" is provisional**: "Iecept tekstūrā", pending the owner's choice.
