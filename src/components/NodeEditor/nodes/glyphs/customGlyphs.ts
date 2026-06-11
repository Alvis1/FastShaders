/**
 * Per-node design overrides authored with node-designer.html (repo root).
 * { svg?: inner SVG (0 0 56 56), justify?: left|center|right, scale?: glyph-only scale,
 *   dx?/dy?: glyph nudge, width?: exact node width (>=24; header ellipsizes),
 *   height?: EXACT body height (>=28, both layouts; shorter than content shrinks
 *   the node, content overflows; independent of glyph scale), text?: text-size
 *   multiplier (0.4-2.5, default 1; header/value/edge-label fonts), sockets?:
 *   per-socket offsets from body center (4px snap; keys = input ids + "out") }
 * Node frame style (corner radius, border) is fixed app-wide.
 * Rewritten wholesale by the designer on save.
 */
export const CUSTOM_GLYPHS: Record<string, { svg?: string; justify?: string; scale?: number; dx?: number; dy?: number; width?: number; height?: number; text?: number; sockets?: Record<string, number> }> = {
  "mul": {
    "svg": "<text x=\"28\" y=\"40\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:500 40px Inter,sans-serif\">×</text>",
    "scale": 0.55,
    "width": 37,
    "height": 42,
    "sockets": {
      "b": 12,
      "a": -12
    }
  },
  "positionGeometry": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#8A8F9C\" stroke-width=\".8\" fill=\"none\"><line x1=\"-22\" y1=\"-18\" x2=\"22\" y2=\"-18\" stroke-width=\".8\"/><circle cx=\"0\" cy=\"-18\" r=\"1.2\" fill=\"#8A8F9C\" stroke=\"none\"/><line x1=\"-22\" y1=\"20\" x2=\"0\" y2=\"-18\"/><line x1=\"-11\" y1=\"20\" x2=\"0\" y2=\"-18\"/><line x1=\"0\" y1=\"20\" x2=\"0\" y2=\"-18\"/><line x1=\"11\" y1=\"20\" x2=\"0\" y2=\"-18\"/><line x1=\"22\" y1=\"20\" x2=\"0\" y2=\"-18\"/><line x1=\"-22\" y1=\"20\" x2=\"22\" y2=\"20\"/><line x1=\"-17\" y1=\"10\" x2=\"17\" y2=\"10\"/><line x1=\"-13\" y1=\"2\" x2=\"13\" y2=\"2\"/><line x1=\"-10\" y1=\"-4\" x2=\"10\" y2=\"-4\"/></g><circle cx=\"-4\" cy=\"14\" r=\"3.5\" fill=\"#F57C00\"/></g>",
    "scale": 1.65,
    "width": 58
  },
  "positionLocal": {
    "scale": 1.2,
    "width": 55
  },
  "positionWorld": {
    "scale": 1.6,
    "dx": 1.5,
    "dy": 7.5,
    "width": 56,
    "height": 28,
    "sockets": {
      "out": -4
    }
  },
  "cameraNear": {
    "scale": 2,
    "dx": -1,
    "dy": -7,
    "width": 72,
    "height": 50,
    "sockets": {
      "out": 0
    }
  },
  "positionView": {
    "width": 82,
    "height": 28
  },
  "positionWorldDirection": {
    "width": 88,
    "height": 28
  },
  "cameraPosition": {
    "width": 87,
    "height": 28
  },
  "cameraFar": {
    "scale": 2,
    "dy": -7,
    "width": 64,
    "height": 49,
    "sockets": {
      "out": -4
    }
  },
  "uv": {
    "scale": 2,
    "dx": -2,
    "dy": -3.5,
    "width": 48,
    "height": 121,
    "sockets": {
      "out": 0
    }
  },
  "add": {
    "svg": "<text x=\"28\" y=\"33\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:200 20px Inter,sans-serif\">+</text>",
    "scale": 1.3,
    "width": 37,
    "height": 42,
    "sockets": {
      "b": 12,
      "a": -12
    }
  },
  "sub": {
    "svg": "<text x=\"28\" y=\"31\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:700 10px Inter,sans-serif\">−</text>",
    "scale": 2,
    "width": 38,
    "height": 42,
    "sockets": {
      "a": -12,
      "b": 12
    }
  },
  "div": {
    "svg": "<text x=\"28\" y=\"35\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:300 25px Inter,sans-serif\">÷</text>",
    "scale": 0.95,
    "width": 37,
    "height": 42,
    "sockets": {
      "b": 12,
      "a": -12
    }
  },
  "abs": {
    "scale": 1.6,
    "dx": -0.5,
    "dy": -7.5,
    "width": 52,
    "height": 41,
    "sockets": {
      "out": 8,
      "x": 8
    }
  },
  "sqrt": {
    "scale": 1.6,
    "dx": -0.5,
    "dy": -7.5,
    "width": 52,
    "height": 41,
    "sockets": {
      "out": 8,
      "x": 8
    }
  },
  "exp": {
    "scale": 1.2,
    "dx": 0.5,
    "dy": -11,
    "width": 52,
    "height": 41,
    "sockets": {
      "out": 8,
      "x": 8
    }
  },
  "log2": {
    "scale": 1.2,
    "dy": -10.5,
    "width": 47,
    "height": 40,
    "sockets": {
      "out": 8,
      "x": 8
    }
  },
  "floor": {
    "scale": 1.2,
    "dy": -10.5,
    "width": 47,
    "height": 41,
    "sockets": {
      "out": 8,
      "x": 8
    }
  },
  "round": {
    "scale": 1.2,
    "dx": 1,
    "dy": -3.5,
    "width": 44,
    "height": 45,
    "sockets": {
      "x": 12,
      "out": 12
    }
  },
  "fract": {
    "scale": 1.3,
    "dx": 0.5,
    "dy": -7.5,
    "width": 46,
    "height": 43,
    "sockets": {
      "x": 12,
      "out": 12
    }
  },
  "oneMinus": {
    "width": 49,
    "height": 28,
    "sockets": {
      "x": 0,
      "out": 0
    }
  }
};
