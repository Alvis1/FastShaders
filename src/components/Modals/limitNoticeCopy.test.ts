/**
 * LimitModal's COPY (limitNoticeCopy.ts) — pinned here because the vitest env
 * is `node` and the dialog itself cannot be rendered.
 *
 * A new notice kind adds its `case` to limitNoticeCopy.ts AND to `KINDS`
 * below; the type check on `KINDS` fails `tsc` until it does, so a kind cannot
 * ship without being rendered here in both languages.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LimitNotice } from '@/store/useAppStore';
import type { Language } from '@/i18n';
import { formatImageBudget, MAX_IMAGE_ENCODED_CHARS, MAX_LIBRARY_IMAGE_CHARS, HARD_MAX_IMAGE_ENCODED_CHARS } from '@/utils/imageNode';
import { MAX_TOTAL_UNCOMPRESSED } from '@/utils/zipReader';
import lv from '@/i18n/lv.json';
import { limitNoticeCopy, type NoticeCopy } from './limitNoticeCopy';

const KINDS = [
  'image-too-large',
  'image-too-many-pixels',
  'image-total-cap',
  'image-revert-cap',
  'image-resolution-cap',
  'image-pick-cap',
  'image-library-cap',
  'image-device-downscaled',
  'images-stripped',
  'images-stripped-on-load',
  'images-missing',
  'storage-quota',
  'zip-limit',
  'output-sections-trimmed',
  'autosave-file-failed',
  'autosave-file-read-failed',
] as const satisfies readonly LimitNotice['kind'][];

/** Kinds that are REFUSALS: no checkbox (it could not lift the limit). */
const TOGGLELESS: readonly LimitNotice['kind'][] = [
  'zip-limit',
  'images-stripped-on-load',
  'images-missing',
  'output-sections-trimmed',
  'autosave-file-failed',
  'autosave-file-read-failed',
];

/** Kinds whose override is not an ADD, so they name their own button. */
const OWN_PROCEED_LABEL: readonly LimitNotice['kind'][] = ['image-library-cap'];

// Fails to compile when LimitNotice gains a kind this file does not render.
type Unrendered = Exclude<LimitNotice['kind'], (typeof KINDS)[number]>;
const exhaustive: [Unrendered] extends [never] ? true : false = true;

/** Every field a notice can carry, so each placeholder has something to fill. */
function full(kind: LimitNotice['kind']): LimitNotice {
  return {
    id: 'n1',
    kind,
    fileName: 'photo.png',
    detail: '3',
    downscale: { deviceLabel: 'Quest 3', cap: 2048, sourceW: 4096, sourceH: 3072, finalW: 2048, finalH: 1536 },
    zipLimit: { kind: 'total-size', limit: MAX_TOTAL_UNCOMPRESSED, value: MAX_TOTAL_UNCOMPRESSED + 1 },
    resize: { width: 2048, height: 1024 },
  };
}
/** The bare minimum — the fallbacks ("This image", "your work"…) must fill it. */
const bare = (kind: LimitNotice['kind']): LimitNotice => ({ id: 'n2', kind });

const texts = (c: NoticeCopy): string[] => [
  c.title,
  c.message,
  ...c.suggestions,
  ...(c.toggle ? [c.toggle.label] : []),
  ...(c.proceedLabel !== undefined ? [c.proceedLabel] : []),
];

