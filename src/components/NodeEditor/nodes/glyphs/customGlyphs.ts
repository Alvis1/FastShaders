/**
 * Per-node design overrides authored with node-designer.html (repo root).
 * { svg?: inner SVG (0 0 56 56), justify?: left|center|right, scale?: glyph-only scale,
 *   dx?/dy?: glyph nudge, width?: exact node width (>=24; header text wraps + header auto-grows),
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
    "width": 47,
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
    "scale": 1.6,
    "dy": -4,
    "width": 48,
    "height": 48,
    "sockets": {
      "out": -4
    }
  },
  "positionWorld": {
    "scale": 1.6,
    "dy": -4,
    "width": 48,
    "height": 48,
    "sockets": {
      "out": -4
    }
  },
  "cameraNear": {
    "svg": "<line x1=\"19\" y1=\"28\" x2=\"47\" y2=\"19.44\" stroke=\"#8A8F9C\" stroke-width=\".8\"></line><line x1=\"19\" y1=\"28\" x2=\"47\" y2=\"37.2\" stroke=\"#8A8F9C\" stroke-width=\".8\"></line><line x1=\"39.78\" y1=\"19.44\" x2=\"39.78\" y2=\"37.2\" stroke=\"#2B2B2B\" stroke-width=\"0.7\" stroke-linecap=\"round\"></line><line x1=\"24\" y1=\"19.44\" x2=\"24\" y2=\"37.2\" stroke=\"#F57C00\" stroke-width=\"2.6\" stroke-linecap=\"round\"></line><ellipse cx=\"13\" cy=\"28\" rx=\"6\" ry=\"3.5\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.6\"></ellipse><circle cx=\"13\" cy=\"28\" r=\"2\" fill=\"#F57C00\"></circle>",
    "scale": 2,
    "dx": -2.5,
    "dy": -13.5,
    "width": 73,
    "height": 35,
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
    "svg": "<line x1=\"19\" y1=\"28\" x2=\"47\" y2=\"19.44\" stroke=\"#8A8F9C\" stroke-width=\".8\"></line><line x1=\"19\" y1=\"28\" x2=\"47\" y2=\"37.2\" stroke=\"#8A8F9C\" stroke-width=\".8\"></line><line x1=\"24\" y1=\"19.44\" x2=\"24\" y2=\"37.2\" stroke=\"#2B2B2B\" stroke-width=\"0.7\" stroke-linecap=\"round\"></line><line x1=\"39.78\" y1=\"19.44\" x2=\"39.78\" y2=\"37.2\" stroke=\"#F57C00\" stroke-width=\"2.6\" stroke-linecap=\"round\"></line><ellipse cx=\"13\" cy=\"28\" rx=\"6\" ry=\"3.5\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.6\"></ellipse><circle cx=\"13\" cy=\"28\" r=\"2\" fill=\"#F57C00\"></circle>",
    "scale": 2,
    "dx": -2.5,
    "dy": -13.5,
    "width": 73,
    "height": 35,
    "sockets": {
      "out": 0
    }
  },
  "uv": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#F57C00\" stroke-width=\".6\" opacity=\".6\"><line x1=\"-13.57\" y1=\"-27.58\" x2=\"-13.57\" y2=\"28.29\"></line><line x1=\"-27.58\" y1=\"28.29\" x2=\"27.36\" y2=\"28.29\"></line><line x1=\"0\" y1=\"-27.58\" x2=\"0\" y2=\"28.29\"></line><line x1=\"14\" y1=\"-27.58\" x2=\"14\" y2=\"28.29\"></line><line x1=\"-27.58\" y1=\"-27.58\" x2=\"-27.58\" y2=\"28.29\"></line><line x1=\"27.36\" y1=\"-27.58\" x2=\"27.36\" y2=\"28.29\"></line><line x1=\"-27.58\" y1=\"-14\" x2=\"27.36\" y2=\"-14\"></line><line x1=\"-27.58\" y1=\"-27.58\" x2=\"27.36\" y2=\"-27.58\"></line><line x1=\"-27.58\" y1=\"0\" x2=\"27.36\" y2=\"0\"></line><line x1=\"-27.58\" y1=\"14.21\" x2=\"27.36\" y2=\"14.21\"></line><line x1=\"-13.57\" y1=\"0\" x2=\"14\" y2=\"0\"></line></g><g stroke=\"#2B2B2B\" stroke-width=\"1.6\" fill=\"none\"><rect x=\"0\" y=\"-14\" width=\"14\" height=\"14\"></rect><rect x=\"0\" y=\"14.21\" width=\"14\" height=\"14.08\"></rect><rect x=\"-13.57\" y=\"0\" width=\"13.57\" height=\"14.21\"></rect><rect x=\"14\" y=\"0\" width=\"13.36\" height=\"14.21\"></rect><rect x=\"0\" y=\"0\" width=\"14\" height=\"14.21\"></rect></g></g>",
    "scale": 1.2,
    "dx": -0.5,
    "dy": 28,
    "width": 49,
    "height": 105,
    "sockets": {
      "out": -52,
      "channel": -44,
      "rotation": 36,
      "tilingV": 24,
      "tilingU": 12
    }
  },
  "add": {
    "svg": "<text x=\"28\" y=\"33\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:200 20px Inter,sans-serif\">+</text>",
    "scale": 1.3,
    "width": 44,
    "height": 42,
    "sockets": {
      "b": 12,
      "a": -12
    }
  },
  "sub": {
    "svg": "<text x=\"28\" y=\"31\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:700 10px Inter,sans-serif\">−</text>",
    "scale": 2,
    "width": 50,
    "height": 41,
    "sockets": {
      "a": -12,
      "b": 12
    }
  },
  "div": {
    "svg": "<text x=\"28\" y=\"35\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:300 25px Inter,sans-serif\">÷</text>",
    "scale": 0.95,
    "width": 40,
    "height": 41,
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
    "svg": "<g transform=\"translate(28 28)\" stroke=\"#F57C00\" stroke-width=\"1.4\" stroke-linecap=\"round\"><line stroke=\"#000000\" x1=\"-13.88\" y1=\"6\" x2=\"13.54\" y2=\"6\"></line><line x1=\"0\" y1=\"3.97\" x2=\"0\" y2=\"-14.15\"></line><line x1=\"-6.18\" y1=\"-3.5\" x2=\"0\" y2=\"3.97\"></line><line x1=\"0\" y1=\"3.97\" x2=\"7.13\" y2=\"-3.5\"></line></g>",
    "scale": 1.2,
    "dy": -10.5,
    "width": 48,
    "height": 37,
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
    "dx": -0.5,
    "dy": -3,
    "width": 63,
    "height": 28,
    "sockets": {
      "x": 0,
      "out": 0
    }
  },
  "dot": {
    "svg": "<g transform=\"translate(15 36)\"><polygon points=\"14.5 -18 8.56 -16 14.5 -10.66\" fill=\"#2D6CDF\"></polygon><polygon points=\"26.8 0 22 -3.23 22 3.45\" fill=\"#8A8F9C\"></polygon><line x1=\"0\" y1=\"0\" x2=\"23.54\" y2=\"0\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></line><line x1=\"0\" y1=\"0\" x2=\"13\" y2=\"-16\" stroke=\"#2D6CDF\" stroke-width=\"1.8\"></line><line x1=\"13\" y1=\"-14.45\" x2=\"13\" y2=\"0\" stroke=\"#8A8F9C\" stroke-width=\".9\" stroke-dasharray=\"1.4 1.4\"></line><line x1=\"0\" y1=\"0\" x2=\"13\" y2=\"0\" stroke=\"#F57C00\" stroke-width=\"3\" stroke-linecap=\"round\"></line></g>",
    "scale": 2,
    "dx": 0.5,
    "dy": -3,
    "width": 48,
    "height": 63,
    "sockets": {
      "b": 20,
      "a": -24
    }
  },
  "pow": {
    "scale": 2,
    "dy": -3.5,
    "width": 40,
    "height": 55,
    "sockets": {
      "exp": 16,
      "base": -16
    }
  },
  "vec4": {
    "sockets": {
      "out": 0
    }
  },
  "vec3": {
    "sockets": {
      "out": 0
    }
  },
  "vec2": {
    "sockets": {
      "out": 0
    }
  },
  "greaterThan": {
    "scale": 1.3,
    "dx": 1,
    "dy": -2.5,
    "width": 45,
    "height": 42,
    "sockets": {
      "a": -12,
      "b": 12
    }
  },
  "lessThan": {
    "scale": 1.3,
    "dx": 1,
    "dy": -2.5,
    "width": 40,
    "height": 40,
    "sockets": {
      "a": -12,
      "b": 12
    }
  },
  "equal": {
    "scale": 1.3,
    "dx": 1,
    "dy": -2.5,
    "width": 39,
    "height": 42,
    "sockets": {
      "a": -12,
      "b": 12
    }
  },
  "normalize": {
    "svg": "<g transform=\"translate(28 32)\"><line x1=\"-14\" y1=\"8\" x2=\"24\" y2=\"-5.5\" stroke=\"#B4B7C0\" stroke-dasharray=\"2 2\" stroke-width=\"1\"></line><line x1=\"-14\" y1=\"8\" x2=\"5\" y2=\"1.5\" stroke=\"#F57C00\" stroke-width=\"2\"></line><polygon points=\"10.03 0 3 -1.8 3 5.69\" fill=\"#F57C00\"></polygon></g>",
    "scale": 1.5,
    "dx": -6.5,
    "dy": -18.5,
    "width": 58,
    "height": 37,
    "sockets": {
      "v": 8,
      "out": 8
    }
  },
  "length": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"-27.68\" y1=\"-9\" x2=\"-27.68\" y2=\"9\" stroke=\"#2B2B2B\" stroke-width=\"1.2\"></line><line x1=\"27.96\" y1=\"-9\" x2=\"27.96\" y2=\"9\" stroke=\"#2B2B2B\" stroke-width=\"1.2\"></line><line x1=\"-27.68\" y1=\"0\" x2=\"27.96\" y2=\"0\" stroke=\"#F57C00\" stroke-width=\"1.6\"></line><polygon points=\"-27.68 0 -22.61 -3 -22.61 3\" fill=\"#F57C00\"></polygon><polygon points=\"27.96 0 22.78 -3 22.78 3\" fill=\"#F57C00\"></polygon></g>",
    "dx": -1,
    "dy": -14,
    "width": 45,
    "height": 30,
    "sockets": {
      "v": 8,
      "out": 8
    }
  },
  "screenUV": {
    "width": 59,
    "height": 47
  },
  "distance": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#8A8F9C\" stroke-width=\".6\" fill=\"none\"><line x1=\"-22\" y1=\"-18\" x2=\"22\" y2=\"-18\" stroke-width=\".8\"></line><circle cx=\"0\" cy=\"-18\" r=\"1.2\" fill=\"#8A8F9C\" stroke=\"none\"></circle><line x1=\"-22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"0\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-22\" y1=\"20\" x2=\"22\" y2=\"20\"></line><line x1=\"-17\" y1=\"10\" x2=\"15.5\" y2=\"10\"></line><line x1=\"-13\" y1=\"2\" x2=\"13\" y2=\"2\"></line><line x1=\"-10\" y1=\"-4\" x2=\"10\" y2=\"-4\"></line></g><line x1=\"-22\" y1=\"4.84\" x2=\"19\" y2=\"-9.75\" stroke=\"#2B2B2B\" stroke-dasharray=\"1.4 1.4\" stroke-width=\"1.1\"></line><circle cx=\"-22\" cy=\"4.84\" r=\"3.5\" fill=\"#2D6CDF\"></circle><circle cx=\"19\" cy=\"-9.75\" r=\"3.5\" fill=\"#F57C00\"></circle></g>",
    "width": 51,
    "height": 56,
    "sockets": {
      "a": -20,
      "b": 20
    }
  },
  "cross": {
    "svg": "<path d=\"M 16 44 L 33 37.5 L 47.69 44 L 28.1 51 Z\" fill=\"#2D6CDF\" fill-opacity=\".16\"></path><line x1=\"33\" y1=\"37.5\" x2=\"47.69\" y2=\"44\" stroke=\"#8A8F9C\" stroke-width=\".9\" stroke-dasharray=\"1.4 1.4\"></line><line x1=\"28.1\" y1=\"51\" x2=\"47.69\" y2=\"44\" stroke=\"#8A8F9C\" stroke-width=\".9\" stroke-dasharray=\"1.4 1.4\"></line><line x1=\"16\" y1=\"44\" x2=\"33\" y2=\"37.5\" stroke=\"#2D6CDF\" stroke-width=\"2.2\"></line><polygon points=\"37.82 37 28.1 35.41 34.5 40.5\" fill=\"#2D6CDF\"></polygon><line x1=\"16\" y1=\"44\" x2=\"28.1\" y2=\"51\" stroke=\"#F57C00\" stroke-width=\"2.2\"></line><polygon points=\"30.5 52.91 22.67 51 28.1 47.37\" fill=\"#F57C00\"></polygon><line x1=\"16\" y1=\"44\" x2=\"16\" y2=\"23.71\" stroke=\"#2E9E5B\" stroke-width=\"2.2\"></line><polygon points=\"16 21.28 12.5 25.5 19.5 25.5\" fill=\"#2E9E5B\"></polygon>",
    "scale": 1.2,
    "dx": -0.5,
    "dy": -10,
    "width": 48,
    "height": 60,
    "sockets": {
      "b": 20,
      "a": -20
    }
  },
  "split": {
    "sockets": {
      "v": 0
    }
  },
  "append": {
    "sockets": {
      "out": 0
    }
  },
  "hsl": {
    "sockets": {
      "out": 0
    }
  },
  "mix": {
    "width": 50,
    "height": 50,
    "sockets": {
      "out": -8,
      "t": 16,
      "b": -4,
      "a": -16
    }
  },
  "smoothstep": {
    "width": 43,
    "height": 50,
    "sockets": {
      "x": 16,
      "out": -12,
      "edge1": -4,
      "edge0": -16
    }
  },
  "remap": {
    "width": 47,
    "height": 83,
    "sockets": {
      "outHigh": 32,
      "outLow": 20,
      "inHigh": 0,
      "inLow": -12,
      "out": 28,
      "x": -32
    }
  },
  "clamp": {
    "scale": 1.5,
    "dx": -1,
    "dy": 25,
    "width": 45,
    "height": 72,
    "sockets": {
      "out": 8,
      "x": -28,
      "min": -8,
      "max": 24
    }
  },
  "min": {
    "width": 44,
    "height": 54,
    "sockets": {
      "a": -20,
      "b": 16
    }
  },
  "max": {
    "dy": -4.5,
    "width": 44,
    "height": 54,
    "sockets": {
      "a": -20,
      "b": 16
    }
  },
  "mod": {
    "width": 47,
    "height": 47
  }
};
