import type { Monaco } from '@monaco-editor/react';

export function registerTSLLanguage(monaco: Monaco) {
  monaco.languages.typescript.javascriptDefaults.addExtraLib(
    `
declare module 'three/tsl' {
  export function Fn(fn: (...args: any[]) => any): any;
  export function If(condition: any, body: () => void): { ElseIf(condition: any, body: () => void): any; Else(body: () => void): void };
  export function Loop(count: any, body: (ctx: { i: any }) => void): void;
  export const positionGeometry: any;
  export const normalLocal: any;
  export const tangentLocal: any;
  export const time: any;
  export const screenUV: any;
  export function uniform(value: any): any;
  export function float(v: number): any;
  export function int(v: number): any;
  export function vec2(x: number, y?: number): any;
  export function vec3(x: number, y?: number, z?: number): any;
  export function vec4(x: number, y?: number, z?: number, w?: number): any;
  export function color(hex: number): any;
  export function add(a: any, b: any): any;
  export function sub(a: any, b: any): any;
  export function mul(a: any, b: any): any;
  export function div(a: any, b: any): any;
  export function sin(x: any): any;
  export function cos(x: any): any;
  export function abs(x: any): any;
  export function pow(base: any, exp: any): any;
  export function sqrt(x: any): any;
  export function exp(x: any): any;
  export function log2(x: any): any;
  export function floor(x: any): any;
  export function round(x: any): any;
  export function fract(x: any): any;
  export function mod(x: any, y: any): any;
  export function clamp(x: any, min: any, max: any): any;
  export function min(a: any, b: any): any;
  export function max(a: any, b: any): any;
  export function mix(a: any, b: any, t: any): any;
  export function smoothstep(e0: any, e1: any, x: any): any;
  export function remap(x: any, inLow: any, inHigh: any, outLow: any, outHigh: any): any;
  export function select(cond: any, a: any, b: any): any;
  export function normalize(v: any): any;
  export function length(v: any): any;
  export function distance(a: any, b: any): any;
  export function dot(a: any, b: any): any;
  export function cross(a: any, b: any): any;
  export function mx_noise_float(pos: any): any;
  export function mx_fractal_noise_float(pos: any, octaves: any, lacunarity: any, diminish: any): any;
  export function mx_worley_noise_float(pos: any): any;
  export function hsl(h: any, s: any, l: any): any;
}
`,
    'ts:three-tsl.d.ts'
  );
}
