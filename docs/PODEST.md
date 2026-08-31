# Podest

A standalone full-screen viewer for TSL shaders — drop a file, get a shader on a
3D object filling the screen. It is one self-contained HTML page
([`podest.html`](../public/podest.html)) with no build step and no framework, and it is
built to run on a pedestal display for **weeks** with nobody touching it.

Podest is a *player*, not an editor: it shows shaders exported from FastShaders
(or any TSL module in the same format) and lets you tune whatever properties
they expose.

## Opening it

| Where | URL |
| --- | --- |
| The editor's toolbar | the **P** button — a new tab on the web, its own app window on desktop |
| GitHub Pages | `<origin>/FastShaders/podest.html` |
| alvismisjuns.lv | `https://alvismisjuns.lv/fastshaders/podest.html` |
| Desktop app | its own window, opened by **P** |
| `npm run dev` | <http://localhost:5173/FastShaders/podest.html> |
| Self-hosted | `<wherever you put it>/podest.html` — see [Self-hosting](#self-hosting) |

## Showing something

**Drop a file anywhere on the page** (or click the panel's drop tile to pick
one):

- **Shader** — `.js`, `.mjs`, `.tsl`, `.txt`. A FastShaders export, or any ES
  module that default-exports a TSL `Fn` and imports from `three/tsl`.
- **Model** — `.glb`, `.gltf`, `.obj`. Becomes the mesh the shader runs on, adds
  a *Loaded model* entry to the geometry picker and selects it.
- **Archive** — `.zip`. Unzipped in the browser; the first shader and the first
  model inside are loaded. If a drop contains a `.zip`, the zip wins and the
  other files in that drop are ignored.

A shader and a model can be dropped together. Nothing prompts on a drop — the
one confirmation in Podest guards *Enter VR*.

Loading a **different** shader clears the tuned property values, so a folder of
unrelated exports whose uniforms all happen to be called `property1` cannot
inherit the previous piece's tuning. Re-loading the same source keeps it.

## The panel

Top-right; click its header to collapse it. Top to bottom:

**Work folder…** — pick a folder of exported shaders and every `.js`, `.mjs`,
`.tsl` and `.zip` inside it (up to 512 files, 3 levels deep) appears in a
dropdown. Then:

- **Cycle** — show each one in turn (needs at least two)
- **Shuffle** — random order
- **seconds** — how long each shader stays up (5–3600, default 30)

The next entry is read ahead at the start of each stay, so a cloud-synced file is
already hydrated when its turn comes. The folder itself **cannot be remembered**
across a reload — re-granting access needs a fresh click every time — but the
last shader *shown* still comes back on its own (see below).

**Drop tile** and the **loaded** summary — what shader and model are on screen.

**Fullscreen** (green) — enters presentation mode. On a headset this button
becomes **Enter VR** instead.

**Scene**
- Geometry — Sphere · Cube · Plane · Teapot · Bunny (+ *Loaded model*)
- **Spin** — turntable; its speed slider (0.1×–4×) appears only while spinning
- **Show model materials** — appears once a model is loaded; swaps between the
  shader and the model's own PBR materials
- **Reset view** — back to the saved framing
- **Background** — scene colour (default `#303540`)
- **Show FPS and frame time** — a top-left readout. This is the *presented*
  frame period, so it reads the display's refresh rate until the shader actually
  misses frames. Off by default and completely silent when off.

**Unattended** (both on by default)
- *Reopen the last file after a reload*
- *Return the view after 90 s idle*

**Title** — *Show the name over the shader*. The name is taken from the dropped
file (underscores read as spaces); click it to change its text and colour. Only
a name you typed is remembered — an auto-derived one does not outlive the shader
it came from.

**Properties** — one row per uniform the loaded shader exposes: a number box, a
slider and editable min/max bounds (colour properties get a colour picker). The
bounds are remembered per name; the values ride the session record.

## Presentation mode

The floating **⛶** button (bottom-right) hides every control and shows only the
artwork and, if enabled, its title. **⤡** leaves.

Presentation mode is deliberately **wider than the browser's Fullscreen API and
is remembered**. Fullscreen can only be entered by a click, and an unattended
pedestal has nobody to click after a browser auto-update or a power blip — it
would come back windowed with the panel sitting over the artwork and, worse,
with no screen wake lock, so the display would blank at the OS idle timeout and
stay black for the rest of the week. So entering ⛶ once at install survives every
restart.

To get the controls back: press **⛶**, then **Esc**.

`?present=1` pins presentation mode for a kiosk launcher. Note that it is read
once at load and never cleared, so on a URL carrying it the ⛶-then-Esc escape
does not restore the chrome — edit the URL instead.

While presenting, Podest **hides** the panel, the drop hint, the error banner and
the animation controls, and **keeps** the title, the FPS readout if you enabled
it, the faded ⛶, and the microphone light — that light is a privacy indicator,
and an indicator that disappears exactly when the machine is left unattended
would be the worst possible behaviour.

The screen wake lock is requested at boot, on entering presentation mode, when
the tab becomes visible, and again every five seconds — platforms drop locks on
their own, so the only robust approach is to keep asking.

**90 s idle → the view returns** to the framing that was on screen when
presentation mode was entered. A visitor spins the model and walks away; the
exhibit should not stay where they left it.

## Running unattended

Everything below is on by default and needs no configuration.

**It reopens itself.** The last drop — shader, model, geometry, title and the
**tuned property values** — is mirrored to IndexedDB and replayed at boot. The
tuning is part of the artwork; losing it to a reload would quietly show the wrong
piece. A file dropped while the restore is still loading always wins. (Turn
*Reopen the last file after a reload* off and the record is deleted.)

**The 3D stage is disposable.** Everything on screen is re-derivable, so if the
renderer dies the stage is rebuilt and the whole state replayed — invisibly.
Failures that trigger a rebuild:

- **Device loss** — detected three ways, including the case where three.js
  swallows the reason and never calls its own callback.
- **A stall** — a 5 s heartbeat carries the renderer's cumulative draw-call
  count; no heartbeat or no progress for 30 s is a restart. The watchdog pauses
  while the tab is hidden, where a frozen counter is normal.
- **A stage that never starts** — no bridge at all within 45 s of a start, i.e.
  the boot itself died. This is the likeliest failure at install time, and it is
  checked before the heartbeat rules rather than by them.

And one thing is handled without any rebuild at all:

- **Time drift** — three's `time` is a 32-bit float counting seconds since boot,
  so its resolution decays to ~8 ms after a day, ~62 ms after a week and ~250 ms
  after a month, which turns a smooth animation into a slideshow. Podest folds
  the clock **in place** every ~4.4 h at an exact multiple of 2π, so `sin(time)`
  crosses the fold with no visible jump. Only the rare case where the clock
  cannot be reached at all falls back to restarting the stage.

Restarts are floored at 30 s apart; after six consecutive failures it backs off
to one quiet retry every ten minutes. **It never gives up permanently** — a
transient driver fault must not end the exhibit. It says so in a sticky error
banner, which — like every banner — is hidden while presenting, so leave
presentation mode to find out why a stage keeps failing.

**Long playlists stay healthy.** Every shader swap costs one dynamic import that
can never be unloaded from a living document, so every 40th swap rebuilds the
stage — about 20 minutes apart at the default 30 s stay.

Error messages from the shader are rate-limited inside the sandbox (identical
repeats and anything past 20/minute are dropped), so a shader logging once per
frame cannot flood the page. Banners dismiss themselves after 20 s unless the
stage can never work.

### Setting up a pedestal

1. Open Podest on the machine, drop the shader, tune it, name it.
2. Press **⛶** once. That arms presentation mode for good.
3. Optionally point the kiosk launcher at `…/podest.html?present=1`.

After a reboot or a browser update the page comes back presenting, wakes the
display, and reopens the last file by itself. What it cannot do for you: launch
the browser, dismiss an OS update dialog, or survive the machine being logged
out — those stay the operating system's job.

## VR

On a headset the green panel button becomes **Enter VR** (resolved from
`navigator.xr`, never a user-agent guess). The floating ⛶ keeps its fullscreen
meaning — it is the way out of presentation mode, and repurposing it would strand
a headset that had ever entered one.

Entering VR asks for confirmation whenever it would run a dropped file — a
loaded shader, or a dropped model used as the geometry — because it is the one
moment that file leaves the sandbox. (With only built-in geometry and no shader
there is nothing untrusted to run, so it goes straight through.) The message
reads, with "model" in place of "shader" when only a model is loaded:

> Enter VR shows the loaded shader **outside** Podest's protective sandbox
> (WebXR cannot start inside it). Only continue if you trust where this file
> came from.

WebXR genuinely cannot start in the sandboxed stage — Chromium denies
permissions to opaque origins outright, and Quest Browser can crash on it — so
*Enter VR* opens a top-level popup at the page's real origin and bakes the
current state into it.

In the headset you can move around: press the controller trigger (or pinch) to
aim and release to teleport; with the bare-hand gesture, hold a fist thumb-up to
aim and then fold the thumb down onto your index finger to go — opening the hand
cancels instead. A ring shows where you will land, and an arc of beads connects
you to it; the ring turns amber when
your aim has been clamped to the 1.2 m–30 m ring you are allowed to move in.
The jump happens behind a blink. Hands are drawn from the tracked joints. After
90 s of a completely motionless head — which only happens when nobody is wearing
the headset — the view returns home.

Known limits: the VR view is a visitor moment, not an exhibit, so none of the
long-run guards run inside it; it is silent (see below); and **in the desktop
app Enter VR does not work** — `window.open` returns null in a webview, so
Podest reports the popup as blocked. Use a browser for VR.

## Model animation

A dropped `.glb`/`.gltf` carrying animation clips plays automatically — a
pedestal showing an animated model standing still reads as broken, not paused. A
pill appears bottom-left with **▶/⏸**, **◎** (play in place — hold the model
still and drop the animation's root movement) and **☰** (pick a clip), plus a
scrubber. Right-click or long-press anywhere on the pill also opens the clip
list.

The playhead, clip and toggles survive a stage rebuild. The controls are hidden
in presentation mode — playback chrome over the artwork is exactly what
presentation mode exists to remove.

DRACO- and meshopt-compressed glTF are not supported (no decoder is bundled);
such a file reports a parse error rather than failing silently.

## Microphone

Shaders built with FastShaders' **Mic** node react to sound. Podest can drive
them: when the loaded shader declares microphone uniforms, a round arm light
appears bottom-left. Click it to start, click it again to stop. It blinks red
while listening, and stays visible in presentation mode as the privacy
indicator.

Nothing is recorded — only four numbers (overall level, bass, mid, treble) reach
the shader.

**Podest never arms the microphone on its own**, and that is deliberate rather
than an omission. Permission is keyed to the origin, and Podest replays its last
drop at every boot — so an auto-arm would let a shared file open the microphone
silently at every boot, for weeks, on a machine nobody is watching. A drop never
arms; a drop always disarms.

Two gaps worth knowing: the **Audio Input** node (tab/system audio) is *not*
driven here — its uniforms stay at zero — and the VR popup is silent.

## Self-hosting

Podest works on any plain static server with no configuration. Copy these files,
keeping the layout:

```
podest.html                          202 KB
js/a-frame-180-a-01.min.js           1.6 MB
js/a-frame-shaderloader-0.6.js        36 KB
js/aframe-orbit-controls.min.js       25 KB
models/teapot.obj                    212 KB   ┐ only for the Teapot /
models/stanford-bunny.obj            2.4 MB   ┘ Bunny geometry options
images/favicon-podest.svg              2 KB
```

4.3 MB in total, or 1.8 MB without the two models — dropping them costs only
those dropdown entries, which then report a 404 in a dismissible banner.
Everything resolves relative to wherever `podest.html` sits. Nothing else is
fetched: no CDN, no web font, no analytics.

An `http(s)` server is required (`file://` will not work). Podest ships no
Content-Security-Policy of its own, so a policy your host sends is the only one
in effect — it must permit `srcdoc` iframes and `blob:` URLs.

## Security model

Dropped and shared shader code is treated as **adversarial**. It runs only
inside a sandboxed iframe with no same-origin access, so it cannot reach the
page, its storage or the drop UI; the two sides exchange nothing but
postMessages, and messages are accepted by frame identity. A dropped `.gltf` can
name buffers and textures by absolute URL, so the stage allowlists `blob:` and
`data:` and neutralises everything else — a shared file cannot phone home with
the viewer's IP.

The one deliberate crossing is *Enter VR*, which is why it asks first.

## Limits

| | |
| --- | --- |
| Shader source remembered | 24 MB |
| Model remembered | 64 MB — a larger model still loads, it just is not restored after a reload |
| Zip | 512 entries, 64 MB inflated, 256-character names; STORE + deflate only |
| Work folder | 512 files, 3 levels deep |
| Title | 120 characters |
| Not supported | DRACO / meshopt glTF compression |

## Reference

**Query parameters** — `?present=1` only.

**Keyboard** — `Esc` closes the clip menu and leaves fullscreen; `Enter`/`Space`
on the title opens its editor; arrows / `Home` / `End` scrub the animation
timeline when it has focus. There are no other global shortcuts.

**Remembered settings** (per browser): spin and its speed, background colour,
per-uniform slider bounds, title text, title colour and whether the title is
shown, FPS readout, auto-restore, presentation mode, idle view return, animation
play/in-place, and the shuffle and seconds settings. The loaded file, its tuned values and the geometry live in
the IndexedDB session record instead; the work folder and the animation clip
index are not remembered at all.

## For developers

`podest.html` has no build step — it is copied verbatim into every deploy, which
is why its asset references are relative and why it receives no CSP meta tag.
Several parts of it are hand-maintained twins of editor modules. `fit-bounds`,
`gltf-anim` and the VR locomotion layer are pinned by tests under `src/`
(`previewFitBounds`, `previewGltfAnim`, `podestVrNav`) rather than by any sync
step. The microphone band analysis and the zip reader's caps are hand-kept
copies with **no test behind them** — change those by hand, together with their
originals. (They have already drifted once: the zip name-length cap is 256 here
and 512 in `src/utils/zipReader.ts`.) On desktop it is opened by a small Rust command
that must keep `disable_drag_drop_handler()` — without it the OS swallows every
HTML5 drop and a drag-drop-first page cannot be given a file at all.

See `CLAUDE.md` for the full conventions.
