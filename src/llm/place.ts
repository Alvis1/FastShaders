/**
 * Placement: the ONE commit path for a generated group — the dialog's Add
 * click, nothing else. It is the dropped-shader ADD (engine/projectImport.ts
 * `addDroppedShader`) handed the gate's canonical text as a file, so a
 * generated group gets exactly what a dropped one does: the ingest sanitizers,
 * its own Output left out, fresh ids, one group frame, ONE undo entry,
 * `fs:graph-merged`. A change to that path changes this one; that coupling is
 * the point (docs/dev/node-generator.md).
 *
 * The one thing it asks for on top (`wire`, owner 2026-11-20): the group's
 * end is wired into the LIVE Output's Color when that socket is still EMPTY —
 * a pressed Preset's rule (utils/libraryAutoWire.ts), never replacing a wire —
 * and the frame lands beside that Output, so the 3D view shows the result at
 * once. With Color taken, or no plain Output in charge, the group is parked
 * unwired as before (at `at`, when the request came from a spot on the
 * canvas) and the note says how to see it.
 *
 * The canonical text is comment-free (no project block for the ADD to find),
 * Fn-shaped (scriptToTSL passes it through), carries no image payload and
 * parses with zero warnings — so the ADD parses exactly the graph the gate
 * verified.
 */
import { addDroppedShader } from '@/engine/projectImport';
import { useAppStore } from '@/store/useAppStore';

export type PlaceOutcome =
  | { ok: true; added: number; groupLabel: string; wired: number }
  | { ok: false; reason: 'study' | 'no-shader' | 'nothing-to-add' | 'parse-failed' | 'over-budget' };

/** Longest group label taken from a prompt. */
export const MAX_GENERATED_LABEL = 40;

/**
 * The group's label: the request's first line, shortened. The ADD names a
 * group after the FILE's stem, which keeps only what follows the last `/` or
 * `\` — so those become spaces here, as do control characters.
 */
export function generatedStem(request: string): string {
  const firstLine = request.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? '';
  const flat = firstLine
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return 'Generated';
  if (flat.length <= MAX_GENERATED_LABEL) return flat;
  const cut = flat.slice(0, MAX_GENERATED_LABEL);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Add the gated program — wired into the Output's empty Color, else parked
 *  beside the graph — and say which. Refuses in a study session: the feature
 *  is absent there. */
export async function addGeneratedGroup(
  tsl: string,
  request: string,
  inStudy: () => boolean,
  at?: { x: number; y: number },
): Promise<PlaceOutcome> {
  if (inStudy()) return { ok: false, reason: 'study' };
  const file = new File([tsl], `${generatedStem(request)}.js`, { type: 'text/javascript' });
  const r = await addDroppedShader(file, { wire: true, at });
  if (!r.ok) return { ok: false, reason: r.reason };
  useAppStore.getState().showImportNote([{ kind: 'generated-added', name: r.groupLabel, nodes: r.added, wired: r.wired }]);
  return { ok: true, added: r.added, groupLabel: r.groupLabel, wired: r.wired };
}
