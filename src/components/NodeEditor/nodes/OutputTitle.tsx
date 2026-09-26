import { formatNodeLabel, type Language } from '@/i18n';

/**
 * The header title of the Raymarch and Splat Outputs — on the canvas AND on
 * their palette tiles (one node, one look): the node's name in the UI
 * language and, whenever that name is a TRANSLATION, the technique's ORIGINAL
 * name on a second line — "SDF IZVADE" over "(Raymarching)", "GAUSA PLEĶI"
 * over "(Gaussian splat)".
 *
 * Neither technique has an official Latvian term: termini.gov.lv (the LZA
 * Terminology Commission's portal) knows only ray tracing, "staru izsekošana",
 * which the Raymarch Output borrowed until 2026-09-26, when the owner picked
 * "Staru soļi" and "Gausa pleķi" from a shortlist and asked for "the same
 * original name underneath always" — so a Latvian reader is never left to
 * guess what this project's own coinage means. The same day the marching sink
 * was renamed after what it renders — "SDF Output" / "SDF Izvade" (type still
 * `raymarchOutput`) — and it keeps the "(Raymarching)" line: the header says
 * WHAT is drawn, the gloss HOW. English mode prints the English
 * name alone: the second line would repeat the first.
 *
 * The plain Output keeps its own span — "Izvade" needs no gloss, and it
 * carries a per-mesh ordinal this component does not.
 */
export function OutputTitle({ title, type, original, language, color }: {
  /** The node's canonical English name (`config.title`). */
  title: string;
  /** The registry type the Latvian label is keyed by. */
  type: string;
  /** The technique's original name (`config.original`), shown in brackets. */
  original: string;
  language: Language;
  color: string;
}) {
  const shown = formatNodeLabel(title, type, language, false);
  return (
    <span className="output-node__title" style={{ color }}>
      {shown}
      {shown !== title && <span className="output-node__original">({original})</span>}
    </span>
  );
}
