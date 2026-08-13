/**
 * Per-node design overrides authored with node-designer.html (repo root).
 * { svg?: inner SVG (0 0 56 56), justify?: left|center|right, scale?: glyph-only scale,
 *   dx?/dy?: glyph nudge, width?: exact node width (>=24; header text wraps + header auto-grows),
 *   height?: EXACT body height (>=28, both layouts; shorter than content shrinks
 *   the node, content overflows; independent of glyph scale), text?: text-size
 *   multiplier (0.4-2.5, default 1; header/value/edge-label fonts), sockets?:
 *   per-socket offsets from body center (4px snap; keys = input ids + "out";
 *   the CORNER DRAG rescales them with the height, the W/H number
 *   fields do not — renderer semantics unchanged, so no saved design moves) }
 * Node frame style (corner radius, border) is fixed app-wide.
 * Rewritten wholesale by the designer on save.
 */
export const CUSTOM_GLYPHS: Record<string, { svg?: string; justify?: string; scale?: number; dx?: number; dy?: number; width?: number; height?: number; text?: number; sockets?: Record<string, number> }> = {
  "positionViewDirection": {
    "svg": "<g transform=\"translate(28 28)\"><path d=\"M-18 10 Q0 0 18 10\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.3\"/><path d=\"M-9 -14 Q0 -20 9 -14 Q0 -8 -9 -14 Z\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.3\"/><circle cx=\"0\" cy=\"-14\" r=\"2\" fill=\"#2B2B2B\"/><line x1=\"0\" y1=\"5\" x2=\"0\" y2=\"-6\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"/><polygon points=\"-4,-4 4,-4 0,-11\" fill=\"#F57C00\"/></g>"
  },
  "toHsl": {
    "dx": -2,
    "dy": 95,
    "sockets": {
      "rgb": 0
    }
  },
  "tangentLocal": {
    "svg": "<g transform=\"translate(28 28)\"><path d=\"M-18 7 Q0 -3 18 7\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.3\"/><line x1=\"-12\" y1=\"0\" x2=\"10\" y2=\"-5\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"/><polygon points=\"8,-9 8,-1 16,-6\" fill=\"#F57C00\"/><rect x=\"-9\" y=\"12\" width=\"18\" height=\"7\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.2\"/></g>"
  },
  "normalWorld": {
    "svg": "<g transform=\"translate(28 28)\"><path d=\"M-18 7 Q0 -3 18 7\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.3\"/><line x1=\"0\" y1=\"2\" x2=\"0\" y2=\"-12\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"/><polygon points=\"-4,-10 4,-10 0,-17\" fill=\"#F57C00\"/><g stroke=\"#2D6CDF\" stroke-width=\"1.3\" stroke-linecap=\"round\"><line x1=\"-9\" y1=\"18\" x2=\"-1\" y2=\"18\"/><line x1=\"-9\" y1=\"18\" x2=\"-9\" y2=\"11\"/><line x1=\"-9\" y1=\"18\" x2=\"-14\" y2=\"21\"/></g></g>",
    "width": 40,
    "height": 43,
    "sockets": {
      "out": -4
    }
  },
  "normalLocal": {
    "svg": "<g transform=\"translate(28 28)\"><path d=\"M-18 7 Q0 -3 18 7\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.3\"/><line x1=\"0\" y1=\"2\" x2=\"0\" y2=\"-12\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"/><polygon points=\"-4,-10 4,-10 0,-17\" fill=\"#F57C00\"/><rect x=\"-9\" y=\"12\" width=\"18\" height=\"7\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.2\"/></g>",
    "width": 34,
    "height": 35,
    "sockets": {
      "out": 0
    }
  },
  "dataviz": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#B4B7C0\" stroke-width=\"0.8\"><line x1=\"-18\" y1=\"6\" x2=\"18\" y2=\"6\"/><line x1=\"-18\" y1=\"6\" x2=\"-18\" y2=\"-15\"/></g><polyline points=\"-18,2 -12,-6 -6,-2 0,-12 6,-7 12,-13 18,-9\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.7\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/><g stroke=\"none\"><rect x=\"-18\" y=\"11\" width=\"9\" height=\"6\" fill=\"#440154\"/><rect x=\"-9\" y=\"11\" width=\"9\" height=\"6\" fill=\"#277f8e\"/><rect x=\"0\" y=\"11\" width=\"9\" height=\"6\" fill=\"#4ac16d\"/><rect x=\"9\" y=\"11\" width=\"9\" height=\"6\" fill=\"#fde725\"/></g><rect x=\"-18\" y=\"11\" width=\"36\" height=\"6\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1\"/></g>",
    "scale": 1.4,
    "dx": -0.5,
    "dy": 1
  },
  "isolines": {
    "svg": "<g transform=\"translate(28 28)\" fill=\"none\"><path d=\"M -22.63 5 Q -22.63 -21.91 1 -21.91 Q 25.5 -20 28.98 0 Q 28.98 27.54 1 25.2 Q -20.5 23.5 -22.63 5 Z\" stroke=\"#8A8F9C\" stroke-width=\"2.3\"></path><path d=\"M -15.5 5 Q -15.5 -13.46 0 -13.46 Q 17.28 -15.5 19.2 0 Q 20.78 18.62 1 18.62 Q -15.5 18.62 -15.5 5 Z\" stroke=\"#2B2B2B\" stroke-width=\"2.3\"></path><path d=\"M -7.16 3 Q -7.16 -4.64 1 -4.64 Q 10.43 -7.35 10.43 3 Q 10.43 10.01 1 10.01 Q -7.16 10.01 -7.16 3 Z\" stroke=\"#F57C00\" stroke-width=\"2.6\"></path></g>",
    "scale": 1.15,
    "dx": -3,
    "dy": -1,
    "width": 43,
    "height": 94,
    "sockets": {
      "out": -4
    }
  },
  "dataRange": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"-31.08\" y1=\"19.5\" x2=\"31.22\" y2=\"19.5\" stroke=\"#B4B7C0\" stroke-width=\"0.8\"></line><path d=\"M -27.42 19.5 Q -11 13.92 -7.5 2.5 Q 0 -17.3 7.17 2.5 Q 11 13.92 28.33 19.5\" fill=\"#FF9800\" fill-opacity=\"0.18\" stroke=\"#F57C00\" stroke-width=\"1.5\"></path><g stroke=\"#2B2B2B\" stroke-width=\"1.6\"><line x1=\"-11\" y1=\"-17.3\" x2=\"-11\" y2=\"28.74\"></line><line x1=\"11\" y1=\"-17.3\" x2=\"11\" y2=\"28.74\"></line></g></g>",
    "dx": -0.5,
    "dy": -3,
    "width": 45,
    "height": 46,
    "sockets": {
      "out": 16,
      "value": 16
    }
  },
  "mul": {
    "svg": "<text x=\"28\" y=\"35\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:500 22px Inter,sans-serif\">×</text>",
    "dx": 0.5,
    "dy": -1.5,
    "width": 47,
    "height": 42,
    "sockets": {
      "b": 12,
      "a": -12
    }
  },
  "positionGeometry": {
    "svg": "<g transform=\"translate(28 28)\"><g fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\" stroke-linejoin=\"round\"><rect x=\"-10\" y=\"-4\" width=\"18\" height=\"18\"/><path d=\"M-10 -4 L-4 -10 L14 -10 L8 -4 M14 -10 L14 8 L8 14\"/></g><circle cx=\"-10\" cy=\"14\" r=\"3.5\" fill=\"#F57C00\"/></g>",
    "scale": 1.65,
    "dx": -1.5,
    "dy": -4.5,
    "width": 41,
    "height": 50,
    "sockets": {
      "out": 0
    }
  },
  "positionLocal": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#8A8F9C\" stroke-width=\".6\" fill=\"none\"><line x1=\"-22\" y1=\"-18\" x2=\"22\" y2=\"-18\" stroke-width=\".8\"></line><circle cx=\"0\" cy=\"-18\" r=\"1.2\" fill=\"#8A8F9C\" stroke=\"none\"></circle><line x1=\"-22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"0\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-22\" y1=\"20\" x2=\"22\" y2=\"20\"></line><line x1=\"-17\" y1=\"10\" x2=\"17\" y2=\"10\"></line><line x1=\"-13\" y1=\"2\" x2=\"13\" y2=\"2\"></line><line x1=\"-10\" y1=\"-4\" x2=\"10\" y2=\"-4\"></line></g><rect x=\"-12\" y=\"4\" width=\"24\" height=\"12\" fill=\"rgba(0,0,0,0.04)\" stroke=\"#2B2B2B\" stroke-width=\"1.4\"></rect><circle cx=\"-5.5\" cy=\"8.5\" r=\"3\" fill=\"#F57C00\"></circle></g>",
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
    "width": 65,
    "height": 35,
    "sockets": {
      "out": 0
    }
  },
  "positionView": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#8A8F9C\" stroke-width=\"0.7\" fill=\"none\"><line x1=\"-20\" y1=\"-14\" x2=\"20\" y2=\"-14\"/><line x1=\"-20\" y1=\"16\" x2=\"0\" y2=\"-14\"/><line x1=\"-8\" y1=\"16\" x2=\"0\" y2=\"-14\"/><line x1=\"8\" y1=\"16\" x2=\"0\" y2=\"-14\"/><line x1=\"20\" y1=\"16\" x2=\"0\" y2=\"-14\"/><line x1=\"-20\" y1=\"16\" x2=\"20\" y2=\"16\"/><line x1=\"-14\" y1=\"4\" x2=\"14\" y2=\"4\"/><line x1=\"-10\" y1=\"-4\" x2=\"10\" y2=\"-4\"/></g><path d=\"M-9 -16 Q0 -22 9 -16 Q0 -10 -9 -16 Z\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\"/><circle cx=\"0\" cy=\"-16\" r=\"2.2\" fill=\"#2B2B2B\"/><circle cx=\"-4\" cy=\"9\" r=\"3.2\" fill=\"#F57C00\"/></g>",
    "width": 52,
    "height": 33,
    "sockets": {
      "out": 0
    }
  },
  "positionWorldDirection": {
    "svg": "<g transform=\"translate(28 28)\"><circle cx=\"0\" cy=\"0\" r=\"5\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.6\"/><g stroke=\"#8A8F9C\" stroke-width=\"1.2\"><line x1=\"0\" y1=\"-7\" x2=\"0\" y2=\"-15\"/><line x1=\"0\" y1=\"7\" x2=\"0\" y2=\"15\"/><line x1=\"-7\" y1=\"0\" x2=\"-15\" y2=\"0\"/><line x1=\"7\" y1=\"0\" x2=\"15\" y2=\"0\"/><line x1=\"-5\" y1=\"-5\" x2=\"-11\" y2=\"-11\"/><line x1=\"5\" y1=\"5\" x2=\"11\" y2=\"11\"/><line x1=\"5\" y1=\"-5\" x2=\"11\" y2=\"-11\"/><line x1=\"-5\" y1=\"5\" x2=\"-11\" y2=\"11\"/></g><polygon points=\"9,-15 17,-15 13,-21\" fill=\"#F57C00\" transform=\"rotate(45 13 -18)\"/></g>",
    "width": 57,
    "height": 33,
    "sockets": {
      "out": 0
    }
  },
  "cameraPosition": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#8A8F9C\" stroke-width=\".8\" fill=\"none\"><line x1=\"-22\" y1=\"-18\" x2=\"22\" y2=\"-18\" stroke-width=\".8\"></line><circle cx=\"0\" cy=\"-18\" r=\"1.2\" fill=\"#8A8F9C\" stroke=\"none\"></circle><line x1=\"-22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"0\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-22\" y1=\"20\" x2=\"22\" y2=\"20\"></line><line x1=\"-16\" y1=\"10\" x2=\"17\" y2=\"10\"></line><line x1=\"-13\" y1=\"2\" x2=\"13\" y2=\"2\"></line><line x1=\"-8.08\" y1=\"-4\" x2=\"10\" y2=\"-4\"></line></g></g>\n\n<g transform=\"translate(28 28)\"><g fill=\"white\" stroke=\"#2B2B2B\" stroke-width=\"1.6\" stroke-linejoin=\"round\"><rect x=\"-14\" y=\"3.57\" width=\"22\" height=\"16.43\" rx=\"2\"></rect><path d=\"M 8 8.49 L 17 3.57 L 17 20 L 8 14.68 Z\"></path></g><circle cx=\"-3.29\" cy=\"11.8\" r=\"4\" fill=\"white\" stroke=\"#8A8F9C\" stroke-width=\"1.3\"></circle><circle cx=\"-3.29\" cy=\"11.8\" r=\"1.72\" fill=\"#F57C00\"></circle><rect x=\"-11\" y=\"0\" width=\"4.7\" height=\"3.57\" fill=\"#2B2B2B\"></rect></g>",
    "scale": 1.4,
    "dy": 4.5,
    "width": 47,
    "height": 48,
    "sockets": {
      "out": 0
    }
  },
  "cameraFar": {
    "svg": "<line x1=\"19\" y1=\"28\" x2=\"47\" y2=\"19.44\" stroke=\"#8A8F9C\" stroke-width=\".8\"></line><line x1=\"19\" y1=\"28\" x2=\"47\" y2=\"37.2\" stroke=\"#8A8F9C\" stroke-width=\".8\"></line><line x1=\"24\" y1=\"19.44\" x2=\"24\" y2=\"37.2\" stroke=\"#2B2B2B\" stroke-width=\"0.7\" stroke-linecap=\"round\"></line><line x1=\"39.78\" y1=\"19.44\" x2=\"39.78\" y2=\"37.2\" stroke=\"#F57C00\" stroke-width=\"2.6\" stroke-linecap=\"round\"></line><ellipse cx=\"13\" cy=\"28\" rx=\"6\" ry=\"3.5\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.6\"></ellipse><circle cx=\"13\" cy=\"28\" r=\"2\" fill=\"#F57C00\"></circle>",
    "scale": 2,
    "dx": -2.5,
    "dy": -13.5,
    "width": 54,
    "height": 37,
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
    "svg": "<text x=\"28\" y=\"35\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:500 22px Inter,sans-serif\">+</text>",
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
    "svg": "<g transform=\"scale(0.8750 0.8750) translate(0 0)\">\n  <text x=\"32\" y=\"40\" font-family=\"sans-serif\" font-size=\"22\" font-weight=\"bold\" text-anchor=\"middle\">\n    <tspan fill=\"#2B2B2B\">1 </tspan>\n    <tspan fill=\"#F57C00\">- x</tspan>\n  </text>\n</g>",
    "scale": 1.4,
    "dx": -0.5,
    "dy": -14.5,
    "width": 52,
    "height": 42,
    "sockets": {
      "x": 8,
      "out": 8
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
    "svg": "<text x=\"26\" y=\"34\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:500 17px Inter,sans-serif\">x<tspan dy=\"-7\" font-size=\"11\" fill=\"#F57C00\">y</tspan></text>",
    "scale": 1.75,
    "dx": 2.5,
    "dy": -0.5,
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
    "svg": "<g transform=\"translate(28 28)\"><rect x=\"-18\" y=\"-13\" width=\"36\" height=\"24\" rx=\"2\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.6\"/><g stroke=\"#8A8F9C\" stroke-width=\"0.8\"><line x1=\"-18\" y1=\"-1\" x2=\"18\" y2=\"-1\"/><line x1=\"0\" y1=\"-13\" x2=\"0\" y2=\"11\"/></g><circle cx=\"7\" cy=\"-6\" r=\"2.6\" fill=\"#F57C00\"/><line x1=\"-8\" y1=\"15\" x2=\"8\" y2=\"15\" stroke=\"#2B2B2B\" stroke-width=\"1.6\"/></g>",
    "scale": 1.6,
    "dx": 0.5,
    "dy": -7.5,
    "width": 47,
    "height": 66
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
    "height": 42,
    "sockets": {
      "a": -12,
      "b": 12,
      "out": 0
    }
  },
  "hsl": {
    "dx": -13.5,
    "width": 46,
    "height": 43,
    "sockets": {
      "out": 0
    }
  },
  "mix": {
    "scale": 1.2,
    "dy": 28,
    "width": 45,
    "height": 64,
    "sockets": {
      "out": -16,
      "t": 16,
      "b": -8,
      "a": -24
    }
  },
  "smoothstep": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"-20\" y1=\"0\" x2=\"20\" y2=\"0\" stroke=\"#B4B7C0\" stroke-width=\"0.6\"/><g stroke=\"#8A8F9C\" stroke-width=\"0.8\" stroke-dasharray=\"1.4 1.4\"><line x1=\"-12\" y1=\"-13\" x2=\"-12\" y2=\"13\"/><line x1=\"12\" y1=\"-13\" x2=\"12\" y2=\"13\"/></g><path d=\"M-20 10 L-12 10 C-3 10 3 -10 12 -10 L20 -10 L20 0 L-20 0 Z\" fill=\"#FF9800\" fill-opacity=\"0.16\" stroke=\"none\"/><path d=\"M-20 10 L-12 10 C-3 10 3 -10 12 -10 L20 -10\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>",
    "scale": 2,
    "dy": 21.5,
    "width": 47,
    "height": 88,
    "sockets": {
      "x": 32,
      "out": 12,
      "edge1": -12,
      "edge0": -36
    }
  },
  "remap": {
    "justify": "left",
    "scale": 3,
    "dx": 8,
    "dy": 4.5,
    "width": 46,
    "height": 91,
    "sockets": {
      "outHigh": 36,
      "outLow": 20,
      "inHigh": 0,
      "inLow": -16,
      "out": 8,
      "x": -36
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
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"-20\" y1=\"0\" x2=\"20\" y2=\"0\" stroke=\"#B4B7C0\" stroke-width=\"0.6\"/><line x1=\"-20\" y1=\"14\" x2=\"20\" y2=\"-14\" stroke=\"#8A8F9C\" stroke-width=\"1\" stroke-dasharray=\"2 2\"/><line x1=\"-20\" y1=\"-4\" x2=\"20\" y2=\"-4\" stroke=\"#8A8F9C\" stroke-width=\"1\" stroke-dasharray=\"2 2\"/><path d=\"M-20 14 L5.7 -4 L20 -4 L20 0 L-20 0 Z\" fill=\"#FF9800\" fill-opacity=\"0.16\" stroke=\"none\"/><polyline points=\"-20,14 5.7,-4 20,-4\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>",
    "dx": -2,
    "dy": -4,
    "width": 44,
    "height": 54,
    "sockets": {
      "a": -20,
      "b": 16
    }
  },
  "max": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"-20\" y1=\"0\" x2=\"20\" y2=\"0\" stroke=\"#B4B7C0\" stroke-width=\"0.6\"/><line x1=\"-20\" y1=\"14\" x2=\"20\" y2=\"-14\" stroke=\"#8A8F9C\" stroke-width=\"1\" stroke-dasharray=\"2 2\"/><line x1=\"-20\" y1=\"-4\" x2=\"20\" y2=\"-4\" stroke=\"#8A8F9C\" stroke-width=\"1\" stroke-dasharray=\"2 2\"/><path d=\"M-20 -4 L5.7 -4 L20 -14 L20 0 L-20 0 Z\" fill=\"#FF9800\" fill-opacity=\"0.16\" stroke=\"none\"/><polyline points=\"-20,-4 5.7,-4 20,-14\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g>",
    "dy": -0.5,
    "width": 44,
    "height": 54,
    "sockets": {
      "a": -20,
      "b": 16
    }
  },
  "mod": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"-20\" y1=\"0\" x2=\"20\" y2=\"0\" stroke=\"#B4B7C0\" stroke-width=\"0.6\"/><g fill=\"#FF9800\" fill-opacity=\"0.16\" stroke=\"none\"><path d=\"M-19.5 0 L-6.5 -10 L-6.5 0 Z\"/><path d=\"M-6.5 0 L6.5 -10 L6.5 0 Z\"/><path d=\"M6.5 0 L19.5 -10 L19.5 0 Z\"/></g><g stroke=\"#F57C00\" stroke-width=\"1.4\" stroke-linecap=\"round\"><line x1=\"-19.5\" y1=\"0\" x2=\"-6.5\" y2=\"-10\"/><line x1=\"-6.5\" y1=\"0\" x2=\"6.5\" y2=\"-10\"/><line x1=\"6.5\" y1=\"0\" x2=\"19.5\" y2=\"-10\"/></g><g stroke=\"#2B2B2B\" stroke-width=\"1\" fill=\"none\"><line x1=\"-6.5\" y1=\"5\" x2=\"-6.5\" y2=\"8\"/><line x1=\"6.5\" y1=\"5\" x2=\"6.5\" y2=\"8\"/><line x1=\"-6.5\" y1=\"8\" x2=\"6.5\" y2=\"8\"/></g><text x=\"0\" y=\"16.5\" text-anchor=\"middle\" fill=\"#2B2B2B\" style=\"font:600 7px 'JetBrains Mono',monospace\">Y</text></g>",
    "scale": 1.25,
    "dy": 0.5,
    "width": 48,
    "height": 57,
    "sockets": {
      "y": 20,
      "x": -20
    }
  },
  "stripes": {
    "svg": "<g transform=\"translate(28 28)\"><g fill=\"#2B2B2B\"><rect x=\"-21\" y=\"-8\" width=\"7\" height=\"21\"/><rect x=\"-10\" y=\"-8\" width=\"5.5\" height=\"21\"/><rect x=\"-1\" y=\"-8\" width=\"4\" height=\"21\"/><rect x=\"6\" y=\"-8\" width=\"3\" height=\"21\"/><rect x=\"12\" y=\"-8\" width=\"2.2\" height=\"21\"/><rect x=\"16.8\" y=\"-8\" width=\"1.7\" height=\"21\"/><rect x=\"20.6\" y=\"-8\" width=\"1.3\" height=\"21\"/></g><path d=\"M-21 -13 Q0 -12 21 -18\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-linecap=\"round\"/></g>",
    "width": 61
  },
  "colormap": {
    "dx": 0.5,
    "dy": 12.5,
    "width": 107,
    "height": 28,
    "sockets": {
      "out": 4,
      "value": 4
    }
  },
  "select": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"-21\" y1=\"0\" x2=\"-15\" y2=\"0\" stroke=\"#8A8F9C\" stroke-width=\"1.2\"/><polygon points=\"-15,0 -6,-7 3,0 -6,7\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\" stroke-linejoin=\"round\"/><line x1=\"3\" y1=\"0\" x2=\"14.5\" y2=\"-6.6\" stroke=\"#F57C00\" stroke-width=\"1.8\"/><polygon points=\"18,-8.6 15.4,-4.1 12.8,-8.7\" fill=\"#F57C00\"/><line x1=\"3\" y1=\"0\" x2=\"17\" y2=\"8\" stroke=\"#8A8F9C\" stroke-width=\"1.1\" stroke-dasharray=\"1.4 1.4\"/></g>",
    "scale": 2,
    "dx": 3,
    "dy": -2,
    "width": 55,
    "height": 77,
    "sockets": {
      "condition": -28,
      "a": 12,
      "b": 28,
      "out": 28
    }
  }
};
