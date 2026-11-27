import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t, type Language } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import {
  FIGURE_CAPTIONS,
  FIRST_LESSON_TITLE,
  LESSONS_TAB_LABEL,
  NEXT_STEP,
  PAGES_IN_ENGLISH,
  READ_MORE,
  SHADER_LINKS,
  START_LABEL,
  explainerParagraphs,
  type ShaderLink,
} from './shaderExplainerText';
import { CX, CY, HIGHLIGHT, ONE_COLOR, R, SPHERE_PATHS, STRIPE_DARK, STRIPE_LIGHT, VIEW } from './shaderFigure';

/** The flat light every sphere wears: a shadow crescent and a light spot. */
function Light({ shadow }: { shadow: string }) {
  return (
    <>
      <path d={shadow} fill="#000" fillOpacity={0.24} />
      <ellipse
        cx={HIGHLIGHT.cx}
        cy={HIGHLIGHT.cy}
        rx={HIGHLIGHT.rx}
        ry={HIGHLIGHT.ry}
        transform={`rotate(${HIGHLIGHT.rotate} ${HIGHLIGHT.cx} ${HIGHLIGHT.cy})`}
        fill="#fff"
        fillOpacity={0.55}
      />
    </>
  );
}

function Figure({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="fs-explainer__figure">
      <svg viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden="true">
        {children}
      </svg>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/** One colour, a pattern, a moved surface: what a shader can do to a sphere
 *  (shaderFigure.ts draws them). */
function ShaderFigures({ language }: { language: Language }) {
  const [one, pattern, moved] = FIGURE_CAPTIONS.map((c) => t(c, language));
  return (
    <div className="fs-explainer__figures">
      <Figure caption={one}>
        <circle cx={CX} cy={CY} r={R} fill={ONE_COLOR} />
        <Light shadow={SPHERE_PATHS.circleShadow} />
        <circle className="fs-explainer__edge" cx={CX} cy={CY} r={R} />
      </Figure>
      <Figure caption={pattern}>
        <circle cx={CX} cy={CY} r={R} fill={STRIPE_LIGHT} />
        {SPHERE_PATHS.darkStripes.map((d) => (
          <path key={d} d={d} fill={STRIPE_DARK} />
        ))}
        <Light shadow={SPHERE_PATHS.circleShadow} />
        <circle className="fs-explainer__edge" cx={CX} cy={CY} r={R} />
      </Figure>
      <Figure caption={moved}>
        {/* Where the surface was: a dashed circle UNDER the moved one, so it
            shows in the dips, where the surface moved in. Drawn over the
            blue, its dashes cut the outline into a ragged edge. */}
        <circle className="fs-explainer__was" cx={CX} cy={CY} r={R} />
        <path d={SPHERE_PATHS.wavy} fill={ONE_COLOR} />
        <Light shadow={SPHERE_PATHS.wavyShadow} />
        <path className="fs-explainer__edge" d={SPHERE_PATHS.wavy} />
      </Figure>
    </div>
  );
}

/**
 * One reading link. On the web, a link that opens a new tab. In the desktop
 * app a link opens nothing (the shell has no new-window handler, the reason
 * the contact popover's website link is dead there too), so it shows the
 * address as selectable text with a Copy button instead. The branch is on the
 * whole element, as the toolbar's Podest link does it: an anchor whose click
 * does nothing still offers "Open in new window".
 */
function ReadingLink({
  link,
  language,
  copied,
  onCopy,
}: {
  link: ShaderLink;
  language: Language;
  copied: boolean;
  onCopy: (url: string) => void;
}) {
  const line = <span className="fs-explainer__link-line">{t(link.line, language)}</span>;
  if (__FS_DESKTOP__) {
    return (
      <li className="fs-explainer__link">
        <span className="fs-explainer__link-title" lang="en">
          {link.title}
        </span>{' '}
        {line}
        <span className="fs-explainer__address">
          <code className="fs-explainer__url">{link.url}</code>
          <button type="button" className="fs-explainer__copy" onClick={() => onCopy(link.url)}>
            {t(copied ? 'Copied' : 'Copy', language)}
          </button>
        </span>
      </li>
    );
  }
  return (
    <li className="fs-explainer__link">
      <a className="fs-explainer__link-title" href={link.url} target="_blank" rel="noreferrer noopener" lang="en">
        {link.title}
      </a>{' '}
      {line}
    </li>
  );
}

/**
 * The intro window's "What is a shader?" tab (owner, 2026-11-26: one of its
 * three pages, after Intro and Keys): three drawn spheres, four short
 * paragraphs, the next step in the app, and five pages to read on. Static
 * like Keys: nothing animates and nothing is written; IntroWindow logs the
 * tab switch in a study session, this file logs nothing. `showCost` is false
 * wherever the intro leaves out its budget slide, and the points paragraph
 * goes with it.
 */
export function ShaderTab({ language, showCost }: { language: Language; showCost: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // No clipboard here: the address is still on screen to select by hand.
      return;
    }
    setCopied(url);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
  };

  const nextStep = fillTemplate(t(NEXT_STEP, language), {
    start: t(START_LABEL, language),
    tab: t(LESSONS_TAB_LABEL, language),
    lesson: t(FIRST_LESSON_TITLE, language),
  });

  return (
    <div className="fs-explainer">
      <ShaderFigures language={language} />
      {explainerParagraphs(showCost).map((p) => (
        <p key={p} className="fs-explainer__text">
          {t(p, language)}
        </p>
      ))}
      <p className="fs-explainer__text fs-explainer__next">{nextStep}</p>
      <div className="fs-explainer__more">{t(READ_MORE, language)}</div>
      {language === 'lv' && <p className="fs-explainer__note">{t(PAGES_IN_ENGLISH, language)}</p>}
      <ul className="fs-explainer__links">
        {SHADER_LINKS.map((link) => (
          <ReadingLink key={link.url} link={link} language={language} copied={copied === link.url} onCopy={copy} />
        ))}
      </ul>
    </div>
  );
}
