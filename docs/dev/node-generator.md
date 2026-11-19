# Text → node generator (`src/llm/`)

"Generate nodes from text": the user types a request ("glowing lava cracks on dark rock"), a model writes a small TSL program, and the app turns it into ONE group of ordinary nodes parked beside the graph, wired to nothing. It is experimental, **off by default** (`fs:nodeGenerator`, exact `'1'`, `utils/generatorFlag.ts`) and **absent in study sessions and the embed**. The planning record (research, designs, the skeptic reviews, the spike) lives in the gitignored `private/docs/llm-generator/`. This file is the reasoning for what was built.

**What is in the app (2026-11-19).**
- The core: the gate, the prompt and examples, the repair rounds, the placement, both providers, the fetch transport, the preferences and the opt-in leaf.
- The desktop's Rust bridge (`src-tauri/src/llm.rs`) and its client, `transport/tauriTransport.ts`.
- The dev server's same-origin proxy to a local model server (`llmDevProxyPlugin`, below).
- The per-build policy: `FS_LLM_CLOUD_ORIGINS` puts the Claude API in a web build's `connect-src` and turns the route on. No hosted build sets it (owner, 2026-11-19), and the host deploys check what is served (below).
- The dialog (`llm/GeneratorDialog.tsx`), the store flag and its ONE entry: the toolbar's right-click Settings list (below, "The dialog and its entry").
- The study clean slate's generator keys.

Still to come: the search-box entry, which replaces the Settings row as the way in.

The generator was built on v0.3.36 in a worktree and ported to main on 2026-11-19. The port's engine fixes are below, under "Holding the gate on a moving engine".

## Routes and what is sent where

| Route | Where | Carried by | What leaves the machine |
|---|---|---|---|
| **This computer** (LM Studio, llama.cpp — the OpenAI-compatible API) | desktop app; dev server | desktop: the Rust bridge `src-tauri/src/llm.rs`, loopback only, through its client `transport/tauriTransport.ts`; dev: `transport/fetchTransport.ts` to the dev server's own same-origin proxy (`llmDevProxyPlugin`) | nothing |
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
- the Output left out (there is nothing to drive yet);
- fresh ids;
- one frame parked beside the graph;
- ONE undo entry and `fs:graph-merged`.

**A change to that path changes this one; that coupling is the point.**

The canonical text is comment-free (no project block for the ADD to find), `Fn`-shaped (scriptToTSL passes it through), image-free and zero-warning. So the ADD parses exactly the graph the gate verified; `scriptToTSLWithSettings(tsl).code === tsl` is pinned. It posts its own note (`generated-added`: "wire its last node into an Output to see it"). It refuses in a study session. Its only caller is the dialog's Add.

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
- **What it forwards.** Only `/v1/models`, `/api/v1/models` and `/v1/chat/completions`, to `FS_LLM_DEV_TARGET` (unset or empty: `http://127.0.0.1:1234`, LM Studio). A target that is not a loopback `http` base with no path stops the dev server. Every other path goes on to the rest of the dev server.
- **What it sends.** `Host` set to the target, `Accept` and `Content-Type`; never an `Origin` of its own, like the Rust bridge. A closed page or a Cancel ends the upstream request, so the model stops.
- **Whom it answers: this dev server's own pages only.** Two attacks reach it from another website open in the same browser:
  - a cross-site request. Even one whose answer the page cannot read can START a generation (a no-cors POST). Refused by its `Sec-Fetch-Site` (anything but `same-origin`) and its `Origin` (anything but `http://<Host>`);
  - DNS REBINDING: the attacker's own name resolves to 127.0.0.1, so the browser counts its requests as same-origin and both checks above pass. Refused by the `Host`, which must be `localhost`, `127.0.0.1` or `[::1]` with an optional port. Vite's own host check does not cover this middleware, because a plugin's middleware runs before Vite's.
- **Checked** by `llmCspContract.test.ts`, which runs the real middleware against a stand-in model server on loopback, and on 2026-11-19 against a running dev server (port 5194): a rebinding `Host`, a cross-site request and a foreign `Origin` got 403; a request from its own page reached a stand-in server, which saw no `Origin`. It has not yet run against a real LM Studio.

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

`prefs.ts` reads `fs:llmRoute`, `fs:llmLocalBase`, `fs:llmLocalModel` and `fs:llmCloudModel`. Each is VALIDATED, never coerced, and falls back when it is not a known value. `GENERATOR_STORAGE_KEYS` (`utils/generatorFlag.ts`) lists them all after the opt-in key, for the study clean slate.

The dialog writes them through `saveGeneratorPref`:
- `fs:llmRoute` when a route is picked;
- `fs:llmLocalBase` after a Check that found a server;
- `fs:llmLocalModel` or `fs:llmCloudModel` on Generate.

Nothing secret is stored: the API key never is.

## The dialog and its entry

**The entry is the toolbar's right-click Settings list.** "Generate nodes from text" is a checkbox row there (the opt-in, `setNodeGenerator`). Once it is ticked, a second row, "Open the generator…", opens the dialog. The rows are drawn only where `!isEvalMode() && !isEmbedMode() && NODE_GENERATOR_BUILD` (a build that can reach a model). The search-box entry will replace this as the way in.

The Toolbar mounts `components/Layout/GeneratorLauncher.tsx`, which checks the same conditions again and loads the dialog with `lazyOr`. If the chunk cannot be fetched, it shows its own small modal fallback.

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
- the Settings rows (`generatorRow`);
- `GeneratorLauncher`, the dialog's render site;
- `runGeneration` (the dialog passes `inStudy: isEvalMode`);
- `addGeneratedGroup`;
- `offeredRoutes` returns `[]`;
- `generatorOffered` is false;
- `cleanSlateForStudy` removes every key in `GENERATOR_STORAGE_KEYS` and turns the flag off, so a `'1'` left by a previous user cannot reach the next session on that machine.

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
- **The served policies.** The next deploys' own verify steps check them: the API on alvismisjuns.lv, and nowhere on fs.sferas.lv.
