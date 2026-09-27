/**
 * A LIT Splat Output — "React to light" (2026-09-27, owner: splats should
 * react to light the way Blender 5.3's do once its Emission node is swapped
 * for a Diffuse BSDF). LEAF module: the emitter, the parser, the node, its
 * tile and its settings menu all read these, so it imports only another leaf.
 *
 * Two halves, switched together by ONE key, `values.lit`:
 *
 *  - the LOADER half: the module's return carries `lit: true`, and loader 0.8
 *    then passes each splat's own SURFACE NORMAL as `n` (the thinnest axis of
 *    its covariance, world space, facing the camera) instead of the direction
 *    to the camera (a-frame-shaderloader, section 9b, `splatSurfaceNormal`);
 *  - the GRAPH half: a key light emitted INSIDE the shade Fn,
 *      const sp1Light = add(mul(<colour>, max(dot(n, normalize(add(vec3(x, y, z), 1e-9))), 0)), <ambient>);
 *      return vec4(mul(<rgb>, sp1Light), <opacity>);
 *    so the lighting is visible in the code panel like the Raymarch Output's.
 *    The `1e-9` (SPLAT_LIGHT_DIRECTION_EPSILON) keeps a ZERO direction from
 *    normalising to NaN, which blacked out every splat.
 *
 * The light is in WORLD space (so a turning model moves under a fixed light),
 * and it MULTIPLIES the captured colour, which already holds the light of the
 * capture: the defaults sum to 1 (0.6 key + 0.4 ambient), so a splat facing
 * the light keeps exactly its captured colour and the far side darkens to 40%.
 *
 * Only the literal `true` lights (node data is untrusted), and "off" DELETES
 * the key — never `false` — so a node switched back off is the node that was
 * never touched: the one flag rule `invert` and `replaceColor` follow too
 * (utils/trueFlag.ts, the only module this leaf imports).
 */
import { hasTrueFlag, withTrueFlag } from './trueFlag';

/** The key light's sockets, in row order: the direction the light comes FROM
 *  (normalised by the emitted line), its colour, and the ambient floor — the
 *  Raymarch Output's names, so the two Light sections read alike. */
export const SPLAT_LIGHT_PORTS: readonly string[] = ['lightX', 'lightY', 'lightZ', 'lightColor', 'ambient'];

/** The direction's defaults — upper right, in front: the Raymarch Output's.
 *  The registry's `defaultValues` must hold the same numbers (pinned). */
export const SPLAT_LIGHT_DIRECTION_DEFAULTS: Readonly<Record<'lightX' | 'lightY' | 'lightZ', number>> = {
  lightX: 0.6,
  lightY: 0.8,
  lightZ: 0.5,
};

/**
 * Added to every component of the direction before it is normalised. A zero
 * vector — three numbers dragged to 0, or `sin(time)` wired to one of them with
 * the other two at 0, on a paused preview — normalises to NaN on the GPU, and
 * that NaN reached every lit splat's colour. With it the zero vector lights
 * from the (1, 1, 1) diagonal, and a real direction does not move: 1e-9 is
 * under half a float32 step of any component above 1/32 in magnitude, and a
 * smaller component moves by 1e-9 — visible only on a vector that is itself
 * within a hair of zero. Covers wires too, which an emit-time check could not. The
 * parse reads this exact number back.
 */
export const SPLAT_LIGHT_DIRECTION_EPSILON = 1e-9;

/**
 * The two colours' defaults: what an UNSET socket emits (a `vec3` literal the
 * parser reads back as unset, never `color(0x…)`, which it reads as stored)
 * and the swatch it shows. The swatch is the sRGB hex of the same LINEAR value
 * (`color(0xcbcbcb)` is 0.597, `color(0xaaaaaa)` 0.402), so picking the shown
 * default emits what was already rendering.
 */
export const SPLAT_LIGHT_COLOR_DEFAULTS: Readonly<Record<'lightColor' | 'ambient', { linear: number; emit: string; hex: string }>> = {
  lightColor: { linear: 0.6, emit: 'vec3(0.6, 0.6, 0.6)', hex: '#cbcbcb' },
  ambient: { linear: 0.4, emit: 'vec3(0.4, 0.4, 0.4)', hex: '#aaaaaa' },
};

/** Is this a light COLOUR socket (a swatch), rather than a direction number? */
export function isSplatLightColorPort(portId: string): portId is 'lightColor' | 'ambient' {
  return portId === 'lightColor' || portId === 'ambient';
}

/** Does this node's raw `values` switch the light on? The OWN key, strictly
 *  the literal `true` — exactly what the emitter counts. */
export function isSplatLit(rawValues: unknown): boolean {
  return hasTrueFlag(rawValues, 'lit');
}

/** `values` with the light switched: `lit: true` added, or the key DELETED.
 *  A fresh object; the input is never mutated. */
