import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { INTRO_OPEN_EVENT, INTRO_SEEN_KEY, introHidden, introOnBoot, setIntroHidden } from './introGate';
import { stubLocalStorage } from '@/test-utils';

describe('intro window: when it opens', () => {
  it('opens on a first boot and stops once it has been closed', () => {
    expect(introOnBoot({ evalMode: false, search: '', seen: null })).toBe(true);
    expect(introOnBoot({ evalMode: false, search: '', seen: '1' })).toBe(false);
  });

  it('treats any other stored value as not seen (the key is adversarial, the cost is one more showing)', () => {
    for (const seen of ['', 'true', ' 1', '01', '{"toString":1}']) {
      expect(introOnBoot({ evalMode: false, search: '', seen }), seen).toBe(true);
    }
  });

  it('?intro opens it again', () => {
    expect(introOnBoot({ evalMode: false, search: '?intro', seen: '1' })).toBe(true);
    expect(introOnBoot({ evalMode: false, search: '?fsreload=1&intro', seen: '1' })).toBe(true);
  });

  it('never opens in a study session, whatever the URL says', () => {
    expect(introOnBoot({ evalMode: true, search: '', seen: null })).toBe(false);
    expect(introOnBoot({ evalMode: true, search: '?intro', seen: null })).toBe(false);
  });

  it('App mounts it lazily, from the eval-aware gate', () => {
    const app = readFileSync(path.join(__dirname, '../App.tsx'), 'utf8');
    expect(app).toContain("import('./intro/IntroWindow')");
    expect(app).toContain('useState(() => shouldShowIntro(isEvalMode()))');
    expect(app).not.toMatch(/import \{[^}]*IntroWindow[^}]*\} from/);
  });
});

describe('intro window: "Don\u2019t show this again"', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ticked keeps it closed on later boots; unticked brings it back', () => {
    const ls = stubLocalStorage();
    expect(introHidden()).toBe(false);
    setIntroHidden(true);
    expect(ls[INTRO_SEEN_KEY]).toBe('1');
    expect(introHidden()).toBe(true);
    expect(introOnBoot({ evalMode: false, search: '', seen: ls[INTRO_SEEN_KEY] })).toBe(false);
    setIntroHidden(false);
    expect(INTRO_SEEN_KEY in ls).toBe(false);
    expect(introHidden()).toBe(false);
  });

  it('the window writes the checkbox on EVERY close, not only from Start', () => {
    const src = readFileSync(path.join(__dirname, 'IntroWindow.tsx'), 'utf8');
    expect(src).toContain('setIntroHidden(dontShow);');
    expect(src.match(/onClick=\{close\}/g)?.length).toBe(2); // backdrop, Start (no ✕ — owner, 2026-10-17)
  });
});

describe('intro window: the toolbar "i" opens it again', () => {
  const toolbar = readFileSync(path.join(__dirname, '../components/Layout/Toolbar.tsx'), 'utf8');
  const app = readFileSync(path.join(__dirname, '../App.tsx'), 'utf8');

  it('sits right after the reload control and is never drawn in a study session', () => {
    const reload = toolbar.indexOf('className="toolbar__local toolbar__reload-wrap"');
    const intro = toolbar.indexOf('className="toolbar__sc-link toolbar__intro"');
    const podest = toolbar.indexOf("title={t('Open Podest in a separate window");
    expect(reload).toBeGreaterThan(-1);
    expect(intro).toBeGreaterThan(reload);
    expect(intro).toBeLessThan(podest);
    expect(toolbar).toMatch(/\{!isEvalMode\(\) && \(\s*<button\s+type="button"\s+className="toolbar__sc-link toolbar__intro"\s+onClick=\{openIntro\}/);
  });

  it('App opens the window on the event, and ignores it in a study session', () => {
    expect(INTRO_OPEN_EVENT).toBe('fs:open-intro');
    expect(app).toMatch(/if \(isEvalMode\(\)\) return;\s*const open = \(\) => setIntroOpen\(true\);\s*window\.addEventListener\(INTRO_OPEN_EVENT, open\);/);
  });
});
