/**
 * Feedback report assembly — PURE (no DOM, no globals), so it is unit-testable
 * under the `node` vitest env. The DOM reads that fill `FeedbackEnv` live in
 * `FeedbackModal.tsx`; everything that decides *what the text says* lives here.
 *
 * WHY mailto: and not a POST. Three constraints rule out a hosted form:
 *   - the build CSP (`vite.config.ts`) is `connect-src 'self' blob: <deploy
 *     origin>` and `form-action 'self'`, so a fetch/POST to Formspree, Google
 *     Forms or the like is blocked by the app's own policy;
 *   - the desktop (Tauri) build must work with NO network at all;
 *   - a third-party form makes someone else a data processor for what is
 *     grant-funded research feedback.
 * A `mailto:` navigation is exempt from CSP (it is navigation, not a fetch),
 * hands the user's own mail client the composed text, and stores nothing
 * anywhere. The clipboard fallback covers the users who have no mail client
 * bound — which is why `buildReportText` produces something that reads fine
 * pasted into a webmail compose box, a forum, or a GitHub issue.
 */

import type { AppEdge, AppNode } from '@/types';
import { unwrapCollapsedGroupEdges } from './edgeUtils';

export type FeedbackKind = 'bug' | 'idea' | 'comment';

/** The destination inbox. Same address the toolbar's contact popover shows. */
export const FEEDBACK_EMAIL = 'alvis.misjuns@va.lv';

/**
 * Longest `mailto:` URL we will hand to the OS. The spec sets no limit, but
 * real handlers do: Windows' shell truncates around 2000 characters and older
 * Outlook builds silently drop the tail — a truncated bug report is worse than
 * no report, because the user believes they sent it. Past this, the modal
 * steers to "Copy report" instead of quietly mangling the message.
 */
export const MAILTO_SAFE_CHARS = 1900;

/** Environment facts collected at the moment the user opens the modal. */
export interface FeedbackEnv {
  /** `__APP_VERSION__` */
  version: string;
  /** 'desktop' for `__FS_DESKTOP__` builds, else 'web'. */
  build: 'web' | 'desktop';
  /** Where the app is actually served from — distinguishes the deploy targets. */
  address: string;
  userAgent: string;
  platform: string;
  /** Whether `navigator.gpu` is exposed at all. */
  gpuExposed: boolean;
  /** Which renderer the preview iframe will end up on — see `previewBackend`. */
  previewBackend: string;
  /** e.g. `2560×1440 · window 1512×850 · DPR 2` */
  display: string;
  /** The app's UI language ('en' | 'lv'). */
  uiLanguage: string;
  /** ISO timestamp; passed in rather than read, to keep this module pure. */
  timestamp: string;
}

/** What the user's project looks like, as counts. No graph content leaves. */
export interface FeedbackProject {
  /** Shader nodes — group frames and notes are counted separately. */
  nodes: number;
  /** How many of those touch at least one wire. */
  connected: number;
  /** Wires, measured on the logical (group-unwrapped) graph. */
  connections: number;
  groups: number;
  notes: number;
  /** GPU cost points, and the headset profile they are being judged against. */
  totalCost: number;
  headset: string;
  budget: number;
  /** Preview geometry setting ('sphere', 'teapot', 'custom', …). */
  geometry: string;
  /** Present only when a custom model is loaded. */
  mesh: { name: string; bytes: number; vertices: number | null } | null;
}

/** Human label for a feedback kind, used in the subject line and heading. */
export function kindLabel(kind: FeedbackKind): string {
  return kind === 'bug' ? 'Bug' : kind === 'idea' ? 'Idea' : 'Comment';
}

/**
 * Count what is on the canvas. Edges are measured on the UNWRAPPED graph
 * (`unwrapCollapsedGroupEdges`) for the same reason every engine consumer does
 * it: a collapsed group rewrites its boundary edges to synthetic pill sockets,
 * so counting them raw would report the collapse state rather than the graph —
 * the same project would read differently depending on which frames happened to
 * be folded when the user hit the feedback button.
 */
export function countProject(nodes: AppNode[], edges: AppEdge[]): {
  nodes: number; connected: number; connections: number; groups: number; notes: number;
} {
  const logical = unwrapCollapsedGroupEdges(nodes, edges);
  const touched = new Set<string>();
  for (const e of logical) {
    touched.add(e.source);
    touched.add(e.target);
  }
  let shader = 0, groups = 0, notes = 0, connected = 0;
  for (const n of nodes) {
    if (n.type === 'group') { groups++; continue; }
    if (n.type === 'note') { notes++; continue; }
    shader++;
    if (touched.has(n.id)) connected++;
  }
  return { nodes: shader, connected, connections: logical.length, groups, notes };
}

/** Thousands separators — a 7-figure vertex count is unreadable without them. */
function group(n: number): string {
  return n.toLocaleString('en-US');
}

/** Byte size at a sensible unit; models run from a few KB to tens of MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The `Graph` / `Cost` / `Mesh` rows of the technical block. */
function projectRows(p: FeedbackProject): [string, string][] {
  const extras: string[] = [];
  if (p.groups) extras.push(`${p.groups} group${p.groups === 1 ? '' : 's'}`);
  if (p.notes) extras.push(`${p.notes} note${p.notes === 1 ? '' : 's'}`);

  const over = p.totalCost > p.budget;
  const rows: [string, string][] = [
    [
      'Graph',
      `${group(p.nodes)} nodes (${group(p.connected)} connected)` +
        ` · ${group(p.connections)} connections` +
        (extras.length ? ` · ${extras.join(' · ')}` : ''),
    ],
    [
      'Cost',
      `${group(p.totalCost)} / ${group(p.budget)} pts` +
        ` · ${p.headset}${over ? ' · OVER BUDGET' : ''}`,
    ],
  ];

  if (p.mesh) {
    const verts = p.mesh.vertices == null ? 'vertex count unavailable' : `${group(p.mesh.vertices)} vertices`;
    rows.push(['Mesh', `${p.mesh.name} · ${verts} · ${formatBytes(p.mesh.bytes)}`]);
  } else {
    rows.push(['Mesh', `${p.geometry} (built-in)`]);
  }
  return rows;
}

