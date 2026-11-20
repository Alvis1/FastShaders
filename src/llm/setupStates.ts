/**
 * What the setup pane shows, as data: ONE box per state (SEARCH-AI-PLAN §13
 * R-a, "nobody guesses the next step"). A pure leaf — the dialog renders the
 * box and wires its actions; this module only decides which box.
 *
 * The rules every box keeps (setupStates.test.ts):
 *  - an `error` box has exactly ONE primary action, and that action is the fix
 *    or the way around (`role="alert"`); an `info` box has at most one;
 *  - a `status` line (checking, starting) and a `done` line (✓) have none;
 *  - the text is the ENGLISH sentence, translated by `t()`, so every one of
 *    them has a `src/i18n/lv.json` entry; `{placeholders}` are filled by
 *    `fillTemplate` after translation;
 *  - at most 2 sentences and 20 words (R-b).
 *
 * This module holds the bundled engine's SURVEY half (P5, the first step).
 * The download, start and load states join it as their steps land.
 */
import type { EngineSurvey } from './engineSurvey';
import type { EngineStatus } from './engineModel';

export type BoxVariant = 'status' | 'info' | 'error' | 'done';

/** Everything a box button can do; the dialog maps each to one handler. */
export type SetupAction =
  | 'checkAgain'
  | 'otherWays'
  | 'useOwnServer'
  | 'useApiKey'
  // The model's own steps (modelSetupBox).
  | 'download'
  | 'notNow'
  | 'pause'
  | 'resume'
  | 'cancelDownload'
  | 'downloadAgain'
  | 'startAgain'
  | 'deleteModel'
  | 'keepModel';

export interface SetupBox {
  variant: BoxVariant;
  /** English, through `t()`. */
  text: string;
  vars?: Readonly<Record<string, string>>;
  primary?: SetupAction;
  secondary?: SetupAction;
  /** The system's own words for a failure, shown muted under the box. */
  detail?: string;
  /** A second, quieter line of the box (English, through `t()`, same `vars`). */
  body?: string;
  /** A download's share done, 0–1: the box draws a bar. */
  progress?: number;
}

/** The button label of each action (English, through `t()`). */
export const ACTION_LABELS: Readonly<Record<SetupAction, string>> = {
  checkAgain: 'Check again',
  otherWays: 'Other ways',
  useOwnServer: 'Use LM Studio / Ollama',
  useApiKey: 'Use an API key',
  // Filled with the box's own `vars`, like its text.
  download: 'Download {size} GB',
  notNow: 'Not now',
  pause: 'Pause',
  resume: 'Resume',
  cancelDownload: 'Cancel',
  downloadAgain: 'Download again',
  startAgain: 'Start again',
  deleteModel: 'Delete',
  keepModel: 'Cancel',
};

/** The engine's state while the pane looks at it. */
export type EngineSetupState =
  | { kind: 'surveying' }
  /** The survey itself could not run (the bridge refused, an unreadable answer). */
  | { kind: 'unchecked'; detail: string }
  | { kind: 'surveyed'; survey: EngineSurvey };

/** Below this, the "needs 8 GB" box. An 8 GB Windows machine reports a little
 *  less than 8 GiB (firmware and graphics reserve some), so the line sits at 7.5. */
export const MIN_RAM_BYTES = 7.5 * 1024 ** 3;

/** Whole GB as the user reads them on the box ("8 GB", not 7.84). */
export const wholeGb = (bytes: number): string => String(Math.max(1, Math.round(bytes / 1024 ** 3)));

export interface SetupContext {
  /** The Claude route is offered by this build: refusals point to it first. */
  claudeOffered: boolean;
}

/** The way around a computer that cannot run the built-in engine. */
const wayAround = (ctx: SetupContext): SetupAction => (ctx.claudeOffered ? 'useApiKey' : 'useOwnServer');

export function engineSetupBox(state: EngineSetupState, ctx: SetupContext): SetupBox {
  if (state.kind === 'surveying') return { variant: 'status', text: 'Checking this computer…' };
  if (state.kind === 'unchecked') {
    return { variant: 'error', text: 'Could not check this computer.', primary: 'checkAgain', secondary: 'otherWays', detail: state.detail || undefined };
  }
  const s = state.survey;
  const detail = s.detail || undefined;
  switch (s.state) {
    case 'ok': {
      if (s.ramBytes !== undefined && s.ramBytes < MIN_RAM_BYTES) {
        return {
          variant: 'error',
          text: 'This computer has {ram} GB of memory; the AI needs 8 GB.',
          vars: { ram: wholeGb(s.ramBytes) },
          primary: wayAround(ctx),
          secondary: 'otherWays',
        };
      }
      const gpu = s.devices.find((d) => /^(MTL|Vulkan)\d+$/.test(d.id));
      return gpu
        ? { variant: 'done', text: '✓ The built-in AI runs on this computer ({device})', vars: { device: gpu.name } }
        : { variant: 'done', text: '✓ The built-in AI runs on this computer, without a graphics card: about 1–3 min per try' };
    }
    case 'intel-mac':
      return { variant: 'error', text: 'Intel Macs can’t run the built-in AI. Use LM Studio or Ollama.', primary: 'useOwnServer', secondary: 'otherWays' };
    case 'old-mac':
      return { variant: 'error', text: 'The built-in AI needs macOS 13.3 or newer.', primary: wayAround(ctx), secondary: 'otherWays', detail };
    case 'unsupported':
      return { variant: 'error', text: 'This computer can’t run the built-in AI. Use LM Studio or Ollama.', primary: 'useOwnServer', secondary: 'otherWays' };
    case 'missing':
      return { variant: 'error', text: 'This build of FastShaders has no built-in AI. Use LM Studio or Ollama.', primary: 'useOwnServer', secondary: 'otherWays', detail };
    case 'tampered':
      return { variant: 'error', text: 'The built-in AI failed its file check. Reinstall FastShaders.', primary: 'checkAgain', secondary: 'otherWays', detail };
    case 'blocked':
      return { variant: 'error', text: 'The system stopped the built-in AI from starting.', primary: 'checkAgain', secondary: 'otherWays', detail };
    case 'runtime-missing':
      return { variant: 'error', text: 'Install the Microsoft Visual C++ Redistributable (x64), then check again.', primary: 'checkAgain', secondary: 'otherWays', detail };
    case 'failed':
      return { variant: 'error', text: 'The built-in AI could not start on this computer.', primary: 'checkAgain', secondary: 'otherWays', detail };
  }
}

