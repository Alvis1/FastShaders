import { describe, expect, it } from 'vitest';
import lv from '@/i18n/lv.json';
import { ENGINE_SURVEY_STATES } from '@/utils/desktopIpc';
import type { EngineSurvey } from './engineSurvey';
import { ENGINE_MODEL_STATES, ENGINE_SERVER_STATES } from '@/utils/desktopIpc';
import type { EngineStatus } from './engineModel';
import {
  ACTION_LABELS,
  DISK_MARGIN_BYTES,
  MIN_RAM_BYTES,
  deleteModelBox,
  engineSetupBox,
  freeGb,
  modelReady,
  modelSetupBox,
  percentDone,
  sizeGb,
  wholeGb,
  type EngineSetupState,
  type ModelSetupState,
  type SetupBox,
} from './setupStates';

const GB = 1024 ** 3;
const survey = (over: Partial<EngineSurvey>): EngineSurvey => ({
  state: 'ok',
  engine: 'b12359',
  devices: [{ id: 'MTL0', name: 'Apple M1', totalMib: 5461, freeMib: 5461 }],
  ramBytes: 8 * GB,
  ...over,
});
const surveyed = (over: Partial<EngineSurvey>): EngineSetupState => ({ kind: 'surveyed', survey: survey(over) });

/** Every box the survey half can show, in both route contexts. */
function everyBox(): Array<[string, SetupBox]> {
  const states: Array<[string, EngineSetupState]> = [
    ['surveying', { kind: 'surveying' }],
    ['unchecked', { kind: 'unchecked', detail: 'boom' }],
    ['ok', surveyed({})],
    ['ok, no gpu', surveyed({ devices: [{ id: 'CPU', name: 'CPU', totalMib: 0, freeMib: 0 }] })],
    ['ok, 4 GB', surveyed({ ramBytes: 4 * GB })],
    ...ENGINE_SURVEY_STATES.filter((s) => s !== 'ok').map((s): [string, EngineSetupState] => [s, surveyed({ state: s, detail: 'why' })]),
  ];
  const out: Array<[string, SetupBox]> = [];
  for (const claudeOffered of [true, false]) {
    for (const [name, st] of states) out.push([`${name} (claude ${claudeOffered})`, engineSetupBox(st, { claudeOffered })]);
  }
  for (const [name, st] of everyModelState()) out.push([`model: ${name}`, modelSetupBox(st)]);
  out.push(['delete confirm', deleteModelBox(SIZE)]);
  return out;
}

const SIZE = 3_106_738_272;
const status = (model: Partial<EngineStatus['model']>, server: EngineStatus['server'] = { state: 'stopped' }, diskFreeBytes: number | undefined = 86e9): ModelSetupState => ({
  kind: 'status',
  status: {
    model: { key: 'gemma-4-e2b', label: 'Gemma 4 E2B', sizeBytes: SIZE, state: 'none', ...model },
    server,
    ...(diskFreeBytes !== undefined ? { diskFreeBytes } : {}),
  },
});

/** Every model state Rust can report, with the variants that draw another box. */
function everyModelState(): Array<[string, ModelSetupState]> {
  const out: Array<[string, ModelSetupState]> = [
    ['loading', { kind: 'loading' }],
    ['unread', { kind: 'unread', detail: 'boom' }],
    ['none, disk unknown', status({}, { state: 'stopped' }, undefined)],
    ['none, disk short', status({}, { state: 'stopped' }, 4e9)],
  ];
  for (const state of ENGINE_MODEL_STATES) {
    out.push([state, status({ state, doneBytes: 1_250_000_000, needBytes: 5_500_000_000, detail: 'why' })]);
  }
  for (const state of ENGINE_SERVER_STATES) out.push([`ready, server ${state}`, status({ state: 'ready' }, { state, detail: 'why' })]);
  return out;
}

const ui = lv.ui as Record<string, string>;
const placeholders = (s: string) => [...s.matchAll(/\{([A-Za-z]\w*)\}/g)].map((m) => m[1]).sort();

