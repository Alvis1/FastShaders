import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONSENT_TEXT_VERSION, EVAL_SERVER_HOSTS } from './evalMode';
import lv from '@/i18n/lv.json';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const consent = read('./ConsentModal.tsx');
const disclosure = read('./DataDisclosureModal.tsx');
const packageBuilder = read('./evalPackage.ts');
const ui = (lv as { ui: Record<string, string> }).ui;

/**
 * Guards the one thing in this feature that cannot fail loudly: the consent
 * screen describing something OTHER than what the package contains.
 *
 * consent-2 said the technical block was "browser and platform version, screen
 * size, and time zone" and closed with "Nothing else is recorded", while the
 * code had grown a 14-field device block (unmasked GPU renderer, cores,
 * deviceMemory), a rendered preview.png, a free-text comment box and a shader
 * bundle carrying note text and dropped files WITH their file names. Nothing
 * failed, because a consent form is prose. These pins make the next such drift
 * fail in CI instead of in an ethics review.
 */
describe('the consent text matches what the package actually contains', () => {
  it('every zip entry the builder can emit is named in the disclosure', () => {
    // Entry names are string literals in buildEvalPackageEntries; a new one has
    // to be disclosed before it can ship.
    const names = [...packageBuilder.matchAll(/name:\s*'([^']+\.[a-z]+)'/g)].map((m) => m[1]);
    const dynamic = /name:\s*`shader\//.test(packageBuilder) ? ['shader/'] : [];
    const entries = [...new Set([...names, ...dynamic])];
    expect(entries.length, 'no zip entries found — did the builder change shape?').toBeGreaterThan(5);
    for (const e of entries) {
      expect(disclosure, `zip entry "${e}" is not disclosed to the participant`).toContain(e);
    }
  });

  it('discloses the four things consent-2 collected but never mentioned', () => {
    // Each of these is a real field in the package (evalContext.collectDevice,
    // previewShot, SusModal's comment box, exportShader's image/model embed).
    expect(disclosure).toMatch(/graphics card name/i);
    expect(disclosure).toMatch(/processor cores|processor count/i);
    expect(disclosure).toMatch(/free-text comment|comment box/i);
    expect(disclosure).toMatch(/file name/i);
  });

  it('the false "Nothing else is recorded" sentence is gone', () => {
    expect(consent).not.toContain('Nothing else is recorded');
    expect(ui['Nothing else is recorded: no keystroke content, no audio or video, nothing outside this app. The data is packaged into one file only when you submit the questionnaire; that file is then sent to the university’s server (alvismisjuns.lv), where only the researcher can open it, and a copy is saved on this computer.'])
      .toBeDefined(); // the stale LV entry may remain; it is simply never looked up
  });

  it('does not call the researcher’s own host "the university’s server", and names both addresses', () => {
    expect(consent).not.toMatch(/university.s server/);
    for (const host of EVAL_SERVER_HOSTS) {
      expect(consent, `${host} is not named in the consent text`).toContain(host);
    }
    expect(consent).toMatch(/operated by the researcher personally, not by the university/);
  });

  it('promises a DPO route only when one is configured', () => {
    // consent-2 said "you can also contact the university's data protection
    // officer" with no name, address or route. The sentence is now conditional
    // on EVAL_DPO_CONTACT, so an empty constant omits it rather than lying.
    expect(consent).toMatch(/EVAL_DPO_CONTACT\s*\n?\s*\?/);
    expect(consent).toMatch(/EVAL_RETENTION_PERIOD\s*\n?\s*\?/);
  });

  it('CONSENT_TEXT_VERSION was bumped, so packages record which wording was shown', () => {
    expect(CONSENT_TEXT_VERSION).not.toBe('consent-2');
    expect(CONSENT_TEXT_VERSION).toMatch(/^consent-\d+$/);
  });
});

describe('the consent and disclosure are fully translated', () => {
  // Latvian is the DEFAULT language and this is a Latvian-run study, so a
  // missing key renders an English sentence in the middle of a Latvian consent
  // form — silently, because t() falls back to the key itself.
  const keys = (src: string) =>
    [...src.matchAll(/t\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*language\s*\)/g)].map((m) =>
      m[1].replace(/\\'/g, "'"),
    );

  it.each([
    ['ConsentModal', consent],
    ['DataDisclosureModal', disclosure],
  ])('%s has a Latvian entry for every string', (_name, src) => {
    const missing = keys(src).filter((k) => !(k in ui));
    expect(missing, `untranslated: ${missing.join(' | ')}`).toEqual([]);
  });

  it('the disclosure item() pairs are translated too', () => {
    // item(heading, body) does not match the t(...) shape above, so it needs
    // its own sweep — this is exactly where a key would be missed.
    const pairs = [...disclosure.matchAll(/item\(\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',?\s*\)/gs)];
    expect(pairs.length, 'no item() pairs found — did the shape change?').toBeGreaterThan(5);
    const missing = pairs
      .flatMap((m) => [m[1], m[2]])
      .map((k) => k.replace(/\\'/g, "'"))
      .filter((k) => !(k in ui));
    expect(missing, `untranslated: ${missing.join(' | ')}`).toEqual([]);
  });
});