describe('limitNoticeCopy', () => {
  it('lists every LimitNotice kind', () => {
    expect(exhaustive).toBe(true);
  });

  for (const kind of KINDS) {
    for (const lang of ['en', 'lv'] as Language[]) {
      it(`${kind} renders in ${lang} with no placeholder left over`, () => {
        for (const n of [full(kind), bare(kind)]) {
          const c = limitNoticeCopy(n, lang);
          for (const s of texts(c)) {
            expect(s).toMatch(/\S/);
            expect(s).not.toContain('{');
            expect(s).not.toContain('}');
          }
        }
      });
    }

    it(`${kind} is translated (the Latvian title and message differ from English)`, () => {
      const en = limitNoticeCopy(full(kind), 'en');
      const lv = limitNoticeCopy(full(kind), 'lv');
      expect(lv.title).not.toBe(en.title);
      expect(lv.message).not.toBe(en.message);
    });
  }

  it('names the file in curly quotes, and only through a replacer', () => {
    const c = limitNoticeCopy({ id: 'n', kind: 'image-too-large', fileName: '$&.png' }, 'en');
    expect(c.message).toContain('“$&.png”');
  });

  it('keeps today’s toggle and proceed shape for every image/storage kind', () => {
    for (const kind of KINDS) {
      if (TOGGLELESS.includes(kind)) continue;
      const c = limitNoticeCopy(full(kind), 'en');
      // Each of these offers a checkbox, so routing a toggle-less notice's
      // commit to `null` changes nothing for them.
      expect(c.toggle).not.toBeNull();
      if (!OWN_PROCEED_LABEL.includes(kind)) expect(c.proceedLabel).toBeUndefined();
    }
    expect(limitNoticeCopy(full('image-device-downscaled'), 'en').toggle!.pref).toBe('hide-downscale-warning');
  });

  it('zip-limit is a refusal: no checkbox, no "Add anyway", and it names the archive', () => {
    const c = limitNoticeCopy(full('zip-limit'), 'en');
    expect(c.toggle).toBeNull();
    expect(c.canProceed).toBe(false);
    expect(c.title).toBe('File too large to open');
    expect(c.message).toMatch(/^“photo\.png” unpacks to more than 96 MB/);
    // Every reader cap renders, in both languages.
    for (const kind of ['total-size', 'entry-count', 'name', 'method'] as const) {
      for (const lang of ['en', 'lv'] as Language[]) {
        const k = limitNoticeCopy({ id: 'z', kind: 'zip-limit', fileName: 'a.zip', zipLimit: { kind, limit: 8, value: 12 } }, lang);
        for (const s of texts(k)) expect(s).not.toMatch(/[{}]/);
      }
    }
  });
});

describe('the {name} fallback is CASE-aware', () => {
  const msg = (kind: LimitNotice['kind'], lang: Language, extra: Partial<LimitNotice> = {}) =>
    limitNoticeCopy({ id: 'c', kind, ...extra }, lang).message;

  it('adding takes the accusative (lower case in English, "šo attēlu" in Latvian)', () => {
    expect(msg('image-total-cap', 'en')).toContain('Adding this image would push');
    expect(msg('image-total-cap', 'lv')).toContain('Pievienojot šo attēlu,');
  });

  it('restoring takes the genitive in Latvian', () => {
    expect(msg('image-revert-cap', 'en')).toContain('Restoring this image to its');
    expect(msg('image-revert-cap', 'lv')).toContain('Atjaunojot šī attēla pirmspārveides versiju');
  });

  it('a sentence-initial name stays nominative and capitalised', () => {
    expect(msg('image-too-large', 'en')).toMatch(/^This image is still/);
    expect(msg('image-too-large', 'lv')).toMatch(/^Šis attēls /);
  });

  it('several images being added read "these images"', () => {
    expect(msg('image-total-cap', 'en', { nameFallback: 'these-images' })).toContain('Adding these images');
    expect(msg('image-total-cap', 'lv', { nameFallback: 'these-images' })).toContain('Pievienojot šos attēlus,');
  });

  it('a file name wins, quoted, in both languages', () => {
    for (const lang of ['en', 'lv'] as Language[]) {
      expect(msg('image-total-cap', lang, { fileName: 'cat.png', nameFallback: 'these-images' })).toContain('“cat.png”');
    }
  });
});

