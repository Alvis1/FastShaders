import { describe, it, expect } from 'vitest';
import { noteMatchesQuery } from './noteSearch';

describe('the Add menu search finds the note', () => {
  it('in English and Latvian, with or without diacritics', () => {
    for (const q of ['note', 'Notes', 'no', 'comment', 'text', 'piezīme', 'piezime', 'Piezīmes', 'teksts', 'add note']) {
      expect(noteMatchesQuery(q), q).toBe(true);
    }
  });
  it('stays quiet for one letter and for node names', () => {
    for (const q of ['', ' ', 'n', 'noise', 'normal', 'add', 'texture']) {
      expect(noteMatchesQuery(q), q).toBe(false);
    }
  });
});
