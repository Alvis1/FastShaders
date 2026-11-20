/**
 * The "Generate nodes from text" switch as a LEAF: its key, its three states
 * and when the feature is offered. The store's own flag and setter are pinned
 * beside the store (they read these).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GENERATOR_FLAG_KEY,
  GENERATOR_STORAGE_KEYS,
  generatorBuild,
  generatorModeFrom,
  generatorOffered,
} from './generatorFlag';

describe('generatorFlag — the opt-in leaf', () => {
  it('is fs:nodeGenerator, listed first among the keys the study clean slate removes', () => {
    expect(GENERATOR_FLAG_KEY).toBe('fs:nodeGenerator');
    expect(GENERATOR_STORAGE_KEYS[0]).toBe(GENERATOR_FLAG_KEY);
    expect(GENERATOR_STORAGE_KEYS.every((k) => k.startsWith('fs:'))).toBe(true);
  });

  it('the stored value is validated, never coerced: exact "1" is on, exact "0" is off, anything else suggests', () => {
    expect(generatorModeFrom('1')).toBe('on');
    expect(generatorModeFrom('0')).toBe('off');
    for (const other of ['true', ' 1', '1 ', '01', 'yes', ' 0', '0 ', 'off', '', null, undefined, 1, 0, true, false]) {
      expect(generatorModeFrom(other), String(other)).toBe('suggest');
    }
  });

  it('is offered only on a build that reaches a model, unless switched off, and never in a study session', () => {
    for (const desktop of [false, true]) {
      for (const cloud of [false, true]) {
        for (const mode of ['suggest', 'on', 'off'] as const) {
          for (const evalMode of [false, true]) {
            expect(generatorOffered(mode, evalMode, generatorBuild(desktop, cloud)))
              .toBe((desktop || cloud) && mode !== 'off' && !evalMode);
          }
        }
      }
    }
  });

  it('imports nothing (it sits on the boot path)', () => {
    expect(readFileSync('src/utils/generatorFlag.ts', 'utf8')).not.toMatch(/^\s*import\s/m);
  });
});
