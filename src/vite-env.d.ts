/// <reference types="vite/client" />

declare module 'tsl-textures' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: Record<string, any>;
  export = mod;
}

/** Injected by Vite at build time from package.json (see vite.config.ts `define`). */
declare const __APP_VERSION__: string;
