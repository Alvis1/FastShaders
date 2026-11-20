/**
 * The bundled engine's MODEL and PROCESS, as the desktop app reports them
 * (src-tauri/src/engine.rs, P5): one pinned model file — downloaded by the
 * engine, hashed by the app — and the engine process that serves it, which
 * Rust starts on the first chat and stops when idle.
 *
 * The webview only ASKS: `status` starts nothing, `download` names an action
 * and never a repository (there is one pin, compiled into the app), and a chat
 * goes through `transport/tauriTransport.ts engineTransport` with no address —
 * the engine's port and key never leave Rust.
 *
 * The answer is RAW JSON bytes, read here strictly: an unknown state, a
 * negative size or a text longer than the app sends is an unreadable answer,
 * not a box to draw. `detail` is DATA for display, never markup.
 */
import {
  ENGINE_MODEL_STATES,
  ENGINE_SERVER_STATES,
  LLM_ENGINE_DELETE,
  LLM_ENGINE_DOWNLOAD,
  LLM_ENGINE_STATUS,
  LLM_ENGINE_STOP,
  desktopBytes,
  parseDesktopError,
} from '@/utils/desktopIpc';
import { safeJsonReviver } from '@/utils/safeJson';
import { errorText, hasDesktopBridge, invokeDesktop } from '@/utils/tauriBridge';

export type EngineModelState = (typeof ENGINE_MODEL_STATES)[number];
export type EngineServerState = (typeof ENGINE_SERVER_STATES)[number];
export type DownloadAction = 'start' | 'pause' | 'cancel';

/** The name the served model answers to (= Rust `SERVED_ALIAS`). */
export const ENGINE_MODEL_ALIAS = 'fastshaders';

export interface EngineStatus {
  model: {
    key: string;
    /** The model's display name, e.g. "Gemma 4 E2B". */
    label: string;
    sizeBytes: number;
    state: EngineModelState;
    /** Bytes on disk, while a download exists. */
    doneBytes?: number;
    /** `low-disk`: the free space the download needs. */
    needBytes?: number;
    detail?: string;
  };
  server: { state: EngineServerState; detail?: string };
  diskFreeBytes?: number;
}

export type StatusOutcome =
  | { ok: true; status: EngineStatus }
  | { ok: false; detail: string };

export interface EngineModelBridge {
  available(): boolean;
  status(): Promise<unknown>;
  download(action: DownloadAction): Promise<unknown>;
  remove(): Promise<unknown>;
  stop(): Promise<unknown>;
}

export const tauriEngineModelBridge: EngineModelBridge = {
  available: hasDesktopBridge,
  status: () => invokeDesktop(LLM_ENGINE_STATUS),
  download: (action) => invokeDesktop(LLM_ENGINE_DOWNLOAD, { action }),
  remove: () => invokeDesktop(LLM_ENGINE_DELETE),
  stop: () => invokeDesktop(LLM_ENGINE_STOP),
};

const MAX_TEXT = 200;
const MAX_NAME = 64;
const MODEL_STATES: ReadonlySet<string> = new Set(ENGINE_MODEL_STATES);
const SERVER_STATES: ReadonlySet<string> = new Set(ENGINE_SERVER_STATES);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const optional = <T>(v: unknown, ok: (x: unknown) => x is T): v is T | undefined => v === undefined || ok(v);
const isDetail = (v: unknown): v is string => isText(v, MAX_TEXT);

/** Strict: null for anything that is not exactly a status. */
export function parseEngineStatus(bytes: Uint8Array): EngineStatus | null {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), safeJsonReviver);
  } catch {
    return null;
  }
  if (!isRecord(v) || !isRecord(v.model) || !isRecord(v.server)) return null;
  const { key, label, sizeBytes, state, doneBytes, needBytes, detail } = v.model;
  if (!isText(key, MAX_NAME) || key === '' || !isText(label, MAX_NAME) || label === '') return null;
  if (!isCount(sizeBytes) || sizeBytes === 0) return null;
  if (typeof state !== 'string' || !MODEL_STATES.has(state)) return null;
  if (!optional(doneBytes, isCount) || !optional(needBytes, isCount) || !optional(detail, isDetail)) return null;
  if (doneBytes !== undefined && doneBytes > sizeBytes) return null;
  const server = v.server;
  if (typeof server.state !== 'string' || !SERVER_STATES.has(server.state)) return null;
  if (!optional(server.detail, isDetail) || !optional(v.diskFreeBytes, isCount)) return null;
  return {
    model: {
      key,
      label,
      sizeBytes,
      state: state as EngineModelState,
      ...(doneBytes !== undefined ? { doneBytes } : {}),
      ...(needBytes !== undefined ? { needBytes } : {}),
      ...(detail !== undefined ? { detail } : {}),
    },
    server: {
      state: server.state as EngineServerState,
      ...(server.detail !== undefined ? { detail: server.detail } : {}),
    },
    ...(v.diskFreeBytes !== undefined ? { diskFreeBytes: v.diskFreeBytes } : {}),
  };
}

async function ask(call: () => Promise<unknown>, bridge: EngineModelBridge): Promise<StatusOutcome> {
  if (!bridge.available()) return { ok: false, detail: 'not the desktop app' };
  let raw: unknown;
  try {
    raw = await call();
  } catch (e) {
    const parsed = parseDesktopError(e);
    return { ok: false, detail: parsed?.detail ?? parsed?.code ?? errorText(e) };
  }
  let status: EngineStatus | null;
  try {
    status = parseEngineStatus(desktopBytes(raw));
  } catch {
    status = null;
  }
  return status ? { ok: true, status } : { ok: false, detail: 'unreadable answer' };
}

/** Never throws; every command answers with the status after it. */
export const engineStatus = (bridge: EngineModelBridge = tauriEngineModelBridge): Promise<StatusOutcome> =>
  ask(() => bridge.status(), bridge);
export const engineDownload = (action: DownloadAction, bridge: EngineModelBridge = tauriEngineModelBridge): Promise<StatusOutcome> =>
  ask(() => bridge.download(action), bridge);
export const engineDeleteModel = (bridge: EngineModelBridge = tauriEngineModelBridge): Promise<StatusOutcome> =>
  ask(() => bridge.remove(), bridge);
export const engineStop = (bridge: EngineModelBridge = tauriEngineModelBridge): Promise<StatusOutcome> =>
  ask(() => bridge.stop(), bridge);