// ── The model: download, check, ready ──

/** What the pane knows about the model: nothing yet, an unreadable answer, or a status. */
export type ModelSetupState =
  | { kind: 'loading' }
  | { kind: 'unread'; detail: string }
  | { kind: 'status'; status: EngineStatus };

/** Free space a download must leave on the disk (= Rust `DISK_MARGIN`). */
export const DISK_MARGIN_BYTES = 2 * 1024 ** 3;

/** A file size the way the download button says it: decimal GB, one decimal ("3.1"). */
export const sizeGb = (bytes: number): string => (bytes / 1e9).toFixed(1);
/** Free space, never rounded up: whole decimal GB. */
export const freeGb = (bytes: number): string => String(Math.floor(bytes / 1e9));
/** Whole percent, never 100 before the last byte. */
export const percentDone = (done: number, total: number): number =>
  total > 0 ? Math.max(0, Math.min(done >= total ? 100 : 99, Math.floor((done / total) * 100))) : 0;

/** Is the model downloaded and checked, with nothing wrong with the engine? */
export function modelReady(state: ModelSetupState): boolean {
  return state.kind === 'status' && state.status.model.state === 'ready' && state.status.server.state !== 'failed';
}

/**
 * The ONE box for the model's current step, under the survey's ✓ line: the
 * download offer (the consent — nothing is ever downloaded silently), the
 * download, the check, and the finished state.
 */
export function modelSetupBox(state: ModelSetupState): SetupBox {
  if (state.kind === 'loading') return { variant: 'status', text: 'Checking this computer…' };
  if (state.kind === 'unread') {
    return { variant: 'error', text: 'Could not check this computer.', primary: 'checkAgain', secondary: 'otherWays', detail: state.detail || undefined };
  }
  const { model, server, diskFreeBytes } = state.status;
  const size = sizeGb(model.sizeBytes);
  const done = model.doneBytes ?? 0;
  const pct = percentDone(done, model.sizeBytes);
  const lowDisk = (need: number, free: number): SetupBox => ({
    variant: 'error',
    text: 'Needs {need} GB free disk space; there is {free} GB. Free some space.',
    vars: { need: String(Math.ceil(need / 1e9)), free: freeGb(free) },
    primary: 'checkAgain',
  });
  switch (model.state) {
    case 'none': {
      const need = model.sizeBytes + DISK_MARGIN_BYTES;
      if (diskFreeBytes !== undefined && diskFreeBytes < need) return lowDisk(need, diskFreeBytes);
      return {
        variant: 'info',
        text: 'Download the AI model ({size} GB)',
        body: diskFreeBytes !== undefined ? 'Model: {model}. Free disk space: {free} GB.' : 'Model: {model}.',
        vars: { size, model: model.label, free: freeGb(diskFreeBytes ?? 0) },
        primary: 'download',
        secondary: 'notNow',
      };
    }
    case 'low-disk':
      return lowDisk(model.needBytes ?? model.sizeBytes + DISK_MARGIN_BYTES, diskFreeBytes ?? 0);
    case 'downloading':
      return {
        variant: 'info',
        text: 'Downloading {done} of {size} GB ({pct}%)',
        vars: { done: sizeGb(done), size, pct: String(pct) },
        progress: model.sizeBytes > 0 ? Math.min(1, done / model.sizeBytes) : 0,
        primary: 'pause',
        secondary: 'cancelDownload',
      };
    case 'partial':
      return {
        variant: 'info',
        text: 'Download paused at {pct}%.',
        vars: { pct: String(pct) },
        progress: model.sizeBytes > 0 ? Math.min(1, done / model.sizeBytes) : 0,
        primary: 'resume',
        secondary: 'cancelDownload',
      };
    case 'offline':
      return { variant: 'error', text: 'Download stopped: no connection.', primary: 'resume', secondary: 'cancelDownload', detail: model.detail || undefined };
    case 'checking':
      return { variant: 'status', text: 'Checking the download…' };
    case 'bad-hash':
      return {
        variant: 'error',
        text: 'The file failed its check and was deleted. If this repeats, update FastShaders.',
        primary: 'downloadAgain',
        detail: model.detail || undefined,
      };
    case 'ready':
      if (server.state === 'failed') {
        return { variant: 'error', text: 'The built-in AI could not start on this computer.', primary: 'startAgain', secondary: 'otherWays', detail: server.detail || undefined };
      }
      if (server.state === 'starting') return { variant: 'status', text: 'Starting the AI…' };
      if (server.state === 'ready') return { variant: 'done', text: '✓ Ready on this computer' };
      return { variant: 'done', text: '✓ AI model downloaded ({size} GB)', vars: { size } };
  }
}

/** The inline confirm behind "Delete model". */
export function deleteModelBox(sizeBytes: number): SetupBox {
  return {
    variant: 'info',
    text: 'Delete the {size} GB model? You can download it again.',
    vars: { size: sizeGb(sizeBytes) },
    primary: 'deleteModel',
    secondary: 'keepModel',
  };
}
