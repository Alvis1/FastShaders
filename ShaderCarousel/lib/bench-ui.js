/* bench-ui — shared interface helpers for the three benches.
 *
 * Each bench wires its own measurement loop but delegates DOM ceremony
 * here: building the grouped picker with master-checkmarks per section,
 * loading/saving settings, showing the start gate before the first run,
 * and showing the results popup at the end. Persistence keys are namespaced
 * per bench so settings don't leak across modes. */

// Falls back to the parent document when the iframe lookup misses — the
// ShaderCarousel launcher re-parents #hud / #controls / #shader-picker /
// #log into its sidebar on the iframe `load` event. Without this fallback,
// lookups by id from inside the iframe return null for any adopted node.
const $ = id => {
  const el = document.getElementById(id);
  if (el) return el;
  if (window.parent !== window) {
    try { return window.parent.document.getElementById(id); } catch { /* cross-origin */ }
  }
  return null;
};

// ── Logging (shared format across benches) ──────────────────────────────────

export function makeLogger(benchTag) {
  const logPanel = $('log');
  if (logPanel) logPanel.classList.add('visible');
  return function log(msg, cls = 'info') {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
    if (logPanel) {
      logPanel.appendChild(d);
      logPanel.scrollTop = logPanel.scrollHeight;
    }
    console.log(`[${benchTag}] ${msg}`);
  };
}

// ── Picker (grouped sections + master checkbox per section) ─────────────────

const GROUP_LABELS = {
  baseline: 'Baseline',
  preset:   'Presets',
  noise:    'Noises (atomic)',
  calib:    'Calibration (k-sweep)',
  combo:    'Combinations',
  saved:    'Saved Groups',
};

const GROUP_ORDER = ['baseline', 'preset', 'noise', 'calib', 'combo', 'saved'];

/**
 * Build the picker DOM and wire master/child checkmark sync.
 * `defaults` is a Set of group names that should be ticked on first load;
 * subsequent loads honour the saved selection in localStorage[storageKey].
 *
 * The baseline (`ref_baseline`) defaults on but is user-toggleable.
 * Without it the export cannot derive marginal cost — bench-stats marks
 * the suggestion file `valid: false` with a `baseline-missing` reason.
 */
export function buildPicker(registry, listEl, storageKey, defaults) {
  const saved = readSelection(storageKey);
  listEl.innerHTML = '';

  // Action row (All / None) — baseline is unaffected by these.
  const actions = document.createElement('div');
  actions.className = 'pick-actions';
  const btnAll = document.createElement('button');
  btnAll.textContent = 'All';
  btnAll.type = 'button';
  const btnNone = document.createElement('button');
  btnNone.textContent = 'None';
  btnNone.type = 'button';
  actions.append(btnAll, btnNone);
  listEl.appendChild(actions);

  const groups = new Map();
  for (const s of registry) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }

  for (const group of GROUP_ORDER) {
    const entries = groups.get(group);
    if (!entries || entries.length === 0) continue;

    // Section header with master checkbox + count
    const header = document.createElement('div');
    header.className = 'pick-section-header';
    const master = document.createElement('input');
    master.type = 'checkbox';
    master.dataset.master = group;
    const title = document.createElement('span');
    title.textContent = GROUP_LABELS[group] || group;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `(${entries.length})`;
    header.append(master, title, count);
    listEl.appendChild(header);

    for (const s of entries) {
      if (s.disabled) {
        // Saved groups that can't be compiled yet — list with a hint.
        const note = document.createElement('div');
        note.className = 'pick-disabled';
        note.textContent = `${s.label} — ${s.disabledReason}`;
        listEl.appendChild(note);
        continue;
      }
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.id;
      cb.dataset.group = group;
      if (s.id === 'ref_baseline') {
        // Baseline defaults on but is user-toggleable. The export pipeline
        // (bench-stats.annotateMarginalCost) already tolerates missing
        // baseline by falling back to 0, so users who want raw frametimes
        // rather than marginal cost can untick this.
        cb.checked = saved ? saved.has(s.id) : true;
        cb.title = 'Baseline. Default on — required for marginal-cost subtraction. Untick for raw frametimes.';
      } else if (saved) {
        cb.checked = saved.has(s.id);
      } else {
        cb.checked = defaults.has(group);
      }
      label.append(cb, document.createTextNode(' ' + s.label));
      listEl.appendChild(label);
    }
  }

  // Master ↔ child sync
  const persist = () => writeSelection(storageKey, getSelectedIds(listEl));
  const refreshMasters = () => {
    listEl.querySelectorAll('input[data-master]').forEach(m => {
      const group = m.dataset.master;
      const children = listEl.querySelectorAll(`input[data-group="${group}"]:not(:disabled)`);
      const checked = listEl.querySelectorAll(`input[data-group="${group}"]:checked:not(:disabled)`);
      m.checked = children.length > 0 && checked.length === children.length;
      m.indeterminate = checked.length > 0 && checked.length < children.length;
    });
  };
  listEl.querySelectorAll('input[data-master]').forEach(m => {
    m.addEventListener('change', () => {
      const group = m.dataset.master;
      listEl.querySelectorAll(`input[data-group="${group}"]:not(:disabled)`).forEach(c => {
        c.checked = m.checked;
      });
      persist(); refreshMasters();
    });
  });
  listEl.querySelectorAll('input[data-group]').forEach(c => {
    c.addEventListener('change', () => { persist(); refreshMasters(); });
  });
  btnAll.addEventListener('click', () => {
    listEl.querySelectorAll('input[data-group]:not(:disabled)').forEach(c => { c.checked = true; });
    persist(); refreshMasters();
  });
  btnNone.addEventListener('click', () => {
    listEl.querySelectorAll('input[data-group]:not(:disabled)').forEach(c => { c.checked = false; });
    persist(); refreshMasters();
  });
  refreshMasters();
}

