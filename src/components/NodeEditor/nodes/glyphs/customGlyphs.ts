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
    "svg": "<path d=\"M 33.77 49.15 L 42.53 48.5 L 54.48 35.05 L 40.17 22.69 L 31.42 22.91 L 20.47 36.93 L 33.77 49.15 Z\" fill=\"#FFFFFF\" stroke=\"none\" stroke-width=\"1.4\"></path>\n<g transform=\"translate(28 28)\"><path d=\"M -25.25 -13.88 Q -12.39 -22.46 0.48 -13.88 Q -12.39 -5.31 -25.25 -13.88 Z\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.3\"></path><circle cx=\"-12.39\" cy=\"-13.88\" r=\"2.86\" fill=\"#2B2B2B\"></circle></g>\n\n<g transform=\"translate(28 28)\"><g fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\" stroke-linejoin=\"round\"><rect x=\"2.38\" y=\"-8.22\" width=\"18.77\" height=\"18.48\" transform=\"rotate(40.33 -0.88 -3.91)\"></rect><path d=\"M 4.39 -5.09 L 13.14 -5.75 L 27.45 6.41 L 18.7 7.05 M 27.45 6.41 L 15.5 20.5 L 6.74 21.15\"></path></g></g>\n\n\n\n\n\n<g transform=\"translate(28 28)\"><line x1=\"5.39\" y1=\"7.93\" x2=\"-5.6\" y2=\"-6.04\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></line><polygon points=\"-8.56 -0.82 0.48 -7.82 -10.2 -12.23\" fill=\"#F57C00\"></polygon></g>",
    "scale": 1.35,
    "dx": -0.5,
    "dy": 4.5,
    "width": 61,
    "height": 50,
    "sockets": {
      "out": 0
    }
  },
  "toHsl": {
    "dx": -2,
    "dy": 95,
    "width": 45,
    "height": 60,
    "sockets": {
      "rgb": 0,
      "out": 20
    }
  },
  "tangentLocal": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"-5.5\" y1=\"4\" x2=\"11.94\" y2=\"-10.88\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></line><polygon points=\"7.06 -12.97 13.2 -5.93 16.92 -14.37\" fill=\"#2B2B2B\"></polygon><rect x=\"-24.07\" y=\"-0.63\" width=\"31\" height=\"11.32\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.2\" transform=\"rotate(20.66 -6.5 13.34)\"></rect></g>\n<path d=\"M 29.5 27.5 Q 22.5 20.17 15.68 28.5\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.7\"></path>",
    "scale": 1.5,
    "dx": 1,
    "dy": -5.5,
    "width": 44,
    "height": 41,
    "sockets": {
      "out": 0
    }
  },
  "vertexColor": {
    "svg": "<g transform=\"translate(28 28)\"><path d=\"M 0 -16 L 15 10 L -15 10 Z\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.5\" stroke-linejoin=\"round\"></path><circle cx=\"0\" cy=\"-16\" r=\"4.2\" fill=\"#F57C00\"></circle><circle cx=\"15\" cy=\"10\" r=\"4.2\" fill=\"#2E9E5B\"></circle><circle cx=\"-15\" cy=\"10\" r=\"4.2\" fill=\"#2D6CDF\"></circle></g>",
    "scale": 1.15,
    "dx": -1,
    "dy": -1.5,
    "width": 35,
    "height": 32,
    "sockets": {
      "out": 0
    }
  },
  "normalWorld": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#8A8F9C\" stroke-width=\".8\" fill=\"none\"><line x1=\"-22\" y1=\"-18\" x2=\"22\" y2=\"-18\" stroke-width=\".8\"></line><circle cx=\"0\" cy=\"-18\" r=\"0.5\" fill=\"#8A8F9C\" stroke=\"none\"></circle><line x1=\"-22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"0\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-22\" y1=\"20\" x2=\"22\" y2=\"20\"></line><line x1=\"-16\" y1=\"10\" x2=\"17\" y2=\"10\"></line><line x1=\"-13\" y1=\"2\" x2=\"13\" y2=\"2\"></line><line x1=\"-8.08\" y1=\"-4\" x2=\"10\" y2=\"-4\"></line></g></g>\n\n<path d=\"M 24.67 49.36 L 31.38 49.36 L 39.16 39.49 L 29.15 30.99 L 23.03 31 L 14 42.56 L 24.67 49.36 Z\" fill=\"#FFFFFF\" stroke=\"none\" stroke-width=\"1.4\"></path>\n\n<path d=\"M 24.67 49.36 L 31.38 49.36 L 39.16 39.49 L 29.15 30.99 L 23.03 31 L 14.91 42.56 L 24.67 49.36 Z\" fill=\"#FFFFFF\" stroke=\"none\" stroke-width=\"1.4\"></path>\n\n<g transform=\"translate(28 28)\"><g fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\" stroke-linejoin=\"round\"><rect x=\"0.47\" y=\"4.02\" width=\"13.13\" height=\"12.93\" transform=\"rotate(40.33 -0.88 -3.91)\"></rect><path d=\"M -4.97 2.99 L 1.15 2.53 L 11.16 11.04 L 5.04 11.49 M 11.16 11.04 L 2.8 20.9 L -3.33 21.35\" fill=\"none\" stroke=\"#2B2B2B\"></path></g></g>\n\n\n\n\n\n<line x1=\"10\" y1=\"14\" x2=\"10\" y2=\"22.5\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.4\"></line><line x1=\"17\" y1=\"22.5\" x2=\"10\" y2=\"22.5\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.4\"></line><line x1=\"6.5\" y1=\"28.5\" x2=\"10\" y2=\"22.5\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.4\"></line>",
    "scale": 1.25,
    "dx": 3,
    "dy": 4.5,
    "width": 44,
    "height": 44,
    "sockets": {
      "out": -4
    }
  },
  "normalLocal": {
    "svg": "<path d=\"M 19.17 19.94 L 25.29 19.47 L 34.75 28 L 26.94 37.84 L 20.81 38.29 L 11.32 29.67 L 19.17 19.94 Z\" fill=\"#FFFFFF\" stroke=\"none\" stroke-width=\"1.4\"></path>\n\n<g transform=\"translate(28 28)\"><g fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\" stroke-linejoin=\"round\"><rect x=\"-9.63\" y=\"-1.93\" width=\"13.13\" height=\"12.93\" transform=\"rotate(40.33 -0.88 -3.91)\"></rect><path d=\"M -8.83 -8.07 L -2.71 -8.53 L 7.3 -0.02 L 1.18 0.43 M 7.3 -0.02 L -1.06 9.84 L -7.19 10.29\"></path></g></g>\n\n<g transform=\"translate(28 28)\"><line x1=\"-0.83\" y1=\"-4.14\" x2=\"5\" y2=\"-11\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></line><polygon points=\"0.66 -12.06 6.75 -6.88 8.23 -14.81\" fill=\"#F57C00\"></polygon></g>\n\n<g transform=\"translate(28 28)\"><line x1=\"0.47\" y1=\"4.97\" x2=\"7.73\" y2=\"10.29\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></line><polygon points=\"8.48 5.89 3.75 12.33 11.77 13.24\" fill=\"#F57C00\"></polygon></g>\n\n<g transform=\"translate(28 28)\"><line x1=\"-7.69\" y1=\"1.06\" x2=\"-16.68\" y2=\"1.67\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></line><polygon points=\"-14.42 5.53 -14.96 -2.45 -21.69 2.03\" fill=\"#F57C00\"></polygon></g>",
    "scale": 1.35,
    "dx": 2,
    "dy": -7,
    "width": 34,
    "height": 35,
    "sockets": {
      "out": 0
    }
  },
  "dataviz": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#B4B7C0\" stroke-width=\"0.8\"><line x1=\"-18\" y1=\"6\" x2=\"18\" y2=\"6\"/><line x1=\"-18\" y1=\"6\" x2=\"-18\" y2=\"-15\"/></g><polyline points=\"-18,2 -12,-6 -6,-2 0,-12 6,-7 12,-13 18,-9\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.7\" stroke-linejoin=\"round\" stroke-linecap=\"round\"/><g stroke=\"none\"><rect x=\"-18\" y=\"11\" width=\"9\" height=\"6\" fill=\"#440154\"/><rect x=\"-9\" y=\"11\" width=\"9\" height=\"6\" fill=\"#277f8e\"/><rect x=\"0\" y=\"11\" width=\"9\" height=\"6\" fill=\"#4ac16d\"/><rect x=\"9\" y=\"11\" width=\"9\" height=\"6\" fill=\"#fde725\"/></g><rect x=\"-18\" y=\"11\" width=\"36\" height=\"6\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1\"/></g>",
    "scale": 2,
    "dy": -7.5,
    "width": 51,
    "height": 80,
    "sockets": {
      "signal": 12,
      "out": 12,
      "lowColor": 20,
      "highColor": 32
    }
  },
  "wireframe": {
    "svg": "<g transform=\"translate(28 28)\" fill=\"none\"><g stroke=\"#8A8F9C\" stroke-width=\"1.5\"><line x1=\"-21\" y1=\"-14\" x2=\"21\" y2=\"-14\"></line><line x1=\"-21\" y1=\"0\" x2=\"21\" y2=\"0\"></line><line x1=\"-21\" y1=\"14\" x2=\"21\" y2=\"14\"></line><line x1=\"-14\" y1=\"-21\" x2=\"-14\" y2=\"21\"></line><line x1=\"0\" y1=\"-21\" x2=\"0\" y2=\"21\"></line><line x1=\"14\" y1=\"-21\" x2=\"14\" y2=\"21\"></line></g><rect x=\"0\" y=\"0\" width=\"14\" height=\"14\" stroke=\"#F57C00\" stroke-width=\"2.4\"></rect></g>",
    "scale": 1.1,
    "width": 45,
    "height": 51,
    "sockets": {
      "out": 0,
      "uv": 0,
      "density": 16
    }
  },
  "isolines": {
    "svg": "<g transform=\"translate(28 28)\" fill=\"none\"><path d=\"M -22.63 5 Q -22.63 -21.91 1 -21.91 Q 25.5 -20 28.98 0 Q 28.98 27.54 1 25.2 Q -20.5 23.5 -22.63 5 Z\" stroke=\"#8A8F9C\" stroke-width=\"2.3\"></path><path d=\"M -15.5 5 Q -15.5 -13.46 0 -13.46 Q 17.28 -15.5 19.2 0 Q 20.78 18.62 1 18.62 Q -15.5 18.62 -15.5 5 Z\" stroke=\"#2B2B2B\" stroke-width=\"2.3\"></path><path d=\"M -7.16 3 Q -7.16 -4.64 1 -4.64 Q 10.43 -7.35 10.43 3 Q 10.43 10.01 1 10.01 Q -7.16 10.01 -7.16 3 Z\" stroke=\"#F57C00\" stroke-width=\"2.6\"></path></g>",
    "scale": 1.15,
    "dx": -3,
    "dy": -1,
    "width": 45,
    "height": 53,
    "sockets": {
      "out": 16,
      "value": 16
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
    "svg": "<path d=\"M 11.3 18.5 L 19.7 10.1 L 44.9 10.1 L 44.9 35.3 L 36.5 43.7 L 11.3 43.7 L 11.3 18.5 Z\" fill=\"#FFFFFF\" stroke=\"none\" stroke-width=\"1.4\"></path>\n\n\n<g transform=\"translate(28 28)\"><g fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\" stroke-linejoin=\"round\"><rect x=\"-16.7\" y=\"-9.5\" width=\"25.2\" height=\"25.2\"></rect><path d=\"M -16.7 -9.5 L -8.3 -17.9 L 16.9 -17.9 L 8.5 -9.5 M 16.9 -17.9 L 16.9 7.3 L 8.5 15.7\"></path></g><circle cx=\"-16.7\" cy=\"15.7\" r=\"4.9\" fill=\"#F57C00\"></circle></g>",
    "scale": 1.35,
    "dx": -1,
    "dy": -2.5,
    "width": 24,
    "height": 39,
    "sockets": {
      "out": 0
    }
  },
  "positionLocal": {
    "svg": "<path d=\"M 18 24 L 24 18 L 42 18 L 42 36 L 36 42 L 18 42 L 18 24 Z\" fill=\"#FFFFFF\" stroke=\"none\" stroke-width=\"1.4\"></path>\n\n<g transform=\"translate(28 28)\"><g fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\" stroke-linejoin=\"round\"><rect x=\"-10\" y=\"-4\" width=\"18\" height=\"18\"></rect><path d=\"M-10 -4 L-4 -10 L14 -10 L8 -4 M14 -10 L14 8 L8 14\"></path></g><circle cx=\"-10\" cy=\"14\" r=\"3.5\" fill=\"#F57C00\"></circle></g>\n\n\n\n<g transform=\"translate(28 28)\"><line x1=\"-21.7\" y1=\"3.5\" x2=\"-16.5\" y2=\"3.5\" stroke=\"#F57C00\" stroke-width=\"1.8\" fill=\"none\"></line><polygon points=\"-17.85 0.1 -17.99 7.06 -11.81 3.69\" fill=\"#F57C00\"></polygon></g>",
    "scale": 1.6,
    "dx": -1,
    "dy": -11,
    "width": 48,
    "height": 34,
    "sockets": {
      "out": 0
    }
  },
  "positionWorld": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#8A8F9C\" stroke-width=\"0.6\" fill=\"none\"><line x1=\"-22\" y1=\"-18\" x2=\"22\" y2=\"-18\" stroke-width=\"0.8\"></line><circle cx=\"0\" cy=\"-18\" r=\"1.2\" fill=\"#8A8F9C\" stroke=\"none\"></circle><line x1=\"-22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"0\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-22\" y1=\"20\" x2=\"22\" y2=\"20\"></line><line x1=\"-17\" y1=\"10\" x2=\"17\" y2=\"10\"></line><line x1=\"-13\" y1=\"2\" x2=\"13\" y2=\"2\"></line><line x1=\"-10\" y1=\"-4\" x2=\"10\" y2=\"-4\"></line></g></g>\n<g transform=\"translate(28 28)\">\n<path d=\"M -8.56 14.56 L -8.56 2 L -4.37 -2.18 L 8.18 -2.18 L 8.18 10.37 L 4 14.56 L -8.56 14.56 Z\" fill=\"#FFFFFF\" stroke=\"none\" stroke-width=\"1.4\"></path>\n\n<g fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\" stroke-linejoin=\"round\"><rect x=\"-8.56\" y=\"2\" width=\"12.56\" height=\"12.56\"></rect><path d=\"M -8.56 2 L -4.37 -2.18 L 8.18 -2.18 L 4 2 M 8.18 -2.18 L 8.18 10.37 L 4 14.56\"></path></g></g>",
    "scale": 1.6,
    "dy": -3,
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
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#8A8F9C\" stroke-width=\"0.6\" fill=\"none\"><line x1=\"-22\" y1=\"-14\" x2=\"22\" y2=\"-14\" stroke-width=\"0.8\"></line><circle cx=\"0\" cy=\"-14\" r=\"1.2\" fill=\"#8A8F9C\" stroke=\"none\"></circle><line x1=\"-22\" y1=\"24\" x2=\"0\" y2=\"-14\"></line><line x1=\"-11\" y1=\"24\" x2=\"0\" y2=\"-14\"></line><line x1=\"0\" y1=\"24\" x2=\"0\" y2=\"-14\"></line><line x1=\"11\" y1=\"24\" x2=\"0\" y2=\"-14\"></line><line x1=\"22\" y1=\"24\" x2=\"0\" y2=\"-14\"></line><line x1=\"-22\" y1=\"24\" x2=\"22\" y2=\"24\"></line><line x1=\"-17\" y1=\"14\" x2=\"17\" y2=\"14\"></line><line x1=\"-13\" y1=\"6\" x2=\"13\" y2=\"6\"></line><line x1=\"-10\" y1=\"0\" x2=\"10\" y2=\"0\"></line></g></g>\n\n\n<ellipse cx=\"28\" cy=\"13.75\" rx=\"11.15\" ry=\"5.75\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.6\"></ellipse><circle cx=\"28\" cy=\"13.75\" r=\"3.72\" fill=\"#F57C00\"></circle>",
    "scale": 1.05,
    "dx": 0.5,
    "dy": -5.5,
    "width": 52,
    "height": 33,
    "sockets": {
      "out": 0
    }
  },
  "positionWorldDirection": {
    "svg": "<g transform=\"translate(28 28)\"><circle cx=\"0\" cy=\"0\" r=\"5\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.6\"/><g stroke=\"#8A8F9C\" stroke-width=\"1.2\"><line x1=\"0\" y1=\"-7\" x2=\"0\" y2=\"-15\"/><line x1=\"0\" y1=\"7\" x2=\"0\" y2=\"15\"/><line x1=\"-7\" y1=\"0\" x2=\"-15\" y2=\"0\"/><line x1=\"7\" y1=\"0\" x2=\"15\" y2=\"0\"/><line x1=\"-5\" y1=\"-5\" x2=\"-11\" y2=\"-11\"/><line x1=\"5\" y1=\"5\" x2=\"11\" y2=\"11\"/><line x1=\"5\" y1=\"-5\" x2=\"11\" y2=\"-11\"/><line x1=\"-5\" y1=\"5\" x2=\"-11\" y2=\"11\"/></g><polygon points=\"9,-15 17,-15 13,-21\" fill=\"#F57C00\" transform=\"rotate(45 13 -18)\"/></g>",
    "scale": 2,
    "dx": -1,
    "dy": -3,
    "width": 41,
    "height": 49,
    "sockets": {
      "out": 0
    }
  },
  "cameraPosition": {
    "svg": "<g transform=\"translate(28 28)\"><g stroke=\"#8A8F9C\" stroke-width=\".8\" fill=\"none\"><line x1=\"-22\" y1=\"-18\" x2=\"22\" y2=\"-18\" stroke-width=\".8\"></line><circle cx=\"0\" cy=\"-18\" r=\"1.2\" fill=\"#8A8F9C\" stroke=\"none\"></circle><line x1=\"-22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"0\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"11\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"22\" y1=\"20\" x2=\"0\" y2=\"-18\"></line><line x1=\"-22\" y1=\"20\" x2=\"22\" y2=\"20\"></line><line x1=\"-16\" y1=\"10\" x2=\"17\" y2=\"10\"></line><line x1=\"-13\" y1=\"2\" x2=\"13\" y2=\"2\"></line><line x1=\"-8.08\" y1=\"-4\" x2=\"10\" y2=\"-4\"></line></g></g>\n\n<ellipse cx=\"28\" cy=\"34.03\" rx=\"6\" ry=\"3.5\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.6\"></ellipse><circle cx=\"28\" cy=\"34.03\" r=\"2\" fill=\"#F57C00\"></circle>",
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
    "svg": "<g transform=\"scale(0.8750 0.8750) translate(0 0)\">\n  <text x=\"32\" y=\"35.99\" font-family=\"sans-serif\" font-size=\"22\" font-weight=\"bold\" text-anchor=\"middle\">\n    <tspan fill=\"#2B2B2B\">-1</tspan>\n    <tspan fill=\"#F57C00\">+1</tspan>\n  </text>\n</g>",
    "scale": 1.6,
    "dx": -1,
    "dy": -12.5,
    "width": 53,
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
    "svg": "<g transform=\"translate(28 28)\" stroke=\"#F57C00\" stroke-width=\"1.4\" stroke-linecap=\"round\"><line stroke=\"#2B2B2B\" x1=\"-13.88\" y1=\"6\" x2=\"13.54\" y2=\"6\"></line><line x1=\"0\" y1=\"3.97\" x2=\"0\" y2=\"-14.15\"></line><line x1=\"-6.18\" y1=\"-3.5\" x2=\"0\" y2=\"3.97\"></line><line x1=\"0\" y1=\"3.97\" x2=\"7.13\" y2=\"-3.5\"></line></g>",
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
    "svg": "<g transform=\"translate(28 28)\" stroke=\"#F57C00\" stroke-width=\"1.4\" stroke-linecap=\"round\">\n\n\n\n<line x1=\"3.12\" y1=\"-5.96\" x2=\"3.12\" y2=\"-15.51\" stroke=\"#B4B7C0\" stroke-width=\"1.5\"></line>\n\n<line x1=\"7.5\" y1=\"-11.39\" x2=\"3.12\" y2=\"-15.51\" stroke=\"#B4B7C0\" stroke-width=\"1.5\"></line>\n\n<line x1=\"-1.45\" y1=\"-11.25\" x2=\"3.12\" y2=\"-15.51\" stroke=\"#B4B7C0\" stroke-width=\"1.5\"></line>\n\n<line x1=\"-14.82\" y1=\"4.07\" x2=\"-14.82\" y2=\"12.79\" stroke=\"#B4B7C0\" stroke-width=\"1.5\"></line>\n\n<line x1=\"-10.53\" y1=\"8.78\" x2=\"-14.82\" y2=\"12.79\" stroke=\"#B4B7C0\" stroke-width=\"1.5\"></line>\n<line x1=\"-19.27\" y1=\"8.78\" x2=\"-14.82\" y2=\"12.79\" stroke=\"#B4B7C0\" stroke-width=\"1.5\"></line>\n\n\n\n<line x1=\"-20\" y1=\"14.46\" x2=\"10.04\" y2=\"14.46\"></line><line x1=\"-20\" y1=\"-16.5\" x2=\"10.04\" y2=\"-16.5\"></line></g>\n\n\n <text x=\"48\" y=\"14.21\" font-family=\"sans-serif\" font-size=\"10\" font-weight=\"bold\" text-anchor=\"middle\">\n    <tspan fill=\"#F57C00\">1</tspan>\n  </text>\n\n<text x=\"48\" y=\"45.14\" font-family=\"sans-serif\" font-size=\"10\" font-weight=\"bold\" text-anchor=\"middle\">\n    <tspan fill=\"#F57C00\">0</tspan>\n  </text><path d=\"M 8 31.52 C 27.96 31.52 14.45 23.23 38.04 23.23\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\"></path>",
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
    "width": 40,
    "height": 43,
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
      "a": -24,
      "out": -4
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
    "svg": "<text x=\"26.12\" y=\"16.81\" font-family=\"sans-serif\" font-size=\"12\" font-weight=\"bold\" text-anchor=\"middle\">\n    <tspan fill=\"#F57C00\">-1</tspan>\n    <tspan fill=\"#F57C00\">+1</tspan>\n  </text>\n\n<g transform=\"translate(28 32)\"><line x1=\"-26\" y1=\"3\" x2=\"25.45\" y2=\"-15.19\" stroke=\"#B4B7C0\" stroke-dasharray=\"2 2\" stroke-width=\"1\"></line><line x1=\"-12.6\" y1=\"-1.69\" x2=\"6.4\" y2=\"-8.19\" stroke=\"#2B2B2B\" stroke-width=\"2\"></line><polygon points=\"11.43 -9.69 4.4 -11.49 4.4 -4\" fill=\"#2B2B2B\"></polygon><line x1=\"-12.6\" y1=\"2.71\" x2=\"-12.6\" y2=\"-13.19\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.4\"></line><line x1=\"11.43\" y1=\"2.71\" x2=\"11.43\" y2=\"-13.19\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.4\"></line></g>",
    "scale": 1.3,
    "dx": 1.5,
    "dy": -1.5,
    "width": 46,
    "height": 47,
    "sockets": {
      "v": 12,
      "out": 12
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
    "height": 37,
    "sockets": {
      "out": 0
    }
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
    "width": 45,
    "height": 34,
    "sockets": {
      "a": -8,
      "b": 8,
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
    "height": 57,
    "sockets": {
      "out": -12,
      "t": 16,
      "b": -4,
      "a": -20
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
    "width": 44,
    "height": 40,
    "sockets": {
      "signal": 12,
      "out": 12,
      "lowColor": 8,
      "highColor": 16
    }
  },
  "colormap": {
    "dx": 0.5,
    "dy": 2.5,
    "width": 63,
    "height": 28,
    "sockets": {
      "out": 0,
      "value": 0
    }
  },
  "select": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"-21\" y1=\"0\" x2=\"-15\" y2=\"0\" stroke=\"#8A8F9C\" stroke-width=\"1.2\"/><polygon points=\"-15,0 -6,-7 3,0 -6,7\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.4\" stroke-linejoin=\"round\"/><line x1=\"3\" y1=\"0\" x2=\"14.5\" y2=\"-6.6\" stroke=\"#F57C00\" stroke-width=\"1.8\"/><polygon points=\"18,-8.6 15.4,-4.1 12.8,-8.7\" fill=\"#F57C00\"/><line x1=\"3\" y1=\"0\" x2=\"17\" y2=\"8\" stroke=\"#8A8F9C\" stroke-width=\"1.1\" stroke-dasharray=\"1.4 1.4\"/></g>",
    "scale": 2,
    "dx": 3,
    "dy": -2,
    "width": 50,
    "height": 77,
    "sockets": {
      "condition": -28,
      "a": 12,
      "b": 28,
      "out": 20
    }
  },
  "sdCircle": {
    "svg": "<g transform=\"translate(28 28)\">\n\n\n\n<circle cx=\"0\" cy=\"0\" r=\"10.13\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.8\"></circle>\n\n<circle cx=\"0\" cy=\"0\" r=\"18.72\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.8\"></circle>\n\n<circle cx=\"0\" cy=\"0\" r=\"23.4\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.8\"></circle>\n\n<circle cx=\"0\" cy=\"0\" r=\"5.86\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.8\"></circle>\n\n<circle cx=\"0\" cy=\"0\" r=\"1.6\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.8\"></circle>\n\n<circle cx=\"0\" cy=\"0\" r=\"14\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.8\"></circle>\n\n<circle cx=\"0\" cy=\"0\" r=\"1.6\" fill=\"#2B2B2B\"></circle><line x1=\"0\" y1=\"0\" x2=\"12\" y2=\"-7.5\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"12\" cy=\"-7.5\" r=\"2.4\" fill=\"#F57C00\"></circle>\n\n\n</g>",
    "scale": 1.1,
    "width": 54,
    "height": 66,
    "sockets": {
      "p": -24,
      "r": 24,
      "out": 0
    }
  },
  "sdBox": {
    "svg": "<g transform=\"translate(28 28)\">\n\n\n<path d=\"M -12.08 -2.31 L -4.38 -10.25 L 11.03 -10.25 L 11.03 4.6 L 3.65 11.24 L -12.08 11.24 L -12.08 -2.31 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M -8.21 -1.66 L -2.75 -7.41 L 8.18 -7.41 L 8.18 3.35 L 2.95 8.14 L -8.21 8.14 L -8.21 -1.66 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<polygon points=\"-15,-4 -15,14 5,14 5,-4\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></polygon><polygon points=\"-15,-4 -6,-13 14,-13 5,-4\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></polygon><polygon points=\"5,-4 14,-13 14,5 5,14\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></polygon><line x1=\"0\" y1=\"0\" x2=\"22\" y2=\"0\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"14\" cy=\"0\" r=\"2.4\" fill=\"#F57C00\"></circle>\n\n<path d=\"M -18.5 -4 L -6.5 -16.5 L 17.5 -16.5 L 17.5 6.86 L 6 17.3 L -18.5 17.3 L -18.5 -4 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M -22.1 -5.01 L -7.84 -19.79 L 20.69 -19.79 L 20.69 7.84 L 7.02 20.2 L -22.1 20.2 L -22.1 -5.01 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M -25.38 -5.6 L -9 -22.93 L 23.79 -22.93 L 23.79 9.47 L 8.08 23.97 L -25.38 23.97 L -25.38 -5.6 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n</g>",
    "scale": 1.2,
    "dx": 0.5,
    "dy": 21,
    "width": 55,
    "height": 81,
    "sockets": {
      "p": -32,
      "w": 16,
      "h": 32,
      "d": 48,
      "out": -8,
      "round": 16,
      "b": 32
    }
  },
  "sdTorus": {
    "svg": "<g transform=\"translate(28 28)\"><ellipse cx=\"0\" cy=\"0\" rx=\"20\" ry=\"11\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></ellipse>\n\n<ellipse cx=\"0\" cy=\"0\" rx=\"8\" ry=\"4\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></ellipse>\n\n<ellipse cx=\"-0.5\" cy=\"-0.1\" rx=\"13.54\" ry=\"7.25\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></ellipse>\n\n<ellipse cx=\"0.22\" cy=\"-0.1\" rx=\"25.52\" ry=\"15.79\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></ellipse>\n\n<line x1=\"0.22\" y1=\"0\" x2=\"13.04\" y2=\"-8.18\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"13.04\" cy=\"-8.18\" r=\"2.4\" fill=\"#F57C00\"></circle></g>",
    "scale": 1.4,
    "dx": 0.5,
    "dy": -8,
    "width": 53,
    "height": 80,
    "sockets": {
      "p": -4,
      "out": -4,
      "ringR": 12,
      "tubeR": 28
    }
  },
  "sdCylinder": {
    "svg": "<g transform=\"translate(28 28)\">\n<path d=\"M-14 12 A14 5 0 0 1 14 12\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\" stroke-dasharray=\"2 2\"></path>\n<ellipse cx=\"0\" cy=\"-12\" rx=\"14\" ry=\"5\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></ellipse><line x1=\"-14\" y1=\"-12\" x2=\"-14\" y2=\"12\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></line><line x1=\"14\" y1=\"-12\" x2=\"14\" y2=\"12\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></line><path d=\"M-14 12 A14 5 0 0 0 14 12\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></path>\n\n<path d=\"M -18.37 -12 C -18.37 -12 -19.56 -22.04 0 -21.16 C 19.56 -21.16 18.3 -12 18.3 -12 L 18.3 12 C 18.3 12 20.72 21.98 0 21.26 C -20.72 21.26 -18.37 12 -18.37 12 L -18.37 -12 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M -21.69 -13.75 C -21.69 -13.75 -23.1 -25.26 0 -24.25 C 23.1 -24.25 21.61 -13.75 21.61 -13.75 L 21.61 13.76 C 21.61 13.76 24.47 25.2 0 24.38 C -24.47 24.38 -21.69 13.76 -21.69 13.76 L -21.69 -13.75 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M -24.98 -15.74 C -24.98 -15.74 -26.61 -28.92 0 -27.76 C 26.61 -27.76 24.89 -15.74 24.89 -15.74 L 24.89 15.76 C 24.89 15.76 28.19 28.86 0 27.92 C -28.19 27.92 -24.98 15.76 -24.98 15.76 L -24.98 -15.74 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n\n<line x1=\"0\" y1=\"12\" x2=\"13.1\" y2=\"12\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"13.1\" cy=\"12\" r=\"2.4\" fill=\"#F57C00\"></circle>\n\n\n<line x1=\"0\" y1=\"12\" x2=\"0\" y2=\"-12\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"0\" cy=\"-12\" r=\"2.4\" fill=\"#F57C00\"></circle>\n\n</g>",
    "dy": 2,
    "width": 39,
    "height": 90,
    "sockets": {
      "p": -4,
      "r": 8,
      "h": 24,
      "round": 40,
      "out": -4
    }
  },
  "sdCapsule": {
    "svg": "<g transform=\"translate(28 28)\">\n\n<rect x=\"-9\" y=\"-18\" width=\"17.74\" height=\"36\" rx=\"9\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></rect>\n\n\n\n<path d=\"M 0 -23.39 C -11.32 -22.39 -14.44 -16.62 -13.63 0 C -14.44 16.8 -11.32 22 0 23.18 C 11.32 22 13.63 16.8 13.63 0 C 13.63 -16.62 11.32 -22.39 0 -23.28 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M 0.12 -27.28 C -14.53 -26.11 -18.57 -19.38 -17.52 0.02 C -18.57 19.62 -14.53 25.69 0.12 27.07 C 14.77 25.69 17.76 19.62 17.76 0.02 C 17.76 -19.38 14.77 -26.11 0.12 -27.15 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<circle cx=\"0\" cy=\"0\" r=\"1.6\" fill=\"#2B2B2B\"></circle><line x1=\"0\" y1=\"0\" x2=\"0\" y2=\"-16.62\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"0\" cy=\"-16.62\" r=\"2.4\" fill=\"#F57C00\"></circle>\n\n<circle cx=\"0\" cy=\"0\" r=\"1.6\" fill=\"#2B2B2B\"></circle><line x1=\"0\" y1=\"0\" x2=\"8.74\" y2=\"0.02\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"8.74\" cy=\"0\" r=\"2.4\" fill=\"#F57C00\"></circle>\n\n</g>",
    "dy": 7.5,
    "width": 27,
    "height": 90,
    "sockets": {
      "p": 0,
      "r": 20,
      "h": 36,
      "out": 0
    }
  },
  "sdCone": {
    "svg": "<g transform=\"translate(28 28)\"><path d=\"M-14 12 L-5 -16 L5 -16 L14 12\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\" stroke-linejoin=\"round\"></path><ellipse cx=\"0\" cy=\"12\" rx=\"14\" ry=\"5\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></ellipse><ellipse cx=\"0\" cy=\"-16\" rx=\"5\" ry=\"2\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></ellipse>\n\n\n<path d=\"M -18.61 12 L -9 -18 C -9 -18 -9 -21.74 0 -21.61 C 9 -21.74 9 -18 9 -18 L 18.84 12 C 18.84 12 18.84 21.89 0 21.89 C -18.61 21.89 -18.61 12 -18.61 12 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M -23.06 13.64 L -11.16 -20.48 C -11.16 -20.48 -11.16 -24.75 -0.03 -24.59 C 11.11 -24.75 11.11 -20.48 11.11 -20.48 L 23.29 13.64 C 23.29 13.64 23.29 24.9 -0.03 24.9 C -23.06 24.9 -23.06 13.64 -23.06 13.64 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M -27.25 15.45 L -13.2 -23.22 C -13.2 -23.22 -13.2 -28.07 -0.05 -27.89 C 13.1 -28.07 13.1 -23.22 13.1 -23.22 L 27.48 15.45 C 27.48 15.45 27.48 28.22 -0.05 28.22 C -27.25 28.22 -27.25 15.45 -27.25 15.45 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<line x1=\"0\" y1=\"12\" x2=\"13.1\" y2=\"12\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"13.1\" cy=\"12\" r=\"2.4\" fill=\"#F57C00\"></circle>\n\n\n<line x1=\"0\" y1=\"12\" x2=\"-0.05\" y2=\"-16\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"-0.05\" cy=\"-16\" r=\"2.4\" fill=\"#F57C00\"></circle>\n</g>",
    "scale": 1.05,
    "dy": 0.5,
    "width": 42,
    "height": 88,
    "sockets": {
      "p": -4,
      "r1": 12,
      "r2": 24,
      "h": 36,
      "out": -4
    }
  },
  "sdPlane": {
    "svg": "<g transform=\"translate(28 28)\">\n\n\n<path d=\"M-20 8 L-4 -6 L22 -6 L6 8 Z\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\" stroke-linejoin=\"round\"></path>\n\n\n<path d=\"M -29.06 11.02 L -6.16 -9.02 L 31.06 -9.02 L 8.16 11.02 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\" stroke-linejoin=\"round\"></path>\n\n<path d=\"M -10.54 4.85 L -1.75 -2.85 L 12.54 -2.85 L 3.75 4.85 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\" stroke-linejoin=\"round\"></path>\n\n<path d=\"M -37.9 13.97 L -8.26 -11.97 L 39.9 -11.97 L 10.26 13.97 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\" stroke-linejoin=\"round\"></path>\n\n<line x1=\"1\" y1=\"1\" x2=\"1\" y2=\"-20\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></line><path d=\"M-3 -15 L1 -21 L5 -15\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></path>\n\n<line x1=\"0.22\" y1=\"0\" x2=\"22\" y2=\"-6\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"22\" cy=\"-6\" r=\"2.4\" fill=\"#F57C00\"></circle>\n\n</g>",
    "scale": 0.85,
    "dx": -1,
    "dy": 31.5,
    "width": 39,
    "height": 73,
    "sockets": {
      "p": -28,
      "nx": 0,
      "ny": 16,
      "nz": 28,
      "h": 24,
      "out": -12,
      "n": 8
    }
  },
  "sdOctahedron": {
    "svg": "<g transform=\"translate(28 28)\"><path d=\"M0 -20 L18 0 L0 20 L-18 0 Z\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\" stroke-linejoin=\"round\"></path><path d=\"M-18 0 L0 6 L18 0 M0 6 L0 20 M0 -20 L0 6\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M -22.83 0 L 0 -25.03 L 22.1 0 L 0 24.97 L -22.83 0 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M -26.89 0.01 L 0.06 -29.55 L 26.16 0.01 L 0.06 29.49 L -26.89 0.01 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<line x1=\"0.22\" y1=\"0\" x2=\"18\" y2=\"0.01\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"18\" cy=\"0\" r=\"0.5\" fill=\"#F57C00\"></circle>\n\n</g>",
    "dx": -0.5,
    "dy": -1,
    "width": 24,
    "height": 61,
    "sockets": {
      "p": -24,
      "s": 24,
      "out": 0
    }
  },
  "sdStar": {
    "svg": "<g transform=\"translate(28 28)\">\n\n\n<polygon points=\"0,-20 4.7,-6.47 19.02,-6.18 7.61,2.47 11.76,16.18 0,8 -11.76,16.18 -7.61,2.47 -19.02,-6.18 -4.7,-6.47\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\" stroke-linejoin=\"round\"></polygon>\n\n<polygon points=\"-0.08 -9.53 2.7 -3.9 8.96 -2.84 4.22 1.53 5.59 7.86 -0.08 4.86 -5.91 7.86 -4.37 1.53 -9.2 -2.84 -2.85 -3.9\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\" stroke-linejoin=\"round\"></polygon>\n\n<polygon points=\"0 -26.17 7.61 -10.73 24.76 -7.82 11.76 4.15 15.54 21.5 0 13.26 -16 21.5 -11.76 4.15 -25 -7.82 -7.61 -10.73\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\" stroke-linejoin=\"round\"></polygon>\n\n<polygon points=\"0.03 -31.72 9.41 -12.69 30.56 -9.1 14.53 5.66 19.19 27.05 0.03 16.89 -19.7 27.05 -14.47 5.66 -30.8 -9.1 -9.36 -12.69\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\" stroke-linejoin=\"round\"></polygon>\n\n<line x1=\"0.22\" y1=\"0\" x2=\"19.02\" y2=\"-6.47\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><circle cx=\"19.02\" cy=\"-6.18\" r=\"2.4\" fill=\"#F57C00\"></circle>\n\n</g>",
    "dx": -1,
    "dy": 4,
    "width": 48,
    "height": 99,
    "sockets": {
      "p": -8,
      "r": 8,
      "n": 24,
      "m": 40,
      "out": -8
    }
  },
  "sdfTransform": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"-18\" y1=\"14\" x2=\"18\" y2=\"14\" stroke=\"#8A8F9C\" stroke-width=\"1.6\"></line><line x1=\"-18\" y1=\"14\" x2=\"-18\" y2=\"-20\" stroke=\"#8A8F9C\" stroke-width=\"1.6\"></line><path d=\"M14 10 L18 14 L14 18 M-22 -16 L-18 -20 L-14 -16\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.6\"></path><rect x=\"-10\" y=\"-8\" width=\"14\" height=\"14\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.2\"></rect><path d=\"M6 -14 A12 12 0 0 1 16 -4\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.8\"></path><path d=\"M12 -5 L16 -4 L17 -8\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.8\"></path></g>",
    "scale": 1.3,
    "dx": 0.5,
    "dy": 16,
    "width": 56,
    "height": 93,
    "sockets": {
      "p": -36,
      "tx": -20,
      "ty": -8,
      "tz": 4,
      "rx": 24,
      "ry": 36,
      "rz": 48,
      "s": 36,
      "out": -16,
      "r": 20,
      "t": 4
    }
  },
  "sdfRepeat": {
    "svg": "<g transform=\"translate(28 28)\"><rect x=\"-18\" y=\"-14\" width=\"8\" height=\"8\" fill=\"#F57C00\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></rect><rect x=\"-4\" y=\"-14\" width=\"8\" height=\"8\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></rect><rect x=\"10\" y=\"-14\" width=\"8\" height=\"8\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></rect><rect x=\"-18\" y=\"2\" width=\"8\" height=\"8\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></rect><rect x=\"-4\" y=\"2\" width=\"8\" height=\"8\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></rect><rect x=\"10\" y=\"2\" width=\"8\" height=\"8\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.8\"></rect></g>",
    "scale": 1.45,
    "dx": -0.5,
    "dy": 9.5,
    "width": 55,
    "height": 74,
    "sockets": {
      "p": -28,
      "sx": -12,
      "sy": 0,
      "sz": 16,
      "lx": 28,
      "ly": 48,
      "lz": 60,
      "out": -8,
      "l": 28,
      "s": 12
    }
  },
  "sdfRepeatPolar": {
    "svg": "<g transform=\"translate(28 28)\"><circle cx=\"0\" cy=\"0\" r=\"16\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\" stroke-dasharray=\"2 2\"></circle><circle cx=\"16\" cy=\"0\" r=\"3.2\" fill=\"#F57C00\"></circle><circle cx=\"8\" cy=\"13.86\" r=\"3.2\" fill=\"#2B2B2B\"></circle><circle cx=\"-8\" cy=\"13.86\" r=\"3.2\" fill=\"#2B2B2B\"></circle><circle cx=\"-16\" cy=\"0\" r=\"3.2\" fill=\"#2B2B2B\"></circle><circle cx=\"-8\" cy=\"-13.86\" r=\"3.2\" fill=\"#2B2B2B\"></circle><circle cx=\"8\" cy=\"-13.86\" r=\"3.2\" fill=\"#2B2B2B\"></circle></g>",
    "scale": 2,
    "width": 25,
    "height": 78,
    "sockets": {
      "p": -32,
      "n": 32,
      "out": 0
    }
  },
  "sdfMirror": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"0\" y1=\"-22\" x2=\"0\" y2=\"22\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><path d=\"M-4 -12 L-18 -4 L-6 10 Z\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.2\" stroke-linejoin=\"round\"></path><path d=\"M4 -12 L18 -4 L6 10 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"2.2\" stroke-linejoin=\"round\"></path></g>",
    "scale": 1.35,
    "dx": -0.5,
    "dy": -20,
    "width": 57,
    "height": 73,
    "sockets": {
      "p": 12,
      "x": 12,
      "y": 28,
      "z": 44,
      "out": -20,
      "m": 28
    }
  },
  "sdfModify": {
    "svg": "<g transform=\"translate(28 28)\"><rect x=\"-10\" y=\"-10\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.2\"></rect><rect x=\"-18\" y=\"-18\" width=\"36\" height=\"36\" rx=\"8\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></rect></g>",
    "scale": 1.2,
    "dx": 0.5,
    "dy": -2.5,
    "width": 45,
    "height": 67,
    "sockets": {
      "d": -24,
      "amount": 20,
      "out": 0
    }
  },
  "sdfDeform": {
    "svg": "<g transform=\"translate(28 28)\"><path d=\"M -13.75 -20 C 31.63 -10 -31.52 10 13.3 20\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></path><path d=\"M 13.3 -20 C -31.52 -10 31.63 10 -13.75 20\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"2.4\"></path></g>",
    "scale": 1.2,
    "dy": -3,
    "width": 29,
    "height": 81,
    "sockets": {
      "p": 16,
      "amount": 32,
      "hx": 16,
      "hy": 32,
      "hz": 44,
      "out": -24,
      "h": 0
    }
  },
  "sdfExtrude": {
    "svg": "<g transform=\"translate(28 28)\"><circle cx=\"6\" cy=\"-6\" r=\"12\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></circle><line x1=\"-14.5\" y1=\"-2.5\" x2=\"-2.5\" y2=\"-14.5\" stroke=\"#F57C00\" stroke-width=\"1.6\"></line><line x1=\"2.5\" y1=\"14.5\" x2=\"14.5\" y2=\"2.5\" stroke=\"#F57C00\" stroke-width=\"1.6\"></line><circle cx=\"-6\" cy=\"6\" r=\"12\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></circle></g>",
    "scale": 1.3,
    "dy": -8.5,
    "width": 34,
    "height": 79,
    "sockets": {
      "d": -4,
      "p": 12,
      "h": 28,
      "out": -4
    }
  },
  "sdfRevolve": {
    "svg": "<g transform=\"translate(28 28)\"><line x1=\"0\" y1=\"-22\" x2=\"0\" y2=\"22\" stroke=\"#F57C00\" stroke-width=\"1.6\" stroke-dasharray=\"3 2\"></line><path d=\"M4 -16 C 16 -10, 6 4, 14 16\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></path><ellipse cx=\"0\" cy=\"16\" rx=\"14\" ry=\"5\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.6\"></ellipse></g>",
    "scale": 1.4,
    "width": 44,
    "height": 74,
    "sockets": {
      "p": -28,
      "o": 28,
      "out": 0
    }
  },
  "sdfMask": {
    "svg": "<g transform=\"translate(28 28)\"><circle cx=\"0\" cy=\"0\" r=\"16\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"2.4\"></circle><path d=\"M0 -16 A16 16 0 0 1 0 16 Z\" fill=\"#2B2B2B\"></path></g>",
    "scale": 1.3,
    "width": 46,
    "height": 63,
    "sockets": {
      "d": -24,
      "w": 24,
      "out": 0
    }
  },
  "sdCombine": {
    "svg": "<g transform=\"translate(28 28)\"><circle cx=\"-9\" cy=\"0\" r=\"10\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.2\" stroke-dasharray=\"2 2\"></circle><circle cx=\"9\" cy=\"0\" r=\"10\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.2\" stroke-dasharray=\"2 2\"></circle><path d=\"M -19 0 A 10 10 0 0 1 -4.4 -9 Q 0 -5 4.4 -9 A 10 10 0 1 1 4.4 9 Q 0 5 -4.4 9 A 10 10 0 0 1 -19 0 Z\" fill=\"none\" stroke=\"#F57C00\" stroke-width=\"1.8\"></path>\n\n\n\n\n<path d=\"M -22.51 0 C -22.53 -8.7 -16.7 -14.32 -9 -14.28 C -1.3 -14.24 -3.59 -11.52 0 -12.06 C 3.59 -11.6 0.96 -14.29 9 -14.18 C 17.04 -14.07 22.64 -8.7 22.54 0 C 22.64 8.7 16.68 13.46 9 13.73 C 1.32 14 4.33 10.19 0 11.23 C -4.33 11.27 -2.98 13.66 -9 13.79 C -15.02 13.92 -22.53 8.7 -22.51 0 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n<path d=\"M -26.07 0.05 C -26.09 -11.27 -19.34 -18.58 -10.43 -18.52 C -1.52 -18.47 -1.52 -14.94 -0.01 -15.99 C 1.52 -14.94 1.1 -18.54 10.41 -18.39 C 19.72 -18.25 26.2 -11.27 26.09 0.05 C 26.2 11.37 19.31 17.56 10.41 17.91 C 1.52 18.26 1.52 13.73 -0.01 15 C -1.52 14 -3.45 17.81 -10.43 17.99 C -17.4 18.15 -26.09 11.37 -26.07 0.05 Z\" fill=\"none\" stroke=\"#8A8F9C\" stroke-width=\"1.4\"></path>\n\n</g>",
    "scale": 1.35,
    "dx": -0.5,
    "dy": -8,
    "width": 39,
    "height": 79,
    "sockets": {
      "a": -4,
      "b": 12,
      "k": 28,
      "out": -4
    }
  },
  "rayDirection": {
    "svg": "<g transform=\"translate(28 28)\"><path d=\"M -24 0 Q -16 -9 -8 0 Q -16 9 -24 0 Z\" fill=\"none\" stroke=\"#2B2B2B\" stroke-width=\"1.6\"></path><circle cx=\"-16\" cy=\"0\" r=\"2.6\" fill=\"#2B2B2B\"></circle><line x1=\"-6\" y1=\"0\" x2=\"18\" y2=\"-8\" stroke=\"#F57C00\" stroke-width=\"1.8\"></line><polygon points=\"16,-13 24,-10 18,-4\" fill=\"#F57C00\"></polygon></g>",
    "scale": 1.2,
    "dx": 2,
    "dy": -2.5,
    "width": 34,
    "height": 33,
    "sockets": {
      "out": 0
    }
  }
};
