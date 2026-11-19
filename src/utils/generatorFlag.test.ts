/**
 * The "Generate nodes from text" opt-in as a LEAF: its key, its exact-'1'
 * reading and when the feature is offered. The store's own flag and setter
 * are pinned beside the store (they read these).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GENERATOR_FLAG_KEY,
  GENERATOR_STORAGE_KEYS,
  generatorBuild,
  generatorEnabledFrom,
  generatorOffered,
} from './generatorFlag';

describe('generatorFlag — the opt-in leaf', () => {
  it('is fs:nodeGenerator, listed first among the keys the study clean slate removes', () => {
    expect(GENERATOR_FLAG_KEY).toBe('fs:nodeGenerator');
    expect(GENERATOR_STORAGE_KEYS[0]).toBe(GENERATOR_FLAG_KEY);
    expect(GENERATOR_STORAGE_KEYS.every((k) => k.startsWith('fs:'))).toBe(true);
  });

  it('the stored value is validated, never coerced: only the exact "1" is on', () => {
    expect(generatorEnabledFrom('1')).toBe(true);
    for (const junk of ['true', ' 1', '1 ', '01', 'yes', '0', '', null, undefined, 1, true]) {
      expect(generatorEnabledFrom(junk), String(junk)).toBe(false);
    }
  });

  it('is offered only on a build that reaches a model, when on, and never in a study session', () => {
    for (const desktop of [false, true]) {
      for (const cloud of [false, true]) {
        for (const enabled of [false, true]) {
          for (const evalMode of [false, true]) {
            expect(generatorOffered(enabled, evalMode, generatorBuild(desktop, cloud)))
              .toBe((desktop || cloud) && enabled && !evalMode);
          }
        }
      }
    }
  });

  it('imports nothing (it sits on the boot path)', () => {
    expect(readFileSync('src/utils/generatorFlag.ts', 'utf8')).not.toMatch(/^\s*import\s/m);
  });
});