describe('the engine survey boxes', () => {
  it('cover every survey state', () => {
    for (const state of ENGINE_SURVEY_STATES) {
      const box = engineSetupBox(surveyed({ state }), { claudeOffered: false });
      expect(box.text, state).toBeTruthy();
    }
  });

  it('an error has exactly one primary action; status and done lines have none', () => {
    for (const [name, box] of everyBox()) {
      if (box.variant === 'error') expect(box.primary, name).toBeDefined();
      if (box.variant === 'status' || box.variant === 'done') {
        expect(box.primary, name).toBeUndefined();
        expect(box.secondary, name).toBeUndefined();
      }
      if (box.secondary) expect(box.secondary, name).not.toBe(box.primary);
    }
  });

  it('every text and button label has its Latvian, with the same placeholders', () => {
    const texts = new Set<string>();
    for (const [, box] of everyBox()) {
      texts.add(box.text);
      if (box.body) texts.add(box.body);
    }
    texts.add('Delete model ({size} GB)');
    for (const label of Object.values(ACTION_LABELS)) texts.add(label);
    for (const text of texts) {
      expect(ui[text], text).toBeTruthy();
      expect(placeholders(ui[text]), text).toEqual(placeholders(text));
    }
  });

  it('every box is short: at most 2 sentences and 20 words (R-b)', () => {
    for (const [name, box] of everyBox()) {
      for (const text of [box.text, box.body ?? '']) {
        const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
        expect(words.length, name).toBeLessThanOrEqual(20);
        const sentences = text.split(/[.!?](?:\s|$)/).filter((s) => s.trim());
        expect(sentences.length, name).toBeLessThanOrEqual(2);
      }
    }
  });

  it('a computer that cannot run it points to the way around this build offers', () => {
    const low = surveyed({ ramBytes: 4 * GB });
    expect(engineSetupBox(low, { claudeOffered: true }).primary).toBe('useApiKey');
    expect(engineSetupBox(low, { claudeOffered: false }).primary).toBe('useOwnServer');
    expect(engineSetupBox(surveyed({ state: 'intel-mac' }), { claudeOffered: true }).primary).toBe('useOwnServer');
    expect(engineSetupBox(surveyed({ state: 'missing' }), { claudeOffered: true }).primary).toBe('useOwnServer');
  });

  it('a fault that may clear offers Check again, with the system’s words as detail', () => {
    for (const state of ['tampered', 'blocked', 'runtime-missing', 'failed'] as const) {
      const box = engineSetupBox(surveyed({ state, detail: 'exit code 3: oops' }), { claudeOffered: false });
      expect(box.primary, state).toBe('checkAgain');
      expect(box.detail, state).toBe('exit code 3: oops');
    }
  });

  it('names the GPU it found, and says so when there is none', () => {
    const ok = engineSetupBox(surveyed({}), { claudeOffered: false });
    expect(ok.variant).toBe('done');
    expect(ok.vars).toEqual({ device: 'Apple M1' });
    const cpu = engineSetupBox(surveyed({ devices: [{ id: 'BLAS', name: 'Accelerate', totalMib: 0, freeMib: 0 }] }), { claudeOffered: false });
    expect(cpu.text).toContain('without a graphics card');
    const vulkan = engineSetupBox(surveyed({ devices: [{ id: 'Vulkan0', name: 'Intel(R) UHD', totalMib: 1, freeMib: 1 }] }), { claudeOffered: false });
    expect(vulkan.vars).toEqual({ device: 'Intel(R) UHD' });
  });

  it('counts an 8 GB machine as 8 GB, though Windows reports a little less', () => {
    const win8 = 7.84 * GB;
    expect(win8).toBeGreaterThanOrEqual(MIN_RAM_BYTES);
    expect(engineSetupBox(surveyed({ ramBytes: win8 }), { claudeOffered: false }).variant).toBe('done');
    expect(engineSetupBox(surveyed({ ramBytes: 4 * GB }), { claudeOffered: false }).vars).toEqual({ ram: '4' });
    expect(wholeGb(7.84 * GB)).toBe('8');
    expect(wholeGb(0)).toBe('1');
    // No figure (an OS the survey cannot read): the engine's own run decides.
    expect(engineSetupBox(surveyed({ ramBytes: undefined }), { claudeOffered: false }).variant).toBe('done');
  });
});