export function getSelectedIds(listEl) {
  return [...listEl.querySelectorAll('input[data-group]:checked')].map(c => c.value);
}

function readSelection(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : null;
  } catch { return null; }
}

function writeSelection(key, ids) {
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* quota */ }
}

// ── Settings (numeric inputs) persistence + defaults ────────────────────────

/**
 * Read a numeric setting input by element id, with an explicit range.
 * Replaces the benches' `+$(id).value || fallback` pattern, which had two
 * traps: a typed `0` is falsy so it silently became the default, and
 * negative values passed straight through (a negative InOut cycle hangs
 * sphere-mover forever; negative pass counts zero out WebGPU runs).
 * Non-finite input → fallback; finite input → clamped into [min, max].
 */
export function readSetting(id, fallback, { min = 1, max = Infinity } = {}) {
  const raw = $(id)?.value;
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * `defaults` is an object whose keys match input IDs (e.g. 'input-duration'),
 * values are the default numeric settings. Loads from localStorage[key] if
 * present; otherwise applies defaults. Returns a `resetToDefaults()` callback.
 */
export function wireSettings(defaults, storageKey) {
  const apply = (vals) => {
    for (const [id, v] of Object.entries(vals)) {
      const el = $(id);
      if (el) el.value = v;
    }
  };
  const persist = () => {
    const out = {};
    for (const id of Object.keys(defaults)) {
      const el = $(id);
      if (el) out[id] = el.value;
    }
    try { localStorage.setItem(storageKey, JSON.stringify(out)); } catch { /* quota */ }
  };

  let stored = null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) stored = JSON.parse(raw);
  } catch { /* ignore */ }
  apply({ ...defaults, ...(stored || {}) });

  for (const id of Object.keys(defaults)) {
    const el = $(id);
    if (el) el.addEventListener('change', persist);
  }

  return {
    reset: () => { apply(defaults); persist(); },
  };
}

// ── Start gate (big centered "Go" before first run) ─────────────────────────

/**
 * `opts` shape:
 *   { title, subtitle, buttonLabel, extraHtml?, onStart, beforeStart? }
 * `beforeStart()` runs synchronously when the button is clicked (use it to
 * read state from extraHtml inputs). `onStart()` is awaited; the gate hides
 * itself before onStart resolves so the bench can show its own progress UI.
 */
