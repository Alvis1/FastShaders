/**
 * Session context that has to ride the package for the numbers inside it to be
 * interpretable later (EVAL_MODE_PLAN.md §7.21–22).
 *
 * Two things a bundle used to leave ambiguous:
 *
 *  - **Which price table valued this graph.** "123 points" means nothing
 *    without the table that produced it, and the tables move with each
 *    calibration round. `costTableProvenance` records whether the built-in
 *    `complexity.json` (stamped with the app version) or an imported device
 *    profile was active, and for a profile whether it was MEASURED on hardware
 *    or typed by hand.
 *  - **What machine it ran on.** Frame times, "the preview was slow" comments
 *    and cost judgements are all device-relative.
 *
 * The device block is deliberately capability-shaped (cores, memory class,
 * screen, renderer) rather than a fingerprint: it is what a methods section
 * reports, and every field is already visible to any page the participant
 * visits.
 */

import { useAppStore, resolveDeviceBudget, VR_HEADSETS } from '@/store/useAppStore';
import { POINT_BUDGET } from '@/utils/budgetPoints';

export interface CostTableProvenance {
  /** e.g. `complexity.json@0.3.27` or a cost-profile id. */
  source: string;
  /** 'builtin' | 'measured' | 'manual' — how the numbers were arrived at. */
  kind: 'builtin' | 'measured' | 'manual';
  /** The device row the budget came from, and that budget in TABLE points —
   *  the unit of every point figure the package records. */
  device: string;
  budget: number;
  /** What the participant's screen printed that budget as: every point figure
   *  on screen was `table points × shownBudget / budget` (utils/budgetPoints.ts).
   *  100 since 2026-10-23; a package without the field printed table points
   *  against `budget` itself. */
  shownBudget: number;
}

export function costTableProvenance(): CostTableProvenance {
  const s = useAppStore.getState();
  const profile = s.costProfiles.find((p) => p.id === s.selectedHeadsetId);
  // Budget comes from the store's own resolver — the one the cost bar divides
  // by — so this is not a second copy of the profile-lookup + VR_HEADSETS
  // fallback rule. This field exists so a point total is interpretable later,
  // which it is not if it states a budget nobody was working to.
  const resolved = resolveDeviceBudget(s.selectedHeadsetId, s.costProfiles);
  if (profile) {
    return {
      source: profile.id,
      // `manual` is set by the profile editor; absent means the numbers came
      // from a benchmark run (the CostBar's own measured/custom distinction).
      kind: profile.meta?.manual ? 'manual' : 'measured',
      device: resolved.label,
      budget: resolved.maxPoints,
      shownBudget: POINT_BUDGET,
    };
  }
  // A built-in headset carrying its own measured prices (the Steam Frame) is
  // NOT the plain table: name the run it was priced from beside the version.
  const headset = VR_HEADSETS.find((h) => h.id === s.selectedHeadsetId);
  if (headset?.costs) {
    return {
      source: `complexity.json@${__APP_VERSION__}+${headset.costsBasis ?? headset.id}`,
      kind: 'measured',
      device: resolved.label,
      budget: resolved.maxPoints,
      shownBudget: POINT_BUDGET,
    };
  }
  return {
    source: `complexity.json@${__APP_VERSION__}`,
    kind: 'builtin',
    device: resolved.label,
    budget: resolved.maxPoints,
    shownBudget: POINT_BUDGET,
  };
}

export interface DeviceInfo {
  userAgent: string;
  platform: string;
  /** Logical cores; `deviceMemory` is a coarse GB class, Chromium-only. */
  cores: number | null;
  memoryGb: number | null;
  maxTouchPoints: number;
  screen: string;
  viewport: string;
  devicePixelRatio: number;
  /** The GPU string WebGL reports, when the browser un-masks it. */
  gpu: string | null;
  webgpu: boolean;
  language: string;
  timezone: string;
  /** Accessibility preferences that change what the participant sees. */
  reducedMotion: boolean;
  colorScheme: 'dark' | 'light';
}

/** Best-effort GPU name. Firefox and Safari mask it; null is a real answer. */
function gpuName(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return null;
    const ext = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    const raw = ext
      ? (gl as WebGLRenderingContext).getParameter(
          (ext as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL,
        )
      : (gl as WebGLRenderingContext).getParameter((gl as WebGLRenderingContext).RENDERER);
    // Release the context rather than leaving it for the GC — browsers cap
    // live WebGL contexts, and the preview needs one.
    (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return typeof raw === 'string' && raw ? raw.slice(0, 200) : null;
  } catch {
    return null;
  }
}

export function collectDevice(): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number; gpu?: unknown };
  const mq = (q: string): boolean => {
    try {
      return window.matchMedia(q).matches;
    } catch {
      return false;
    }
  };
  let timezone = '';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    /* keep '' */
  }
  return {
    userAgent: navigator.userAgent || '',
    platform: navigator.platform || '',
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    screen: `${window.screen.width}×${window.screen.height}`,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio,
    gpu: gpuName(),
    webgpu: nav.gpu != null,
    language: navigator.language || '',
    timezone,
    reducedMotion: mq('(prefers-reduced-motion: reduce)'),
    colorScheme: mq('(prefers-color-scheme: dark)') ? 'dark' : 'light',
  };
}
