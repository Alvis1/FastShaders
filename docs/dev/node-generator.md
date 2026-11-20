# Text → node generator (`src/llm/`)

"Generate nodes from text": the user types a request ("glowing lava cracks on dark rock"), a model writes a small TSL program, and the app turns it into ONE group of ordinary nodes, wired into the Output's Color when that socket is empty and parked beside the graph otherwise. It is experimental, **suggested by default where a model can be reached** (`fs:nodeGenerator`, three states, `utils/generatorFlag.ts`: a search that reads as a request offers it, and nothing is loaded or sent before the dialog's Generate) and **absent in study sessions, the embed and a running lesson**. The planning record (research, designs, the skeptic reviews, the spike) lives in the gitignored `private/docs/llm-generator/`. This file is the reasoning for what was built.

**What is in the app (2026-11-19).**
- The core: the gate, the prompt and examples, the repair rounds, the placement, both providers, the fetch transport, the preferences and the opt-in leaf.
- The desktop's Rust bridge (`src-tauri/src/llm.rs`) and its client, `transport/tauriTransport.ts`.
- The dev server's same-origin proxy to a local model server (`llmDevProxyPlugin`, below).
- The per-build policy: `FS_LLM_CLOUD_ORIGINS` puts the Claude API in a web build's `connect-src` and turns the route on. No hosted build sets it (owner, 2026-11-19), and the host deploys check what is served (below).
- The dialog (`llm/GeneratorDialog.tsx`), the store flag and its ONE entry: the toolbar's right-click Settings list (below, "The dialog and its entry").
- The study clean slate's generator keys.
- The bundled engine (P5, below, "The bundled engine"): llama.cpp packaged into the desktop app, pinned file by file; the survey the built-in route shows; the one pinned model, downloaded on the user's yes and hashed by the app; and the engine that serves it, started on the first Generate and stopped when idle.

Still to come: the search-box entry, which replaces the Settings row as the way in.

The generator was built on v0.3.36 in a worktree and ported to main on 2026-11-19. The port's engine fixes are below, under "Holding the gate on a moving engine".

## Routes and what is sent where

| Route | Where | Carried by | What leaves the machine |
|---|---|---|---|
| **On this computer · free** (the bundled llama.cpp, P5; being built) | desktop app only | `src-tauri/src/engine.rs` runs llama.cpp's own `llama-server`, shipped in the app | nothing (the model download itself, from Hugging Face, comes next) |
| **My LM Studio or Ollama** (LM Studio, llama.cpp — the OpenAI-compatible API) | desktop app; dev server | desktop: the Rust bridge `src-tauri/src/llm.rs`, loopback only, through its client `transport/tauriTransport.ts`; dev: `transport/fetchTransport.ts` (`devProxyTransport`) to the dev server's own same-origin proxy (`llmDevProxyPlugin`), which forwards to the server the request names | nothing |
| **Claude** with the user's own API key | desktop app and dev server; a web build only where its CSP names `https://api.anthropic.com`, which no hosted build does (owner, 2026-11-19) | the official `@anthropic-ai/sdk` (pinned EXACTLY at 0.132.1), straight from the browser (`dangerouslyAllowBrowser`, which sends the direct-browser-access header the API's CORS answer needs) | the request text, the fixed rules, the node list and worked examples. **Nothing from the user's graph or files** |

Deliberately NOT offered:
- **local servers from a hosted web page.** Safari never allows it. Everywhere else it means a CSP widening and a CORS setup per user.
- **a model downloaded into the tab.** It is 1–3 GB and fights the preview for the GPU.
- **Chrome's built-in model.** It needs its own measurement first; see Deferred.

`registry.ts` decides which routes a build offers. `offeredRoutes` returns `[]` in a study session. Each route loads through `import()`.

`__FS_LLM_CLOUD__` says whether a build may offer the Claude route. It comes from the same value as the build's `connect-src` entry, so the option never shows where the policy would refuse it ("The per-build policy", below).

**The generator is never on the boot wave.** `bootWave.test.ts` fails on a static path from `main.tsx` into `src/llm/` or to `@anthropic-ai/*`. The only boot-path pieces are the LEAF `utils/generatorFlag.ts`, which imports nothing, and `components/Layout/GeneratorLauncher.tsx`, which loads the dialog with `import()`. The test also checks that both ARE on the wave, so it cannot pass on nothing.

## Model output is adversarial: parse, then RE-EMIT

A reply is as untrusted as a shared `.fastshader`. Nothing a model writes executes, and nothing of it reaches the store unchecked. This is the Data Range formula's rule (docs/dev/node-types.md): the text is parsed against a closed grammar and the program is WRITTEN AGAIN from the app's own tables. The model contributes checked ASCII identifiers and finite numbers; every other byte of what the ADD parses comes from `emit.ts`.

`gate.ts` is THE acceptance gate:

