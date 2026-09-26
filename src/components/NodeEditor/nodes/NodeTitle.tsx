import { useMemo, type CSSProperties } from 'react';
import { splitTitle } from './titleSplit';

/** Spaces that must NOT break: everything but the chosen seam. */
const nb = (s: string) => s.replace(/ /g, ' ');

/**
 * The node header's title — the ONE renderer of `.node-base__title`, so every
 * node (canvas components, the NodeVisual replica behind cards, the overview
 * and the designer stage) wraps by the same rule: at most two lines, at the
 * seam `splitTitle` picks. The full text stays on `title` for hover, since the
 * CSS clamp can still ellipsize a name whose halves both overflow.
 *
 * `bare` drops that title: a canvas header carrying its own name label
 * (`useHeaderTip` — the Latvian name, drawn above the header) must not also
 * open the tooltip layer's bubble with the varName over it.
 */
export function NodeTitle({ text, style, bare = false }: { text: string; style?: CSSProperties; bare?: boolean }) {
  const split = useMemo(() => splitTitle(text), [text]);
  return (
    <span className="node-base__title" title={bare ? undefined : text} style={style}>
      {split ? (
        <>
          {nb(split.head)}
          {split.space ? ' ' : <wbr />}
          {nb(split.tail)}
        </>
      ) : (
        nb(text)
      )}
    </span>
  );
}