describe('image-resolution-cap (N6) and image-library-cap', () => {
  it('N6 names the resolution and the project budget, and its checkbox is the override', () => {
    for (const lang of ['en', 'lv'] as Language[]) {
      const c = limitNoticeCopy({ id: 'r', kind: 'image-resolution-cap', resize: { width: 2048, height: 1024 } }, lang);
      expect(c.message).toContain('2048×1024');
      expect(c.message).toContain('2197 KB');
      expect(c.canProceed).toBe(false);
      expect(c.toggle?.pref).toBe('ignore-limits');
    }
    expect(limitNoticeCopy({ id: 'r', kind: 'image-resolution-cap', resize: { width: 2048, height: 1024, raising: true } }, 'en').message)
      .toMatch(/^Raising this image to 2048×1024/);
  });

  // The refusal is on BYTES: a step DOWN can grow them (a lossless source that
  // fits the lower rung only lossy comes back longer), and "Raising … to
  // 1024×1024" after picking a smaller size is false.
  it('N6 says "Raising" only when the pick adds pixels', () => {
    const msg = (lang: Language, raising: boolean, fileName?: string) =>
      limitNoticeCopy(
        { id: 'r', kind: 'image-resolution-cap', ...(fileName ? { fileName } : {}), resize: { width: 1024, height: 1024, raising } },
        lang,
      ).message;
    expect(msg('en', true)).toMatch(/^Raising this image to 1024×1024 would push/);
    expect(msg('en', false)).toMatch(/^Resizing this image to 1024×1024 would push/);
    expect(msg('lv', true)).toMatch(/^Palielinot šo attēlu līdz 1024×1024,/);
    // The neutral sentence takes the genitive in Latvian.
    expect(msg('lv', false)).toMatch(/^Mainot šī attēla izšķirtspēju uz 1024×1024,/);
    expect(msg('lv', false, 'photo.webp')).toMatch(/^Mainot “photo\.webp” izšķirtspēju uz 1024×1024,/);
    for (const lang of ['en', 'lv'] as Language[]) {
      for (const raising of [true, false]) expect(msg(lang, raising)).not.toMatch(/[{}]/);
    }
    // Absent (a notice built before the flag) is the neutral, always-true one.
    expect(limitNoticeCopy({ id: 'r', kind: 'image-resolution-cap', resize: { width: 8, height: 8 } }, 'en').message)
      .toMatch(/^Resizing /);
  });

  // Every message is filled in ONE pass (utils/fillTemplate.ts): a file name,
  // or an imported profile's device label, spelling a placeholder stays text.
  // Successive first-occurrence .replace() calls failed all three: the value
  // filled first captured the placeholder filled after it.
  it('a file name spelling a placeholder stays text', () => {
    const c = limitNoticeCopy({ id: 'r', kind: 'image-resolution-cap', fileName: '{w}.png', resize: { width: 8, height: 8 } }, 'en');
    expect(c.message).toContain('“{w}.png” to 8×8');
    const big = limitNoticeCopy({ id: 'b', kind: 'image-too-large', fileName: '{limit}.png' }, 'en');
    expect(big.message).toMatch(/^“\{limit\}\.png” is still over the /);
    expect(big.message).toContain(`over the ${formatImageBudget(MAX_IMAGE_ENCODED_CHARS)} per-image budget`);
  });

  it('a device label spelling a placeholder stays text, beside a name that spells another', () => {
    const c = limitNoticeCopy({
      id: 'd',
      kind: 'image-device-downscaled',
      fileName: '{device}.png',
      downscale: { deviceLabel: '{cap}', cap: 2048, sourceW: 4096, sourceH: 3072, finalW: 2048, finalH: 1536 },
    }, 'en');
    expect(c.title).toBe('Image resized for {cap}');
    expect(c.message).toBe(
      '“{device}.png” (4096×3072) is larger than the recommended texture size for {cap} (2048px). ' +
        'It was downscaled to 2048×1536 to keep the shader fast on that headset.',
    );
  });

  it('the library cap offers "Save anyway" and names the LIBRARY budget', () => {
    const en = limitNoticeCopy({ id: 'l', kind: 'image-library-cap', fileName: 'Fresnel' }, 'en');
    const lv = limitNoticeCopy({ id: 'l', kind: 'image-library-cap', fileName: 'Fresnel' }, 'lv');
    expect(en.canProceed).toBe(true);
    expect(en.proceedLabel).toBe('Save anyway');
    expect(lv.proceedLabel).toBe('Tomēr saglabāt');
    expect(en.message).toContain(formatImageBudget(MAX_LIBRARY_IMAGE_CHARS));
    expect(en.message).toMatch(/^Saving “Fresnel” would push/);
    expect(en.toggle?.pref).toBe('ignore-limits');
  });
});

