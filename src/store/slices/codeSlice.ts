/**
 * Code Slice
 * Manages Monaco editor code state
 */

import { StateCreator } from 'zustand';
import { ParseError } from '../../core/types';

export interface CodeSlice {
  // State
  code: string;
  codeErrors: ParseError[];
  isDirty: boolean;

  // Actions
  setCode: (code: string) => void;
  setCodeErrors: (errors: ParseError[]) => void;
  clearCodeErrors: () => void;
  setIsDirty: (isDirty: boolean) => void;
  resetCode: () => void;
}

const DEFAULT_CODE = `import { Fn, color, vec3 } from 'three/tsl';

// Your shader code here
const baseColor = color(0xff0000);

export default Fn(() => {
  return baseColor;
});
`;

export const createCodeSlice: StateCreator<CodeSlice> = (set) => ({
  // Initial state
  code: DEFAULT_CODE,
  codeErrors: [],
  isDirty: false,

  // Actions
  setCode: (code) =>
    set({
      code,
      isDirty: true,
    }),

  setCodeErrors: (errors) => set({ codeErrors: errors }),

  clearCodeErrors: () => set({ codeErrors: [] }),

  setIsDirty: (isDirty) => set({ isDirty }),

  resetCode: () =>
    set({
      code: DEFAULT_CODE,
      codeErrors: [],
      isDirty: false,
    }),
});
