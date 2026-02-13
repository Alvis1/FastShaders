/**
 * UI Slice
 * Manages UI state (panels, modals, context menus, etc.)
 */

import { StateCreator } from 'zustand';

export interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  type: 'canvas' | 'node' | 'output' | null;
  nodeId?: string;
}

export interface UISlice {
  // State
  showPreview: boolean;
  splitRatio: number;  // 0-1, percentage of screen for node view
  contextMenu: ContextMenuState;
  isLoading: boolean;
  loadingMessage: string;
  showExportModal: boolean;
  showSettingsModal: boolean;

  // Actions
  setShowPreview: (show: boolean) => void;
  setSplitRatio: (ratio: number) => void;
  openContextMenu: (x: number, y: number, type: 'canvas' | 'node' | 'output', nodeId?: string) => void;
  closeContextMenu: () => void;
  setIsLoading: (isLoading: boolean, message?: string) => void;
  setShowExportModal: (show: boolean) => void;
  setShowSettingsModal: (show: boolean) => void;
}

export const createUISlice: StateCreator<UISlice> = (set) => ({
  // Initial state
  showPreview: true,
  splitRatio: 0.5,  // 50/50 split
  contextMenu: {
    isOpen: false,
    x: 0,
    y: 0,
    type: null,
  },
  isLoading: false,
  loadingMessage: '',
  showExportModal: false,
  showSettingsModal: false,

  // Actions
  setShowPreview: (show) => set({ showPreview: show }),

  setSplitRatio: (ratio) =>
    set({
      splitRatio: Math.max(0.2, Math.min(0.8, ratio)),  // Clamp between 20% and 80%
    }),

  openContextMenu: (x, y, type, nodeId) =>
    set({
      contextMenu: {
        isOpen: true,
        x,
        y,
        type,
        nodeId,
      },
    }),

  closeContextMenu: () =>
    set({
      contextMenu: {
        isOpen: false,
        x: 0,
        y: 0,
        type: null,
      },
    }),

  setIsLoading: (isLoading, message = '') =>
    set({
      isLoading,
      loadingMessage: message,
    }),

  setShowExportModal: (show) => set({ showExportModal: show }),

  setShowSettingsModal: (show) => set({ showSettingsModal: show }),
});