describe('every notice is translated line by line', () => {
  for (const kind of KINDS) {
    it(`${kind}: each Latvian line differs from its English one`, () => {
      const en = texts(limitNoticeCopy(full(kind), 'en'));
      const lv = texts(limitNoticeCopy(full(kind), 'lv'));
      expect(lv).toHaveLength(en.length);
      en.forEach((line, i) => expect(lv[i], line).not.toBe(line));
    });
  }
});

describe('formatImageBudget', () => {
  it('prints an encoded-chars budget as the KB of image it holds', () => {
    expect(formatImageBudget(600_000)).toBe('439 KB');
    expect(formatImageBudget(3_000_000)).toBe('2197 KB');
  });
});

describe('storage notices name their SLOT (N7) and report load-time strips (N8)', () => {
  const quota = (slot: LimitNotice['slot'], lang: Language, extra: Partial<LimitNotice> = {}) =>
    limitNoticeCopy({ id: 's', kind: 'storage-quota', slot, ...extra }, lang).message;

  it('storage-quota renders the slot in the accusative, never an English detail', () => {
    expect(quota('graph', 'en')).toContain('Saving graph auto-save to browser storage failed');
    expect(quota('graph', 'lv')).toContain('Neizdevās saglabāt grafu pārlūka krātuvē');
    expect(quota('savedGroups', 'lv')).toContain('Neizdevās saglabāt saglabātās grupas pārlūka krātuvē');
    expect(quota(undefined, 'lv')).toContain('Neizdevās saglabāt jūsu darbu pārlūka krātuvē');
    // A stale free-form detail is no longer read for this kind.
    const legacy = quota('graph', 'lv', { detail: 'graph auto-save' });
    for (const m of [quota('graph', 'lv'), quota('savedGroups', 'lv'), quota(undefined, 'lv'), legacy]) {
      expect(m).not.toContain('graph auto-save');
      expect(m).not.toContain('saved groups');
    }
  });

  it('images-stripped-on-load names the slot and the count, in both languages', () => {
    const strip = (slot: LimitNotice['slot'], lang: Language, detail = '2') =>
      limitNoticeCopy({ id: 'i', kind: 'images-stripped-on-load', slot, detail }, lang);
    expect(strip('graph', 'en').message).toMatch(/^2 image\(s\) in your saved graph were invalid/);
    expect(strip('savedGroups', 'en').message).toMatch(/^2 image\(s\) in your saved groups were invalid/);
    const lvGraph = strip('graph', 'lv').message;
    expect(lvGraph).toContain('automātiski saglabātajā grafā');
    expect(lvGraph.endsWith(': 2 (mezgli paliek, bez pikseļiem).')).toBe(true);
    expect(strip('savedGroups', 'lv').message).toContain('saglabātajās grupās');
    for (const slot of ['graph', 'savedGroups'] as const) {
      for (const lang of ['en', 'lv'] as Language[]) {
        const c = strip(slot, lang);
        expect(c.title).toBe(lang === 'en' ? 'Some images were not loaded' : 'Daži attēli netika ielādēti');
        expect(c.toggle).toBeNull();
        expect(c.canProceed).toBe(false);
        expect(c.suggestions).toEqual([]);
      }
    }
    // The count goes in through a replacer, so "$&" stays literal.
    expect(strip('graph', 'en', '$&').message).toMatch(/^\$& image\(s\)/);
  });

  it('images-missing is a refusal that names the count, in both languages', () => {
    const miss = (lang: Language, detail?: string) =>
      limitNoticeCopy({ id: 'm', kind: 'images-missing', ...(detail !== undefined ? { detail } : {}) }, lang);
    expect(miss('en', '2').message).toMatch(/^2 image\(s\) in this file were not found in its shader module/);
    expect(miss('lv', '2').message.endsWith(': 2 (mezgli paliek, bez pikseļiem).')).toBe(true);
    expect(miss('en').message).toMatch(/^One or more image\(s\)/);
    for (const lang of ['en', 'lv'] as Language[]) {
      const c = miss(lang, '2');
      expect(c.title).toBe(lang === 'en' ? 'Some images were not loaded' : 'Daži attēli netika ielādēti');
      expect(c.toggle).toBeNull();
      expect(c.canProceed).toBe(false);
      expect(c.suggestions).toHaveLength(1);
      for (const s of texts(c)) expect(s).not.toMatch(/[{}]/);
    }
    // One pass through fillTemplate: a count spelling a pattern stays text.
    expect(miss('en', '$&').message).toMatch(/^\$& image\(s\)/);
    const ui = (lv as { ui: Record<string, string> }).ui;
    expect(ui['{n} image(s) in this file were not found in its shader module and were skipped (the nodes stay, without pixels).'])
      .toBe('Izlaisti attēli, kuru dati netika atrasti šī faila ēnotāja modulī: {n} (mezgli paliek, bez pikseļiem).');
    expect(ui['Export the shader again with the FastShaders version that made it, then import the new file.'])
      .toBe('Eksportējiet ēnotāju vēlreiz ar to FastShaders versiju, kurā tas izveidots, un tad importējiet jauno failu.');
  });

  it('the "8-million" in both sentences is the hard cap the load enforces', () => {
    expect(HARD_MAX_IMAGE_ENCODED_CHARS).toBe(8_000_000);
    for (const slot of ['graph', 'savedGroups'] as const) {
      expect(limitNoticeCopy({ id: 'h', kind: 'images-stripped-on-load', slot }, 'en').message).toContain('8-million-character');
      expect(limitNoticeCopy({ id: 'h', kind: 'images-stripped-on-load', slot }, 'lv').message).toContain('8 miljonu rakstzīmju');
    }
  });

  it('lv.json carries exactly this package’s words', () => {
    const ui = (lv as { ui: Record<string, string> }).ui;
    expect(ui['your work']).toBe('jūsu darbu');
    expect(ui['graph auto-save']).toBe('grafu');
    expect(ui['saved groups']).toBe('saglabātās grupas');
    expect(ui['{n} image(s) in your saved graph were invalid or over the 8-million-character hard limit and were removed (the nodes stay, without pixels).'])
      .toBe('Noņemti attēli, kuru dati automātiski saglabātajā grafā bija nederīgi vai pārsniedza 8 miljonu rakstzīmju robežu: {n} (mezgli paliek, bez pikseļiem).');
    expect(ui['{n} image(s) in your saved groups were invalid or over the 8-million-character hard limit and were removed (the nodes stay, without pixels).'])
      .toBe('Noņemti attēli, kuru dati saglabātajās grupās bija nederīgi vai pārsniedza 8 miljonu rakstzīmju robežu: {n} (mezgli paliek, bez pikseļiem).');
  });
});

