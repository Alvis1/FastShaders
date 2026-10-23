import { createContext } from 'react';

/**
 * Sockets that carry what a canvas handle carries: React Flow's `data-handleid`
 * and the name label (`data-tooltip`, TypedHandle's text). OFF for the asset
 * tiles — their sockets are never hovered (the card is `pointer-events: none`),
 * and an invisible label still hangs outside the frame, where it would count
 * toward the strip's scroll width. ON for a surface that shows a connection
 * being made or a node's labels pinned (the intro, `src/intro/`), which rings a
 * socket and shows its label with the canvas's own `.fs-connect-socket` and
 * `[data-fs-labels-shown]` rules.
 *
 * Its own module so NodeVisual (which NodePreviewCard imports) can read it.
 */
export const CardSocketLabels = createContext(false);