describe('the model boxes', () => {
  const box = (model: Partial<EngineStatus['model']>, server?: EngineStatus['server'], free?: number) => modelSetupBox(status(model, server, free));

  it('cover every model and server state', () => {
    for (const [name, st] of everyModelState()) expect(modelSetupBox(st).text, name).toBeTruthy();
  });

  it('the offer is the consent: it names the size, the model and the free space, and downloads only on its button', () => {
    const offer = box({ state: 'none' });
    expect(offer).toMatchObject({ variant: 'info', primary: 'download', secondary: 'notNow' });
    expect(offer.vars).toEqual({ size: '3.1', model: 'Gemma 4 E2B', free: '86' });
    expect(ACTION_LABELS.download).toContain('{size}');
  });

  it('a disk without room for the file and its margin says so before any download', () => {
    const short = box({ state: 'none' }, undefined, SIZE + DISK_MARGIN_BYTES - 1);
    expect(short).toMatchObject({ variant: 'error', primary: 'checkAgain' });
    expect(short.vars).toEqual({ need: '6', free: '5' });
    expect(box({ state: 'none' }, undefined, SIZE + DISK_MARGIN_BYTES).variant).toBe('info');
    // Rust's own refusal reads the same.
    expect(box({ state: 'low-disk', needBytes: 5_500_000_000 }, undefined, 4_200_000_000).vars).toEqual({ need: '6', free: '4' });
  });

  it('a download shows its share, and can be paused or cancelled; a paused one resumes', () => {
    const running = box({ state: 'downloading', doneBytes: 1_250_000_000 });
    expect(running).toMatchObject({ variant: 'info', primary: 'pause', secondary: 'cancelDownload' });
    expect(running.vars).toEqual({ done: '1.3', size: '3.1', pct: '40' });
    expect(running.progress).toBeCloseTo(1_250_000_000 / SIZE, 6);
    expect(box({ state: 'partial', doneBytes: 1_250_000_000 })).toMatchObject({ primary: 'resume', secondary: 'cancelDownload', vars: { pct: '40' } });
    expect(box({ state: 'offline', detail: 'no data for 60 s' })).toMatchObject({ variant: 'error', primary: 'resume', detail: 'no data for 60 s' });
  });

  it('a failed check offers the download again, with the reason', () => {
    expect(box({ state: 'bad-hash', detail: 'the model changed upstream' })).toMatchObject({ variant: 'error', primary: 'downloadAgain', detail: 'the model changed upstream' });
  });

  it('ready means downloaded and checked, with an engine that is not failing', () => {
    expect(modelReady(status({ state: 'ready' }))).toBe(true);
    expect(modelReady(status({ state: 'ready' }, { state: 'ready' }))).toBe(true);
    expect(modelReady(status({ state: 'ready' }, { state: 'failed', detail: 'x' }))).toBe(false);
    for (const state of ENGINE_MODEL_STATES) if (state !== 'ready') expect(modelReady(status({ state })), state).toBe(false);
    expect(modelReady({ kind: 'loading' })).toBe(false);
    expect(box({ state: 'ready' }, { state: 'failed', detail: 'stopped 3 times' })).toMatchObject({ variant: 'error', primary: 'startAgain', detail: 'stopped 3 times' });
    expect(box({ state: 'ready' }, { state: 'ready' }).text).toBe('✓ Ready on this computer');
  });

  it('prints sizes the way the button does and never rounds a share or free space up', () => {
    expect(sizeGb(SIZE)).toBe('3.1');
    expect(freeGb(5_999_999_999)).toBe('5');
    expect(percentDone(SIZE - 1, SIZE)).toBe(99);
    expect(percentDone(SIZE, SIZE)).toBe(100);
    expect(percentDone(0, 0)).toBe(0);
  });
});
