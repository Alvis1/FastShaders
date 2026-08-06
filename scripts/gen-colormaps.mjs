/**
 * Generate src/utils/colormapData.ts from the authoritative upstream tables.
 * Downsamples each 256-entry map to the smallest uniform anchor count whose
 * piecewise-linear reconstruction stays within MAX_ERR (in 0-255 sRGB units).
 */
import { readFileSync, writeFileSync } from 'fs';

const SRC = new URL('./cmapsrc/', import.meta.url).pathname;
const MAX_ERR = 2; // max per-channel reconstruction error, 0-255 sRGB units

// ── parsers ────────────────────────────────────────────────────────────────

/** Pull a `_name_data = [[r, g, b], ...]` block out of a matplotlib source. */
function parseListData(file, name) {
  const text = readFileSync(SRC + file, 'utf8');
  const start = text.indexOf(`_${name}_data = [`);
  if (start < 0) throw new Error(`missing _${name}_data in ${file}`);
  // Scan forward balancing brackets from the opening `[` of the outer list.
  let i = text.indexOf('[', start);
  let depth = 0;
  let end = -1;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '[') depth++;
    else if (text[j] === ']') {
      depth--;
      if (depth === 0) { end = j + 1; break; }
    }
  }
  const block = text.slice(i, end);
  const rows = [...block.matchAll(/\[\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)\s*\]/g)]
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  if (rows.length !== 256) throw new Error(`${name}: expected 256 rows, got ${rows.length}`);
  return rows;
}

/** matplotlib LinearSegmentedColormap segmentdata → 256 samples. */
function parseSegmentData(file, name) {
  const text = readFileSync(SRC + file, 'utf8');
  const start = text.indexOf(`_${name}_data = {`);
  if (start < 0) throw new Error(`missing _${name}_data in ${file}`);
  const end = text.indexOf('\n}', start);
  const block = text.slice(start, end);
  const chan = {};
  for (const key of ['red', 'green', 'blue']) {
    const ks = block.indexOf(`'${key}': [`);
    const ke = block.indexOf('],', ks);
    const pts = [...block.slice(ks, ke).matchAll(/\(\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)\s*\)/g)]
      .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    if (!pts.length) throw new Error(`${name}.${key}: no control points`);
    chan[key] = pts;
  }
  const at = (pts, x) => {
    if (x <= pts[0][0]) return pts[0][2];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, , y1a] = pts[i - 1];
        const [x1, y0b] = pts[i];
        const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
        return y1a + (y0b - y1a) * f;
      }
    }
    return pts[pts.length - 1][1];
  };
  return Array.from({ length: 256 }, (_, i) => {
    const x = i / 255;
    return [at(chan.red, x), at(chan.green, x), at(chan.blue, x)];
  });
}

/** Whitespace- or comma-separated 256-row float table (Crameri .txt, CET .csv). */
function parseTable(file) {
  const rows = readFileSync(SRC + file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/[\s,]+/).map(Number))
    .filter((r) => r.length >= 3 && r.every(Number.isFinite));
  if (rows.length !== 256) throw new Error(`${file}: expected 256 rows, got ${rows.length}`);
  return rows.map((r) => [r[0], r[1], r[2]]);
}

/** CIE L*-linear greyscale — the perceptually uniform grey ramp. */
function lstarGrey() {
  const yToSrgb = (y) => (y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055);
  return Array.from({ length: 256 }, (_, i) => {
    const L = (i / 255) * 100;
    const Y = L > 8 ? Math.pow((L + 16) / 116, 3) : L / 903.3;
    const s = Math.min(1, Math.max(0, yToSrgb(Y)));
    return [s, s, s];
  });
}

// ── downsample + error check ───────────────────────────────────────────────

const q = (v) => Math.min(255, Math.max(0, Math.round(v * 255)));

