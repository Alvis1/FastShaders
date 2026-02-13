/**
 * Complexity Slice
 * Manages VR performance complexity tracking
 */

import { StateCreator } from 'zustand';
import { VRPerformanceLevel } from '../../core/types';

export interface ComplexitySlice {
  // State
  totalComplexity: number;
  nodeComplexities: Record<string, number>;
  performanceLevel: VRPerformanceLevel;
  estimatedFPS: number;
  budgetPercentage: number;
  warnings: string[];
  suggestions: string[];

  // Actions
  setTotalComplexity: (complexity: number) => void;
  setNodeComplexities: (complexities: Record<string, number>) => void;
  setPerformanceLevel: (level: VRPerformanceLevel) => void;
  setEstimatedFPS: (fps: number) => void;
  setBudgetPercentage: (percentage: number) => void;
  setWarnings: (warnings: string[]) => void;
  setSuggestions: (suggestions: string[]) => void;
  recalculateComplexity: () => void;
  clearComplexity: () => void;
}

export const createComplexitySlice: StateCreator<ComplexitySlice> = (set) => ({
  // Initial state
  totalComplexity: 0,
  nodeComplexities: {},
  performanceLevel: 'comfortable',
  estimatedFPS: 90,
  budgetPercentage: 0,
  warnings: [],
  suggestions: [],

  // Actions
  setTotalComplexity: (complexity) =>
    set({
      totalComplexity: complexity,
    }),

  setNodeComplexities: (complexities) =>
    set({
      nodeComplexities: complexities,
    }),

  setPerformanceLevel: (level) =>
    set({
      performanceLevel: level,
    }),

  setEstimatedFPS: (fps) =>
    set({
      estimatedFPS: fps,
    }),

  setBudgetPercentage: (percentage) =>
    set({
      budgetPercentage: percentage,
    }),

  setWarnings: (warnings) => set({ warnings }),

  setSuggestions: (suggestions) => set({ suggestions }),

  recalculateComplexity: () => {
    // This will be implemented in the VRPerformanceTracker
    // For now, just a placeholder
  },

  clearComplexity: () =>
    set({
      totalComplexity: 0,
      nodeComplexities: {},
      performanceLevel: 'comfortable',
      estimatedFPS: 90,
      budgetPercentage: 0,
      warnings: [],
      suggestions: [],
    }),
});