export function splatLitValues(values: Readonly<Record<string, unknown>>, on: boolean): Record<string, unknown> {
  return withTrueFlag(values, 'lit', on);
}

/**
 * The light values a code-panel Apply cannot see. The resync rebuilds the
 * active Splat Output from the module (useSyncEngine `mergeMatch`), and a
 * light value is IN the module only while the node is lit and that socket is
 * unwired — so the parse can never legitimately set the others: what the
 * parsed node holds there is only the registry's seeded default (Light X/Y/Z)
 * or nothing. Carried from the OLD node, whatever the parse seeded:
 *
 *  - every light value while the parsed node is UNLIT: the light is dormant,
 *    and switching it back on must bring back the light the user set;
 *  - a WIRED socket's value while lit: the wire wins at emission, the Output
 *    node's wired-channel carry.
 *
 * An unwired value of a LIT node stays code-authoritative (a colour edited back
 * to the default grey in the code panel really is cleared). OWN keys only.
 * Returns the next values (a fresh object), or null when nothing is carried.
 */
export function carrySplatLightValues(
  parsedValues: Readonly<Record<string, unknown>>,
  oldValues: Readonly<Record<string, unknown>>,
  isWired: (port: string) => boolean,
): Record<string, unknown> | null {
  const lit = isSplatLit(parsedValues);
  let next: Record<string, unknown> | null = null;
  for (const port of SPLAT_LIGHT_PORTS) {
    if (!Object.prototype.hasOwnProperty.call(oldValues, port)) continue;
    if (lit && !isWired(port)) continue;
    if (parsedValues[port] === oldValues[port]) continue;
    next ??= { ...parsedValues };
    next[port] = oldValues[port];
  }
  return next;
}

/**
 * The WIRES a code-panel Apply cannot see: an UNLIT Splat Output reads no Light
 * socket (utils/sdfPartition.ts `splatScopes`), so a wire into one is DORMANT —
 * its feeder is emitted in the flat body like any node nothing reads, and no
 * line of the module names the socket. The parse rebuilds the feeder but not
 * the wire, so without this every Apply deleted it, with no notice (a file
 * can carry one: the settings menu drops the wires when the light is switched
 * off, a hand-edited or older file need not). The edges counterpart of
 * `carrySplatLightValues`, and the Output node's wired-channel carry for
 * edges.
 *
 * Carried: an old edge into a Light socket of a Splat Output that was unlit
 * BEFORE the Apply and is unlit AFTER it, from a source that survived the
 * resync (`survivingIds`: a paired node keeps its OLD id, so the edge is
 * carried verbatim), into a socket the parse left unwired. Never while either
 * side is lit — a lit node's light wires ARE in the module, and deleting them
 * there is an edit. `oldEdges` must be the UNWRAPPED old edges (a feeder inside
 * a collapsed group). Pure; returns the edges to add.
 *
 * The CALLER's limit, shared with every resync carry: useSyncEngine runs it
 * only when the parse added no node (`unpositioned.length === 0`), since
 * otherwise the old graph may be another document whose type-paired nodes
 * would wire this one. An Apply that also adds a node drops the wire.
 */
export function carryDormantLightEdges<E extends { source: string; target: string; targetHandle?: string | null }>(
  oldNodes: readonly { id: string; data: { registryType?: unknown; values?: unknown } }[],
  finalNodes: readonly { id: string; data: { registryType?: unknown; values?: unknown } }[],
  oldEdges: readonly E[],
  parsedEdges: readonly { target: string; targetHandle?: string | null }[],
  survivingIds: ReadonlySet<string>,
): E[] {
  const unlitSplat = (n: { data: { registryType?: unknown; values?: unknown } } | undefined) =>
    !!n && n.data.registryType === 'splatOutput' && !isSplatLit(n.data.values);
  const dormant = new Set<string>();
  for (const n of finalNodes) {
    if (unlitSplat(n) && unlitSplat(oldNodes.find((o) => o.id === n.id))) dormant.add(n.id);
  }
  if (dormant.size === 0) return [];
  return oldEdges.filter(
    (e) =>
      dormant.has(e.target) &&
      SPLAT_LIGHT_PORTS.includes(e.targetHandle ?? '') &&
      survivingIds.has(e.source) &&
      !parsedEdges.some((p) => p.target === e.target && p.targetHandle === e.targetHandle),
  );
}

/**
 * How many Splat Outputs are lit — a per-notify selector's answer (a number:
 * no allocation, and any one node switching changes it). The preview's canvas
 * note reads it to tell a SETTINGS change from a wire: unticking React to
 * light is what makes an unlit node's Normal notice appear, and that is not
 * news to the user who just did it (components/Preview/ShaderPreview.tsx).
 */
export function litSplatCount(nodes: readonly { data: { registryType?: unknown; values?: unknown } }[]): number {
  let count = 0;
  for (const n of nodes) if (n.data.registryType === 'splatOutput' && isSplatLit(n.data.values)) count++;
  return count;
}