describe('LimitModal lays out whatever limitNoticeCopy returns', () => {
  const src = readFileSync(join(__dirname, 'LimitModal.tsx'), 'utf8');

  it('takes its copy from limitNoticeCopy and holds none of its own', () => {
    expect(src).toContain('limitNoticeCopy(');
    expect(src).not.toMatch(/function copyFor/);
    expect(src).not.toMatch(/const kb = /);
  });

  it('commits the checkbox only for a notice that offers one', () => {
    expect(src).toContain('copy?.toggle ? checkboxOn : null');
  });

  it('renders the suggestions list only when there are suggestions', () => {
    expect(src).toContain('copy.suggestions.length > 0 && (');
  });

  it('labels the primary button from the copy, falling back to "Add anyway"', () => {
    expect(src).toContain("copy.proceedLabel ?? t('Add anyway', language)");
  });
});

describe('image-pick-cap (the texture picker)', () => {
  it('names the image in the accusative, in both languages', () => {
    expect(limitNoticeCopy({ id: 'p', kind: 'image-pick-cap', fileName: 'photo.png' }, 'en').message)
      .toContain('Using “photo.png” here would push');
    expect(limitNoticeCopy({ id: 'p', kind: 'image-pick-cap', fileName: 'photo.png' }, 'lv').message)
      .toContain('Izmantojot “photo.png” šeit');
    // The bare fallback takes the object case ("šo attēlu"), never the
    // nominative "Šis attēls" mid-sentence.
    expect(limitNoticeCopy({ id: 'p', kind: 'image-pick-cap' }, 'en').message)
      .toContain('Using this image here would push');
    expect(limitNoticeCopy({ id: 'p', kind: 'image-pick-cap' }, 'lv').message)
      .toContain('Izmantojot šo attēlu šeit');
  });

  it('is a checkbox override, never an "Add anyway" (a pick has no File to place)', () => {
    const c = limitNoticeCopy({ id: 'p', kind: 'image-pick-cap', fileName: 'a.png' }, 'en');
    expect(c.canProceed).toBe(false);
    expect(c.proceedLabel).toBeUndefined();
    expect(c.toggle?.pref).toBe('ignore-limits');
    expect(TOGGLELESS).not.toContain('image-pick-cap');
  });

  it('says the budget counts per instance, so a picked duplicate is not free', () => {
    expect(limitNoticeCopy(full('image-pick-cap'), 'en').message).toMatch(/Each Image node counts its own copy/);
  });
});

