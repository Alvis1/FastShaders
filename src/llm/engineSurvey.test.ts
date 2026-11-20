import { describe, expect, it } from 'vitest';
import { ENGINE_SURVEY_STATES } from '@/utils/desktopIpc';
import { parseEngineSurvey, runEngineSurvey, type EngineBridge } from './engineSurvey';

const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

/** What engine.rs answered on an M4 Max (2026-11-19, the quarantined-copy run). */
const REAL = {
  state: 'ok',
  engine: 'b12359',
  version: '1.0.0-dev (build 12359, commit b1b770d90)',
  devices: [
    { id: 'MTL0', name: 'Apple M4 Max', totalMib: 110100, freeMib: 110100 },
    { id: 'BLAS', name: 'Accelerate', totalMib: 0, freeMib: 0 },
  ],
  ramBytes: 137438953472,
  diskFreeBytes: 86273527808,
  osVersion: '27.0.1',
};

const bridge = (answer: () => Promise<unknown>, available = true): EngineBridge => ({
  available: () => available,
  survey: answer,
});

describe('parseEngineSurvey', () => {
  it('reads what engine.rs writes', () => {
    expect(parseEngineSurvey(enc(REAL))).toEqual(REAL);
    const minimal = { state: 'intel-mac', engine: 'b12359', devices: [] };
    expect(parseEngineSurvey(enc(minimal))).toEqual(minimal);
  });

  it('accepts every state Rust can send, and nothing else', () => {
    for (const state of ENGINE_SURVEY_STATES) {
      expect(parseEngineSurvey(enc({ ...REAL, state }))?.state).toBe(state);
    }
    for (const state of ['OK', 'ready', '', 'constructor', 'toString']) {
      expect(parseEngineSurvey(enc({ ...REAL, state })), state).toBeNull();
    }
  });

  it('refuses an answer with any field of the wrong shape', () => {
    const bad: unknown[] = [
      'not json',
      '[]',
      'null',
      { ...REAL, engine: 7 },
      { ...REAL, engine: 'x'.repeat(33) },
      { ...REAL, devices: 'MTL0' },
      { ...REAL, devices: Array.from({ length: 17 }, (_, i) => ({ id: `D${i}`, name: 'g', totalMib: 1, freeMib: 1 })) },
      { ...REAL, devices: [{ id: '', name: 'g', totalMib: 1, freeMib: 1 }] },
      { ...REAL, devices: [{ id: 'MTL0', name: 'g', totalMib: -1, freeMib: 1 }] },
      { ...REAL, devices: [{ id: 'MTL0', name: 'g', totalMib: 1.5, freeMib: 1 }] },
      { ...REAL, devices: [{ id: 'MTL0', name: { toString: 1 }, totalMib: 1, freeMib: 1 }] },
      { ...REAL, devices: [null] },
      { ...REAL, ramBytes: '8' },
      { ...REAL, ramBytes: -8 },
      { ...REAL, diskFreeBytes: 1e300 },
      { ...REAL, detail: 5 },
      { ...REAL, version: 'v'.repeat(201) },
      { ...REAL, osVersion: ['27'] },
    ];
    for (const b of bad) expect(parseEngineSurvey(enc(b)), JSON.stringify(b).slice(0, 60)).toBeNull();
    expect(parseEngineSurvey(new Uint8Array([0xff, 0xfe, 0x7b]))).toBeNull();
  });

  it('keeps a device name as text, whatever it spells', () => {
    const odd = { ...REAL, devices: [{ id: 'MTL0', name: '<img src=x onerror=alert(1)>', totalMib: 1, freeMib: 1 }] };
    expect(parseEngineSurvey(enc(odd))?.devices[0].name).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('runEngineSurvey', () => {
  it('outside the desktop app it says so without calling anything', async () => {
    let called = false;
    const r = await runEngineSurvey(bridge(async () => { called = true; return null; }, false));
    expect(r).toEqual({ ok: false, reason: 'unavailable', detail: 'not the desktop app' });
    expect(called).toBe(false);
  });

  it('parses the raw bytes the bridge hands back, in any of its shapes', async () => {
    const bytes = enc(REAL);
    for (const raw of [bytes.buffer, bytes, Array.from(bytes)]) {
      const r = await runEngineSurvey(bridge(async () => raw));
      expect(r).toEqual({ ok: true, survey: REAL });
    }
  });

  it('maps a refusal: E_BUSY is busy, anything else an error with its words', async () => {
    expect(await runEngineSurvey(bridge(async () => { throw 'E_BUSY'; }))).toEqual({ ok: false, reason: 'busy', detail: '' });
    expect(await runEngineSurvey(bridge(async () => { throw 'E_FORBIDDEN'; }))).toEqual({ ok: false, reason: 'error', detail: 'FORBIDDEN' });
    expect(await runEngineSurvey(bridge(async () => { throw new Error('boom'); }))).toEqual({ ok: false, reason: 'error', detail: 'boom' });
    expect(await runEngineSurvey(bridge(async () => 'not bytes'))).toEqual({ ok: false, reason: 'error', detail: 'unreadable answer' });
    expect(await runEngineSurvey(bridge(async () => enc({ state: 'nope' }).buffer))).toEqual({ ok: false, reason: 'error', detail: 'unreadable answer' });
  });
});
