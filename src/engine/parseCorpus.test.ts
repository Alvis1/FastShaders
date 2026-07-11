/**
 * Parse-corpus guard: every human-authored shader fixture under Tests/ is
 * parsed with codeToGraph and its shape pinned against hardcoded expectations
 * ({nodeTypeCounts, edgeCount, errorCount, warningCount}). This freezes
 * human-code fidelity — a parser change that silently drops wiring, duplicates
 * nodes, or starts (or stops) warning shows up here as a diff, not in a user's
 * imported shader.
 *
 * The EXPECTED table was generated from the parser's behavior after the
 * 2026-07-11 fixes (member-init split wiring, .toVar() dedup, constant folding
 * + degradation warnings). When a parser change legitimately alters these
 * numbers, regenerate the affected entries and justify the change in review.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { codeToGraph } from './codeToGraph';

const TESTS_DIR = fileURLToPath(new URL('../../Tests', import.meta.url));

/** Recursively collect shader fixtures (`.js`, incl. `.tsl.js`) under Tests/. */
function collectShaderFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectShaderFiles(join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.js')) {
      out.push(rel);
    }
  }
  return out;
}

interface CorpusStats {
  nodeTypeCounts: Record<string, number>;
  edgeCount: number;
  /** Blocking errors (severity omitted or 'error') — these stop graph sync. */
  errorCount: number;
  /** Non-blocking diagnostics (severity 'warning'). */
  warningCount: number;
}

function parseStats(code: string): CorpusStats {
  const result = codeToGraph(code);
  const nodeTypeCounts: Record<string, number> = {};
  for (const n of result.nodes) {
    nodeTypeCounts[n.data.registryType] = (nodeTypeCounts[n.data.registryType] ?? 0) + 1;
  }
  return {
    nodeTypeCounts,
    edgeCount: result.edges.length,
    errorCount: result.errors.filter((e) => e.severity !== 'warning').length,
    warningCount: result.errors.filter((e) => e.severity === 'warning').length,
  };
}