/** Take `k` uniformly spaced anchors (endpoints included) from a 256-row table. */
function anchors(rows, k) {
  return Array.from({ length: k }, (_, i) => {
    const x = (i * 255) / (k - 1);
    const lo = Math.floor(x);
    const hi = Math.min(255, lo + 1);
    const f = x - lo;
    return [0, 1, 2].map((c) => rows[lo][c] + (rows[hi][c] - rows[lo][c]) * f);
  });
}

/** Max per-channel error (0-255) of reconstructing 256 samples from `k` anchors. */
function reconstructionError(rows, anch) {
  const k = anch.length;
  let max = 0;
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (k - 1);
    const lo = Math.floor(x);
    const hi = Math.min(k - 1, lo + 1);
    const f = x - lo;
    for (let c = 0; c < 3; c++) {
      const v = anch[lo][c] + (anch[hi][c] - anch[lo][c]) * f;
      max = Math.max(max, Math.abs(q(v) - q(rows[i][c])));
    }
  }
  return max;
}

function toHexStops(rows, name) {
  for (const k of [17, 33, 65, 129, 256]) {
    const a = anchors(rows, k);
    // Quantize FIRST, then measure — the emitted file only carries the 8-bit hex.
    const qa = a.map((c) => c.map((v) => q(v) / 255));
    const err = reconstructionError(rows, qa);
    if (err <= MAX_ERR || k === 256) {
      const hex = qa
        .map((c) => c.map((v) => q(v).toString(16).padStart(2, '0')).join(''))
        .join(',');
      return { hex, k, err };
    }
  }
}

// ── catalogue ──────────────────────────────────────────────────────────────

const MAPS = [
  // [id, label, kind, source loader, provenance]
  ['viridis', 'Viridis', 'sequential', () => parseListData('_cm_listed.py', 'viridis'), 'matplotlib (CC0)'],
  ['magma', 'Magma', 'sequential', () => parseListData('_cm_listed.py', 'magma'), 'matplotlib (CC0)'],
  ['inferno', 'Inferno', 'sequential', () => parseListData('_cm_listed.py', 'inferno'), 'matplotlib (CC0)'],
  ['plasma', 'Plasma', 'sequential', () => parseListData('_cm_listed.py', 'plasma'), 'matplotlib (CC0)'],
  ['cividis', 'Cividis', 'sequential', () => parseListData('_cm_listed.py', 'cividis'), 'matplotlib (CC0)'],
  ['batlow', 'Batlow', 'sequential', () => parseTable('batlow.txt'), 'Crameri (MIT)'],
  ['lajolla', 'Lajolla', 'sequential', () => parseTable('lajolla.txt'), 'Crameri (MIT)'],
  ['grey', 'Grey (L*)', 'sequential', lstarGrey, 'CIE L*-linear, generated'],
  ['turbo', 'Turbo', 'rainbow', () => parseListData('_cm_listed.py', 'turbo'), 'Google (Apache-2.0)'],
  ['coolwarm', 'Cool-Warm', 'diverging', () => parseSegmentData('_cm.py', 'coolwarm'), 'Moreland via matplotlib (CC0)'],
  ['vik', 'Vik', 'diverging', () => parseTable('vik.txt'), 'Crameri (MIT)'],
  ['roma', 'Roma', 'diverging', () => parseTable('roma.txt'), 'Crameri (MIT)'],
  ['isoluminant', 'Isoluminant', 'isoluminant', () => parseTable('isolum_cgo70.csv'), 'Kovesi CET (CC-BY)'],
  ['isoluminantDiv', 'Isoluminant Diverging', 'isoluminant', () => parseTable('isolum_div_cjm75.csv'), 'Kovesi CET (CC-BY)'],
];

const entries = MAPS.map(([id, label, kind, load, src]) => {
  const rows = load();
  const { hex, k, err } = toHexStops(rows, id);
  console.log(`${id.padEnd(16)} ${String(k).padStart(4)} stops  maxErr=${err}/255  (${src})`);
  return { id, label, kind, hex, k, err, src };
});

const bytes = entries.reduce((n, e) => n + e.hex.length, 0);
console.log(`\ntotal stop-string bytes: ${bytes}`);