/**
 * Which backend the sandboxed preview will run on, as a diagnostic string.
 *
 * MIRRORS `__fsForceWebGL2()` emitted by `engine/tslToPreviewHTML.ts` — that
 * function is emitted as source-code strings for the iframe, so it cannot be
 * imported and called here. `feedbackReport.test.ts` guards the pair against
 * drift by asserting both agree on the UA shapes that matter; if you change the
 * rule in one place, that test fails until you change it in the other.
 *
 * This matters because the app's most-reported symptom — "the preview is
 * blank" — has historically been a backend question (three r184's WebGPU path
 * does not paint on Apple WebKit), and a report that answers it up front is the
 * difference between a diagnosable ticket and a round trip.
 */
/**
 * The platform half of the rule, as the REASON it forces (null = platform
 * doesn't force). Split out so ShaderPreview's WGSL/GLSL toggle can derive
 * its locked state from the SAME statement of the rule instead of a third
 * copy — the toggle must not trust the iframe's own backend report for
 * anything but its label, because that report comes from the sandboxed
 * document, which runs the loaded shader (adversarial by project rule) and
 * can forge `fs:backend`.
 */
export function platformWebGL2Reason(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
): string | null {
  if (/iPad|iPhone|iPod/.test(userAgent)) return 'iOS WebKit';
  if (platform === 'MacIntel' && maxTouchPoints > 1) return 'iPadOS desktop mode';
  if (!/Chrome|Chromium|CriOS|FxiOS|Edg|EdgiOS|OPR|OPiOS|SamsungBrowser|Firefox|Android/.test(userAgent)
      && /Safari|AppleWebKit/.test(userAgent)) {
    return 'Safari/WebKit';
  }
  return null;
}

export function previewBackend(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
  gpuExposed: boolean,
  userForcedWebGL2 = false,
): string {
  const reason = platformWebGL2Reason(userAgent, platform, maxTouchPoints);
  if (reason) return `WebGL2 (forced — ${reason})`;
  // The preview's WGSL/GLSL toggle. AFTER the platform checks — those force
  // regardless of the toggle, so they are the more fundamental cause — and
  // deliberately NOT part of the __fsForceWebGL2 mirror above: the emitted
  // rule keeps the toggle as a separate branch (a constant baked per
  // document), so the drift test's UA-shape comparison stays about the
  // platform rule alone. This flag is app state, read from the store.
  if (userForcedWebGL2) return 'WebGL2 (forced — preview GLSL toggle)';
  if (!gpuExposed) return 'WebGL2 (no navigator.gpu)';
  return 'WebGPU (if an adapter is granted, else WebGL2)';
}

/**
 * Aligned `Label: value` lines for the technical-details block. The project
 * rows come FIRST — "42 nodes, 1830/200 pts on a Quest 3" is what makes a
 * report reproducible, while the browser string is the tiebreak underneath.
 */
export function envLines(env: FeedbackEnv, project?: FeedbackProject | null): string[] {
  const rows: [string, string][] = [
    ['Version', `${env.version} (${env.build})`],
    ...(project ? projectRows(project) : []),
    ['Address', env.address],
    ['Browser', env.userAgent],
    ['Platform', env.platform],
    ['Preview', env.previewBackend],
    ['WebGPU', env.gpuExposed ? 'exposed' : 'not exposed'],
    ['Display', env.display],
    ['Language', env.uiLanguage],
    ['Date', env.timestamp],
  ];
  const pad = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${(k + ':').padEnd(pad + 2)}${v}`);
}

/** Subject line: scannable in an inbox that also receives unrelated mail. */
export function buildSubject(kind: FeedbackKind, version: string): string {
  return `FastShaders ${kindLabel(kind)} — v${version}`;
}

export interface ReportInput {
  kind: FeedbackKind;
  /** The user's free text. */
  message: string;
  /** Whether to append the technical-details block. */
  includeEnv: boolean;
  env: FeedbackEnv;
  /** Project counts; omitted when unavailable. Rides the same checkbox. */
  project?: FeedbackProject | null;
}

/**
 * The full report body. Deliberately plain text with no markup: it has to read
 * correctly in a mail client, a plain-text paste, and a GitHub issue alike.
 * The message goes FIRST — the technical block is an appendix, not a preamble
 * the reader has to scroll past.
 *
 * There is deliberately NO "who sent this" field: the report arrives as email,
 * so the sender's address is already on it, and asking again would be a second
 * form field that earns nothing.
 */
export function buildReportText(input: ReportInput): string {
  const parts: string[] = [];
  parts.push(input.message.trim());
  if (input.includeEnv) {
    parts.push(['--- Technical details ---', ...envLines(input.env, input.project)].join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * `mailto:` URL for the composed report. `encodeURIComponent` is the right
 * encoder here: it escapes the `&`, `?` and `#` that would otherwise terminate
 * or split the header fields, and turns newlines into `%0A`, which every mail
 * client expands back into line breaks in the compose window.
 */
export function buildMailtoUrl(to: string, subject: string, body: string): string {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Whether the composed URL is long enough to risk handler truncation. */
export function mailtoTooLong(url: string): boolean {
  return url.length > MAILTO_SAFE_CHARS;
}
