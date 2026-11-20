/**
 * The bundled engine's survey (src-tauri/src/engine.rs `llm_engine_survey`):
 * is there an engine for this computer, did every file match its pin, does it
 * run, which GPU devices does it see, and how much memory and free disk there
 * is. The setup pane runs it when the built-in route is shown
 * (setupStates.ts turns the answer into ONE box).
 *
 * The answer crosses as raw JSON bytes. Rust wrote it, but its device names
 * and version are an outside program's output, so the parse is STRICT: a field
 * of the wrong type, an unknown state, a string past its cap or a number that
 * is not a non-negative safe integer makes the whole answer `null`, which the
 * pane shows as "Could not check this computer".
 *
 * Every Tauri call goes through an `EngineBridge`, so tests drive this with a
 * fake (the tauriTransport.ts pattern). Never throws, never rejects.
 */
import { ENGINE_SURVEY_STATES, LLM_ENGINE_SURVEY, desktopBytes, parseDesktopError } from '@/utils/desktopIpc';
import { safeJsonReviver } from '@/utils/safeJson';
import { errorText, hasDesktopBridge, invokeDesktop } from '@/utils/tauriBridge';

export type EngineSurveyState = (typeof ENGINE_SURVEY_STATES)[number];

export interface EngineDevice {
  /** `MTL0`, `Vulkan0`, `BLAS`, … as llama-server names it. */
  id: string;
  name: string;
  totalMib: number;
  freeMib: number;
}

export interface EngineSurvey {
  state: EngineSurveyState;
  /** Why, for a state other than `ok`: DATA for display, never markup. */
  detail?: string;
  /** The pinned llama.cpp build tag. */
  engine: string;
  version?: string;
  devices: EngineDevice[];
  ramBytes?: number;
  diskFreeBytes?: number;
  osVersion?: string;
}

export type SurveyOutcome =
  | { ok: true; survey: EngineSurvey }
  | { ok: false; reason: 'busy' | 'unavailable' | 'error'; detail: string };

/** What the survey needs from Tauri; `tauriEngineBridge` is the real one. */
export interface EngineBridge {
  available(): boolean;
  survey(): Promise<unknown>;
}

export const tauriEngineBridge: EngineBridge = {
  available: hasDesktopBridge,
  survey: () => invokeDesktop(LLM_ENGINE_SURVEY),
};

/** Rust caps every text at 120 characters; anything longer is not its answer. */
const MAX_TEXT = 200;
const MAX_ID = 32;
const MAX_DEVICES = 16;
const STATES: ReadonlySet<string> = new Set(ENGINE_SURVEY_STATES);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function parseDevice(v: unknown): EngineDevice | null {
  if (!isRecord(v)) return null;
  const { id, name, totalMib, freeMib } = v;
  if (!isText(id, MAX_ID) || id === '' || !isText(name, MAX_TEXT) || !isCount(totalMib) || !isCount(freeMib)) return null;
  return { id, name, totalMib, freeMib };
}

/** The survey from its raw bytes, or null when they are not exactly one. */
export function parseEngineSurvey(bytes: Uint8Array): EngineSurvey | null {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), safeJsonReviver);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  const { state, detail, engine, version, devices, ramBytes, diskFreeBytes, osVersion } = v;
  if (typeof state !== 'string' || !STATES.has(state)) return null;
  if (!isText(engine, MAX_ID)) return null;
  if (!Array.isArray(devices) || devices.length > MAX_DEVICES) return null;
  const parsedDevices: EngineDevice[] = [];
  for (const d of devices) {
    const device = parseDevice(d);
    if (!device) return null;
    parsedDevices.push(device);
  }
  const survey: EngineSurvey = { state: state as EngineSurveyState, engine, devices: parsedDevices };
  for (const [key, value] of [['detail', detail], ['version', version], ['osVersion', osVersion]] as const) {
    if (value === undefined) continue;
    if (!isText(value, MAX_TEXT)) return null;
    survey[key] = value;
  }
  for (const [key, value] of [['ramBytes', ramBytes], ['diskFreeBytes', diskFreeBytes]] as const) {
    if (value === undefined) continue;
    if (!isCount(value)) return null;
    survey[key] = value;
  }
  return survey;
}

/** Run the survey. Resolves with the answer or why there is none. */
export async function runEngineSurvey(bridge: EngineBridge = tauriEngineBridge): Promise<SurveyOutcome> {
  if (!bridge.available()) return { ok: false, reason: 'unavailable', detail: 'not the desktop app' };
  let raw: unknown;
  try {
    raw = await bridge.survey();
  } catch (e) {
    const parsed = parseDesktopError(e);
    if (parsed?.code === 'BUSY') return { ok: false, reason: 'busy', detail: '' };
    return { ok: false, reason: 'error', detail: parsed?.detail ?? parsed?.code ?? errorText(e) };
  }
  let survey: EngineSurvey | null;
  try {
    survey = parseEngineSurvey(desktopBytes(raw));
  } catch {
    survey = null;
  }
  return survey ? { ok: true, survey } : { ok: false, reason: 'error', detail: 'unreadable answer' };
}
