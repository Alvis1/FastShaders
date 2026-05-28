import type { AppNode, AppEdge } from '@/types';

/**
 * Snapshot of FastShaders editor state embedded into a downloaded `.js` shader
 * so the file round-trips: external A-Frame / Three.js consumers see only a
 * plain TSL module (the snapshot lives in a leading block comment they
 * ignore), while dragging the same file back into FastShaders restores node
 * positions, groups, preview/iframe settings, and UI prefs.
 */
export interface FastShadersProject {
  version: 1;
  shaderName: string;
  selectedHeadsetId?: string;
  graph: { nodes: AppNode[]; edges: AppEdge[] };
  preview: {
    geometry?: string;
    lighting?: string;
    subdivision?: number;
    bgColor?: string;
    playing?: boolean;
    uniformValues?: Record<string, number>;
    uniformBounds?: Record<string, unknown>;
    cameraPos?: { x: number; y: number; z: number } | null;
    rotation?: { x: number; y: number; z: number } | null;
  };
  ui: {
    nodeEditorBgColor?: string;
    codeEditorTheme?: 'vs' | 'vs-dark';
    costColorLow?: string;
    costColorHigh?: string;
  };
}

const BEGIN_MARKER = '/* FASTSHADERS_PROJECT_V1';
const END_MARKER = 'END_FASTSHADERS_PROJECT */';

/**
 * Drop dangerous structural keys when parsing the embedded JSON. Same rationale
 * as the reviver in useAppStore — a tampered `.js` file shared between users
 * should not be able to smuggle `__proto__` / `constructor` / `prototype` into
 * any of the objects we then spread, structuredClone, or look up dynamically.
 */
function safeJsonReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

// Append a FastShaders project snapshot as a trailing block comment.
//
// Placed AFTER the shader code so anyone opening the file in an editor sees
// the actual TSL module first; the metadata sits at the bottom out of the
// way. JSON.stringify does not escape the comment terminator inside string
// values, so a node label containing it would close the comment early and
// corrupt the module. We replace any literal terminator with its
// JSON-equivalent unicode escape (*/); JSON.parse decodes that back on the
// receiving side, so the data round-trips losslessly while the comment
// terminator stays unique.
export function embedProjectState(scriptCode: string, project: FastShadersProject): string {
  const json = JSON.stringify(project, null, 2).replace(/\*\//g, '*\\u002F');
  const sep = scriptCode.endsWith('\n') ? '' : '\n';
  return `${scriptCode}${sep}\n${BEGIN_MARKER}\n${json}\n${END_MARKER}\n`;
}

/**
 * Find and parse a FastShaders project snapshot from arbitrary `.js` text.
 *
 * Returns the parsed project plus `stripped`, the original text with the
 * snapshot removed — that stripped form is what gets passed to `scriptToTSL`
 * so the resulting TSL doesn't carry the metadata comment.
 *
 * Returns null when no snapshot is present or it fails to parse (older format,
 * truncated file, malformed JSON) — callers should fall back to treating the
 * file as a plain TSL shader module.
 */
export function extractProjectState(
  text: string,
): { project: FastShadersProject; stripped: string } | null {
  const beginIdx = text.indexOf(BEGIN_MARKER);
  if (beginIdx < 0) return null;
  const endIdx = text.indexOf(END_MARKER, beginIdx + BEGIN_MARKER.length);
  if (endIdx < 0) return null;

  const jsonStart = beginIdx + BEGIN_MARKER.length;
  const json = text.slice(jsonStart, endIdx).trim();

  let project: FastShadersProject;
  try {
    project = JSON.parse(json, safeJsonReviver) as FastShadersProject;
  } catch {
    return null;
  }
  if (!project || project.version !== 1) return null;
  if (!project.graph || !Array.isArray(project.graph.nodes) || !Array.isArray(project.graph.edges)) {
    return null;
  }

  const blockEnd = endIdx + END_MARKER.length;
  // Strip the block and any whitespace that bracketed it: leading newlines if
  // it sat at the top of an old-format file, trailing ones now that it lives
  // at the bottom.
  const stripped = (text.slice(0, beginIdx) + text.slice(blockEnd))
    .replace(/\s+$/, '\n')
    .replace(/^\s*\n/, '');
  return { project, stripped };
}
