/**
 * FastShaders Main Store
 * Combines all slices with Zustand
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { GraphSlice, createGraphSlice } from './slices/graphSlice';
import { CodeSlice, createCodeSlice } from './slices/codeSlice';
import { PreviewSlice, createPreviewSlice } from './slices/previewSlice';
import { ComplexitySlice, createComplexitySlice } from './slices/complexitySlice';
import { UISlice, createUISlice } from './slices/uiSlice';

/**
 * Combined store type
 */
export type AppStore = GraphSlice &
  CodeSlice &
  PreviewSlice &
  ComplexitySlice &
  UISlice & {
    // Sync state
    lastUpdateSource: 'graph' | 'code' | 'init';
    syncInProgress: boolean;

    // Sync actions
    setLastUpdateSource: (source: 'graph' | 'code' | 'init') => void;
    setSyncInProgress: (inProgress: boolean) => void;
    syncFromGraph: () => void;
    syncFromCode: () => void;
  };

/**
 * Main application store
 */
export const useStore = create<AppStore>()(
  devtools(
    (set, get, api) => ({
      // Combine all slices
      ...createGraphSlice(set, get, api),
      ...createCodeSlice(set, get, api),
      ...createPreviewSlice(set, get, api),
      ...createComplexitySlice(set, get, api),
      ...createUISlice(set, get, api),

      // Sync state
      lastUpdateSource: 'init',
      syncInProgress: false,

      // Sync actions
      setLastUpdateSource: (source) => set({ lastUpdateSource: source }),

      setSyncInProgress: (inProgress) => set({ syncInProgress: inProgress }),

      syncFromGraph: () => {
        // This will be implemented by the SyncEngine
        // For now, just update the source
        set({
          lastUpdateSource: 'graph',
          syncInProgress: true,
        });
      },

      syncFromCode: () => {
        // This will be implemented by the SyncEngine
        // For now, just update the source
        set({
          lastUpdateSource: 'code',
          syncInProgress: true,
        });
      },
    }),
    {
      name: 'FastShaders',
      enabled: import.meta.env.DEV,  // Only enable devtools in development
    }
  )
);

/**
 * Export individual slice types for convenience
 */
export type {
  GraphSlice,
  CodeSlice,
  PreviewSlice,
  ComplexitySlice,
  UISlice,
};