export function createStartGate(opts) {
  const existing = $('bench-start-gate');
  if (existing) existing.remove();

  const gate = document.createElement('div');
  gate.id = 'bench-start-gate';

  const card = document.createElement('div');
  card.className = 'gate-card';

  const h1 = document.createElement('h1'); h1.textContent = opts.title || 'Ready';
  const sub = document.createElement('div'); sub.className = 'gate-sub';
  sub.textContent = opts.subtitle || '';

  card.append(h1, sub);

  if (opts.extraHtml) {
    const extra = document.createElement('div');
    extra.className = 'gate-detect';
    extra.innerHTML = opts.extraHtml;
    card.appendChild(extra);
  }

  const go = document.createElement('button');
  go.className = 'gate-go';
  go.type = 'button';
  go.textContent = opts.buttonLabel || '▶ Start';
  card.appendChild(go);

  gate.appendChild(card);
  document.body.appendChild(gate);

  const originalLabel = opts.buttonLabel || '▶ Start';
  const api = {
    hide: () => gate.classList.add('hidden'),
    show: () => gate.classList.remove('hidden'),
    remove: () => gate.remove(),
    setBusy: (busy) => {
      go.disabled = busy;
      go.textContent = busy ? 'Working…' : originalLabel;
    },
  };

  go.addEventListener('click', async () => {
    if (opts.beforeStart) {
      try { opts.beforeStart(); } catch (e) { console.error(e); }
    }
    api.setBusy(true);
    try {
      api.hide();
      await opts.onStart();
    } catch (e) {
      console.error('[bench-ui] start failed:', e);
      api.show();
    } finally {
      api.setBusy(false);
      go.textContent = opts.buttonLabel || '▶ Start';
    }
  });

  return api;
}

// ── Done popup ─────────────────────────────────────────────────────────────

/**
 * Show a modal summarising the run. `rows` is `[{ label, points, medianMs,
 * marginalMs, frameCount }]` — typically derived from results before export.
 * Optional `warning` is rendered as a high-visibility banner between the
 * subtitle and the results table; pass HTML (it's bench-authored, not
 * user-input, so `innerHTML` is safe).
 * Buttons:
 *   • Download — calls `onDownload()` (which typically calls exportResults)
 *   • Run again — calls `onRunAgain()` (returns to start gate)
 *   • Close — dismisses the popup
 */
