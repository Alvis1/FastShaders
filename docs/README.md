# docs

Images and diagrams used by the repository's markdown files. Deliberately **not**
in `public/` — that directory is "everything the app serves", and it is copied
into `dist/` on every build and uploaded on every deploy. Nothing here ships
with the app.

## `dev/`

The reasoning behind `CLAUDE.md`'s rules — the measurements, browser results and
rejected approaches — moved out of the always-loaded context. See
[dev/README.md](dev/README.md) for the index. These are prose, not images, but they
belong here for the same reason: nothing in `docs/` ships with the app.

## `fastshaders-function-diagram.{png,svg}`

The architecture / data-flow diagram in the root [README](../README.md):
imports (images, 3D models, Gaussian splats, palettes, audio, data files, a
benchmark profile) → node editor ↔ TSL code editor → preview, cost estimate,
export, and the ShaderCarousel / Podest / ShaderLoader satellites.

**The README references the PNG, and that is deliberate — do not "upgrade" the
link to the SVG.** The SVG is a draw.io (mxGraph) export in which every label is
HTML inside a `<foreignObject>` element, with no SVG `<text>` fallback. A
markdown image becomes an `<img>`, and an SVG loaded as an image renders in a
restricted mode where `foreignObject` content is not drawn in several browsers
(Firefox notably) — so the SVG shows the boxes and arrows with **no text at
all**, while looking perfect in Chrome and in any editor that opens it as a
document. The PNG renders identically everywhere.

The SVG is kept as the editable source: it still carries its embedded
`mxGraphModel`, so draw.io can reopen and edit it directly. Save a new revision
over this file name rather than beside it, so the README keeps pointing at one
diagram. After editing, regenerate the PNG at 2×:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --blink-settings=preferredColorScheme=1 --force-device-scale-factor=2 \
  --window-size=711,661 --screenshot=out.png file://$PWD/fastshaders-function-diagram.svg
magick out.png -strip -colors 256 fastshaders-function-diagram.png
```

The window is a CROP, not the SVG's size. The diagram's outer frame ends at
about 692 × 636 CSS px, but the SVG declares 1547 px wide, because the drawing
also holds a stray, unconnected "iframe" label far to the right of the frame.
711 × 661 keeps the frame with a white margin and leaves that label out. If a
revision moves the frame's edge, render with a large window first and read the
frame's bounds off that (`magick big.png -trim info:` measures everything,
stray label included, so check the frame by eye). An earlier revision of this
note said 784 × 449, which cut off the bottom third of the diagram.

`preferredColorScheme=1` is insurance, kept because this has bitten once. An
earlier revision embedded the theme-aware `favicon-podest.svg`, whose `.ink` rule
flips to near-white under `prefers-color-scheme: dark`; headless Chrome inherits
the machine's appearance, so rendering on a Mac after dark silently produced a
diagram with an invisible Podest logo on the white background. The current SVG
embeds plain marks and renders identically in either scheme (verified: zero
differing pixels), but pin it anyway so a future re-export cannot reintroduce
the problem — and if you do embed a theme-aware mark, remember the SVG itself
will still show it near-white in a dark-mode browser, because the diagram's own
background stays white.

The 256-colour quantisation is visually lossless on a flat-colour diagram and
about a third of the size.

Re-exporting from draw.io with **Text Settings → SVG** would produce real
`<text>` labels and make the SVG safe to reference directly.
