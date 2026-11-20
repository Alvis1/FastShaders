/**
 * The engine's status as the webview reads it: strict (an unknown state or a
 * malformed number is an unreadable answer), and never a throw — every command
 * resolves with a status or a reason.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE_MODEL_STATES, ENGINE_SERVER_STATES } from '@/utils/desktopIpc';
import {
  engineDeleteModel,
  engineDownload,
  engineStatus,
  engineStop,
  parseEngineStatus,
  type EngineModelBridge,
} from './engineModel';

const bytes = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const GOOD = {
  model: { key: 'gemma-4-e2b', label: 'Gemma 4 E2B', sizeBytes: 3_106_738_272, state: 'downloading', doneBytes: 1_000_000 },
  server: { state: 'stopped' },
  diskFreeBytes: 86_000_000_000,
};
const withModel = (over: Record<string, unknown>) => ({ ...GOOD, model: { ...GOOD.model, ...over } });

describe('parseEngineStatus', () => {
  it('reads a status, keeping only the fields it knows', () => {
    expect(parseEngineStatus(bytes({ ...GOOD, extra: 1 }))).toEqual(GOOD);
  });

  it('accepts every state Rust can send', () => {
    for (const state of ENGINE_MODEL_STATES) {
      expect(parseEngineStatus(bytes(withModel({ state })))?.model.state, state).toBe(state);
    }
    for (const state of ENGINE_SERVER_STATES) {
      expect(parseEngineStatus(bytes({ ...GOOD, server: { state, detail: 'why' } }))?.server, state).toEqual({ state, detail: 'why' });
    }
  });

  it('refuses anything else', () => {
    const bad: unknown[] = [
      'not json',
      '[]',
      'null',
      { model: GOOD.model },
      { ...GOOD, server: { state: 'running' } },
      withModel({ state: 'done' }),
      withModel({ state: 5 }),
      withModel({ sizeBytes: 0 }),
      withModel({ sizeBytes: -1 }),
      withModel({ sizeBytes: '3' }),
      withModel({ doneBytes: 1.5 }),
      withModel({ doneBytes: GOOD.model.sizeBytes + 1 }),
      withModel({ needBytes: Number.MAX_SAFE_INTEGER + 2 }),
      withModel({ key: '' }),
      withModel({ label: 'x'.repeat(65) }),
      withModel({ detail: 'x'.repeat(201) }),
      withModel({ detail: { toString: 1 } }),
      { ...GOOD, diskFreeBytes: '86' },
      { ...GOOD, server: { state: 'failed', detail: 7 } },
    ];
    for (const v of bad) expect(parseEngineStatus(bytes(v)), JSON.stringify(v).slice(0, 80)).toBeNull();
    // Not UTF-8 at all.
    expect(parseEngineStatus(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });

  it('a hostile key cannot reach a prototype', () => {
    const parsed = parseEngineStatus(bytes('{"__proto__":{"x":1},"model":{"key":"k","label":"L","sizeBytes":1,"state":"none"},"server":{"state":"stopped"}}'));
    expect(parsed).toEqual({ model: { key: 'k', label: 'L', sizeBytes: 1, state: 'none' }, server: { state: 'stopped' } });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('the commands', () => {
  const bridge = (over: Partial<EngineModelBridge>): EngineModelBridge => ({
    available: () => true,
    status: async () => bytes(GOOD),
    download: async () => bytes(GOOD),
    remove: async () => bytes(GOOD),
    stop: async () => bytes(GOOD),
    ...over,
  });

  it('each resolves with the status after it', async () => {
    const seen: string[] = [];
    const b = bridge({ download: async (action) => { seen.push(action); return bytes(GOOD); } });
    expect(await engineStatus(b)).toEqual({ ok: true, status: GOOD });
    expect(await engineDownload('start', b)).toEqual({ ok: true, status: GOOD });
    await engineDownload('pause', b);
    await engineDownload('cancel', b);
    expect(seen).toEqual(['start', 'pause', 'cancel']);
    expect((await engineDeleteModel(b)).ok).toBe(true);
    expect((await engineStop(b)).ok).toBe(true);
  });

  it('never throw: no bridge, a refusal and an unreadable answer are all values', async () => {
    expect(await engineStatus(bridge({ available: () => false }))).toEqual({ ok: false, detail: 'not the desktop app' });
    expect(await engineStatus(bridge({ status: async () => { throw 'E_NOT_READY survey first'; } }))).toEqual({ ok: false, detail: 'survey first' });
    expect(await engineStatus(bridge({ status: async () => 'nonsense' }))).toEqual({ ok: false, detail: 'unreadable answer' });
    expect(await engineDownload('start', bridge({ download: () => Promise.reject(new Error('boom')) }))).toMatchObject({ ok: false });
  });
});