export function showDonePopup({ title, subtitle, warning, rows, onDownload, onRunAgain }) {
  const existing = $('bench-done-popup');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.id = 'bench-done-popup';
  const card = document.createElement('div');
  card.className = 'popup-card';

  const h = document.createElement('h2'); h.textContent = title || 'Benchmark complete';
  const sub = document.createElement('div'); sub.className = 'popup-sub';
  sub.textContent = subtitle || `${rows.length} shaders measured.`;
  card.append(h, sub);

  if (warning) {
    const w = document.createElement('div');
    w.className = 'popup-warning';
    w.innerHTML = warning;
    card.appendChild(w);
  }

  if (rows.length > 0) {
    const table = document.createElement('table');
    const head = document.createElement('thead');
    head.innerHTML = '<tr><th>Shader</th><th class="num">Median ms</th><th class="num">Marginal ms</th><th class="num">Points</th></tr>';
    table.appendChild(head);
    const body = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(r.label)}</td><td class="num">${r.medianMs?.toFixed(3) ?? '—'}</td><td class="num">${r.marginalMs?.toFixed(3) ?? '—'}</td><td class="num">${r.points ?? '—'}</td>`;
      body.appendChild(tr);
    }
    table.appendChild(body);
    card.appendChild(table);
  }

  const actions = document.createElement('div');
  actions.className = 'popup-actions';
  const btnDl = document.createElement('button');
  btnDl.className = 'primary'; btnDl.type = 'button';
  btnDl.textContent = '⬇ Download JSON + CSV + suggestion';
  btnDl.addEventListener('click', () => { try { onDownload?.(); } catch (e) { console.error(e); } });
  const btnAgain = document.createElement('button');
  btnAgain.type = 'button';
  btnAgain.textContent = '↻ Run again';
  btnAgain.addEventListener('click', () => { wrap.remove(); onRunAgain?.(); });
  const btnClose = document.createElement('button');
  btnClose.className = 'ghost'; btnClose.type = 'button';
  btnClose.textContent = 'Close';
  btnClose.addEventListener('click', () => wrap.remove());
  actions.append(btnDl, btnAgain, btnClose);
  card.appendChild(actions);

  wrap.appendChild(card);
  document.body.appendChild(wrap);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ── Error overlay surface ──────────────────────────────────────────────────

export function installErrorOverlay() {
  const show = msg => {
    let el = $('error-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'error-overlay';
      document.body.appendChild(el);
    }
    el.style.display = 'block';
    el.textContent = String(msg).slice(0, 500);
  };
  window.addEventListener('error', e => show(`${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener('unhandledrejection', e => show(e.reason?.message || String(e.reason)));
}

// ── Headset detection (UA sniff + override input) ──────────────────────────

const HEADSET_PATTERNS = [
  { name: 'Meta Quest 3',     test: /Quest 3\b/i },
  { name: 'Meta Quest Pro',   test: /Quest Pro\b/i },
  { name: 'Meta Quest 2',     test: /Quest 2\b/i },
  { name: 'Meta Quest',       test: /OculusBrowser|Quest/i },
  { name: 'Pico 4',           test: /Pico 4\b/i },
  { name: 'Pico Neo 3',       test: /Pico Neo/i },
  { name: 'Apple Vision Pro', test: /Vision Pro|VisionOS/i },
  { name: 'Generic WebXR',    test: /XRBrowser|VR/i },
];

export function detectHeadset() {
  const ua = navigator.userAgent || '';
  for (const p of HEADSET_PATTERNS) {
    if (p.test.test(ua)) return p.name;
  }
  return null;
}

export async function isXRSupported() {
  if (!navigator.xr || !navigator.xr.isSessionSupported) return false;
  try { return await navigator.xr.isSessionSupported('immersive-vr'); }
  catch { return false; }
}

/**
 * Diagnose *why* WebXR is unavailable, so the UI can show something more
 * useful than a generic "not supported". Returns one of:
 *   { ok: true }
 *   { ok: false, reason: 'insecure' | 'no-navigator-xr' | 'no-immersive-vr' | 'unknown', detail }
 *
 * `insecure` is the common one: WebXR `immersive-vr` requires a secure
 * context. Modern Chromium treats `http://localhost` and `http://127.0.0.1`
 * as secure, but Safari is stricter; any LAN-IP HTTP URL is rejected
 * everywhere. The Quest Browser refuses XR on non-HTTPS unless served
 * from localhost via adb port-forward.
 */
export async function diagnoseXR() {
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason: 'insecure',
      detail: `Page is not a secure context (location: ${location.protocol}//${location.host}). WebXR immersive-vr requires HTTPS, or http://localhost / http://127.0.0.1. For Quest 3 testing serve over HTTPS, or use \`adb reverse tcp:PORT tcp:PORT\` to port-forward localhost.`,
    };
  }
  if (!navigator.xr) {
    return {
      ok: false,
      reason: 'no-navigator-xr',
      detail: 'navigator.xr is not present. Use a WebXR-capable browser (Chrome/Edge desktop with a headset connected via SteamVR, or the Meta Quest Browser on-device).',
    };
  }
  if (!navigator.xr.isSessionSupported) {
    return {
      ok: false,
      reason: 'no-immersive-vr',
      detail: 'navigator.xr.isSessionSupported is not implemented in this browser build.',
    };
  }
  try {
    const ok = await navigator.xr.isSessionSupported('immersive-vr');
    if (ok) return { ok: true };
    return {
      ok: false,
      reason: 'no-immersive-vr',
      detail: 'navigator.xr.isSessionSupported("immersive-vr") returned false — no compatible XR device connected, or the device is in use by another session.',
    };
  } catch (e) {
    return { ok: false, reason: 'unknown', detail: e?.message || String(e) };
  }
}