const out = `/**
 * Colormap catalogue — the perceptually uniform / colour-vision-safe ramps the
 * scientific-visualization community actually uses, plus the two isoluminant
 * maps that matter specifically on a LIT 3D surface.
 *
 * GENERATED from upstream tables — do not hand-edit the stop strings. Each map
 * is stored as N uniformly spaced sRGB hex anchors; \`sampleColormap\` does the
 * piecewise-linear reconstruction. N per map was chosen as the smallest of
 * {17, 33, 65, 129, 256} whose reconstruction stays within ${MAX_ERR}/255 of the
 * original 256-entry table, so the catalogue costs a few KB instead of ~30.
 *
 * WHY THESE MAPS: a rainbow/jet ramp has no perceptual ordering and its
 * uncontrolled luminance introduces gradients the data does not contain
 * (Borland & Taylor 2007); the maps here are perceptually uniform and readable
 * with colour-vision deficiency (Crameri, Shephard & Heron, Nat. Commun. 2020).
 * Turbo is included as the ONE rainbow-family option because the more recent
 * counterpoint (Ware et al., "Rainbow Colormaps Are Not All Bad", IEEE CG&A)
 * finds rainbow maps genuinely better at resolving fine local detail — it is
 * marked \`kind: 'rainbow'\` so the UI can say so rather than hide it.
 *
 * THE ISOLUMINANT ENTRIES ARE NOT DECORATIVE. On a shaded 3D mesh a map with a
 * strong lightness ramp competes with shape-from-shading and flattens the
 * geometry; an isoluminant map holds perceptual lightness constant so lighting
 * reads shape and hue reads value (Kindlmann et al. 2002; Kovesi, "Good Colour
 * Maps: How to Design Them", arXiv:1509.03700). The trade-off is real — vision
 * resolves luminance far better than hue, so an isoluminant map carries less
 * fidelity for high-frequency data. That is a choice for the user to make, which
 * is why both families ship.
 *
 * PROVENANCE / LICENCE
 *   viridis, magma, inferno, plasma, cividis, coolwarm — via matplotlib (CC0).
 *     cividis: Nuñez, Anderton & Renslow, PLOS ONE 2018. coolwarm: Moreland 2009.
 *   batlow, lajolla, vik, roma — Fabio Crameri, Scientific colour maps (MIT).
 *   turbo — Copyright 2019 Google LLC, Apache-2.0 (Anton Mikhailov).
 *   isoluminant* — Peter Kovesi, CET perceptually uniform colour maps (CC-BY),
 *     via the colorcet distribution.
 *   grey — generated here as a CIE L*-linear ramp (not a raw 0→255 sRGB ramp,
 *     which is perceptually front-loaded).
 *
 * All stop values are sRGB-ENCODED, i.e. exactly what the upstream tables
 * publish. Anything sampling these for the GPU must convert to linear-light
 * first — see \`srgbToLinear01\` in colorUtils. Interpolating sRGB values as if
 * they were linear is precisely the error that destroys the perceptual
 * uniformity these maps exist to provide.
 */

/** How a map is meant to be read — drives UI grouping and the default choice. */
export type ColormapKind = 'sequential' | 'diverging' | 'isoluminant' | 'rainbow';

export interface ColormapDef {
  id: string;
  label: string;
  kind: ColormapKind;
  /** Comma-separated 6-digit sRGB hex anchors, uniformly spaced over [0, 1]. */
  stops: string;
}

export const COLORMAPS: ColormapDef[] = [
${entries.map((e) => `  {
    id: '${e.id}',
    label: '${e.label}',
    kind: '${e.kind}',
    // ${e.k} anchors, max reconstruction error ${e.err}/255 — ${e.src}
    stops:
      '${e.hex}',
  },`).join('\n')}
];
`;

writeFileSync(new URL('./colormapData.ts', import.meta.url).pathname, out);
console.log('\nwrote colormapData.ts');