const EXPECTED: Record<string, CorpusStats> = {
  '1stTest/2km-shader-iced-udens.js': {
    nodeTypeCounts: { color: 2, float: 1, time: 1, mul: 4, unknown: 2, remap: 1, add: 4, clamp: 1, mix: 1, output: 1, positionLocal: 1 },
    edgeCount: 19, errorCount: 0, warningCount: 2,
  },
  '1stTest/2km-shader-uguns.js': {
    nodeTypeCounts: { color: 2, sub: 2, uv: 2, vec2: 3, add: 4, mul: 10, split: 1, cos: 2, sin: 2, time: 1, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 37, errorCount: 0, warningCount: 2,
  },
  '1stTest/as_udens.js': {
    nodeTypeCounts: { color: 2, time: 1, float: 1, mul: 5, unknown: 2, remap: 1, add: 4, clamp: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 22, errorCount: 0, warningCount: 2,
  },
  '1stTest/as_uguns.js': {
    nodeTypeCounts: { color: 2, time: 1, sub: 2, uv: 2, vec2: 3, add: 4, mul: 10, split: 1, cos: 2, sin: 2, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 37, errorCount: 0, warningCount: 2,
  },
  '1stTest/bj_udens.js': {
    nodeTypeCounts: { time: 1, float: 1, color: 2, mul: 5, unknown: 2, remap: 1, add: 4, clamp: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 22, errorCount: 0, warningCount: 2,
  },
  '1stTest/bj_uguns.js': {
    nodeTypeCounts: { color: 2, sub: 2, uv: 2, vec2: 3, add: 4, mul: 10, split: 1, cos: 2, sin: 2, time: 1, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 37, errorCount: 0, warningCount: 2,
  },
  '1stTest/bj_uguns2.js': {
    nodeTypeCounts: { color: 2, sub: 2, uv: 2, vec2: 3, add: 4, mul: 10, split: 1, cos: 2, sin: 2, time: 1, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 37, errorCount: 0, warningCount: 2,
  },
  '1stTest/em_udens.js': {
    nodeTypeCounts: { time: 1, float: 2, color: 2, voronoi: 1, mul: 5, unknown: 2, remap: 1, add: 4, clamp: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 22, errorCount: 0, warningCount: 2,
  },
  '1stTest/em_uguns.js': {
    nodeTypeCounts: { color: 2, sub: 4, uv: 2, vec2: 6, add: 6, mul: 14, split: 2, cos: 4, sin: 4, time: 1, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 56, errorCount: 0, warningCount: 2,
  },
  '1stTest/emk-udens.js': {
    nodeTypeCounts: { color: 2, time: 1, float: 1, uv: 1, mul: 5, unknown: 3, mix: 1, output: 1, add: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 15, errorCount: 0, warningCount: 3,
  },
  '1stTest/emk-uguns.js': {
    nodeTypeCounts: { time: 1, sub: 2, uv: 1, vec2: 3, add: 3, mul: 7, split: 1, cos: 2, sin: 2, color: 1, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 31, errorCount: 0, warningCount: 2,
  },
  '1stTest/ez_udens.js': {
    nodeTypeCounts: { time: 1, color: 2, float: 1, mul: 5, unknown: 2, remap: 1, add: 4, clamp: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 22, errorCount: 0, warningCount: 2,
  },
  '1stTest/ez_uguns.js': {
    nodeTypeCounts: { time: 1, sub: 2, uv: 2, vec2: 3, add: 4, mul: 10, split: 1, cos: 2, sin: 2, color: 2, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 37, errorCount: 0, warningCount: 2,
  },
  '1stTest/li_udens.js': {
    nodeTypeCounts: { color: 2, time: 1, float: 1, mul: 5, unknown: 2, remap: 1, add: 4, clamp: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 22, errorCount: 0, warningCount: 2,
  },
  '1stTest/li_uguns.js': {
    nodeTypeCounts: { color: 2, sub: 2, uv: 2, vec2: 3, add: 4, mul: 10, split: 1, cos: 2, sin: 2, time: 1, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 37, errorCount: 0, warningCount: 2,
  },
  '1stTest/lo_udens.js': {
    nodeTypeCounts: { time: 1, color: 2, mul: 3, div: 3, unknown: 2, mix: 3, split: 2, add: 3, clamp: 3, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 28, errorCount: 0, warningCount: 2,
  },
  '1stTest/lo_uguns.js': {
    nodeTypeCounts: { time: 1, sub: 6, uv: 2, vec2: 6, add: 5, mul: 13, split: 3, cos: 4, sin: 4, unknown: 2, div: 1, mix: 1, clamp: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 56, errorCount: 0, warningCount: 2,
  },
  '1stTest/my-shader 2.js': {
    nodeTypeCounts: { unknown: 2, color: 2, sub: 5, uv: 2, vec2: 6, add: 5, mul: 10, split: 2, cos: 4, sin: 4, time: 1, positionGeometry: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 49, errorCount: 0, warningCount: 2,
  },
  '1stTest/my-shader 3.js': {
    nodeTypeCounts: { unknown: 2, color: 2, sub: 5, uv: 2, vec2: 6, add: 5, mul: 10, split: 2, cos: 4, sin: 4, time: 1, positionGeometry: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 49, errorCount: 0, warningCount: 2,
  },
  '1stTest/rk-udens.js': {
    nodeTypeCounts: { color: 2, time: 1, float: 1, mul: 5, unknown: 2, add: 4, remap: 1, clamp: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 22, errorCount: 0, warningCount: 2,
  },
  '1stTest/rk-udens2.js': {
    nodeTypeCounts: { color: 2, time: 1, float: 1, unknown: 3, mul: 6, add: 5, remap: 1, sub: 1, clamp: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 28, errorCount: 0, warningCount: 3,
  },
  '1stTest/rk-uguns.js': {
    nodeTypeCounts: { color: 2, time: 1, sub: 2, uv: 2, vec2: 3, add: 4, mul: 10, split: 1, cos: 2, sin: 2, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 38, errorCount: 0, warningCount: 2,
  },
  '1stTest/tk-udens.js': {
    nodeTypeCounts: { color: 2, time: 1, float: 1, mul: 5, unknown: 2, remap: 1, add: 4, clamp: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 22, errorCount: 0, warningCount: 2,
  },
  '1stTest/tk-uguns.js': {
    nodeTypeCounts: { color: 2, time: 1, sub: 2, uv: 2, vec2: 3, add: 4, mul: 10, split: 1, cos: 2, sin: 2, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 37, errorCount: 0, warningCount: 2,
  },
  '1stTest/udens-shader.js': {
    nodeTypeCounts: { time: 1, float: 1, color: 2, mul: 5, unknown: 2, add: 4, remap: 1, clamp: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 22, errorCount: 0, warningCount: 2,
  },
  '1stTest/wood.js': {
    nodeTypeCounts: { property_float: 6, positionGeometry: 1, mul: 36, cos: 3, sin: 2, split: 1, sub: 3, add: 8, exp: 2, max: 1, div: 3, vec3: 7, perlin: 5, mix: 2, output: 1 },
    edgeCount: 114, errorCount: 0, warningCount: 0,
  },
  '1stTest/zd_udens.js': {
    nodeTypeCounts: { time: 1, float: 1, color: 2, mul: 5, unknown: 2, remap: 1, add: 4, clamp: 1, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 22, errorCount: 0, warningCount: 2,
  },
  '1stTest/zd_uguns.js': {
    nodeTypeCounts: { color: 2, sub: 2, uv: 2, vec2: 3, add: 4, mul: 10, split: 1, cos: 2, sin: 2, time: 1, unknown: 2, mix: 1, output: 1, positionLocal: 1, normalLocal: 1 },
    edgeCount: 37, errorCount: 0, warningCount: 2,
  },
  'morph-triangles-watercolor.tsl.js': {
    nodeTypeCounts: { property_float: 7, positionGeometry: 1, mul: 7, fbm: 2, add: 3, clamp: 2, voronoiVec3: 1, split: 1, sub: 1, smoothstep: 5, color: 8, mix: 7, output: 1 },
    edgeCount: 52, errorCount: 0, warningCount: 0,
  },
};

describe('parse corpus — human-authored shader fixtures under Tests/', () => {
  const files = collectShaderFiles(TESTS_DIR);

  it('covers exactly the fixture set on disk', () => {
    expect([...files].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const rel of files) {
    it(rel, () => {
      const stats = parseStats(readFileSync(join(TESTS_DIR, rel), 'utf8'));
      expect(stats).toEqual(EXPECTED[rel]);
    });
  }
});
