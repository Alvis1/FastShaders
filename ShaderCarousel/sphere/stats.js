// ShaderSphere v3 — Points-based shader cost measurement
// 100 points = 120 fps (8.33 ms) at Quest 3 per-eye resolution, full coverage

const BUDGET_MS = 8.33; // 120 Hz single-eye frame budget

// ── Statistics ──────────────────────────────────────────────────────────────

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

function stdDev(arr) {
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

export function computeStats(frames) {
  if (frames.length < 2) return { points: 0, medianFt: 0, frameCount: frames.length };
  const fts = frames.map(f => f.frameTime);
  const median = pct(fts, 50);
  const mean = fts.reduce((a, b) => a + b, 0) / fts.length;

  const mid = Math.floor(fts.length / 2);
  const aMean = fts.slice(0, mid).reduce((s, v) => s + v, 0) / Math.max(mid, 1);
  const rMean = fts.slice(mid).reduce((s, v) => s + v, 0) / Math.max(fts.length - mid, 1);

  return {
    points:       Math.round(median / BUDGET_MS * 100),
    medianFt:     +median.toFixed(3),
    p95Ft:        +pct(fts, 95).toFixed(3),
    p99Ft:        +pct(fts, 99).toFixed(3),
    jitter:       +stdDev(fts).toFixed(3),
    avgFps:       +(1000 / mean).toFixed(1),
    thermalDrift: +(aMean > 0 ? rMean / aMean : 1).toFixed(3),
    frameCount:   fts.length,
  };
}

// ── Export ───────────────────────────────────────────────────────────────────

export function downloadJSON(data, prefix) {
  if (!data.shaders?.length) return;
  const ts = new Date().toISOString().slice(0, 16).replace(/:/g, '');
  const dur = data.metadata?.config?.duration;
  const durPart = dur ? `-${Math.round(dur / 1000)}s` : '';
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${prefix}${durPart}-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);

  // Also export a compact stats-only summary
  const summary = {
    metadata: data.metadata,
    shaders: data.shaders.map(s => ({ id: s.id, label: s.label, category: s.category, ...s.stats })),
  };
  const csvRows = [
    ['id', 'label', 'points', 'medianFt', 'p95Ft', 'p99Ft', 'jitter', 'avgFps', 'thermalDrift', 'frameCount'].join(','),
    ...summary.shaders.map(s =>
      [s.id, `"${s.label}"`, s.points, s.medianFt, s.p95Ft, s.p99Ft, s.jitter, s.avgFps, s.thermalDrift, s.frameCount].join(',')
    ),
  ].join('\n');
  const csvBlob = new Blob([csvRows], { type: 'text/csv' });
  const csvUrl = URL.createObjectURL(csvBlob);
  const b = document.createElement('a');
  b.href = csvUrl;
  b.download = `${prefix}-summary${durPart}-${ts}.csv`;
  b.click();
  URL.revokeObjectURL(csvUrl);
}

// ── Shader picker ───────────────────────────────────────────────────────────

const STORE_KEY = 'shadersphere-selected';

export function buildShaderPicker(shaders, listEl) {
  listEl.innerHTML = '';
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  for (const s of shaders) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = s.id;
    cb.checked = saved ? saved.includes(s.id) : true;
    cb.addEventListener('change', () => {
      const ids = [...listEl.querySelectorAll('input:checked')].map(c => c.value);
      localStorage.setItem(STORE_KEY, JSON.stringify(ids));
    });
    label.append(cb, ` ${s.label}`);
    listEl.appendChild(label);
  }
}

export function getSelectedIds(listEl) {
  return [...listEl.querySelectorAll('input:checked')].map(c => c.value);
}

export function pickerAll(listEl) {
  listEl.querySelectorAll('input').forEach(c => { c.checked = true; });
  localStorage.setItem(STORE_KEY, JSON.stringify([...listEl.querySelectorAll('input')].map(c => c.value)));
}

export function pickerNone(listEl) {
  listEl.querySelectorAll('input').forEach(c => { c.checked = false; });
  localStorage.setItem(STORE_KEY, JSON.stringify([]));
}

// ── Settings persistence ────────────────────────────────────────────────────

const SETTINGS_KEY = 'shadersphere-settings';

export function saveSettings() {
  const duration = document.getElementById('input-duration')?.value;
  const warmup = document.getElementById('input-warmup')?.value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ duration, warmup }));
}

export function loadSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return;
  try {
    const { duration, warmup } = JSON.parse(raw);
    if (duration) { const el = document.getElementById('input-duration'); if (el) el.value = duration; }
    if (warmup) { const el = document.getElementById('input-warmup'); if (el) el.value = warmup; }
  } catch (_) {}
}