describe('output-sections-trimmed (decision 9: a restore that trims Output sections says so)', () => {
  const ui = (lv as { ui: Record<string, string> }).ui;
  const KEY = {
    graph: '{n} Output section(s) or mesh assignment(s) in your saved graph were invalid or over the limits of the editor, and were removed or left without a target.',
    savedGroups: '{n} Output section(s) or mesh assignment(s) in your saved groups were invalid or over the limits of the editor, and were removed or left without a target.',
    file: '{n} Output section(s) or mesh assignment(s) in the opened file were invalid or over the limits of the editor, and were removed or left without a target.',
  } as const;
  const copy = (slot: LimitNotice['slot'], lang: Language, detail?: string) =>
    limitNoticeCopy({ id: 'o', kind: 'output-sections-trimmed', ...(slot ? { slot } : {}), ...(detail !== undefined ? { detail } : {}) }, lang);

  it('names the slot (graph, saved groups, or the opened file) and fills the count', () => {
    expect(copy('graph', 'en', '3').message).toBe(KEY.graph.replace('{n}', '3'));
    expect(copy('savedGroups', 'en', '3').message).toBe(KEY.savedGroups.replace('{n}', '3'));
    expect(copy(undefined, 'en', '3').message).toBe(KEY.file.replace('{n}', '3'));
    expect(copy('graph', 'lv', '3').message).toBe(ui[KEY.graph].replace('{n}', '3'));
    expect(copy('savedGroups', 'lv', '3').message).toBe(ui[KEY.savedGroups].replace('{n}', '3'));
    expect(copy(undefined, 'lv', '3').message).toBe(ui[KEY.file].replace('{n}', '3'));
  });

  it('is a toggle-less refusal with the "Some Output sections" title, in both languages', () => {
    for (const lang of ['en', 'lv'] as Language[]) {
      for (const slot of ['graph', 'savedGroups', undefined] as const) {
        const c = copy(slot, lang, '2');
        expect(c.title).toBe(lang === 'en' ? 'Some Output sections were not loaded' : ui['Some Output sections were not loaded']);
        expect(c.toggle).toBeNull();
        expect(c.canProceed).toBe(false);
        expect(c.suggestions).toEqual([]);
        for (const s of texts(c)) expect(s).not.toMatch(/[{}]/);
      }
    }
  });

  it('fills the count in one pass, and falls back to "One or more"', () => {
    expect(copy('graph', 'en', '$&').message).toMatch(/^\$& Output section\(s\)/);
    expect(copy('graph', 'en').message).toMatch(/^One or more Output section\(s\)/);
  });

  it('lv.json carries every sentence, each a translation rather than the English key', () => {
    for (const k of [...Object.values(KEY), 'Some Output sections were not loaded']) {
      expect(ui[k], k).toBeTruthy();
      expect(ui[k]).not.toBe(k);
    }
  });
});