1. **Extract** (`dialect.ts extractProgram`): a 32 K-character cap; any `FASTSHADERS_PROJECT` marker is refused (the ADD would restore a project block's own nodes); inline `<think>` is dropped; the last fenced block that returns is taken. The prose before it is the PLAN, shown as DATA.
2. **Strict parse**: `@babel/parser` with `errorRecovery: false` and no plugins. `codeToGraph` parses with recovery ON and never reads `ast.errors`, so a duplicate const or a TypeScript annotation would otherwise vanish without a word.
3. **Allow-list walk** into the internal form (`ir.ts`: steps referenced by INDEX, never by name). Every form is enumerated. Anything else is a PROBLEM with its line, the offending text and what to write instead (at most eight per round). Each of these is a form the parser drops or misreads silently:
   - an undeclared or forward reference;
   - a second noise argument (TSL reads it as AMPLITUDE, not a scale);
   - `float(x)`/`int(x)` of a value;
   - `color(0.5)` (setHex reads it as black);
   - `uv(n)`;
   - a short vector of values;
   - `.step()` and other chain methods TSL reorders;
   - helper `Fn`s, `Discard`, `If`/`Loop`, `.assign`;
   - a channel-object return;
   - strings;
   - namespace callees (`Math.sin`, `TSL.mix`, which shift every argument one port);
   - `uniform(<value>)`;
   - wrong arity;
   - ternaries, destructuring, `new`, computed members, a swizzle of a swizzle, non-finite numbers, and nesting past 24.

   A returned comparison is refused too: it is 0 or 1, and the dialect asks for the colour to pick.
4. **Lenient where a rewrite is mechanical and EXACT.** Every rejection costs a repair round (10–300 s on a local model), and the 2026-10-02 spike's failure classes asked for exactly these:
   - nested calls flatten into steps;
   - constant arithmetic folds (`1/6`, `Math.PI * 2`);
   - an operator on nodes becomes its function (`a * b` → `mul(a, b)`), the most common rejection on Gemma 4 E2B;
   - a method becomes the free function, positional for every TSL chain method EXCEPT `mix` and `smoothstep`, which put the receiver in the factor slot (`t.mix(a, b)` → `mix(a, b, t)`, pinned against three's `MathNode.js`);
   - `.toVar()`/`.toConst()` drop; `const k = 0.5` and `const a = b` substitute;
   - `vec3(scalar)` spreads and `vec3(colour)` is the colour. Widths are TSL's, not the registry's declared port types: `remap` and `smoothstep` (declared float) and `normalize` (declared vec3) follow their inputs, so `vec3(remap(uv(), …))` is refused, as is any vector component wider than one channel;
   - `a.xy` → `vec2(a.x, a.y)`;
   - `color(r, g, b)` → `vec3(r, g, b)` (TSL's three-number colour is LINEAR components, exactly a vec3);
   - a 7–8-digit hex keeps its low 24 bits (what `Color.setHex` reads);
   - a registry type name maps to its function (`perlin(p)` → `mx_noise_float(p)`);
   - a left-out TRAILING argument is filled only where TSL itself has a default (`clamp`'s low/high, `remap`'s outLow/outHigh, pinned against r184's source). Anywhere else r184 uses 0.0, not the registry's port default, so `mix(a, b)` is refused, never completed;
   - an input written as a call is the bare input;
   - a noise scale written first is still the scale (scaling commutes; the one-channel side is the scale);
   - unused consts are DROPPED and reported, the most common rejection after a repair round.

   Re-scored with this gate, the spike's saved replies went from 2/15 to 14/15 valid on the first try for Gemma 4 E2B, and from 12 to 15 for Qwen3-Coder-Next. The frontier ceiling stayed 15/15.
5. **Atomic forms the parser must see whole** are steps of their own, never flattened:
   - `uniform(<number>)`;
   - `uniform(color(0x…))`. Flattened, the colour uniform becomes a float uniform fixed at 1.0 that survives a type-and-name round trip;
   - a noise call with `pos.mul(scale)`;
   - `time.mul(k)` (Time's speed);
   - `mul(uv(), vec2(a, b))` (the UV node's tiling);
   - the unsigned remap `.mul(0.5).add(0.5)`, on the SIGNED noises only.
6. **Names** (`names.ts`) are ASCII `[A-Za-z][A-Za-z0-9_]*`, checked by explicit code-unit ranges. Latvian letters fold to their base letters (`ātrums` → `atrums`), and the gate says so.
   - Uniforms are renamed with graphToCode's bare-first scheme (`speed` → `speed2`), off the LIVE graph's property names (claims replayed over `sanitizeIdentifier`) and every stored tuned name (`fs:previewUniformValues`/`Bounds`, read through their sanitizers). A reused name would start at someone else's tuning.
   - `RESERVED_NAMES` holds: every registry `tslFunction`; every module helper and its imports; every function graphToCode imports by LITERAL or from a literal list (`CODEGEN_LITERAL_IMPORTS`, the drift pair `gate.test.ts` scans graphToCode.ts for, `mat2` and the SDF Output's list included); the Data Range formula's functions and the splat constants' imports (read from their own tables); JS words; `Object.prototype` names; `src` (the loader's own key); and the module's other names.
   - `params` is reserved too. The module reads every uniform through `export default function(params)`, and since 2026-11-18 the module itself renames a body local of that name to `_params` (docs/dev/codegen.md, fixTDZ). A generated uniform never needs that rename.
   - The live replay starts from graphToCode's own seed, the module-helper names and the splat parameters, so a live property named `hsl` is known to be emitted as `hsl2`.
   - Without these, `const color = uniform(color(…))` would be a TDZ error at load that every graph-level check passes. Other consts only label their node (graphToCode mints its own names), but they share the canonical module with the imports and are checked the same way.
7. **Verify with the commit's own parser**:
   - `codeToGraph(tsl)` gives no error, no warning and no `unknown` node;
   - node types stay inside the catalogue plus the parser-made ones;
   - at most 100 nodes (Wood, the largest built-in, is 80) and at most 8 uniforms;
   - every vector component is fed by ONE channel (`getEdgeOutputShape`).
8. **The semantic round trip** makes the enumeration in step 3 non-critical. The parsed graph's own re-emission (`graphToCode`) is walked AGAIN by the same walker and must compute the same thing as the model's program (`ir.ts semanticKeys`: a key per value, interned in a table both programs share, so a key stays short however much the steps share).
   - The re-walk is `trusted`: the app's helper Fns are skipped by name, and graphToCode's int→float promotions are read back by codeToGraph's own `stripIntPromotions`.
   - Forms the parser legitimately normalises key alike: `time.mul(3)` and `mul(time, 3)`; `noise(p.mul(k))` and `noise(mul(p, k))`; the unsigned remap and its arithmetic; an alias and the bare input; commutative operands; a Fresnel and its `.x`.
   - Any form the parser dropped or misread changes the key, and the first step whose key is lost names the line.
   - Graph → code → graph must also be stable (types, edges, stored values), so the parked group does not grow on the next Apply.
9. **Price** with `computeReachableCost` on the parse, while its Output still seeds the walk. A parked group prices 0 until it is wired, so the dialog is the only place this number appears beforehand.

### The built-in corpus is the gate's acceptance test

`gate.test.ts` runs every built-in through the gate: the Presets tab's recipes, Presets 2 and the textures. It sorts each one by CONTENT, never by an id list or a written count:
- a **channel-object return** is refused by design. A parked group has no Output to map channels onto;
- a **single return holding a node the catalogue leaves out** is refused for that node. These are Color Ramp and RGB Curves (below);
- **every other single return passes UNCHANGED**: the same graph signature as `codeToGraph(code)` and the same uniform names.

A further test pins that every recipe is counted, and in which class.

The snapshot on 2026-11-19 had 46 built-ins:
- 30 passed (2 recipes, 28 Presets 2 and textures);
- 6 single-return recipes were refused for their Color Ramp;
- 10 returned a channel object (5 recipes, 5 others).

### Holding the gate on a moving engine (the 2026-11-19 port)

The semantic round trip walks graphToCode's re-emission, so **a form the engine starts writing later refuses every program that reaches it, without any generator code changing**. The port onto main found three such forms. Each is pinned by a test written to fail first.

- **Fresnel.** Main's helper takes three arguments, `fsFresnel(eta, n, pw)`, and graphToCode always appends `positionWorld`, while the registry lists two sockets. Every generated Fresnel was refused ("fsFresnel() takes 2 arguments, not 3"). The fix has two parts:
  - **The third argument.** `dialect.ts IMPLICIT_TRAILING_ARGS` names that trailing argument. It is dropped when it is exactly the bare `positionWorld`, and refused with a fix line otherwise. codeToGraph warns on any other value.
  - **`.x` is the node.** graphToCode writes the `out` socket as `fresnel1.x`, and the parser reads the bare name as that same socket. So a member that maps to a node's FIRST socket through graphToCode's `OWN_MEMBER_TO_HANDLE` IS the node.
  - `gate.test.ts` pins `.y` (Facing) beside it.
- **An Int meeting a Float.** Main's int promotion writes `mul(float(int1), 0.3)`, and the re-walk refused `float(int1)` ("float() takes one number"). The trusted re-walk now runs codeToGraph's `stripIntPromotions` over its AST. That function is exported for this one reader, so the rule has one copy. The strip also reads back the `vec3(<scalar>)` widening graphToCode writes into `normalize`/`dot` (`VECTOR_ONLY_FNS`), so `normalize(u.x)` passes. A model still may not write a conversion of a value itself.
- **Color Ramp and RGB Curves.** The catalogue follows the registry automatically, so it offered `fsColorRamp`/`fsRgbCurves`. Both nodes are written with a canonical string argument inside a plain-JS module helper, and the dialect has no strings. They are now in `GENERATION_EXCLUDED_TYPES`. `catalogue.test.ts` calls EVERY catalogue entry by its own signature through the whole gate, so the next node the dialect cannot write fails there, not in a user's repair rounds.

Three engine round-trip bugs that the semantic check exposed in 2026-10 are on main in other forms:
- A swizzle into a noise position is wired by codeToGraph's `wireMemberPos`.
- A comparison wired straight into an Output is read back through `stripIntPromotions`.
- A Property named `params` is handled module-side (docs/dev/codegen.md, fixTDZ).

The worktree's own versions of those fixes were not ported.

## Placement: the dropped-shader ADD

`place.ts addGeneratedGroup` hands the canonical text to `addDroppedShader` as a file named after the request's first line. Slashes and control characters become spaces (the ADD keeps only what follows the last `/`), and the name is shortened at a word.

So a generated group gets exactly what a dropped one does:
- the ingest sanitizers;
- its own Output left out;
- fresh ids;
- one frame;
- ONE undo entry and `fs:graph-merged`.

**A change to that path changes this one; that coupling is the point.**

**The one thing it asks for on top is `wire`** (owner, 2026-11-20: "it should automatically connect to the Output, if nothing was connected there before"). A dropped file's Add never passes it.
- `planShaderGroup` keeps what fed the arriving PLAIN Output as `outputWires` (re-sourced onto the fresh ids). A generated program returns ONE value, so that is one wire into Color.
- `addDroppedShader({ wire: true })` re-targets them at the LIVE Output with a pressed Preset's own helpers (`utils/libraryAutoWire.ts`): `libraryWireOutput` (the active sink, only a plain Output, never one hidden in a collapsed group), `takenOutputChannels` + `libraryWireEdges` (a socket that has a wire is never touched), `exposeWiredChannels` and `makeOpacityReadable`.
- A wired frame lands beside that Output (`LIBRARY_WIRE_GAP` left of it, then `freeFrameSpot`), so the 3D view shows the result at once. The wire, the frame and the Output's change are the SAME undo entry.
- No free socket, or no plain Output in charge (a driving SDF or Splat Output, an empty canvas): the group is parked unwired as before — at `at` when the request came from a spot on the canvas (the Space menu), nearest free spot — and the note says to wire it.
- Everything is asked AFTER the last `await`: the Output may have been wired or deleted while the text was parsed.

The canonical text is comment-free (no project block for the ADD to find), `Fn`-shaped (scriptToTSL passes it through), image-free and zero-warning. So the ADD parses exactly the graph the gate verified; `scriptToTSLWithSettings(tsl).code === tsl` is pinned. It posts its own note (`generated-added`: "connected to the Output", or "wire its last node into an Output to see it"). It refuses in a study session. Its only caller is the dialog's Add.

## The prompt and the repair rounds

`prompt.ts` sends four things:
- the RULES the spike measured, which ask for the strict flat style the gate re-emits;
- the node list;
- up to four worked examples;
- the request.

The node list comes from `catalogue.ts`, and it is an ADD SURFACE:
- It is `getEditorDefinitions(hiddenOptionalCategories(flags))` written literally, so the optionalCategories and editorVisibility sweeps cover `src/llm/` too.
- It is intersected with `TSL_FUNCTION_TO_DEF`, so it can never offer what the parser cannot read.
- It is keyed on how a node is WRITTEN: the colour uniform is added, and Output, Split, Append and the float uniform are never offered as calls.
- Some nodes are left out, each with a reason in `GENERATION_EXCLUDED_TYPES`:
  - Vertex Color and Tangent, which are white or zero on every built-in shape;
  - Color Ramp and RGB Curves (above);
  - SDF, because an ADD drops the SDF Output it needs.

Examples (`examples.ts`) are built-ins chosen by shared words, with names weighted and Latvian display text included. The choice is deterministic, with no embeddings. They are written in the gate's canonical form, so every example passes the gate itself. A request that shares no word gets the spike's trio. Budgets are set per context class with a pessimistic 3.2 characters per token, and the richest prompt that fits is sent.

Repair rounds (`orchestrate.ts`, at most three) are STATELESS: the request, the rejected program and its problem lines go in a fresh prompt. Prefix-cache reuse is unreliable on the local models measured, and a growing conversation overflows small windows. The system prompt is byte-identical every round, which is also what lets the Claude route re-read it from the prompt cache. The run refuses in a study session.

## The local route

`providers/local.ts` speaks the OpenAI-compatible chat API over any `LocalTransport`:
- **The transport contract** (`transport/types.ts`) never throws. Failures carry the Rust bridge's `E_` codes, so ONE classifier, `protocol/errors.ts`, serves both transports.
- **Streaming** goes through `protocol/sse.ts`, split-safe at every byte. `openaiCompat.ts` reads content deltas, falls back to `reasoning_content` when a model writes everything into its thinking channel, and reads usage and in-stream errors.
- **The settings** are temperature 0.2 and `chat_template_kwargs.enable_thinking: false`, the spike's settings.
- **`checkLocalServer`** asks LM Studio's native `/api/v1/models` first, the only list that says what is LOADED and at which context. Then it asks `/v1/models`. Each state maps to its own message: nothing listening, no model, wrong port, or a context below `LOCAL_MIN_CONTEXT`. That minimum is 12,288 tokens; LM Studio's default here is 8,192, which a repair round can overflow. The message carries the `lms load … --context-length 16384` hint.

### The desktop bridge (`src-tauri/src/llm.rs`)

The desktop app reaches a model server on THIS computer through Rust, because a webview fetch from `tauri://localhost` (or `http://tauri.localhost` on Windows) is cross-origin: it needs the server's CORS switch, and Ollama answers the Windows origin with 403. Rust sends no origin header, so neither applies.

`main.rs` registers three async commands (`llm_local_models`, `llm_local_chat`, `llm_local_cancel`), the managed `LlmState`, and `page_load_guard`, a plugin `on_page_load` hook beside the `navigation_guard` plugin. Both are plugins: the builder's own hooks keep only the last one set, while plugin hooks all run. The rules:
- **Main webview only.** Every command refuses unless `webview.label()` is `main` (`E_FORBIDDEN`). Capabilities do not scope app commands (build.rs declares no `AppManifest`), so the label is the only caller identity a command has. Podest's window is refused.
- **Loopback only.** `parse_base` is a strict hand-written check: `http://` + `127.0.0.1` | `localhost` | `[::1]` + an explicit port 1–65535 + at most a trailing `/`. Nothing else passes: no userinfo, no `127.1`, no hex or decimal IPv4, no IPv4-mapped IPv6, no path or query. It connects by `SocketAddr` with no DNS; `localhost` tries 127.0.0.1 first, then ::1, because the servers listen on IPv4 only. `src/llm/endpoint.ts` mirrors the parser for UX only (Rust is the boundary). Both read the shared vectors in `src-tauri/tests/llm-urls.json`.
- **Exact routes.** `GET_ROUTES` and `POST_ROUTES`, equal to `LLM_LOCAL_GET_ROUTES`/`POST_ROUTES` in `utils/desktopIpc.ts`.
- **A fixed header set.** `Host` exactly as typed, `Content-Type` and `Content-Length` on a POST, `Accept`, `Accept-Encoding: identity`, `Connection: close`. No origin header, no `Expect`.
- **Answers.** Only 200 succeeds. A 3xx is refused, never followed. Any other status is `E_HTTP <status>: <excerpt>`, at most 300 characters with control and invisible characters removed.
- **Caps.** Request 1 MiB, streamed body 8 MiB, model list 1 MiB, response head 16 KiB.
- **Time.** Connect 3 s per address, then 300 s for the first BODY byte (a just-in-time model load and the prompt come first), 120 s between bytes after that and 900 s in all; the model list has shorter timers. The read loop is non-blocking and polls every 20 ms under `spawn_blocking`. It never relies on `shutdown` waking a blocked receive (undocumented on Windows) or on `SO_RCVTIMEO` (a timed-out Winsock receive leaves the socket indeterminate).
- **One request at a time** (`E_BUSY`). A cancel that arrives before its request is remembered for 10 s. A page load in the main window cancels whatever the old page left running (`page_load_guard`), or the slot would answer `E_BUSY` until that stream timed out.
- **No HTTP client crate.** HTTP/1.1 over `std::net` with a hand-written chunked decoder; no new crate was added.

**Only raw bytes cross.** Every channel message is `InvokeResponseBody::Raw` with a tag in byte 0: DATA (1) carries de-chunked body bytes, batched at about 16 KiB or 50 ms; ONE END (2), always last, carries the status as UTF-8 (empty for success, else the `E_…` string). A string sent as channel JSON would be the `Json` variant, which Tauri pastes UNQUOTED into an `eval` in the main window, so whatever answers on the loopback port could run script there. The model list returns raw bytes too (`ipc::Response`).

**The client** (`transport/tauriTransport.ts`) completes on the END frame, never on the invoke promise: frames of 1 KiB or more are fetched by the webview separately and can land after it resolves. The command rejects only when it sent no frame at all. Aborting sends `llm_local_cancel` once and resolves `CANCELLED` at once; `pagehide` does the same. Request ids are time-based, so a reloaded page never reuses one that Rust still remembers a cancel for. Every Tauri call goes through an `LlmDesktopBridge`, so `tauriTransport.test.ts` drives the whole protocol with a fake.

**Pinned on both sides.** `desktopIpcContract.test.ts` holds the commands (registered, async, from `llm.rs`), the route lists, hosts, caps, frame tags and timers to their TS twins, and checks the main-webview test, raw-only sends, no `origin` anywhere in the Rust code, the page-load guard's registration and a deny-list of HTTP client crates. The crate's own `cargo test` drives fake loopback servers (SSE, a 404 excerpt, a 302, oversize bodies, the first-byte and gap timeouts, a cancel mid-stream, the exact header set) and reads the shared URL vectors. An `#[ignore]`d live test runs against LM Studio with `FS_LLM_LIVE=1`.

`transport/fetchTransport.ts` serves the probe under node and the dev server's proxy, and enforces the same routes and caps.

### The dev server's proxy (`llmDevProxyPlugin`, vite.config.ts)

On the dev server the local route goes through a same-origin proxy, so the dialog can be exercised in a browser. No web BUILD has it (`apply: 'serve'`).
- **What it forwards.** Only `/v1/models`, `/api/v1/models` and `/v1/chat/completions`. Every other path goes on to the rest of the dev server.
- **Where to: the server the REQUEST names** (owner, 2026-11-20: "allow to change the port"). `devProxyTransport` sends every request to the dev server's own origin with the header `x-fs-llm-target: http://127.0.0.1:<port>` — the address the dialog's Port field holds, the same one the desktop bridge is handed. The proxy takes only what Rust's `parse_base` takes, minus the trailing slash (`LLM_DEV_TARGET_RE`: `http://`, `127.0.0.1` / `localhost` / `[::1]` exactly, a port 1–65535 with no sign or leading zero) and answers 400 to anything else, to a request with no header, and to its OWN port (that request would come back into the proxy). The header never reaches the model server. There is no `FS_LLM_DEV_TARGET` any more: until 2026-11-20 one env variable fixed the target for the whole run of the dev server, so trying Ollama meant restarting it.
- **What that widens, and what it does not.** A same-origin document can now reach the three routes on ANY loopback port, not one. On the dev server that includes the VR popup: it runs user shader code at the app's real origin, and its own policy (`XR_CSP`) allows `'self'`, which there is this proxy. That code could already reach the ONE configured server through it; now it can ask any loopback port for a model list or a chat. The limit is the three routes, and the sandboxed preview is unaffected (opaque origin: its requests are cross-site, 403). Dev server only (`apply: 'serve'`); no build ships it. The header is also one more thing a cross-site form or no-cors request cannot send.
- **What it sends.** `Host` set to the target, `Accept` and `Content-Type`; never an `Origin` of its own, like the Rust bridge. A closed page or a Cancel ends the upstream request, so the model stops.
- **Whom it answers: this dev server's own pages only.** Two attacks reach it from another website open in the same browser:
  - a cross-site request. Even one whose answer the page cannot read can START a generation (a no-cors POST). Refused by its `Sec-Fetch-Site` (anything but `same-origin`) and its `Origin` (anything but `http://<Host>`);
  - DNS REBINDING: the attacker's own name resolves to 127.0.0.1, so the browser counts its requests as same-origin and both checks above pass. Refused by the `Host`, which must be `localhost`, `127.0.0.1` or `[::1]` with an optional port. Vite's own host check does not cover this middleware, because a plugin's middleware runs before Vite's.
- **Checked** by `llmCspContract.test.ts`, which runs the real middleware against a stand-in model server on loopback, and on 2026-11-19 against a running dev server (port 5194): a rebinding `Host`, a cross-site request and a foreign `Origin` got 403; a request from its own page reached a stand-in server, which saw no `Origin`. On 2026-11-20 the Port field was driven in real Chrome against the running dev server: 1234 listed a real LM Studio's models, 11434 reached a second server, a port nothing listens on said so, a wrong value showed the hint and disabled Check, and a pasted `http://127.0.0.1:1234/v1` settled into `1234`.

## The bundled engine (P5, desktop)

The desktop app's main route ("On this computer · free", route id `engine`) runs llama.cpp's `llama-server`, shipped INSIDE the app, so a user installs nothing. It is packaged and surveyed (the first half below), then its model is downloaded and it is run (the second half, "The model and the running engine"). Design record: SEARCH-AI-PLAN §7, §11.5, §12.1.

**One manifest, `src-tauri/engine.json`.** It pins one llama.cpp build (b12359, the build behind llama.cpp's v1.0.0 release) for two platforms: the release asset's URL, sha256 and size, and every shipped file's sha256 and size.
- **macOS arm64**, Metal: 12 files, 31.6 MB unpacked. The universal `.dmg` carries it; the x64 slice reports `intel-mac` and touches no file (D19: llama.cpp's x64 macOS build has no Metal).
- **Windows x64**, Vulkan + CPU: 25 files, 89.6 MB unpacked, all 14 CPU variants, since ggml picks the best one for the processor at run time. The RPC backend (`ggml-rpc.dll`) is left out: on Windows it is a loadable backend, and nothing here uses it.
- The llama.cpp licence ships on both from `src-tauri/engine-licenses/` (the Windows archive has none).
- Files ship UNEDITED: no `lipo`, `install_name_tool` or re-signing. The macOS archive's `libggml.1.dylib -> libggml.1.0.0.dylib` links are replaced by the real file under the name the loader asks for, which changes no byte.

**Staging: `npm run fetch:engine`** (`scripts/fetch-engine.mjs`). It downloads the asset (cached in `node_modules/.cache/fetch-engine/`), checks its sha256, unpacks it with the system `tar`, and writes exactly the listed files into `src-tauri/engine-dist/<tag>/`. Then it checks every staged file against its pin. A failed run leaves the folder EMPTY. `tauri.conf.json` bundles `engine-dist/` as the resource folder `engine/`. The binaries are gitignored; the tracked `.gitkeep` keeps the folder present, because tauri-build resolves resources on every cargo run. The release job runs the script before each desktop build, and the Windows portable zip copies `engine/` beside the exe. A build made without the script carries no engine, and the survey says so (`missing`).

**The survey** (`llm_engine_survey`, main webview only, one at a time). It answers raw JSON bytes, like the model list, because device names are the GPU driver's words.
1. The host: no engine for this OS or architecture, or macOS below 13.3 (the engine's own `minos`).
2. The files: every file's size and SHA-256 must match the compiled-in pin in the folder it will run from. A difference, a missing file or an extra one is `tampered`, and nothing runs.
3. Two read-only runs, `--version` and `--list-devices`. The environment is CLEARED (llama reads `LLAMA_ARG_*`, `HF_ENDPOINT`, `MODEL_ENDPOINT` and more from it) except for the few variables the OS needs (`KEPT_ENV`). There is no stdin, the output is capped, and there is a 20 s deadline; a run past it is killed and reported `blocked`.
4. Memory, free disk where the model will go, and the OS version, read in Rust (`libc` on macOS, `windows-sys` on Windows; both were already in the dependency tree).

**macOS runs the app's OWN copy.** A browser marks a downloaded `.dmg` with `com.apple.quarantine`. Mounting it passes the mark to every file inside, and dragging the app out keeps it. "Open Anyway" approves the APP; a quarantined Mach-O the app then spawns is assessed on its own. Measured 2026-11-19 on macOS 27: a quarantined, ad-hoc-signed `llama-server` held its exec on a Gatekeeper prompt, and `spctl` said "rejected". So `install_copy` copies the engine into `app_data_dir()/engine/<tag>/`, hashing every file AS IT IS WRITTEN and renaming it into place only when it matched. A file this process writes carries no mark, and a mark that does appear is removed only after the file matched. Older tags are deleted. The `#[ignore]`d `real_quarantined_engine_runs_from_its_own_copy` marks every staged file as a download and surveys it: `ok`, Metal device found. The copy also works when macOS runs the app from a read-only translocated path.

**Windows runs it in place.** The installer writes the files, so they carry no Mark of the Web. ggml loads every `ggml-*.dll` beside the executable, so the folder must hold exactly the pinned set: an extra file is `tampered`. The tag is in the path, so an update never mixes two versions. Every engine DLL imports the Visual C++ runtime (MSVCP140, VCRUNTIME140, VCRUNTIME140_1). A Windows without it exits with STATUS_DLL_NOT_FOUND or STATUS_ENTRYPOINT_NOT_FOUND, and the survey reports `runtime-missing`.

**What the user sees** (`EngineSetup.tsx`, `SetupBox.tsx`): ONE box from `setupStates.ts`, a pure leaf (SEARCH-AI-PLAN §13 R-a):
- "Checking this computer…" while it runs;
- a ✓ line naming the GPU it found;
- or one error box whose primary button is the fix or the way around: Check again, Use LM Studio / Ollama, or Use an API key.

`setupStates.test.ts` holds every box to one primary action, a Latvian entry with the same placeholders, and at most 2 sentences and 20 words. An `ok` survey is kept for the session.

### The model and the running engine

One pinned model (`engine.json` `models[0]`: Gemma 4 E2B, Q4_K_M, 3.1 GB, Apache-2.0) and at most ONE engine process at a time. Everything was measured on the real b12359 binary on 2026-11-20, not inferred.

**The pin** names where the engine's downloader finds the file (a Hugging Face repository and quantisation; `POST /models` takes no revision) and what the file must BE: its size and SHA-256, read from the repository at the recorded commit. Every field is a plain path segment or lowercase hex (`valid_model`), so nothing in it can smuggle a path, a query string or a second repository.

**Download: the engine fetches, the app only watches.** The app has no HTTP-over-TLS crate, and gains none: `llama-server` runs in ROUTER mode with `LLAMA_CACHE` set to a staging folder and `--no-models-autoload`, so nothing is ever loaded there. It gets ONE request, `POST /models`, whose body Rust builds from the pin (`download_body`: the pinned repository, `sidecars: []`). The webview sends an action word (`start`, `pause`, `cancel`), never a repository.
- The downloader names its file by the SHA-256 the repository claims: `<sha256>.downloadInProgress`, then `<sha256>`. So `scan_blobs` reads the folder by name and size only, never through a link, and a name other than the pinned hash means the file changed upstream — refused before a byte of it is kept (`bad-hash`, the staging folder deleted).
- No progress stream is read. Progress is the partial file's size; "no connection" is 45 s without a partial file or 60 s without growth (`offline`, the partial kept).
- Pause kills the router and keeps the partial; posting again resumes from it (measured: 25.8 MB kept across a `kill -9`, the next run continued from there). Cancel also deletes the staging folder. An app that exits mid-download leaves a `partial`, shown as "Download paused at N%".
- A download that would leave under 2 GiB free is refused (`low-disk`); the pane checks the same before offering.

**Check: llama.cpp never hashes what it downloads, so the app does.** The router is stopped first. `check_and_place` hashes the file against the pin; only a match is renamed into `models/` and given a marker (`<file>.ok`: hash, size, modified time). A mismatch is deleted. `model_ready` trusts a file only with a matching marker, which spares every later start a 3 GB re-hash and makes a swapped file (another size or time) unknown again.

**Serve: single-model mode, offline.** `llama-server -m <the checked file> --offline`, never the router: a router's per-model workers answer WITHOUT the key. Flags (`serve_args`): loopback, a free port, `--no-webui --no-slots`, `--cors-origins localhost` (measured: a foreign origin's preflight gets no `Access-Control-Allow-Origin`), `--no-mmproj`, and a pinned `-c 16384 -np 1` (room for the prompt, its output and a repair round; it also stops `--fit` taking all GPU memory). The key is made per start and travels in the ENVIRONMENT (`LLAMA_API_KEY`), never as an argument other programs could read. Never `--rpc`, `--tools`, `--agent`, `--props`, `--sleep-idle-seconds` or `--connect`.
- **A chat** is `llm_engine_chat` in llm.rs: a body, a request id and a channel — no address and no path, so there is no query string to strip. It takes the bridge's one-at-a-time slot (so `llm_local_cancel` and the page-load guard cover it), asks `Runner::ensure_ready` under the request's own cancel flag, and posts to `/v1/chat/completions` with the key as a bearer token. The port and the key never reach the webview. On the JS side it is the local provider over `engineTransport()` (`transport/tauriTransport.ts`), the same protocol code as LM Studio.
- **Start on demand.** Nothing runs at app start. The first chat spawns the engine and polls `GET /health` (503 while loading, measured) for up to 180 s; a warm load took 2.1 s here.
- **Idle stop.** After 10 minutes without a chat a watcher thread stops it ("wakes on Generate"). A chat in flight holds a `Session`, which keeps the timer off it.
- **Failures.** A start that fails, or a run that dies, is counted; 3 in 10 minutes and the app stops retrying by itself (`failed`, "Start again" clears the count).
- **Stopping with the app.** `RunEvent::Exit` calls `EngineState::shutdown`. On macOS every engine process leads its own process GROUP, and the group is what is killed (the downloader is a child of the router). On Windows every engine process lives in its own Job Object flagged kill-on-close: a stop ends the whole tree (`TerminateJobObject`), and the system closes the handle, ending it, however the app ends. macOS has no such object: the live pids are written to `llm/engine.pid`, and the next launch kills what a crash left — only a pid that is still THIS server binary (`proc_pidpath`), so a reused pid is never touched.

**Where it lives:** `app_local_data_dir()/llm/` — `staging/` (the download), `models/` (the checked file and its marker), `engine.pid`. Never a roaming or synced folder.

**What the user sees** (`modelSetupBox` in `setupStates.ts`, under the survey's ✓ line): the offer, which IS the consent ("Download the AI model (3.1 GB)" with the model's name and the free space; nothing is ever downloaded silently) → the download with a bar, Pause and Cancel → "Checking the download…" → "✓ AI model downloaded (3.1 GB)", and "Delete model (3.1 GB)" behind an inline confirm. `EngineSetup.tsx` reads `llm_engine_status` every 0.5 s while something moves and every 2.5 s at rest; the status call starts nothing. The route is ready to Generate when the survey passed, the model is `ready` and the engine is not `failed`.

**Commands** (all main-webview only, each answering the status as raw JSON bytes): `llm_engine_status`, `llm_engine_download`, `llm_engine_delete`, `llm_engine_stop`; the chat is `llm_engine_chat`.

**Not built:** the "memory is tight" check before a load, the idle-time setting (fixed at 10 minutes), the preview's slow-down while the AI computes, the grammar and the fixed seed (P3), a model already on disk reused by hash (D24), and the other models' probe runs.

**Pinned on both sides.** `desktopIpcContract.test.ts`: the command's registration, the caller check before anything runs, the survey states, raw-only answers, the cleared environment and the two runs; for the model and the engine: the four commands behind one caller check, the state lists, no repository, address or key from the webview, the hash before any load, the offline flags and the exit hook. `engineBundle.test.ts`: the manifest's shape, the resource mapping, the gitignore, the script holding no pin of its own, and the release job's order. `engine.rs`'s own tests: copying, refusing, pruning, links, the probe's deadline and cleared environment, and the device parser.

## The cloud route

`providers/claude.ts` is reached only through `import()`. How it sends a request:
- **A client per request.** It is built inside the key's closure and never cached.
- **Streamed and abortable.**
- **Thinking.** It is left adaptive, with an explicit effort (`medium`). Haiku 4.5 takes neither setting.
- **The cache breakpoint** sits on the fixed system prompt. Haiku 4.5 needs 4,096 tokens to cache and silently does not.
- **`stop_reason` is read BEFORE any text.** A `refusal` or a cut-off reply never reaches the gate as an answer.
- **Fallbacks.** Server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) is set on the two models whose classifiers can decline.
- **Errors** are told apart by the SDK's classes. Only a 400's message is read, to tell a too-long prompt from other bad requests.

The default model is Claude Opus 5.5; Sonnet 5.5 and Haiku 4.5 are selectable (`claudeModels.ts`, ids as of 2026-10-08).

**The key** (`cloudKey.ts`) lives in this tab's memory only:
- **Never in the store.** History clones it, and the autosave and the feedback report read store state.
- **Never in storage.** Every page on the shared origins can read it.
- **No getter.** It is a dependency-free leaf, and only `providers/claude.ts` calls `withCloudKey` (pinned by `generatorWiring.test.ts`).

This is persistence hygiene, not isolation: other code on the same origin could read the key while the tab is open.

### The per-build policy (`FS_LLM_CLOUD_ORIGINS`)

The Claude route is the app's first request to a third-party origin, so whether a build may make it is decided per build. ONE variable drives both halves (vite.config.ts):
- **The policy.** `FS_LLM_CLOUD_ORIGINS` (space-separated) joins the page's `connect-src`. Each entry must be exactly `https://<host>`; a path, a port, a wildcard or `http:` fails the BUILD rather than widening the policy in a way nobody reviewed. It is EMPTY by default.
- **The option.** `llmCloudDefinePlugin` sets `__FS_LLM_CLOUD__` to `command === 'serve' || FS_DESKTOP || LLM_CLOUD_IN_CSP`: the dev server and the desktop app have no page CSP, and a web build offers the route only when its policy names `https://api.anthropic.com`. A forgotten env therefore HIDES the feature; it never widens a policy.
- **The SDK.** `@anthropic-ai/sdk` is its own `vendor-anthropic` chunk, reached only through `import()`. `registry.ts`'s `loadClaude` branches on the build constant, so a build without the origin drops the import and ships no SDK.

| Build | Made by | `connect-src` adds | `__FS_LLM_CLOUD__` | SDK shipped |
|---|---|---|---|---|
| GitHub Pages | release.yml's `web` job (unset); `npm run deploy` (EMPTY) | nothing | false | no |
| alvismisjuns.lv | `deploy-alvismisjuns.sh`, which sets it EMPTY | nothing | false | no |
| fs.sferas.lv, the study host | `deploy-sferas.sh`, which sets it EMPTY | nothing | false | no |
| a plain `npm run build` | — | nothing | false | no |
| the desktop app | `tauri build` (`FS_DESKTOP`) | no page CSP | true | yes |
| the dev server | `npm run dev` | no page CSP | true | on first use |

**No hosted build offers the Claude route** (owner, 2026-11-19). The port's first cut had GitHub Pages and alvismisjuns.lv name the API; the owner declined it before any deploy. Offering it on a host later is one value in that host's build plus flipping its deploy check.

**The host deploys check what is SERVED.** `npm run deploy`, `deploy-alvismisjuns.sh` and `deploy-sferas.sh` set the variable EMPTY in their build command, so a stale shell export cannot widen a hosted build, and both host deploys fail if the served page names `api.anthropic.com` anywhere. Both keep every check they had (version, upload origin, `/compare/`, and `/evalp/` on the study host).

**Pinned** by `llmCspContract.test.ts`. It loads the REAL config with Vite's own `loadConfigFromFile`, once per target, under the env that target's script sets (read from release.yml, package.json and the two deploy scripts, never restated), plus one build that names the API. For each it reads the CSP meta the html plugin writes, the define and the chunk the SDK lands in, and checks that the API entry and the option appear and disappear together. The deploy scripts' verify steps curl a live host, so those are pinned as text.

**Measured on 2026-11-19 in two real builds** (`vite build`, no deploy):
- with `FS_LLM_CLOUD_ORIGINS=https://api.anthropic.com FS_BASE=/fastshaders/`: index.html, compare/ and node-designer.html all had `connect-src 'self' blob: https://alvis1.github.io https://alvismisjuns.lv https://api.anthropic.com`; the bundle held `cloud:!0`, a `vendor-anthropic` chunk (218 KB raw) and the `claude` provider chunk;
- a plain build: the same `connect-src` without the API, `cloud:!1`, and neither chunk; no JS file named the API.

**Shader code never reaches the API.** The preview, intro and podest-stage documents carry their own `connect-src blob: data:` (`SANDBOX_CSP`), and the VR popup adds `connect-src 'self' blob: data:` (`XR_CSP`) on top of the page policy it inherits. node-designer.html and the comparison page inherit the page policy but never call the API.

## Preferences

`prefs.ts` reads `fs:llmRoute` (`engine`, `local` or `claude`), `fs:llmLocalBase`, `fs:llmLocalModel` and `fs:llmCloudModel`. Each is VALIDATED, never coerced, and falls back when it is not a known value. `GENERATOR_STORAGE_KEYS` (`utils/generatorFlag.ts`) lists them all after the opt-in key, for the study clean slate.

The dialog writes them through `saveGeneratorPref`:
- `fs:llmRoute` when a route is picked;
- `fs:llmLocalBase` after a Check that found a server;
- `fs:llmLocalModel` or `fs:llmCloudModel` on Generate.

Nothing secret is stored: the API key never is.

## A picture in the request

A request can carry ONE picture, and a picture alone is a request (owner, 2026-11-18; built 2026-11-20 as P9 step 1). What reaches a model is the app's own MEASUREMENT of it — never pixels, on any route — so it works with every model, including the small local ones that cannot see.

**The reader (`llm/picture.ts`).** The file is adversarial like every dropped one:
- SVG is refused outright (markup, not pixels); a file over 20 MB is refused before decoding; a decoded picture over `MAX_SOURCE_PIXELS` (64 MP) after it.
- It is decoded by the browser's own decoder (`createImageBitmap`, EXIF orientation applied) and by nothing else. The app draws it onto its OWN canvas at ≤ 256 px and measures THAT; the thumbnail is a ≤ 128 px PNG of the same kind of drawing. So no metadata, no markup and no byte of the file reaches the page or a model.
- The file itself is kept only for "Use the picture itself".

**The measurement (`llm/imageAnalysis.ts`, pure, no model).** On a 96-cell grid averaged in linear light:
- **colours**: k-means in Oklab from a FIXED start (so the result is deterministic), close centres merged, a rare colour lying between two common ones folded away (it is the blended edge the averaging makes), each colour reported as its cells' MIDDLE value per channel — a flat colour comes back exact (`#ff5a00`, not `#fe5a00`);
- **brightness and contrast**: mean and spread of the Oklab lightness;
- **scale**: light-and-dark cycles across and down (sign changes around the mean with a dead band, the median over rows and columns);
- **direction**: the structure tensor's dominant gradient; features are named by the way they RUN (horizontal, vertical, rising or falling to the right with an angle);
- **repetition**: the best self-match at a shift near one feature's length;
- **edges**: hard when nearly every cell sits at the dark or the light end;
- a **hint** from a fixed set (flat, gradient, stripes, streaks, grid, grain, blotches, clouds).

**What is sent (`pictureLines`).** A fixed frame of about eight lines around hex colours, counts, an angle and words from the module's own tables — about 120 tokens. Nothing in them is text from the file, so a picture cannot carry an instruction into the prompt (`imageAnalysis.test.ts` holds the lines to printable ASCII and a fixed first line). They follow the request line in `userText` and stay in every repair round. With no words the line is `PICTURE_ONLY_REQUEST` ("Make a shader that looks like this picture.", a constant in `prompt.ts`, never shown or translated), and the worked examples are picked by the hint's words (`pictureHintWords`) instead of the request's.

**In the dialog.** "Add picture…", paste (pasted TEXT still goes to the field) and drop anywhere over the dialog. One picture: a new one replaces the old and says so. A shader, project or model file dropped there is refused with "Close this window to open a shader file." — the dialog never opens a document behind itself. Generate needs words OR a picture. The group from a picture alone is labelled `From picture` (English data, like a dropped preset's label).

**"Use the picture itself"** is the only exact copy: it closes the dialog and hands the FILE to the canvas's own picture drop through `utils/picturePlaceRequest.ts` (`fs:place-pictures`). NodeEditor's `placePictureFiles` is the ONE queue behind a dropped file and this — the convert-or-keep question, the ghosts, every cap and budget, one note — so a handed-over picture gets exactly what a dropped one does. The listener takes only real `File`s that pass `isImageFile`.

**From a search box.** A picture pasted or dropped on the palette's search box opens the dialog with it (`utils/pictureTransfer.ts`, a util so the palette never imports `src/llm`); typed text becomes the request's words. It never starts a run. Gated by `useGeneratorOffer` like every entry; the Space menu takes no pictures.

**Not built yet** (P9 step 2 and §11.3): models that SEE the picture (Claude; the built-in model needs a second, pinned vision file), the cloud tick box that goes with sending pixels, and the automatic slider tuning against a hidden render.

**Checked 2026-11-20** in real Chrome against the dev server and a real LM Studio (`google/gemma-4-e2b`): a 480×320 picture of diagonal orange stripes pasted on the search box opened the dialog with its thumbnail; the request sent was the fixed line plus the block (`#ff5a00 52%, #1a1a1a 48%`, 3 features across and down, rising at about 35°, even, hard edges, "even stripes") and no pixels; the model answered a 16-node stripes shader in those two colours, added as "From picture". A second picture replaced the first, a `.js` was refused, and "Use the picture itself" raised the canvas's convert question and added one Image node.

## The search-box entry

Both search boxes offer the generator when a query reads as a REQUEST (owner, 2026-11-20). It only OFFERS: detection loads nothing and sends nothing, Enter opens the dialog and never starts it, and the request leaves the machine only on the dialog's own Generate.

**Where it is offered the box says so**: its placeholder reads "Find nodes or write a prompt" in both boxes (owner, 2026-11-20; the palette's box widens to 252 px for it, and for the Latvian), and "Search…" / "Search nodes..." everywhere else — a hosted build, a study, the embed, a running lesson, and the Space menu while it wires or splices.

**The switch has three states** under `fs:nodeGenerator` (`utils/generatorFlag.ts`, validated, never coerced):
- absent = `suggest`, the default: a detected query offers "✦ Set up AI…";
- exact `'1'` = `on`: written the first time a route works (`GeneratorDialog`'s `routeReady` effect);
- exact `'0'` = `off`: the Settings row "Suggest AI in search" unticked, or the dialog's "Don't suggest AI" link (shown while `suggest`). Every entry is gone.

Anything else stored reads as absent. `generatorOffered(mode, evalMode, build)` is true unless `off`.

**Detection** is the leaf `utils/promptDetect.ts` (its only import is the search fold), on the words of the folded query:

| Rule | Condition |
|---|---|
| T1 | 4+ words, not part of a known name |
| T2 | exactly 3 words, no ordinary result, not part of a known name |
| T3 | exactly 2 words, no ordinary result, and a trailing `?` or a request verb first |

- One word is never a request (the intro's search scene types "noise").
- Request verbs are English only (make, create, generate, build, give, want, need, how, i). Never "add" or "show": those are search verbs.
- **"No ordinary result" alone would misfire.** Search matches the whole phrase as ONE substring, so most multi-word names typed as plain words ("perlin noise vec3") find nothing. Hence the name guard, `partOfKnownName`: the query's words run along a known name's words, in order, from any word, the last one possibly unfinished. `promptDetect.test.ts` types every multi-word node, preset, texture and lesson name, in both languages, word by word and letter-short, and none is detected.
- **Known names** (`components/NodeEditor/promptKnownNames.ts`): every registry node's label in both languages and its `Also:` aliases, the lesson titles, the note's words; the asset bar adds preset, recipe and texture names and the saved groups'. A hidden node's name still counts.

**The asset bar** (`ContentBrowser.tsx`):
- detects on the SETTLED query and waits for the built-in libraries, which every live search loads anyway (their names are known names, and "no result" is said only once they were searched). The names list is built only under a live query, so an idle tab never pays the preset parse;
- "an ordinary result" is the All tab's: nodes, the note, presets, textures;
- one button after the input, drawn only while detected: "✦ Generate with AI" once the dialog's route has worked this session (`generatorRouteReady`, session-only), else "✦ Set up AI…";
- the All tab's no-match line gains "Press Enter to make it with AI.";
- Enter on a detected, settled query opens the dialog. Ctrl/Cmd+Enter opens it for ANY query (an empty box opens it empty) and starts at once only when the route already worked this session and there is text;
- one polite live-region announcement when a query becomes detected; when the dialog closes, focus returns to the box that opened it.

**The Space / right-click menu** (`menus/AddNodeMenu.tsx`): a LAST row under a divider, "Generate “…” with AI". Last, so a real match keeps the Enter key; with no match it is the only row. It passes the menu's canvas point as `at`, where an unwired result lands. Never on a menu opened by a dropped wire or an edge's Insert node: a generated group cannot take that wire's place.

**One opener.** Both boxes and the Settings row call the store's `openGenerator({ prompt, at?, autostart? })`, which writes the session-only `generatorRequest`; `GeneratorLauncher` renders the dialog from it and `closeGenerator` clears it. Opening is not an edit: no history entry, nothing stored. `generatorWiring.test.ts` pins that nothing else calls it and that no entry file reaches `src/llm`, the network or the study telemetry.

**One offer rule.** Both boxes ask `hooks/useGeneratorOffer.ts`: a build that can reach a model, the switch not `off`, and never a study session, the embed or a running lesson.

Not built yet: a picture pasted or dropped on the search box (P9), and the info-box setup panes for the LM Studio / Ollama and Claude routes (their forms are still P1's).

## The dialog and its Settings rows

**The toolbar's right-click Settings list** holds the switch, "Suggest AI in search" (ticked in `suggest` and `on`; `setNodeGenerator('on' | 'off')`), and under it, while not `off`, "Open the generator…", which opens the dialog empty. The rows are drawn only where `!isEvalMode() && !isEmbedMode() && NODE_GENERATOR_BUILD` (a build that can reach a model).

The Toolbar mounts `components/Layout/GeneratorLauncher.tsx`, which checks the same conditions again and loads the dialog with `lazyOr`. If the chunk cannot be fetched, it shows its own small modal fallback.

The dialog takes `{ initialPrompt, at?, autostart? }`. `autostart` fires once, the first time this dialog can generate, and is dropped the moment the user edits the request or changes the route. While the switch is `suggest`, the dialog shows one first-time line (what the AI sees, what is free) and the "Don't suggest AI" link. A request holding a Latvian letter shows "Write requests in English." and is still sent as typed.

**The dialog** (`GeneratorDialog.tsx`) has these parts:
- the route;
- a server check, or the key field;
- the request. It starts as this session's last request, held in memory only;
- Generate, and a live status line with the round and the elapsed time;
- the result: the plan, the node count, the price, the properties (renames shown), unused lines left out, and the code;
- Add.

How it behaves:
- **Keys.** The panel is `role="dialog"` + `aria-modal="true"`, so the canvas's own key handlers stand down behind it (`keysBehindDialogs.test.ts`). Its own `window` listener runs in the CAPTURE phase and stops every key but Tab. So Cmd+Z in the text box undoes the TEXT, never the graph. Escape cancels a run, else closes. Cmd/Ctrl+Enter generates, or adds a finished result.
- **Cancel.** Closing the dialog, Escape, unmounting and `pagehide` all abort a run and a running Check. On the desktop that sends the bridge's cancel, so the server stops generating.
- **The price** prints like every other figure: divided by the selected device's budget onto the fixed 100 (`useDeviceBudget`, `toBudgetPoints`, `<Points>`). The facts line turns red past 100.
- **Model text is DATA.** The plan, the problem lines, the code and the property names are React text nodes, never markup, and never go through `t()`. Problem lines stay English, like the parser's own diagnostics.
- **The example request stays English** in both languages (`placeholder`), because requests are written in English. The rest of the dialog is translated (`lv.json`; `generatorWiring.test.ts` fails on a `t()` string without its Latvian).
- **The key field** is a plain text field outside any `<form>`, with autocomplete and spellcheck off. A password field would invite the password manager to SAVE the key on a shared origin.

## Absent in a study session and the embed

This is a deliberate study decision, recorded in docs/dev/eval-mode.md: since 2026-11-10 a new feature reaches a study by default, and this one does not. Each gate refuses on its own:
- both search boxes (`useGeneratorOffer`: no detection, no button, no row, no key);
- the Settings rows (`generatorRow`);
- `GeneratorLauncher`, the dialog's render site;
- `runGeneration` (the dialog passes `inStudy: isEvalMode`);
- `addGeneratedGroup`;
- `offeredRoutes` returns `[]`;
- `generatorOffered` is false;
- `cleanSlateForStudy` removes every key in `GENERATOR_STORAGE_KEYS` and sets the store's switch to `off` with no open request. The next ordinary session on that machine starts at the default, `suggest`, with no route or choice remembered.

No file in `src/llm`, nor the launcher, calls `evalLog`.

The embed (`?embed=1`) mounts no toolbar, so it has no Settings list. The row and the launcher check `isEmbedMode()` as well: the host owns its own context, and a key typed into an iframe is a different trust question.

`generatorWiring.test.ts` pins all of these.

## Measured (2026-10-02 spike, re-scored 2026-10-08 with the real gate)

These were measured on the v0.3.36 engine, on this Mac through LM Studio. The owner blind-rated all 46 rendered tiles: 0 = not it, 1 = partly, 2 = clearly it.

| Model | Valid after repair | Median call | Median rating (n rendered) | Stalls past 8 min |
|---|---|---|---|---|
| google/gemma-4-e2b | 15/15 (100%) | 7 s | 1 (n=9) | 0/15 |
| qwen/qwen3-coder-next | 15/15 (100%) | 12 s | 1 (n=12) | 0/15 |
| google/gemma-4-31b | 4/4 of those that answered | 139 s | 1 (n=4) | 5/15 |
| qwen/qwen3.8-27b | 6/6 of those that answered | 80 s | 1 (n=6) | 3/15 |
| claude-opus-5-5 (ceiling) | 15/15 (100%) | — | 2 (n=15) | 0/15 |

**The go/stop rule** was fixed before the ratings came in. Go when at least one route gives mostly valid results (over half of what it answered, after repair) with a median blind rating of at least 1. **Result: GO.** The dense 27–31B models clear the bar only on the calls that answered inside the 8-minute cap. Counting the stalls as failures, they succeed on about 4/15 and 6/15.

**The recommended local model is `google/gemma-4-e2b`:** 100% valid after repair, zero stalls, 7 s a call here, and 3.1 GB at Q4, so it fits a machine with 8 GB of memory. Load it with at least a 16K context (`lms load <model> --context-length 16384`); below `LOCAL_MIN_CONTEXT` (12,288 tokens) the Check refuses the server.

`qwen/qwen3-coder-next` was just as reliable (12 s a call) and was the recommendation of 2026-10-09. That was withdrawn on 2026-11-18: it is an 80B mixture-of-experts model, 48.5 GB at Q4, so it needs a 64 GB machine and is no default for students' computers.

**Valid is not good on its own.** The gate guarantees safety and round-trip fidelity, not that "lava" looks like lava. Every model had a median rating of 1, and Claude Opus 5.5 alone reached 2.

## Deferred, with why

- **Chrome's built-in model**: shipped only if it reaches 50 % on tier 1 with the small catalogue, measured in real Chrome. Not measured, not built.
- **The JSON "steps" form**: only if a probe shows it helps small models by more than the tie margin. The text gate's exact rewrites already absorb the small models' common failures.
- **Ollama's native protocol** (`/api/chat` with `num_ctx`): its routes are already on the allow-list (`LLM_LOCAL_GET_ROUTES`/`POST_ROUTES`). The provider waits for a captured fixture. KNOWN LIMIT meanwhile: Ollama also answers the OpenAI-compatible routes, but those cannot set the context length. With Ollama's small default context a long prompt is cut without an error, so the result looks like a weak model.
- **Channel-object returns** (emissive, position, …) and **SDF** generation: both need an Output the ADD drops.
- **Color Ramp and RGB Curves**: would need a canonical stop-string form in the dialect, parsed and re-emitted through `utils/colorRamp.ts`/`utils/rgbCurves.ts` like every other stored value.
- **The probe matrix and the spike harness**: still in the generator's worktree, not in this repo.

## Owed verification

- **The desktop route.** The bridge and its client are in, but no desktop build has run them on main yet. Test on a real `tauri dev`, `.dmg` and Windows installer against LM Studio: the server stopped, a JIT load, a 4,096-token context, a cancel mid-stream, a tampered base, and a reload during a run (`page_load_guard`).
- **The cloud route.** No real Claude call has been made on main. Make one with a key against a BUILT `dist` (`FS_LLM_CLOUD_ORIGINS=https://api.anthropic.com npm run build`, then `vite preview`), since the dev server has no CSP and cannot catch a mismatch; and from the desktop app, for CORS from `tauri://localhost` and `http://tauri.localhost`.
- **The dev server's proxy** against a real LM Studio (so far only a stand-in server).
- **Safari and Firefox.** The dialog was smoke-tested in Chrome only. Owed in both: the dialog itself, and the Claude route's streaming and CORS.
- **The served policies.** The next deploys' own verify steps check them: no host's page may name the API.
- **The bundled engine in the real desktop app.** `engine.rs`'s ignored tests ran the whole path against the real engine on a development Mac (2026-11-20): a real download checked and placed, a wrong pin refused, the pinned model served and stopped. Not yet run through the WEBVIEW in a built app: the offer, the progress bar, Pause / Resume / Cancel, a Generate through the engine, the idle stop after 10 minutes, and quitting mid-download.
- **Windows, all of it.** The Job Object, `CREATE_NO_WINDOW` and the in-place run compile and lint for `x86_64-pc-windows-msvc` and have never run.
- **The bundled engine on a clean Mac** (P5's go/no-go): a `.dmg` downloaded through a browser, opened with "Open Anyway", the built-in route's survey reaching `ok`. The copy-out was measured on a development Mac with every file marked, not yet on a machine that has never run a developer tool.
- **The bundled engine on Windows**: the installer and the portable zip both reaching `ok`; a machine without the Visual C++ runtime showing `runtime-missing`; a laptop with integrated graphics listing its Vulkan device.
