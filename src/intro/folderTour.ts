/**
 * The intro's Work folder slide as data: pick a folder, open its list, load
 * one shader, then another, change a value and Save it back.
 *
 * The folder is an EXAMPLE (the slide cannot read the user's disk, and the
 * control exists only in the desktop app): its files and the two small graphs
 * they hold are the slide's own. Which file is marked current, the name the
 * shader takes from its file, and what Save writes back to are the app's rules
 * (`adoptShaderName`, `workFolderSaveName` — FolderScene reads them).
 *
 * Pure and node-testable, like the other tours.
 */
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

/** The example folder, in the order the list shows it. */
export const FOLDER_NAME = 'My shaders';
export const FOLDER_FILES = [
  { fileName: 'lava.zip', sizeBytes: 231_000 },
  { fileName: 'metal.js', sizeBytes: 9_400 },
  { fileName: 'waves.js', sizeBytes: 14_100 },
] as const;
export type FolderDoc = 'none' | 'waves.js' | 'metal.js';

/** The value the edit scrubs, before and after (the Float feeding Roughness). */
export const EDIT_FROM = 0.3;
export const EDIT_TO = 0.8;
const EDIT_STEP = 0.1;
/** Stage px the pointer travels per step of the scrub. */
const SCRUB_PX = 9;

export interface FolderGeometry {
  /** "Work folder" before a folder is picked; the caret and Save after. */
  pick: Point;
  caret: Point;
  save: Point;
  rows: Record<'waves.js' | 'metal.js', Point>;
  /** The Float's number, where the scrub starts. */
  value: Point;
}

export interface FolderState {
  /** A folder has been picked: the control is Save | ▾. */
  picked: boolean;
  /** The folder's list is open. */
  list: boolean;
  /** The file the editor holds. */
  doc: FolderDoc;
  /** The edited value, as stored. */
  value: number;
  /** Save's green flash (`toolbar__wf-save--saved`). */
  saved: boolean;
  pressed: boolean;
}

export interface FolderTour {
  geo: FolderGeometry;
  tl: Timeline<FolderState>;
  /** Stills: the list open on the second load, the saved flash. */
  listed: number;
  saved: number;
}

const REST: Point = { x: 260, y: 250 };

export function buildFolderTour(geo: FolderGeometry): FolderTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  let cur: FolderState = {
    picked: false, list: false, doc: 'none', value: EDIT_FROM, saved: false, pressed: false,
  };
  const steps: Step<FolderState>[] = [];
  /** A step from the state so far, changed by `patch` (a press is momentary). */
  const go = (ms: number, to: Point, patch: Partial<FolderState> = {}) => {
    cur = { ...cur, pressed: false, ...patch };
    steps.push({ ms, to: at(to), state: cur });
  };

  go(600, REST);
  go(800, geo.pick);
  go(240, geo.pick, { pressed: true });
  go(600, geo.pick, { picked: true });
  // First load.
  go(700, geo.caret);
  go(220, geo.caret, { pressed: true, list: true });
  go(500, geo.caret);
  go(600, geo.rows['waves.js']);
  go(220, geo.rows['waves.js'], { pressed: true });
  go(1500, geo.rows['waves.js'], { list: false, doc: 'waves.js' });
  // Second load.
  go(700, geo.caret);
  go(220, geo.caret, { pressed: true, list: true });
  const listedAt = steps.length;
  go(500, geo.caret);
  go(600, geo.rows['metal.js']);
  go(220, geo.rows['metal.js'], { pressed: true });
  go(1000, geo.rows['metal.js'], { list: false, doc: 'metal.js' });
  // The edit: press the number and scrub it up.
  go(800, geo.value);
  go(200, geo.value, { pressed: true });
  const n = Math.round((EDIT_TO - EDIT_FROM) / EDIT_STEP);
  for (let i = 1; i <= n; i++) {
    go(140, { x: geo.value.x + i * SCRUB_PX, y: geo.value.y }, {
      pressed: true,
      value: Math.round((EDIT_FROM + i * EDIT_STEP) * 10) / 10,
    });
  }
  const edited = { x: geo.value.x + n * SCRUB_PX, y: geo.value.y };
  go(500, edited);
  // Save.
  go(900, geo.save);
  go(220, geo.save, { pressed: true });
  const savedAt = steps.length;
  go(1600, geo.save, { saved: true });
  go(700, geo.save, { saved: false });
  go(600, { x: geo.save.x + 40, y: geo.save.y + 90 });

  const tl = timeline(at(REST), steps);
  return { geo, tl, listed: stepMiddle(tl, listedAt), saved: stepMiddle(tl, savedAt) };
}

export function folderFrame(tour: FolderTour, t: number): { cursor: Point; state: FolderState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}
