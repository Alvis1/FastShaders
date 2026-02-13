/**
 * Preview Slice
 * Manages shader preview state
 */

import { StateCreator } from 'zustand';
import { Material } from 'three';
import { PreviewGeometry, PreviewMode, CompilationError } from '../../core/types';

export interface PreviewSlice {
  // State
  previewGeometry: PreviewGeometry;
  previewMode: PreviewMode;
  previewMaterial: Material | null;
  vrEnabled: boolean;
  showFPS: boolean;
  showVRMetrics: boolean;
  currentFPS: number;
  compilationErrors: CompilationError[];

  // Actions
  setPreviewGeometry: (geometry: PreviewGeometry) => void;
  setPreviewMode: (mode: PreviewMode) => void;
  setPreviewMaterial: (material: Material | null) => void;
  setVREnabled: (enabled: boolean) => void;
  setShowFPS: (show: boolean) => void;
  setShowVRMetrics: (show: boolean) => void;
  setCurrentFPS: (fps: number) => void;
  setCompilationErrors: (errors: CompilationError[]) => void;
  clearCompilationErrors: () => void;
}

export const createPreviewSlice: StateCreator<PreviewSlice> = (set) => ({
  // Initial state
  previewGeometry: 'sphere',  // Default from mockup
  previewMode: 'standard',
  previewMaterial: null,
  vrEnabled: false,
  showFPS: true,
  showVRMetrics: true,
  currentFPS: 60,
  compilationErrors: [],

  // Actions
  setPreviewGeometry: (geometry) => set({ previewGeometry: geometry }),

  setPreviewMode: (mode) => set({ previewMode: mode }),

  setPreviewMaterial: (material) => set({ previewMaterial: material }),

  setVREnabled: (enabled) => set({ vrEnabled: enabled }),

  setShowFPS: (show) => set({ showFPS: show }),

  setShowVRMetrics: (show) => set({ showVRMetrics: show }),

  setCurrentFPS: (fps) => set({ currentFPS: fps }),

  setCompilationErrors: (errors) => set({ compilationErrors: errors }),

  clearCompilationErrors: () => set({ compilationErrors: [] }),
});
