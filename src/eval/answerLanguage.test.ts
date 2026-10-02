import { describe, it, expect } from 'vitest';
import { summarizeAnswerLanguages } from './answerLanguage';

describe('the language a SUS form was answered in', () => {
  it('is that language when every answer was given in it', () => {
    expect(summarizeAnswerLanguages(Array(10).fill('lv'), 'en')).toEqual({
      language: 'lv',
      perItem: Array(10).fill('lv'),
    });
  });

  it('is mixed when the answers span both — whatever the language at Submit', () => {
    // Rated items 1-6 in English, switched, rated 7-10 in Latvian.
    const perItem = [...Array(6).fill('en'), ...Array(4).fill('lv')];
    for (const atSubmit of ['en', 'lv'] as const) {
      const r = summarizeAnswerLanguages(perItem, atSubmit);
      expect(r.language).toBe('mixed');
      expect(r.perItem).toEqual(perItem);
    }
  });

  it('ignores the language at Submit when the answers agree', () => {
    // Answered everything in English, then switched to read the comment
    // prompt in Latvian: still an English form.
    expect(summarizeAnswerLanguages(Array(10).fill('en'), 'lv').language).toBe('en');
  });

  it('counts an item with no note as the language at Submit', () => {
    const r = summarizeAnswerLanguages(['en', undefined, 'en'], 'en');
    expect(r).toEqual({ language: 'en', perItem: ['en', 'en', 'en'] });
    expect(summarizeAnswerLanguages(['en', undefined], 'lv').language).toBe('mixed');
    expect(summarizeAnswerLanguages([], 'lv')).toEqual({ language: 'lv', perItem: [] });
  });
});
