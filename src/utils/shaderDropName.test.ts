import { describe, it, expect } from 'vitest';
import {
  MAX_DROPPED_NAME_LENGTH,
  droppedGroupLabel,
  sanitizeDroppedName,
  shaderDropStem,
} from './shaderDropName';

describe('shaderDropStem', () => {
  it('strips every extension a shader drop arrives under', () => {
    expect(shaderDropStem('waves.js')).toBe('waves');
    expect(shaderDropStem('waves.mjs')).toBe('waves');
    expect(shaderDropStem('waves.tsl')).toBe('waves');
    expect(shaderDropStem('waves.zip')).toBe('waves');
    expect(shaderDropStem('waves.fastshader')).toBe('waves');
    expect(shaderDropStem('waves.JS')).toBe('waves');
  });

  it('strips only the LAST extension, and only a known one', () => {
    expect(shaderDropStem('lo.udens.js')).toBe('lo.udens');
    expect(shaderDropStem('waves.js.bak')).toBe('waves.js.bak');
  });

  it('keeps a browser download artefact readable', () => {
    expect(shaderDropStem('waves (1).js')).toBe('waves (1)');
  });

  it('takes the base name off a path, so a directory drop cannot name the shader', () => {
    expect(shaderDropStem('/etc/passwd/waves.js')).toBe('waves');
    expect(shaderDropStem('C:\\Users\\a\\waves.js')).toBe('waves');
  });
});

describe('sanitizeDroppedName', () => {
  it('flattens control characters — a file name is attacker-chosen and RENDERED', () => {
    expect(sanitizeDroppedName('a\nb')).toBe('a b');
    expect(sanitizeDroppedName('a\u0000b')).toBe('a b');
    expect(sanitizeDroppedName('a\u007fb')).toBe('a b');
    // A run collapses to ONE space rather than leaving the box ragged.
    expect(sanitizeDroppedName('a\n\n\t b')).toBe('a b');
  });

  it('caps the length', () => {
    const long = 'x'.repeat(MAX_DROPPED_NAME_LENGTH + 50);
    expect(sanitizeDroppedName(long)).toHaveLength(MAX_DROPPED_NAME_LENGTH);
  });

  it("answers '' for a name with nothing usable left, which every caller reads as “no name”", () => {
    expect(sanitizeDroppedName('')).toBe('');
    expect(sanitizeDroppedName('   ')).toBe('');
    expect(sanitizeDroppedName('\n\t')).toBe('');
  });

  it('keeps Latvian diacritics — the cap is characters, not an ASCII filter', () => {
    expect(sanitizeDroppedName('Ūdens virsma')).toBe('Ūdens virsma');
  });
});

describe('droppedGroupLabel', () => {
  it('is always the FILE stem — the frame says which drop it came from', () => {
    // NOT the authored name: the user matched the file they dragged.
    expect(droppedGroupLabel('lo_udens.zip')).toBe('lo_udens');
  });

  it('never renders empty', () => {
    expect(droppedGroupLabel('.js')).toBe('Added shader');
    expect(droppedGroupLabel('   .js')).toBe('Added shader');
  });
});
